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

  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    const { relaunch } = await import('@tauri-apps/plugin-process');

    const update = await check();
    if (!update) return;

    const proceed = window.confirm(
      `HektikCad ${update.version} ist verfügbar.\n` +
      `(Installiert: ${update.currentVersion})\n\n` +
      `Jetzt herunterladen und installieren? Die App startet danach neu.`,
    );
    if (!proceed) return;

    await update.downloadAndInstall();
    await relaunch();
  } catch (err) {
    // Never let an updater glitch prevent the app from starting. Log and move
    // on — worst case the user keeps running the current version for another
    // session and the next launch tries again.
    console.warn('[updater] check failed:', err);
  }
}
