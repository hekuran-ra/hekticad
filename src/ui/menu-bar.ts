/**
 * Application menu bar (Datei · Bearbeiten · Ansicht · Einfügen · Format · Hilfe).
 *
 * Behaviour mirrors a classic desktop-app menu:
 *  - Click a menu item to open its dropdown
 *  - Hover a sibling menu item while one is open to switch to it
 *  - Click outside or press Escape to close
 *  - Click a dropdown item to fire its action (and close the menu)
 *  - Keyboard: ArrowUp/ArrowDown move focus, Enter activates, Escape closes
 *
 * The menu contents are described declaratively below (`MENUS`). Each entry
 * has either an `action` (function to run) or is `'separator'`. Items can
 * provide a `shortcut` string shown on the right-hand side, and an optional
 * `disabled()` predicate — evaluated at open-time — for items that should
 * grey out (e.g. Redo when there's nothing to redo).
 *
 * Keeping the menu wiring here (rather than inline in main.ts) lets the
 * actions stay discoverable and avoids scattering dozens of IDs through the
 * HTML. The menu bar is the main "discovery surface" for users who don't
 * know the keyboard shortcuts yet.
 */

import { state } from '../state';
import { clearAll, loadJson, saveJson } from '../io';
import { showExportDialog } from './export-dialog';
import { showCompanySettings } from './company-settings';
import { showDimStyleDialog } from './dim-style-dialog';
import { showAboutDialog } from './help-dialogs';
import { showShortcutsSettingsDialog } from './shortcuts-settings';
import { resetUserDefaultsFlow, saveCurrentAsDefaultFlow } from './user-defaults-dialogs';
import { closeThemePopover, showThemeDialog } from '../themes';
import { cancelTool, getPanelsLocked, resetToolOrder, setPanelsLocked, setTool, TOOLS, toolRequiresSelection } from '../tools';
import { undo, redo } from '../undo';
import { toast, updateSelStatus } from '../ui';
import { requestRender } from '../render';
import { runtime } from '../state';
import { zoomFit } from '../view';
import { getShortcutKey } from '../shortcuts';

type MenuAction = () => void | Promise<void>;
type MenuEntry =
  | 'separator'
  | {
      /**
       * Stable command id of the form "{menu}:{verb}" — e.g. `datei:neu`,
       * `bearbeiten:undo`. The native macOS menu bar built in Rust emits
       * this id when the item is picked, and the frontend dispatches back
       * to `action()` via `runMenuCommand(id)`. Must match the id used in
       * `src-tauri/src/lib.rs`.
       */
      id: string;
      label: string;
      /**
       * Right-hand shortcut label in the dropdown. Either a static string
       * (for system chords like `Strg+S` that never change) or a getter
       * resolved at open-time — used for tool-activation items so the menu
       * stays in sync with the current tool key (including any user override
       * from Einstellungen → Tastenkürzel). Without the getter, hard-coding
       * the letter here risks drift: if the tool table remaps a key (e.g.
       * Polylinie Y → P) the menu would keep showing the stale letter.
       */
      shortcut?: string | (() => string);
      action: MenuAction;
      disabled?: () => boolean;
      /**
       * When present, the dropdown prefixes the label with "✓ " at open-time
       * whenever this predicate returns true. Used for toggle-style entries
       * (design preset, panel lock, etc.) so the user can see current state
       * without opening a sub-dialog.
       */
      checked?: () => boolean;
    };

type MenuId = 'datei' | 'bearbeiten' | 'ansicht' | 'einfuegen' | 'format' | 'hilfe';

// ────────────────────────────────────────────────────────────────────────────
// Action helpers
// ────────────────────────────────────────────────────────────────────────────

function selectAllUnlocked(): void {
  state.selection.clear();
  for (const ent of state.entities) {
    if (!state.layers[ent.layer]?.locked) state.selection.add(ent.id);
  }
  updateSelStatus();
  requestRender();
}

function deselectAll(): void {
  cancelTool();
}

function zoomBy(factor: number): void {
  state.view.scale = Math.max(0.01, Math.min(2000, state.view.scale * factor));
  requestRender();
}

function toggleGrid(): void {
  runtime.snapSettings.showGrid = !runtime.snapSettings.showGrid;
  // Keep the floating snap-toolbar visuals in sync.
  document.getElementById('tb-raster')?.classList.toggle('on', runtime.snapSettings.showGrid);
  requestRender();
}

