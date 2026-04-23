mod menu;

use std::sync::Mutex;

use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

/// Accumulates `.hcad` paths that the OS has asked us to open before the
/// frontend is ready to receive them. The frontend drains this on startup via
/// `get_pending_opens`; after that, subsequent opens arrive live via the
/// `file-open-request` event. Without this buffer, a macOS launch-to-open
/// (double-click from Finder) races the webview: the Apple Event fires on
/// `applicationDidFinishLaunching`, sometimes before the JS bridge is wired.
#[derive(Default)]
struct PendingOpens {
  paths: Mutex<Vec<String>>,
}

impl PendingOpens {
  fn push(&self, path: String) {
    if let Ok(mut v) = self.paths.lock() {
      v.push(path);
    }
  }
  fn drain(&self) -> Vec<String> {
    self
      .paths
      .lock()
      .map(|mut v| std::mem::take(&mut *v))
      .unwrap_or_default()
  }
}

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

/// Read the contents of a file into a UTF-8 string. Used by the file-open-
/// request flow (frontend receives a path from Rust, asks us to read it) so
/// the frontend doesn't need broad `fs:read` capability — we only expose this
/// narrow command and the caller is always our own `file-open-request`
/// listener in `tauribridge.ts`.
#[tauri::command]
async fn read_file_text(path: String) -> Result<String, String> {
  tauri::async_runtime::spawn_blocking(move || std::fs::read_to_string(&path))
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| format!("Datei lesen fehlgeschlagen: {e}"))
}

/// Direct write to an already-known path — used by the frontend's Ctrl+S
/// fast path when the drawing already has a bound file (previously opened
/// or previously saved-as). Skips the Save-As dialog so successive saves
/// behave like every other editor: write and move on.
///
/// Separate from `save_bytes_dialog` so the Tauri permission surface stays
/// narrow: this command only writes to a specific path the frontend already
/// holds (it got it from an earlier `save_bytes_dialog` or `file-open-request`
/// call), never to an arbitrary user-picked location.
#[tauri::command]
async fn write_file_bytes(path: String, data: Vec<u8>) -> Result<(), String> {
  tauri::async_runtime::spawn_blocking(move || std::fs::write(&path, &data))
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| format!("Speichern fehlgeschlagen: {e}"))
}

/// Drain any `.hcad` paths that the OS queued for us to open before the
/// frontend was ready. Called once by `tauribridge.ts` on startup — anything
/// arriving after that goes live via the `file-open-request` event.
#[tauri::command]
fn get_pending_opens(state: tauri::State<'_, PendingOpens>) -> Vec<String> {
  state.drain()
}

/// Convert a best-effort list of argv strings (from a second-instance launch
/// or our own process args) into candidate `.hcad` file paths. Filters by
/// extension so we don't treat unrelated flags / the executable path itself
/// as documents to open.
fn argv_to_hcad_paths<I, S>(argv: I) -> Vec<String>
where
  I: IntoIterator<Item = S>,
  S: AsRef<str>,
{
  argv
    .into_iter()
    .filter_map(|a| {
      let s = a.as_ref();
      let lower = s.to_lowercase();
      if lower.ends_with(".hcad") || lower.ends_with(".json") {
        Some(s.to_string())
      } else {
        None
      }
    })
    .collect()
}

/// Emit `file-open-request` to the frontend for every path, or buffer them
/// into `PendingOpens` if no webview window exists yet (the early-startup
/// case on macOS where the Apple Event beats the webview).
fn deliver_open_paths<R: tauri::Runtime>(app: &tauri::AppHandle<R>, paths: Vec<String>) {
  if paths.is_empty() {
    return;
  }
  let has_window = app.webview_windows().values().next().is_some();
  if has_window {
    for p in &paths {
      if let Err(err) = app.emit("file-open-request", p.clone()) {
        log::warn!("failed to emit file-open-request for {p}: {err}");
      }
    }
  }
  // Buffer unconditionally — even when we emit, the frontend may still be
  // mid-boot and not yet listening. Drain-on-startup covers that race.
  if let Some(state) = app.try_state::<PendingOpens>() {
    for p in paths {
      state.push(p);
    }
  }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let mut builder = tauri::Builder::default();

  // Single-instance must be the FIRST plugin registered (Tauri 2 docs). Its
  // callback fires on a second launch (OS "open with" → HektikCad → another
  // process spawn); we forward the argv paths to the already-running app.
  #[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
  {
    builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
      let paths = argv_to_hcad_paths(argv);
      // Bring the existing window to the front so the user actually sees the
      // file they just opened — otherwise the second launch just silently
      // hands off and it feels like nothing happened.
      if let Some(win) = app.webview_windows().values().next() {
        let _ = win.set_focus();
        let _ = win.unminimize();
      }
      deliver_open_paths(app, paths);
    }));
  }

  builder
    .plugin(tauri_plugin_updater::Builder::new().build())
    .plugin(tauri_plugin_process::init())
    .plugin(tauri_plugin_dialog::init())
    .invoke_handler(tauri::generate_handler![
      save_bytes_dialog,
      read_file_text,
      write_file_bytes,
      get_pending_opens,
      menu::set_menu_check
    ])
    .manage(PendingOpens::default())
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

      // First-launch argv: Windows & Linux pass the double-clicked file path
      // as argv[1]. (macOS uses Apple Events — handled below in RunEvent::
      // Opened, so skip argv there to avoid double-delivery.)
      #[cfg(any(target_os = "windows", target_os = "linux"))]
      {
        let paths = argv_to_hcad_paths(std::env::args().skip(1));
        deliver_open_paths(&app.handle(), paths);
      }
      Ok(())
    })
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|_app, _event| {
      // macOS delivers "open with" via Apple Events, which Tauri surfaces as
      // RunEvent::Opened. Fires both at launch (cold open) and while running.
      // The variant ONLY exists in the macOS build of `tauri::RunEvent` —
      // matching on it unconditionally fails to compile on Windows/Linux with
      // `no variant named 'Opened' found for enum 'RunEvent'`. Gate the whole
      // block behind `#[cfg(target_os = "macos")]` so the other targets see
      // an empty runner (they receive paths via argv/single-instance instead,
      // wired up in `.setup()` above and in the single-instance plugin).
      #[cfg(target_os = "macos")]
      {
        let app = _app;
        if let tauri::RunEvent::Opened { urls } = _event {
          let paths: Vec<String> = urls
            .into_iter()
            .filter_map(|u| u.to_file_path().ok())
            .map(|p| p.to_string_lossy().into_owned())
            .collect();
          deliver_open_paths(app, paths);
        }
      }
    });
}
