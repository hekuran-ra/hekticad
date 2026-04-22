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
import { showAboutDialog, showShortcutsDialog } from './help-dialogs';
import { openThemePopover, closeThemePopover } from '../themes';
import { cancelTool, getPanelsLocked, resetToolOrder, setPanelsLocked, setTool, TOOLS, toolRequiresSelection } from '../tools';
import { undo, redo } from '../undo';
import { toast, updateSelStatus } from '../ui';
import { requestRender } from '../render';
import { runtime } from '../state';
import { zoomFit } from '../view';

type MenuAction = () => void | Promise<void>;
type MenuEntry =
  | 'separator'
  | {
      label: string;
      shortcut?: string;
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
      { label: 'Neu',          shortcut: '',             action: () => { void clearAll(); } },
      { label: 'Öffnen…',      shortcut: '',             action: () => { void loadJson(); } },
      { label: 'Speichern',    shortcut: 'Strg+S',       action: () => saveJson() },
      'separator',
      { label: 'Importieren…', shortcut: 'Strg+Shift+I', action: () => showImportDialogStub() },
      { label: 'Exportieren…', shortcut: 'Strg+Shift+E', action: () => { void showExportDialog(); } },
      'separator',
      { label: 'Alles löschen', action: () => { void clearAll(); } },
    ],
  },
  bearbeiten: {
    label: 'Bearbeiten',
    entries: [
      { label: 'Rückgängig',       shortcut: 'Strg+Z',       action: () => undo() },
      { label: 'Wiederherstellen', shortcut: 'Strg+Y',       action: () => redo() },
      'separator',
      { label: 'Alles auswählen',  shortcut: 'Strg+A',       action: () => selectAllUnlocked() },
      { label: 'Auswahl aufheben', shortcut: 'Esc',          action: () => deselectAll() },
    ],
  },
  ansicht: {
    label: 'Ansicht',
    entries: [
      { label: 'Alles zoomen',    shortcut: 'Home', action: () => zoomFit() },
      { label: 'Vergrößern',      shortcut: '',     action: () => zoomBy(1.25) },
      { label: 'Verkleinern',     shortcut: '',     action: () => zoomBy(1 / 1.25) },
      'separator',
      { label: 'Raster anzeigen',  shortcut: 'F7', action: () => toggleGrid(),
        checked: () => runtime.snapSettings.showGrid },
      { label: 'Am Raster fangen', shortcut: 'F9', action: () => toggleGridSnap(),
        checked: () => runtime.snapSettings.grid },
    ],
  },
  einfuegen: {
    label: 'Einfügen',
    entries: [
      { label: 'Linie',      shortcut: 'L', action: () => activateTool('line') },
      { label: 'Polylinie',  shortcut: 'Y', action: () => activateTool('polyline') },
      { label: 'Rechteck',   shortcut: 'R', action: () => activateTool('rect') },
      { label: 'Kreis',      shortcut: 'C', action: () => activateTool('circle') },
      { label: 'Text',       shortcut: 'T', action: () => activateTool('text') },
      { label: 'Bemaßung',   shortcut: 'D', action: () => activateTool('dim') },
      { label: 'Hilfslinie', shortcut: 'H', action: () => activateTool('xline') },
    ],
  },
  format: {
    // Display label: "Einstellungen". Internal id stays `format` so the
    // menu-bar data-menu attribute and MenuId enum don't have to change.
    label: 'Einstellungen',
    entries: [
      { label: 'Design…', action: () => {
        // Open the theme popover anchored under the Einstellungen menu
        // item. Moved here from Ansicht — conceptually a settings thing.
        const anchor = document.querySelector<HTMLElement>('.menu-item[data-menu="format"]');
        openThemePopover(anchor);
      } },
      'separator',
      { label: 'Firmeneinstellungen…', action: () => { void showCompanySettings(); } },
      { label: 'Bemaßungsstil…',       action: () => { void showDimStyleDialog(); } },
      'separator',
      // Toggle entry — ✓ prefix when locked. Locking prevents palette headers
      // from being dragged and tool buttons from being reordered; click-to-
      // activate and right-click menus still work.
      { label: 'Toolgruppen sperren',
        action: () => setPanelsLocked(!getPanelsLocked()),
        checked: () => getPanelsLocked() },
      { label: 'Toolgruppen zurücksetzen', action: () => resetToolOrder() },
    ],
  },
  hilfe: {
    label: 'Hilfe',
    entries: [
      { label: 'Tastenkürzel-Übersicht', action: () => { void showShortcutsDialog(); } },
      { label: 'Über HektikCad',         action: () => { void showAboutDialog(); } },
    ],
  },
};

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

    if (entry.shortcut) {
      const sc = document.createElement('span');
      sc.className = 'menu-dropdown-shortcut';
      sc.textContent = entry.shortcut;
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