function toggleGridSnap(): void {
  runtime.snapSettings.grid = !runtime.snapSettings.grid;
  document.getElementById('tb-gridsnap')?.classList.toggle('on', runtime.snapSettings.grid);
  requestRender();
}

function activateTool(id: string): void {
  if (toolRequiresSelection(id) && state.selection.size === 0) {
    toast('Erst Objekte wählen');
    return;
  }
  const def = TOOLS.find(t => t.id === id);
  if (!def) return;
  setTool(def.id as Parameters<typeof setTool>[0]);
}

/**
 * Resolve the current effective shortcut for a tool id, honouring any user
 * override. Returns an empty string if the tool doesn't exist (so the menu
 * simply renders without an accelerator chip rather than showing "undefined").
 * Used by the insert-menu entries below — keeping the resolution in one place
 * means the menu, the rail tooltip and the keydown matcher all draw from the
 * same source of truth and can't drift out of sync.
 */
function toolShortcutLabel(toolId: string): string {
  const def = TOOLS.find(t => t.id === toolId);
  if (!def) return '';
  return getShortcutKey(String(def.id), def.key);
}

// Stub — wired up when the import dialog lands in a later phase. Until then,
// the menu item and header button both call this and show a placeholder toast.
function showImportDialogStub(): void {
  toast('Import-Dialog kommt in einer späteren Phase');
}

export function showImportDialog(): void {
  showImportDialogStub();
}

// ────────────────────────────────────────────────────────────────────────────
// Menu contents
// ────────────────────────────────────────────────────────────────────────────

