/**
 * User-customisable keyboard shortcuts for tool activation.
 *
 * The built-in bindings live on each `ToolDef.key` (see `TOOLS` in tools.ts).
 * This module layers a localStorage-backed override map on top, so a user can
 * swap e.g. `R` (Rechteck) for some other key they find more comfortable
 * without editing source. The main keydown handler in `main.ts` consults
 * `getShortcutKey(toolId)` before matching against the pressed key — defaults
 * are restored when the override for a tool is cleared.
 *
 * We deliberately scope this to single-key tool shortcuts. System chords
 * (Ctrl+S, Ctrl+Z, …) and non-tool actions (Esc, Delete, Space) remain
 * hardcoded: they're too entangled with OS conventions to remap safely in v1.
 * The settings dialog surfaces them read-only so users see the full map.
 */

const STORAGE_KEY = 'hektikcad.shortcuts.v1';

type OverrideMap = Record<string, string>;

let overrides: OverrideMap = load();

function load(): OverrideMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      const out: OverrideMap = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'string' && v.length > 0) out[k] = v;
      }
      return out;
    }
  } catch {
    // Corrupted payload — fall through to defaults. Not worth alerting the
    // user: a bad shortcut override is harmless, just resets to stock.
  }
  return {};
}

function save(): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides)); } catch { /* quota — ignore */ }
}

/**
 * Resolve the active key for a tool. Checks the user override first, falls
 * back to the built-in default passed in. Returns the default verbatim when
 * no override exists (so callers get the same behaviour as before this module
 * was introduced).
 */
export function getShortcutKey(toolId: string, defaultKey: string): string {
  const o = overrides[toolId];
  return (o && o.length > 0) ? o : defaultKey;
}

/** True when the tool currently uses an override (not the built-in default). */
export function hasOverride(toolId: string): boolean {
  return Object.prototype.hasOwnProperty.call(overrides, toolId);
}

/**
 * Set the user override for a tool. Passing an empty string clears the
 * override (falls back to the default). Normalised to upper-case for letters
 * so the keydown matcher's `.toLowerCase()` compare works consistently with
 * the displayed capitalisation in settings UI.
 */
export function setShortcutKey(toolId: string, key: string): void {
  const trimmed = key.trim();
  if (trimmed.length === 0) {
    delete overrides[toolId];
  } else {
    overrides[toolId] = trimmed.length === 1 ? trimmed.toUpperCase() : trimmed;
  }
  save();
  fireChange();
}

/** Remove every override, reverting all tools to their built-in defaults. */
export function resetShortcuts(): void {
  overrides = {};
  save();
  fireChange();
}

/** Snapshot of the current override map. Caller must treat as read-only. */
export function getAllOverrides(): Readonly<OverrideMap> {
  return overrides;
}

type ChangeListener = () => void;
const listeners: ChangeListener[] = [];
/**
 * Subscribe to override changes. Fired after `setShortcutKey` or
 * `resetShortcuts`. Useful for a live-open settings dialog that wants to
 * redraw its rows, but also for any future component that caches a computed
 * binding.
 */
export function onShortcutsChange(fn: ChangeListener): void { listeners.push(fn); }
function fireChange(): void { for (const fn of listeners) { try { fn(); } catch { /* ignore */ } } }
