//! Native macOS menu bar for HektikCad.
//!
//! Mirrors the `MENUS` constant in `src/ui/menu-bar.ts`: each menu item
//! carries a stable string id (e.g. `file:save`, `edit:undo`) that the
//! frontend's `runMenuCommand()` dispatches back to the same action the
//! in-app HTML dropdown would have called. So the native bar is a pure
//! shell — no behavior duplication, no drift between platforms.
//!
//! Keyboard accelerators are only bound for modifier-shortcuts (Cmd+S,
//! Cmd+Z, …). Single-letter tool shortcuts (L for Linie, R for Rechteck,
//! …) stay in the frontend's keydown handler so they respect text-input
//! focus — a native accelerator would fire even while the user is typing
//! in a dialog field.
//!
//! `on_menu_event` catches every click and emits an `app-menu-command`
//! event carrying the item id. See `src/tauribridge.ts` for the listener.

use tauri::menu::{
    AboutMetadataBuilder, CheckMenuItemBuilder, Menu, MenuItemBuilder, PredefinedMenuItem,
    SubmenuBuilder,
};
use tauri::{AppHandle, Emitter, Manager, Runtime};

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    // ── App menu (macOS convention: the first menu is always the app menu,
    //    and `About`, `Services`, `Hide`, and `Quit` are predefined items so
    //    the OS wires them up correctly — e.g. Cmd+Q gracefully terminates).
    let about_meta = AboutMetadataBuilder::new()
        .name(Some("HektikCad"))
        .version(Some(env!("CARGO_PKG_VERSION")))
        .authors(Some(vec!["VisualsbyHekuran".into()]))
        .comments(Some("Parametric 2D CAD sketchpad"))
        .website(Some("https://github.com/hekuran-ra/hekticad"))
        .website_label(Some("GitHub"))
        .build();

    let app_submenu = SubmenuBuilder::new(app, "HektikCad")
        .item(&PredefinedMenuItem::about(app, Some("Über HektikCad"), Some(about_meta))?)
        .separator()
        .item(
            &MenuItemBuilder::with_id("app:check-updates", "Auf Updates prüfen…")
                .build(app)?,
        )
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    // ── Datei
    let file_submenu = SubmenuBuilder::new(app, "Datei")
        .item(
            &MenuItemBuilder::with_id("file:new", "Neu")
                .accelerator("CmdOrCtrl+N")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("file:open", "Öffnen…")
                .accelerator("CmdOrCtrl+O")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("file:save", "Speichern")
                .accelerator("CmdOrCtrl+S")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("file:import", "Importieren…")
                .accelerator("CmdOrCtrl+Shift+I")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("file:export", "Exportieren…")
                .accelerator("CmdOrCtrl+Shift+E")
                .build(app)?,
        )
        .separator()
        .item(&MenuItemBuilder::with_id("file:clear", "Alles löschen").build(app)?)
        .build()?;

    // ── Bearbeiten
    //    macOS-Konvention: Redo ist Cmd+Shift+Z (nicht Cmd+Y wie auf Windows).
    let edit_submenu = SubmenuBuilder::new(app, "Bearbeiten")
        .item(
            &MenuItemBuilder::with_id("edit:undo", "Rückgängig")
                .accelerator("CmdOrCtrl+Z")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("edit:redo", "Wiederherstellen")
                .accelerator("CmdOrCtrl+Shift+Z")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("edit:select-all", "Alles auswählen")
                .accelerator("CmdOrCtrl+A")
                .build(app)?,
        )
        // Esc bleibt rein im Frontend — native Accelerator würde Modale
        // und Tool-Cancel kaputt machen.
        .item(&MenuItemBuilder::with_id("edit:deselect", "Auswahl aufheben").build(app)?)
        .build()?;

    // ── Ansicht (Toggles als CheckMenuItem; Anfangszustand „on" passt zu den
    //    Defaults in runtime.snapSettings).
    let view_submenu = SubmenuBuilder::new(app, "Ansicht")
        .item(&MenuItemBuilder::with_id("view:zoom-fit", "Alles zoomen").build(app)?)
        .item(
            &MenuItemBuilder::with_id("view:zoom-in", "Vergrößern")
                .accelerator("CmdOrCtrl+=")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("view:zoom-out", "Verkleinern")
                .accelerator("CmdOrCtrl+-")
                .build(app)?,
        )
        .separator()
        .item(
            &CheckMenuItemBuilder::with_id("view:toggle-grid", "Raster anzeigen")
                .checked(true)
                .build(app)?,
        )
        .item(
            &CheckMenuItemBuilder::with_id("view:toggle-snap", "Am Raster fangen")
                .checked(true)
                .build(app)?,
        )
        .build()?;

    // ── Einfügen (Werkzeug-Shortcuts sind Single-Key (L/Y/R/…). Keine
    //    Accelerators — die Frontend-keydown-Handler respektieren Text-Input-
    //    Fokus; ein OS-Accelerator würde mitten beim Tippen feuern.)
    let insert_submenu = SubmenuBuilder::new(app, "Einfügen")
        .item(&MenuItemBuilder::with_id("insert:line", "Linie").build(app)?)
        .item(&MenuItemBuilder::with_id("insert:polyline", "Polylinie").build(app)?)
        .item(&MenuItemBuilder::with_id("insert:rect", "Rechteck").build(app)?)
        .item(&MenuItemBuilder::with_id("insert:circle", "Kreis").build(app)?)
        .item(&MenuItemBuilder::with_id("insert:text", "Text").build(app)?)
        .item(&MenuItemBuilder::with_id("insert:dim", "Bemaßung").build(app)?)
        .item(&MenuItemBuilder::with_id("insert:xline", "Hilfslinie").build(app)?)
        .build()?;

    // ── Einstellungen
    let settings_submenu = SubmenuBuilder::new(app, "Einstellungen")
        .item(&MenuItemBuilder::with_id("settings:theme", "Design…").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("settings:company", "Firmeneinstellungen…").build(app)?)
        .item(&MenuItemBuilder::with_id("settings:dim-style", "Bemaßungsstil…").build(app)?)
        .separator()
        .item(
            &CheckMenuItemBuilder::with_id("settings:lock-panels", "Toolgruppen sperren")
                .checked(false)
                .build(app)?,
        )
        .item(&MenuItemBuilder::with_id("settings:reset-tools", "Toolgruppen zurücksetzen").build(app)?)
        .separator()
        .item(
            &MenuItemBuilder::with_id("settings:save-default", "Aktuellen Zustand als Standard speichern…")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("settings:reset-default", "Eigenen Standard zurücksetzen")
                .build(app)?,
        )
        .build()?;

    // ── Hilfe
    let help_submenu = SubmenuBuilder::new(app, "Hilfe")
        .item(&MenuItemBuilder::with_id("help:shortcuts", "Tastenkürzel-Übersicht").build(app)?)
        .item(&MenuItemBuilder::with_id("help:about", "Über HektikCad").build(app)?)
        .build()?;

    // `Manager` brings `menu()` into scope for the trait we don't otherwise
    // need here — keep the import so clippy doesn't flag it under a future
    // refactor.
    let _ = app.webview_windows();

    Menu::with_items(
        app,
        &[
            &app_submenu,
            &file_submenu,
            &edit_submenu,
            &view_submenu,
            &insert_submenu,
            &settings_submenu,
            &help_submenu,
        ],
    )
}

/// Emit the clicked item's id over the `app-menu-command` event so the
/// frontend's `tauribridge.ts` listener can dispatch it.
pub fn on_menu_event<R: Runtime>(app: &AppHandle<R>, event: tauri::menu::MenuEvent) {
    let id = event.id.as_ref().to_string();
    if let Err(err) = app.emit("app-menu-command", id.clone()) {
        log::warn!("failed to emit app-menu-command for {id}: {err}");
    }
}
