/**
 * Auto-update bootstrap for the Tauri desktop build.
 *
 * Two entry points:
 *  - `checkForUpdatesOnStartup()` — called once from main.ts at launch.
 *     Silent on the happy path (no nag when already up-to-date).
 *  - `checkForUpdatesManually()` — wired to the "Auf Updates prüfen…" menu
 *     entry. Always confirms the outcome to the user: offers the update,
 *     says "you're on the latest version", or surfaces the error.
 *
 * When the page is running inside a Tauri window, both check the configured
 * updater endpoint (see `src-tauri/tauri.conf.json → plugins.updater.endpoints`)
 * and — if a newer version is published on GitHub Releases — ask the user
 * whether to install it right now. On confirmation the binary is downloaded,
 * the installer runs, and the app is relaunched.
 *
 * In plain-browser mode (vite dev, static hosting) the `@tauri-apps/api/core`
 * import resolves to a stub where `isTauri()` returns false, so both functions
 * become no-ops. That keeps the web bundle shippable without the Tauri runtime.
 */

type DlgKind = 'info' | 'warning' | 'error';
type DlgOpts = { title?: string; kind?: DlgKind };

interface DialogApi {
  showDialog: (msg: string, opts?: DlgOpts) => Promise<void>;
  askDialog: (msg: string, opts?: DlgOpts) => Promise<boolean>;
}

async function loadDialogApi(): Promise<DialogApi> {
  try {
    const dialog = await import('@tauri-apps/plugin-dialog');
    return {
      showDialog: async (msg, opts) => { await dialog.message(msg, opts); },
      askDialog: (msg, opts) => dialog.ask(msg, opts),
    };
  } catch {
    return {
      showDialog: async (msg) => { window.alert(msg); },
      askDialog: async (msg) => window.confirm(msg),
    };
  }
}

async function isTauriEnv(): Promise<boolean> {
  try {
    const { isTauri } = await import('@tauri-apps/api/core');
    return isTauri();
  } catch {
    return false;
  }
}

async function runUpdateFlow(showUpToDateMessage: boolean): Promise<void> {
  if (!(await isTauriEnv())) return;
  const { showDialog, askDialog } = await loadDialogApi();

  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    const { relaunch } = await import('@tauri-apps/plugin-process');
    const { getVersion } = await import('@tauri-apps/api/app');

    const update = await check();
    if (!update) {
      if (showUpToDateMessage) {
        const current = await getVersion().catch(() => 'aktuelle Version');
        await showDialog(
          `Du verwendest bereits die neueste Version (${current}).`,
          { title: 'HektikCad Updater', kind: 'info' },
        );
      }
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
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    // eslint-disable-next-line no-console
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

/** Silent on "already latest"; only speaks up if there's an update or an error. */
export function checkForUpdatesOnStartup(): Promise<void> {
  return runUpdateFlow(false);
}

/** Triggered by the "Auf Updates prüfen…" menu item — always confirms outcome. */
export function checkForUpdatesManually(): Promise<void> {
  return runUpdateFlow(true);
}
