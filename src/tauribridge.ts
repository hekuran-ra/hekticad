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
import { saveJsonInteractive } from './io';
import { showUnsavedChangesPrompt } from './modal';

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

  await installCloseGuard();
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
