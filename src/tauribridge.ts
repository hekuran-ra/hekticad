/**
 * Desktop (Tauri) ↔ frontend bridge.
 *
 * Called once from main.ts at startup. In a plain-browser build this is a
 * no-op; inside a Tauri window it:
 *
 *   1. Adds `.is-tauri-desktop` to <body> so CSS can hide the in-app menu
 *      bar (the native macOS menu bar replaces it).
 *   2. Subscribes to the `app-menu-command` event the Rust side emits when
 *      the user picks a native menu item, and dispatches each command id
 *      to its frontend handler — either the shared `runMenuCommand()`
 *      (for items mirrored in both the in-app and native menus) or one of
 *      the app-menu-only actions (`app:check-updates`, `app:about`, …).
 *
 * Keeping the bridge here means `main.ts` stays focused on the canvas app
 * and the Tauri-specific wiring lives in one audible place.
 */

import { runMenuCommand } from './ui/menu-bar';
import { checkForUpdatesManually } from './updater';
import { showAboutDialog } from './ui/help-dialogs';
import { isDirty } from './dirty';
import { applyLoadedDrawing, saveJsonInteractive } from './io';
import { setCurrentFilePath } from './docfile';
import { showUnsavedChangesPrompt } from './modal';
import { toast } from './ui';
import { getPanelsLocked, onPanelsLockedChange } from './tools';

async function isTauriEnv(): Promise<boolean> {
  try {
    const { isTauri } = await import('@tauri-apps/api/core');
    return isTauri();
  } catch {
    return false;
  }
}

function dispatchMenuCommand(id: string): void {
  // App-menu-only commands that don't live in the `MENUS` map.
  switch (id) {
    case 'app:about':
      void showAboutDialog();
      return;
    case 'app:check-updates':
      void checkForUpdatesManually();
      return;
  }
  // Everything else is a mirror of the in-app menu entries.
  runMenuCommand(id);
}

export async function initTauriBridge(): Promise<void> {
  if (!(await isTauriEnv())) return;

  // CSS hook — hides `#menu-bar` and the redundant header buttons while
  // running under Tauri, since the native macOS menu bar carries those
  // actions.
  document.body.classList.add('is-tauri-desktop');

  try {
    const { listen } = await import('@tauri-apps/api/event');
    await listen<string>('app-menu-command', (ev) => {
      if (typeof ev.payload === 'string') dispatchMenuCommand(ev.payload);
    });
  } catch (err) {
    // If the event plugin is unavailable the app still works — just without
    // native-menu integration. Log and carry on.
    // eslint-disable-next-line no-console
    console.warn('[tauri-bridge] failed to subscribe to menu events:', err);
  }

  await installFileOpenHandler();
  await installCloseGuard();
  await installNativeMenuStateSync();
}

/**
 * Keep the native menu's toggle items (currently just `settings:lock-panels`)
 * in sync with the frontend's runtime state. Two triggers:
 *
 *   1. Startup — push the current `getPanelsLocked()` so the native ✓ reflects
 *      whatever we loaded from user-defaults / localStorage. Without this the
 *      CheckMenuItem's hardcoded initial `checked(false)` wins on Windows and
 *      the check ends up inverted vs. the real state after the first load.
 *   2. Toggle — `setPanelsLocked` fires our change listener, which forwards
 *      the new state to the Rust `set_menu_check` command. macOS auto-toggles
 *      the check correctly on click (NSMenuItem behaviour), but Windows muda
 *      doesn't, so a manual sync is the cross-platform safe path.
 *
 * If the command errors we log but don't toast — a misaligned native check
 * isn't worth interrupting the user for.
 */
async function installNativeMenuStateSync(): Promise<void> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const push = (checked: boolean): void => {
      void invoke('set_menu_check', { id: 'settings:lock-panels', checked }).catch((err) => {
        // eslint-disable-next-line no-console
        console.warn('[tauri-bridge] set_menu_check failed:', err);
      });
    };
    push(getPanelsLocked());
    onPanelsLockedChange(push);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[tauri-bridge] failed to install native menu state sync:', err);
  }
}

