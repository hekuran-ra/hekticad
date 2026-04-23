/**
 * Current document file binding — which .hcad path on disk the drawing is
 * synced with, and the document name shown in the title bar.
 *
 * Lifecycle:
 *   • Boot                  → null, title shows `${drawingNumber}_zeichnung.hcad`
 *   • Save-As (first save)  → binding set to chosen path, title = basename(path)
 *   • Save (existing path)  → binding unchanged, direct write, no dialog
 *   • Open (OS file event)  → binding = opened path
 *   • Open (browser input)  → binding cleared (no real FS path available)
 *   • Datei → Neu           → binding cleared, drawingNumber auto-advances,
 *                             title falls back to the new numbered default
 *
 * Design: we never store the path in persistent localStorage — a binding is
 * a session-level "where did this drawing last live on disk" cache. Persisting
 * across reloads would mean silently writing to a stale path after the user
 * restarted the app without realising the file binding outlived the process.
 */

import { state } from './state';

let currentFilePath: string | null = null;

/** The absolute filesystem path the drawing is currently bound to, or null
 *  when the drawing is unsaved / was loaded via the browser file input. */
export function getCurrentFilePath(): string | null {
  return currentFilePath;
}

/**
 * Set or clear the binding. Passing null reverts the title to the numbered
 * default. Always triggers a title-bar refresh so the span + native window
 * title stay in sync with the new state.
 */
export function setCurrentFilePath(path: string | null): void {
  currentFilePath = path;
  refreshDocumentTitle();
}

/**
 * Filename to pre-fill in the Save-As dialog for an unsaved drawing. Uses the
 * auto-incrementing Zeichnungs-Nr. from projectMeta so a freshly-opened app
 * suggests `001_zeichnung.hcad`, the next new drawing `002_zeichnung.hcad`
 * etc. — matches what the title bar is already showing, so the user isn't
 * surprised when the OS picker pops up.
 */
export function getDefaultSaveFilename(): string {
  const num = (state.projectMeta.drawingNumber ?? '').trim();
  return num ? `${num}_zeichnung.hcad` : 'zeichnung.hcad';
}

/**
 * Name displayed in the title bar + native window title. Basename of the
 * bound path when we have one, numbered default otherwise.
 */
export function getDocumentDisplayName(): string {
  return currentFilePath ? basename(currentFilePath) : getDefaultSaveFilename();
}

/**
 * Extract the last segment of a path. Tolerant of both separators so a file
 * opened through a Windows build still renders cleanly if its path ever
 * round-trips through a non-Windows display layer (and vice versa).
 */
function basename(p: string): string {
  const m = /[^\\/]+$/.exec(p);
  return m ? m[0] : p;
}

/**
 * Repaint the in-app title-bar span and the native window title. Exposed so
 * code paths that mutate `projectMeta.drawingNumber` (e.g. `clearAll`) can
 * trigger a refresh without touching the file-path state.
 */
export function refreshDocumentTitle(): void {
  const name = getDocumentDisplayName();
  // In-app title bar. Selector uses a stable data-attribute we set in
  // index.html so it survives layout tweaks around the brand area. Missing
  // element is a silent no-op (headless tests, stripped-down embeds).
  const span = document.querySelector<HTMLElement>('.brand-doc span[data-doc-name]');
  if (span) span.textContent = name;
  void syncNativeWindowTitle(name);
}

/** Keep the OS window title (titlebar on Windows/Linux, Dock tooltip/menu on
 *  macOS) in sync with the document name. No-op on non-Tauri runtimes. */
async function syncNativeWindowTitle(name: string): Promise<void> {
  try {
    const core = await import('@tauri-apps/api/core');
    if (!core.isTauri()) return;
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().setTitle(`HektikCad — ${name}`);
  } catch {
    /* ignore — bridge unavailable or API missing at runtime */
  }
}
