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
}