const MENUS: Record<MenuId, { label: string; entries: MenuEntry[] }> = {
  datei: {
    label: 'Datei',
    entries: [
      { id: 'file:new',      label: 'Neu',          shortcut: '',             action: () => { void clearAll(); } },
      { id: 'file:open',     label: 'Öffnen…',      shortcut: '',             action: () => { void loadJson(); } },
      { id: 'file:save',     label: 'Speichern',    shortcut: 'Strg+S',       action: () => saveJson() },
      'separator',
      { id: 'file:import',   label: 'Importieren…', shortcut: 'Strg+Shift+I', action: () => showImportDialogStub() },
      { id: 'file:export',   label: 'Exportieren…', shortcut: 'Strg+Shift+E', action: () => { void showExportDialog(); } },
      'separator',
      { id: 'file:clear',    label: 'Alles löschen',                          action: () => { void clearAll(); } },
    ],
  },
  bearbeiten: {
    label: 'Bearbeiten',
    entries: [
      { id: 'edit:undo',       label: 'Rückgängig',       shortcut: 'Strg+Z',       action: () => undo() },
      { id: 'edit:redo',       label: 'Wiederherstellen', shortcut: 'Strg+Y',       action: () => redo() },
      'separator',
      { id: 'edit:select-all', label: 'Alles auswählen',  shortcut: 'Strg+A',       action: () => selectAllUnlocked() },
      { id: 'edit:deselect',   label: 'Auswahl aufheben', shortcut: 'Esc',          action: () => deselectAll() },
    ],
  },
  ansicht: {
    label: 'Ansicht',
    entries: [
      { id: 'view:zoom-fit', label: 'Alles zoomen',    shortcut: 'Home', action: () => zoomFit() },
      { id: 'view:zoom-in',  label: 'Vergrößern',      shortcut: '',     action: () => zoomBy(1.25) },
      { id: 'view:zoom-out', label: 'Verkleinern',     shortcut: '',     action: () => zoomBy(1 / 1.25) },
      'separator',
      { id: 'view:toggle-grid', label: 'Raster anzeigen',  shortcut: 'F7', action: () => toggleGrid(),
        checked: () => runtime.snapSettings.showGrid },
      { id: 'view:toggle-snap', label: 'Am Raster fangen', shortcut: 'F9', action: () => toggleGridSnap(),
        checked: () => runtime.snapSettings.grid },
    ],
  },
  einfuegen: {
    label: 'Einfügen',
    entries: [
      // Shortcut labels resolve at open-time from the live tool table so a
      // remap (factory default or user override) shows up here without hand-
      // edits. Previously the literals drifted — Polylinie showed `Y` long
      // after the tool moved to `P`, making it look like Y was bound twice
      // (extend_to on the rail AND Polylinie in the menu).
      { id: 'insert:line',     label: 'Linie',      shortcut: () => toolShortcutLabel('line'),     action: () => activateTool('line') },
      { id: 'insert:polyline', label: 'Polylinie',  shortcut: () => toolShortcutLabel('polyline'), action: () => activateTool('polyline') },
      { id: 'insert:rect',     label: 'Rechteck',   shortcut: () => toolShortcutLabel('rect'),     action: () => activateTool('rect') },
      { id: 'insert:circle',   label: 'Kreis',      shortcut: () => toolShortcutLabel('circle'),   action: () => activateTool('circle') },
      { id: 'insert:text',     label: 'Text',       shortcut: () => toolShortcutLabel('text'),     action: () => activateTool('text') },
      { id: 'insert:dim',      label: 'Bemaßung',   shortcut: () => toolShortcutLabel('dim'),      action: () => activateTool('dim') },
      { id: 'insert:xline',    label: 'Hilfslinie', shortcut: () => toolShortcutLabel('xline'),    action: () => activateTool('xline') },
    ],
  },
  format: {
    // Display label: "Einstellungen". Internal id stays `format` so the
    // menu-bar data-menu attribute and MenuId enum don't have to change.
    label: 'Einstellungen',
    entries: [
      { id: 'settings:theme', label: 'Design…', action: () => { void showThemeDialog(); } },
      'separator',
      { id: 'settings:company',   label: 'Firmeneinstellungen…', action: () => { void showCompanySettings(); } },
      { id: 'settings:dim-style', label: 'Bemaßungsstil…',       action: () => { void showDimStyleDialog(); } },
      'separator',
      // Toggle entry — ✓ prefix when locked. Locking prevents palette headers
      // from being dragged and tool buttons from being reordered; click-to-
      // activate and right-click menus still work.
      { id: 'settings:lock-panels', label: 'Toolgruppen sperren',
        action: () => setPanelsLocked(!getPanelsLocked()),
        checked: () => getPanelsLocked() },
      { id: 'settings:reset-tools', label: 'Toolgruppen zurücksetzen', action: () => resetToolOrder() },
      'separator',
      // Capture the current layout + layers + snap + (optionally) drawing as
      // the user's personal default. Applied at next startup via
      // applyUserDefaultsAtStartup(). Separate from the factory baseline so
      // "zurücksetzen" falls back cleanly.
      { id: 'settings:save-default',  label: 'Aktuellen Zustand als Standard speichern…',
        action: () => { void saveCurrentAsDefaultFlow(); } },
      { id: 'settings:reset-default', label: 'Eigenen Standard zurücksetzen',
        action: () => { void resetUserDefaultsFlow(); } },
      'separator',
      // Editable tool-key bindings. Moved from the old Hilfe → Übersicht
      // (read-only) so power users can remap single-key shortcuts (L, R, C, …)
      // from one place that also functions as the up-to-date reference.
      { id: 'settings:shortcuts', label: 'Tastenkürzel…',
        action: () => { void showShortcutsSettingsDialog(); } },
      // Developer-only export of the bundled defaults file lives in
      // `exportBundledDefaultsFlow` (src/ui/user-defaults-dialogs.ts). It's
      // intentionally NOT wired into the menu — end users shouldn't see it.
      // To regenerate `src/bundled-defaults.json` for a new build, re-add an
      // entry here that calls the flow, export, commit the JSON, then revert.
    ],
  },
  hilfe: {
    label: 'Hilfe',
    entries: [
      // The Tastenkürzel entry moved to Einstellungen → Tastenkürzel… because
      // that dialog is now editable (not just a read-only list). Leaving
      // "Über HektikCad" as Hilfe's sole entry for now; future entries (Log
      // öffnen, Bug melden, …) can rejoin here.
      { id: 'help:about',     label: 'Über HektikCad',         action: () => { void showAboutDialog(); } },
    ],
  },
};

// ────────────────────────────────────────────────────────────────────────────
// Command dispatch for the native macOS menu
// ────────────────────────────────────────────────────────────────────────────
//
// The Rust side (see `src-tauri/src/lib.rs`) builds a NSMenu mirroring the
// `MENUS` structure above, using the same ids. When the user picks a native
// menu item, Rust emits an `app-menu-command` event; `src/main.ts` listens
// for it and calls `runMenuCommand(id)`, which re-enters the same action
// function the in-app dropdown would have called. Single source of truth.
//
// Unknown ids are silently ignored — a stale Rust menu (e.g. during a
// version-skew between binary and frontend) won't crash the app.