/**
 * Wire the OS "open with HektikCad" flow:
 *
 *   1. Subscribe to the `file-open-request` event Rust emits whenever the
 *      OS hands us a .hcad path (macOS Apple Events, Windows / Linux argv
 *      forwarded via single-instance).
 *   2. Drain any paths Rust already queued before we were ready — on a
 *      cold macOS launch-to-open, the Apple Event fires before the
 *      webview's JS boots, so the first path sits in the Rust-side buffer.
 *
 * Each path is read via the narrow `read_file_text` command (so we don't
 * have to grant broad fs:read capability) and then applied through the
 * shared `applyLoadedDrawing` helper — same code path as Datei → Öffnen.
 */
async function installFileOpenHandler(): Promise<void> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const { listen } = await import('@tauri-apps/api/event');

    const openPath = async (path: string): Promise<void> => {
      try {
        const text = await invoke<string>('read_file_text', { path });
        if (!applyLoadedDrawing(text)) {
          toast(`Fehler beim Laden: ${path}`);
          return;
        }
        // Bind the drawing to this path so the next Ctrl+S writes straight
        // back without a dialog. Also updates the title bar span + native
        // window title to the opened file's basename.
        setCurrentFilePath(path);
        toast(`Geladen: ${path}`);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[tauri-bridge] read_file_text failed:', err);
        const msg = err instanceof Error ? err.message : String(err);
        toast(`Fehler beim Öffnen: ${msg}`);
      }
    };

    await listen<string>('file-open-request', (ev) => {
      if (typeof ev.payload === 'string') void openPath(ev.payload);
    });

    const pending = await invoke<string[]>('get_pending_opens');
    // Multiple pending paths would be unusual, but if the OS did hand us
    // several we just open them in order — the last one wins as the
    // active drawing. Matches how most editors handle multi-file launches.
    for (const p of pending) {
      await openPath(p);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[tauri-bridge] failed to install file-open handler:', err);
  }
}

/**
 * Hook the window's close request so a dirty drawing prompts the user before
 * the app terminates. On Tauri 2, `onCloseRequested` fires for every close
 * vector (title-bar X, Cmd+Q / Alt+F4, menu quit, …) and lets us veto by
 * calling `event.preventDefault()`. The native OS confirm would happen
 * before this if we didn't preventDefault, so the guard has to run first
 * and then decide whether to destroy the window itself.
 *
 * Flow:
 *   - Clean drawing → return, let the default close proceed.
 *   - Dirty drawing → preventDefault, show three-way modal:
 *       • Speichern → run interactive save; proceed to close only on success.
 *       • Verwerfen → close immediately without saving.
 *       • Abbrechen / Escape / backdrop → stay open.
 *
 * `destroy()` is the right call on Tauri 2 — it bypasses the close-requested
 * listener (otherwise we'd re-enter this handler), terminates the window,
 * and (since this is the only window) ends the process.
 */
async function installCloseGuard(): Promise<void> {
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const win = getCurrentWindow();
    await win.onCloseRequested(async (event) => {
      if (!isDirty()) return; // Nothing unsaved — let Tauri close normally.
      event.preventDefault();
      const choice = await showUnsavedChangesPrompt({
        title: 'Ungespeicherte Änderungen',
        message: 'Die Zeichnung enthält Änderungen, die noch nicht gespeichert wurden.',
        saveText: 'Speichern',
        discardText: 'Verwerfen',
        cancelText: 'Abbrechen',
      });
      if (choice === 'cancel') return;
      if (choice === 'save') {
        const result = await saveJsonInteractive();
        // If the user cancelled the save dialog or an error bubbled up,
        // don't close — they still have unsaved work. `saveJsonInteractive`
        // already toasted the error if any.
        if (result !== 'saved') return;
      }
      // 'discard' or a completed 'save' → tear the window down. `destroy`
      // skips the onCloseRequested listener so we don't loop here.
      await win.destroy();
    });
  } catch (err) {
    // If the window plugin isn't available we fall back to the default OS
    // close behaviour — not great, but better than crashing the bridge.
    // eslint-disable-next-line no-console
    console.warn('[tauri-bridge] failed to install close guard:', err);
  }
}
