/**
 * Einstellungen → Tastenkürzel — customise single-key tool shortcuts.
 *
 * Replaces the read-only "Tastenkürzel-Übersicht" that used to live under
 * Hilfe. Every tool's shortcut is rendered as an editable single-char input;
 * typing a letter or digit and blurring commits it through `setShortcutKey`,
 * persisting to localStorage. System chords (Strg+S, Esc, …) are shown below
 * as a read-only reference — they stay OS-convention-bound and can't be
 * remapped in v1.
 *
 * A "Zurücksetzen" button clears every override at once. The dialog redraws
 * itself on `onShortcutsChange` so the reset is visible without re-opening.
 *
 * Conflicts: if the user binds a key that another tool already uses, we
 * warn inline but still commit — the main keydown handler walks TOOLS and
 * returns the first match, so a conflicting binding just means the later
 * tool in the list wins. Surfacing the warning rather than blocking lets
 * power users deliberately overlap (e.g. re-map a tool they don't use and
 * inherit the key for one they do).
 */

import { openModal } from '../modal';
import { TOOLS } from '../tools';
import type { ToolDef } from '../tools';
import {
  getAllOverrides, getShortcutKey, hasOverride, onShortcutsChange,
  resetShortcuts, setShortcutKey,
} from '../shortcuts';

type SystemRow = { keys: string; description: string };

// Grouped for readability; order mirrors the rail's group order in tools.ts.
const TOOL_GROUP_LABELS: Record<string, string> = {
  pointer:    'Zeiger',
  guide:      'Hilfen',
  construct:  'Zeichnen',
  annot:      'Beschriftung',
  modify:     'Ändern',
};

// Built-in non-remappable shortcuts. Synced by hand with the main.ts keydown
// handler + menu accelerators so the user sees the full map in one place.
const SYSTEM_GROUPS: { title: string; rows: SystemRow[] }[] = [
  { title: 'Datei', rows: [
    { keys: 'Strg+S',       description: 'Zeichnung speichern' },
    { keys: 'Strg+Shift+E', description: 'Exportieren…' },
    { keys: 'Strg+Shift+I', description: 'Importieren…' },
  ]},
  { title: 'Bearbeiten', rows: [
    { keys: 'Strg+Z',       description: 'Rückgängig' },
    { keys: 'Strg+Y',       description: 'Wiederherstellen' },
    { keys: 'Strg+A',       description: 'Alles auswählen' },
    { keys: 'Entf',         description: 'Auswahl löschen' },
    { keys: 'Esc',          description: 'Werkzeug / Auswahl abbrechen' },
  ]},
  { title: 'Ansicht', rows: [
    { keys: 'Home',            description: 'Alles zoomen' },
    { keys: 'Leertaste+Ziehen', description: 'Pan (Verschieben)' },
    { keys: 'Mausrad',         description: 'Zoom' },
  ]},
  { title: 'Sonstiges', rows: [
    { keys: 'Umschalt (halten)', description: 'Ortho / 15°-Snap beim Zeichnen' },
    { keys: 'Alt+Ziehen',        description: 'Auswahl duplizieren' },
    { keys: 'Enter',             description: 'Letztes Werkzeug erneut starten' },
    { keys: 'Rechtsklick',       description: 'Werkzeug abbrechen' },
  ]},
];

export async function showShortcutsSettingsDialog(): Promise<void> {
  await openModal((close) => buildPanel(close));
}

function buildPanel(close: (reason: 'ok' | 'cancel') => void): HTMLElement {
  const panel = document.createElement('div');
  panel.classList.add('hk-modal-help');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-labelledby', 'hk-shortcuts-title');

  // ── Header ──
  const head = document.createElement('div');
  head.className = 'hk-modal-head';
  const title = document.createElement('div');
  title.className = 'hk-modal-title';
  title.id = 'hk-shortcuts-title';
  title.textContent = 'Tastenkürzel anpassen';
  head.appendChild(title);
  const msg = document.createElement('div');
  msg.className = 'hk-modal-msg';
  msg.textContent = 'Klicke in das Tastenfeld und drücke die neue Taste. Leer lassen, um zum Standard zurückzukehren.';
  head.appendChild(msg);
  panel.appendChild(head);

  // ── Body ──
  // Re-rendered in place on override change so the user sees the live state
  // without the dialog flickering closed/open.
  const body = document.createElement('div');
  body.className = 'hk-modal-body hk-help-body';
  panel.appendChild(body);

  const renderBody = (): void => {
    body.innerHTML = '';
    renderToolGroups(body);
    renderSystemGroups(body);
  };
  renderBody();

  // Subscribe so external changes (e.g. reset-all) reflect here without a
  // manual reopen. The listener stays registered for the app's lifetime —
  // harmless because renderBody is idempotent and the dialog reuses `body`
  // when it re-opens. If dialog churn ever becomes a concern, add an
  // off-ramp to the shortcuts module.
  onShortcutsChange(renderBody);

  // ── Actions ──
  const actions = document.createElement('div');
  actions.className = 'hk-modal-actions';

  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'hk-modal-btn';
  reset.textContent = 'Alle zurücksetzen';
  reset.title = 'Jedes benutzerdefinierte Tastenkürzel löschen und zu den HektikCad-Standardbelegungen zurückkehren.';
  reset.addEventListener('click', () => {
    if (Object.keys(getAllOverrides()).length === 0) return;
    resetShortcuts();
  });
  actions.appendChild(reset);

  // Spacer so the OK button sits right-aligned while reset stays on the left.
  const spacer = document.createElement('div');
  spacer.style.flex = '1';
  actions.appendChild(spacer);

  const ok = document.createElement('button');
  ok.type = 'button';
  ok.className = 'hk-modal-btn hk-modal-btn-primary';
  ok.textContent = 'Schließen';
  ok.addEventListener('click', () => close('ok'));
  actions.appendChild(ok);

  panel.appendChild(actions);

  queueMicrotask(() => ok.focus());
  return panel;
}

