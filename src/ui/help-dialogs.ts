/**
 * Hilfe menu dialogs — "Über HektikCad" only.
 *
 * The Tastenkürzel-Übersicht moved to Einstellungen → Tastenkürzel… where
 * the user can now also remap tool keys (see `ui/shortcuts-settings.ts`).
 * The old read-only dialog and its static `SHORTCUT_GROUPS` list are kept
 * below but are NOT wired into any menu — left in place as a reference for
 * the system-shortcut portion (now lives in `SYSTEM_GROUPS` of the new
 * dialog) so a diff-y comparison stays easy during the transition. If we
 * confirm the new dialog fully replaces this one by the next release, the
 * `showShortcutsDialog` export and `SHORTCUT_GROUPS` can be deleted.
 */

import { openModal } from '../modal';

type ShortcutRow = { keys: string; description: string };
type ShortcutGroup = { title: string; rows: ShortcutRow[] };

const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: 'Datei',
    rows: [
      { keys: 'Strg+S',       description: 'Zeichnung speichern' },
      { keys: 'Strg+Shift+E', description: 'Exportieren…' },
      { keys: 'Strg+Shift+I', description: 'Importieren…' },
    ],
  },
  {
    title: 'Bearbeiten',
    rows: [
      { keys: 'Strg+Z',       description: 'Rückgängig' },
      { keys: 'Strg+Y',       description: 'Wiederherstellen' },
      { keys: 'Strg+A',       description: 'Alles auswählen' },
      { keys: 'Entf',         description: 'Auswahl löschen' },
      { keys: 'Esc',          description: 'Werkzeug / Auswahl abbrechen' },
    ],
  },
  {
    title: 'Ansicht',
    rows: [
      { keys: 'Home',            description: 'Alles zoomen' },
      { keys: 'Leertaste+Ziehen', description: 'Pan (Verschieben)' },
      { keys: 'Mausrad',         description: 'Zoom' },
      { keys: 'F7',              description: 'Raster anzeigen' },
      { keys: 'F9',              description: 'Am Raster fangen' },
    ],
  },
  {
    title: 'Werkzeuge',
    rows: [
      { keys: 'L',   description: 'Linie' },
      { keys: 'Y',   description: 'Polylinie' },
      { keys: 'R',   description: 'Rechteck' },
      { keys: 'C',   description: 'Kreis' },
      { keys: 'T',   description: 'Text' },
      { keys: 'D',   description: 'Bemaßung' },
      { keys: 'H',   description: 'Hilfslinie' },
      { keys: 'V',   description: 'Verschieben' },
      { keys: 'J',   description: 'Kopieren' },
      { keys: 'O',   description: 'Drehen' },
      { keys: 'M',   description: 'Spiegeln' },
      { keys: 'B',   description: 'Stutzen' },
      { keys: 'U',   description: 'Versatz' },
    ],
  },
  {
    title: 'Sonstiges',
    rows: [
      { keys: 'Umschalt (halten)', description: 'Ortho / 15°-Snap beim Zeichnen' },
      { keys: 'Alt+Ziehen',        description: 'Auswahl duplizieren' },
      { keys: 'Enter',             description: 'Letztes Werkzeug erneut starten' },
      { keys: 'Rechtsklick',       description: 'Werkzeug abbrechen' },
    ],
  },
];

export async function showShortcutsDialog(): Promise<void> {
  await openModal((close) => {
    const panel = document.createElement('div');
    panel.classList.add('hk-modal-help');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-labelledby', 'hk-shortcuts-title');

    const head = document.createElement('div');
    head.className = 'hk-modal-head';
    const title = document.createElement('div');
    title.className = 'hk-modal-title';
    title.id = 'hk-shortcuts-title';
    title.textContent = 'Tastenkürzel-Übersicht';
    head.appendChild(title);
    panel.appendChild(head);

    const body = document.createElement('div');
    body.className = 'hk-modal-body hk-help-body';

    for (const group of SHORTCUT_GROUPS) {
      const section = document.createElement('div');
      section.className = 'hk-help-section';
      const h = document.createElement('div');
      h.className = 'hk-export-section-label';
      h.textContent = group.title;
      section.appendChild(h);

      const table = document.createElement('div');
      table.className = 'hk-help-table';
      for (const row of group.rows) {
        const rowEl = document.createElement('div');
        rowEl.className = 'hk-help-row';
        const kbd = document.createElement('span');
        kbd.className = 'hk-help-kbd';
        kbd.textContent = row.keys;
        const desc = document.createElement('span');
        desc.className = 'hk-help-desc';
        desc.textContent = row.description;
        rowEl.append(kbd, desc);
        table.appendChild(rowEl);
      }
      section.appendChild(table);
      body.appendChild(section);
    }
    panel.appendChild(body);

    const actions = document.createElement('div');
    actions.className = 'hk-modal-actions';
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'hk-modal-btn hk-modal-btn-primary';
    ok.textContent = 'Schließen';
    ok.addEventListener('click', () => close('ok'));
    actions.appendChild(ok);
    panel.appendChild(actions);

    queueMicrotask(() => ok.focus());
    return panel;
  });
}

export async function showAboutDialog(): Promise<void> {
  await openModal((close) => {
    const panel = document.createElement('div');
    panel.classList.add('hk-modal-about');

    const head = document.createElement('div');
    head.className = 'hk-modal-head';
    const title = document.createElement('div');
    title.className = 'hk-modal-title';
    title.textContent = 'Über HektikCad';
    head.appendChild(title);
    panel.appendChild(head);

    const body = document.createElement('div');
    body.className = 'hk-modal-body';

    const p1 = document.createElement('div');
    p1.className = 'hk-modal-msg';
    p1.textContent = 'HektikCad — Ein schlanker, paramterisierbarer 2D-CAD-Editor im Browser.';
    body.appendChild(p1);

    const p2 = document.createElement('div');
    p2.className = 'hk-modal-msg';
    p2.textContent = 'Export: PDF, DXF R12, EPS, SVG. Einheiten: Millimeter.';
    body.appendChild(p2);

    panel.appendChild(body);

    const actions = document.createElement('div');
    actions.className = 'hk-modal-actions';
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'hk-modal-btn hk-modal-btn-primary';
    ok.textContent = 'OK';
    ok.addEventListener('click', () => close('ok'));
    actions.appendChild(ok);
    panel.appendChild(actions);

    queueMicrotask(() => ok.focus());
    return panel;
  });
}
