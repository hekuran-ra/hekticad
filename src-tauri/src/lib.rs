mod menu;

use tauri_plugin_dialog::DialogExt;

/// Open a native "Save as…" dialog and write the given bytes to whatever path
/// the user picks. Returns the chosen path on success, `None` if the user
/// cancelled. Frontend export routes (`exportDrawing` in `src/io.ts`) call
/// this instead of the browser's `<a download>` trick so the user gets to
/// choose the location — before this existed, every export landed in the
/// default Downloads folder which (a) hid the file and (b) clobbered previous
/// exports with the same name.
///
/// Bytes are taken as `Vec<u8>` and written via `std::fs::write` rather than
/// routing through the fs plugin: no extra capability scope to configure and
/// the write happens on the command worker thread.
#[tauri::command]
async fn save_bytes_dialog(
  app: tauri::AppHandle,
  data: Vec<u8>,
  suggested_name: String,
  filter_name: String,
  filter_extensions: Vec<String>,
) -> Result<Option<String>, String> {
  // Callback-style Tauri dialog → std::sync::mpsc. The callback fires on the
  // dialog plugin's internal thread; we bridge it to our async command via a
  // blocking `recv` wrapped in `spawn_blocking` so the async runtime worker
  // stays free. Avoids pulling `tokio::sync::oneshot` as a direct dep.
  let (tx, rx) = std::sync::mpsc::channel();
  let ext_refs: Vec<&str> = filter_extensions.iter().map(|s| s.as_str()).collect();
  app
    .dialog()
    .file()
    .set_file_name(&suggested_name)
    .add_filter(&filter_name, &ext_refs)
    .save_file(move |path| {
      let _ = tx.send(path);
    });
  let picked = tauri::async_runtime::spawn_blocking(move || rx.recv())
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
  let Some(file_path) = picked else { return Ok(None) };
  // `FilePath` wraps a real path or a URI. Desktop save dialogs always produce
  // a real path — `into_path` would only fail on a mobile content-provider URI.
  let path_buf = file_path.into_path().map_err(|e| e.to_string())?;
  std::fs::write(&path_buf, &data).map_err(|e| format!("Speichern fehlgeschlagen: {e}"))?;
  Ok(Some(path_buf.to_string_lossy().into_owned()))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_updater::Builder::new().build())
    .plugin(tauri_plugin_process::init())
    .plugin(tauri_plugin_dialog::init())
    .invoke_handler(tauri::generate_handler![save_bytes_dialog])
    .menu(|handle| menu::build(handle))
    .on_menu_event(|app, event| menu::on_menu_event(app, event))
    .setup(|app| {
      // Log plugin in every build — release logs go to the OS log dir so we
      // can diagnose update failures in shipped builds. Frontend `info!`/
      // `error!` calls from `@tauri-apps/plugin-log` show up there too.
      app.handle().plugin(
        tauri_plugin_log::Builder::default()
          .level(log::LevelFilter::Info)
          .build(),
      )?;
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