function renderToolGroups(host: HTMLElement): void {
  const grouped = new Map<string, ToolDef[]>();
  for (const t of TOOLS) {
    if (t.action) continue;      // Löschen etc. — not shortcut-driven in the same way
    if (!t.key) continue;         // Safety guard.
    const arr = grouped.get(t.group) ?? [];
    arr.push(t);
    grouped.set(t.group, arr);
  }
  for (const [groupId, tools] of grouped) {
    const section = document.createElement('div');
    section.className = 'hk-help-section';
    const h = document.createElement('div');
    h.className = 'hk-export-section-label';
    h.textContent = TOOL_GROUP_LABELS[groupId] ?? groupId;
    section.appendChild(h);

    const table = document.createElement('div');
    table.className = 'hk-help-table';
    for (const t of tools) table.appendChild(renderToolRow(t));
    section.appendChild(table);
    host.appendChild(section);
  }
}

function renderToolRow(t: ToolDef): HTMLElement {
  const row = document.createElement('div');
  row.className = 'hk-help-row';

  // Editable key field. Styled to match the read-only <kbd>-like rows from
  // the system section so the visual rhythm is consistent.
  const kbd = document.createElement('input');
  kbd.className = 'hk-help-kbd hk-shortcut-input';
  kbd.type = 'text';
  kbd.maxLength = 6;  // allow F1/F10/Del, but mostly single char
  kbd.spellcheck = false;
  kbd.autocomplete = 'off';
  const effective = getShortcutKey(String(t.id), t.key);
  kbd.value = effective;
  kbd.setAttribute('aria-label', `Tastenkürzel für ${t.label}`);
  // keydown: if it's a printable single char, auto-commit. Arrow/Tab keep
  // default nav. Space + backspace do natural editing.
  kbd.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); kbd.blur(); return; }
    if (e.key === 'Escape') {
      e.preventDefault();
      kbd.value = getShortcutKey(String(t.id), t.key);
      kbd.blur();
      return;
    }
    // Single printable character (ignore modifier chords like Ctrl+A):
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      kbd.value = e.key.toUpperCase();
      commitRow(t, kbd);
    }
  });
  kbd.addEventListener('blur', () => commitRow(t, kbd));
  // Select-all on focus so the user just types the new key.
  kbd.addEventListener('focus', () => kbd.select());

  const desc = document.createElement('span');
  desc.className = 'hk-help-desc';
  desc.textContent = t.label;

  const note = document.createElement('span');
  note.className = 'hk-shortcut-note';
  if (hasOverride(String(t.id))) {
    note.textContent = `Standard: ${t.key}`;
  }

  // Conflict check: is another tool using the same effective key right now?
  const eff = effective.toLowerCase();
  const conflicts = TOOLS.filter(other =>
    other.id !== t.id && !other.action
    && getShortcutKey(String(other.id), other.key).toLowerCase() === eff,
  );
  if (conflicts.length > 0) {
    const warn = document.createElement('span');
    warn.className = 'hk-shortcut-conflict';
    warn.textContent = `⚠ Konflikt mit ${conflicts.map(c => c.label).join(', ')}`;
    row.append(kbd, desc, note, warn);
  } else {
    row.append(kbd, desc, note);
  }
  return row;
}

function commitRow(t: ToolDef, kbd: HTMLInputElement): void {
  const val = kbd.value.trim();
  const current = getShortcutKey(String(t.id), t.key);
  if (val === current) return;                  // no-op — avoid listener churn
  if (val === t.key) setShortcutKey(String(t.id), '');  // match default → clear override
  else                setShortcutKey(String(t.id), val);
}

function renderSystemGroups(host: HTMLElement): void {
  const divider = document.createElement('div');
  divider.className = 'hk-export-section-label';
  divider.style.marginTop = '20px';
  divider.textContent = 'System (nicht anpassbar)';
  host.appendChild(divider);

  for (const group of SYSTEM_GROUPS) {
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
    host.appendChild(section);
  }
}