export function runMenuCommand(id: string): void {
  for (const menu of Object.values(MENUS)) {
    for (const entry of menu.entries) {
      if (entry === 'separator') continue;
      if (entry.id === id) {
        if (entry.disabled && entry.disabled()) return;
        void entry.action();
        return;
      }
    }
  }
  // eslint-disable-next-line no-console
  console.warn(`[menu] unknown command id "${id}"`);
}

// ────────────────────────────────────────────────────────────────────────────
// Runtime: open/close/render the dropdown
// ────────────────────────────────────────────────────────────────────────────

let activeMenuId: MenuId | null = null;
let popoverEl: HTMLElement | null = null;

function getPopover(): HTMLElement {
  if (popoverEl) return popoverEl;
  const el = document.getElementById('menu-popover');
  if (!el) throw new Error('#menu-popover missing from index.html');
  popoverEl = el;
  return el;
}

function closeMenu(): void {
  if (!activeMenuId) return;
  const pop = getPopover();
  pop.hidden = true;
  pop.innerHTML = '';
  document.querySelectorAll<HTMLElement>('.menu-item.active')
    .forEach(el => el.classList.remove('active'));
  activeMenuId = null;
}

function openMenu(id: MenuId): void {
  // Opening the same menu that's already open means the user clicked the
  // title again → toggle closed, like a real menu bar.
  if (activeMenuId === id) { closeMenu(); return; }
  closeMenu();

  const trigger = document.querySelector<HTMLElement>(`.menu-item[data-menu="${id}"]`);
  if (!trigger) return;
  trigger.classList.add('active');

  const pop = getPopover();
  pop.innerHTML = '';
  pop.hidden = false;

  const def = MENUS[id];
  for (const entry of def.entries) {
    if (entry === 'separator') {
      const sep = document.createElement('div');
      sep.className = 'menu-dropdown-sep';
      pop.appendChild(sep);
      continue;
    }
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'menu-dropdown-item';
    if (entry.disabled && entry.disabled()) item.classList.add('disabled');

    const label = document.createElement('span');
    label.className = 'menu-dropdown-label';
    const checked = entry.checked ? entry.checked() : false;
    label.textContent = checked ? `✓ ${entry.label}` : entry.label;
    item.appendChild(label);

    // `shortcut` is either a literal string (for static system chords like
    // `Strg+S`) or a getter for items whose accelerator is derived from the
    // live tool table. Resolving on each open keeps the displayed letter in
    // sync with user overrides from Einstellungen → Tastenkürzel.
    const shortcutText = typeof entry.shortcut === 'function'
      ? entry.shortcut()
      : entry.shortcut;
    if (shortcutText) {
      const sc = document.createElement('span');
      sc.className = 'menu-dropdown-shortcut';
      sc.textContent = shortcutText;
      item.appendChild(sc);
    }

    item.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (item.classList.contains('disabled')) return;
      // Close FIRST so actions that open their own modal/popover don't
      // receive a stale "click outside" event that immediately closes them.
      closeMenu();
      void entry.action();
    });
    pop.appendChild(item);
  }

  // Position the popover directly under the trigger, left-aligned.
  const r = trigger.getBoundingClientRect();
  pop.style.top = `${Math.round(r.bottom + 2)}px`;
  pop.style.left = `${Math.round(r.left)}px`;
  pop.style.right = 'auto';

  activeMenuId = id;
}

// ────────────────────────────────────────────────────────────────────────────
// Public init
// ────────────────────────────────────────────────────────────────────────────

export function initMenuBar(): void {
  const bar = document.getElementById('menu-bar');
  if (!bar) return;

  bar.querySelectorAll<HTMLElement>('.menu-item').forEach(btn => {
    const id = btn.dataset.menu as MenuId | undefined;
    if (!id || !MENUS[id]) return;

    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      // Opening a menu implicitly closes the theme popover, so it doesn't
      // linger under the new dropdown.
      closeThemePopover();
      openMenu(id);
    });

    // When any menu is already open, hovering a sibling title switches to it —
    // standard desktop menu-bar affordance.
    btn.addEventListener('mouseenter', () => {
      if (activeMenuId && activeMenuId !== id) openMenu(id);
    });
  });

  // Click outside the menu or popover → close.
  document.addEventListener('mousedown', (ev) => {
    if (!activeMenuId) return;
    const target = ev.target as Node | null;
    if (!target) return;
    if (getPopover().contains(target)) return;
    if (bar.contains(target)) return;
    closeMenu();
  });

  // Escape closes the menu.
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && activeMenuId) {
      ev.stopPropagation();
      closeMenu();
    }
  });
}
