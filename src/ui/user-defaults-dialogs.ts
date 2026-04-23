/**
 * Dialogs for the "Aktueller Zustand als Standard" feature. The save flow
 * asks the user whether they want the current drawing (features / entities /
 * parameters) baked into the snapshot, or just the layout + layers + snap
 * settings. Reset is a simple confirm.
 */
import { openModal, showAlert, showConfirm } from '../modal';
import { state } from '../state';
import { toast } from '../ui';
import { saveBlobViaDialog } from '../io';
import {
  clearUserDefaults, exportCurrentAsBundledDefaults,
  hasUserDefaults, saveCurrentAsUserDefaults,
} from '../user-defaults';

type SaveChoice = 'with-drawing' | 'without-drawing' | 'cancel';

async function askIncludeDrawing(): Promise<SaveChoice> {
  // `openModal` resolves to 'ok' | 'cancel' which doesn't carry enough info
  // for our three-way choice, so we stash the selected option in a ref cell
  // that the build callback writes to and the outer `.then` reads.
  const ref: { choice: SaveChoice } = { choice: 'cancel' };
  return new Promise<SaveChoice>((resolve) => {
    void openModal((close) => {

      const panel = document.createElement('div');
      panel.classList.add('hk-modal-about');
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-labelledby', 'hk-save-default-title');

      const head = document.createElement('div');
      head.className = 'hk-modal-head';
      const title = document.createElement('div');
      title.className = 'hk-modal-title';
      title.id = 'hk-save-default-title';
      title.textContent = 'Als Standard speichern';
      head.appendChild(title);
      panel.appendChild(head);

      const body = document.createElement('div');
      body.className = 'hk-modal-body';

      const p1 = document.createElement('div');
      p1.className = 'hk-modal-msg';
      p1.textContent = 'Der aktuelle Zustand wird als Ausgangspunkt für '
        + 'neue HektikCad-Sitzungen gespeichert: Werkzeug-Anordnung, '
        + 'Ebenen, Fang-Optionen und Modus-Flags.';
      body.appendChild(p1);

      const featCount = state.features.length;
      const paramCount = state.parameters.length;
      const p2 = document.createElement('div');
      p2.className = 'hk-modal-msg';
      if (featCount > 0 || paramCount > 0) {
        p2.textContent = `Möchtest du die aktuelle Zeichnung `
          + `(${featCount} Feature${featCount === 1 ? '' : 's'}, `
          + `${paramCount} Variable${paramCount === 1 ? '' : 'n'}) einschließen?`;
      } else {
        p2.textContent = 'Die Zeichnung ist leer — nur Layout und Ebenen werden gespeichert.';
      }
      body.appendChild(p2);
      panel.appendChild(body);

      const actions = document.createElement('div');
      actions.className = 'hk-modal-actions';

      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'hk-modal-btn';
      cancel.textContent = 'Abbrechen';
      cancel.addEventListener('click', () => { ref.choice ='cancel'; close('cancel'); });
      actions.appendChild(cancel);

      // Only offer "Nur Einstellungen" when there's actually a drawing to
      // exclude — otherwise the two primary buttons would do the same thing.
      if (featCount > 0 || paramCount > 0) {
        const withoutDrawing = document.createElement('button');
        withoutDrawing.type = 'button';
        withoutDrawing.className = 'hk-modal-btn';
        withoutDrawing.textContent = 'Nur Einstellungen';
        withoutDrawing.addEventListener('click', () => {
          ref.choice ='without-drawing'; close('ok');
        });
        actions.appendChild(withoutDrawing);
      }

      const withDrawing = document.createElement('button');
      withDrawing.type = 'button';
      withDrawing.className = 'hk-modal-btn hk-modal-btn-primary';
      withDrawing.textContent = (featCount > 0 || paramCount > 0)
        ? 'Mit Zeichnung speichern'
        : 'Speichern';
      withDrawing.addEventListener('click', () => {
        ref.choice =(featCount > 0 || paramCount > 0) ? 'with-drawing' : 'without-drawing';
        close('ok');
      });
      actions.appendChild(withDrawing);

      panel.appendChild(actions);
      queueMicrotask(() => withDrawing.focus());

      return panel;
    }).then(() => resolve(ref.choice));
  });
}

export async function saveCurrentAsDefaultFlow(): Promise<void> {
  const choice = await askIncludeDrawing();
  if (choice === 'cancel') return;
  try {
    saveCurrentAsUserDefaults({ includeDrawing: choice === 'with-drawing' });
    toast(choice === 'with-drawing'
      ? 'Standard gespeichert (inkl. Zeichnung)'
      : 'Standard gespeichert');
  } catch {
    await showAlert({
      title: 'Speichern fehlgeschlagen',
      message: 'Der aktuelle Zustand konnte nicht gespeichert werden. '
        + 'Möglicherweise ist der Speicher voll.',
    });
  }
}

/**
 * Developer-only flow: capture the current state as build-time bundled defaults.
 * The resulting JSON string is saved to disk via the standard save dialog —
 * the developer commits it over `src/bundled-defaults.json` so every future
 * build ships those defaults to new users who haven't saved a personal
 * snapshot. Reuses `askIncludeDrawing` so the developer has the same
 * with/without-drawing choice the regular save flow offers.
 */
export async function exportBundledDefaultsFlow(): Promise<void> {
  const choice = await askIncludeDrawing();
  if (choice === 'cancel') return;
  try {
    const json = exportCurrentAsBundledDefaults({
      includeDrawing: choice === 'with-drawing',
    });
    const blob = new Blob([json], { type: 'application/json' });
    const res = await saveBlobViaDialog(blob, 'bundled-defaults.json');
    if (res.cancelled) return;
    toast('Build-Standard exportiert — nach src/bundled-defaults.json kopieren und committen');
  } catch {
    await showAlert({
      title: 'Export fehlgeschlagen',
      message: 'Der Build-Standard konnte nicht exportiert werden.',
    });
  }
}

export async function resetUserDefaultsFlow(): Promise<void> {
  if (!hasUserDefaults()) {
    toast('Kein eigener Standard gespeichert.');
    return;
  }
  const ok = await showConfirm({
    title: 'Eigenen Standard zurücksetzen?',
    message: 'Ab der nächsten Sitzung gelten wieder die Werks-Einstellungen. '
      + 'Die aktuelle Sitzung bleibt unverändert.',
    okText: 'Zurücksetzen',
    danger: true,
  });
  if (!ok) return;
  clearUserDefaults();
  toast('Eigener Standard entfernt');
}
