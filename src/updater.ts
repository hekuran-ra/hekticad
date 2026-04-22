/**
 * Auto-update bootstrap for the Tauri desktop build.
 *
 * Called once from main.ts at startup. When the page is running inside a Tauri
 * window, this checks the configured updater endpoint (see
 * `src-tauri/tauri.conf.json → plugins.updater.endpoints`) and, if a newer
 * version is published on GitHub Releases, asks the user whether to install
 * it right now. On confirmation the binary is downloaded, the installer runs,
 * and the app is relaunched — no manual re-download, no visiting the repo.
 *
 * In plain-browser mode (vite dev server, Infomaniak-hosted build, GitHub
 * Pages, etc.) the `@tauri-apps/api/core` import resolves to a stub where
 * `isTauri()` returns false, so this becomes a no-op. That keeps the web
 * bundle shippable without the Tauri runtime.
 *
 * Errors are surfaced as native dialogs so a user on a shipped build can tell
 * the difference between "no update available" and "update check failed" —
 * critical for debugging the release pipeline end-to-end.
 */

export async function checkForUpdatesOnStartup(): Promise<void> {
  // Lazy-load so the Tauri packages are only fetched in the desktop build —
  // Vite tree-shakes them out of the web bundle when this path isn't taken.
  let isTauri: () => boolean;
  try {
    ({ isTauri } = await import('@tauri-apps/api/core'));
  } catch {
    return;
  }
  if (!isTauri()) return;

  type DlgOpts = { title?: string; kind?: 'info' | 'warning' | 'error' };
  let showDialog: (msg: string, opts?: DlgOpts) => Promise<void>;
  let askDialog: (msg: string, opts?: DlgOpts) => Promise<boolean>;
  try {
    const dialog = await import('@tauri-apps/plugin-dialog');
    showDialog = async (msg, opts) => { await dialog.message(msg, opts); };
    askDialog = (msg, opts) => dialog.ask(msg, opts);
  } catch {
    // Fallback to browser dialogs if the plugin isn't available.
    showDialog = async (msg) => { window.alert(msg); };
    askDialog = async (msg) => window.confirm(msg);
  }

  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    const { relaunch } = await import('@tauri-apps/plugin-process');

    const update = await check();
    if (!update) {
      // Nothing to do — silent on the happy path so we don't nag on every launch.
      return;
    }

    const proceed = await askDialog(
      `HektikCad ${update.version} ist verfügbar.\n` +
      `(Installiert: ${update.currentVersion})\n\n` +
      `Jetzt herunterladen und installieren? Die App startet danach neu.`,
      { title: 'Update verfügbar', kind: 'info' },
    );
    if (!proceed) return;

    await update.downloadAndInstall();
    await relaunch();
  } catch (err) {
    // Surface failures so the user (and we, while debugging the pipeline) can
    // see *why* the updater didn't offer an install — silent console.warn is
    // invisible in a release build with no devtools.
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.warn('[updater] check failed:', err);
    try {
      await showDialog(
        `Update-Prüfung fehlgeschlagen:\n\n${detail}`,
        { title: 'HektikCad Updater', kind: 'warning' },
      );
    } catch {
      // Dialog plugin itself could fail — don't crash startup.
    }
  }
}
