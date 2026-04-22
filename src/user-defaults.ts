/**
 * User-authored defaults — a snapshot the user takes of the current app state
 * and wants to see the next time they launch (or pick "Neu" in the Datei
 * menu). The snapshot lives in a single localStorage blob and can include:
 *
 *   - tool panel layout (Werkzeug-Anordnung)
 *   - layer list (Ebenen)
 *   - snap toolbar toggles (Fang-Optionen)
 *   - ortho auto-lock / parametric mode flags
 *   - optionally: the current drawing (Features, Entities, Parameters)
 *
 * Separate from the factory-defaults baked into `state.ts` / `tools.ts` — if
 * a user-snapshot exists it overrides the factory baseline at startup, but
 * the factory baseline is still what `resetUserDefaults()` falls back to.
 */
import type { Entity, Feature, Layer, Parameter, SnapSettings } from './types';
import {
  runtime, state,
  saveOrthoAutoLock, saveParametricMode, saveShowAxes, saveSnapDynamic,
} from './state';
import { applyLayoutSnapshot, snapshotLayout, type ToolLayout } from './tools';

const USER_DEFAULTS_KEY = 'hekticad.userDefaults.v1';

type SnapSnapshot = Pick<SnapSettings,
  'end' | 'mid' | 'int' | 'center' | 'axis' | 'grid' | 'tangent' | 'perp'
  | 'gridSize' | 'showGrid' | 'showAxes' | 'polar' | 'tracking' | 'polarAngleDeg'>;

type DrawingSnapshot = {
  features: Feature[];
  entities: Entity[];
  parameters: Parameter[];
  nextId: number;
  activeLayer: number;
};

export type UserDefaults = {
  version: 1;
  savedAt: number;
  layout: ToolLayout;
  layers: Layer[];
  snap: SnapSnapshot;
  orthoAutoLock: boolean;
  parametricMode: boolean;
  /** Only present if the user ticked "Zeichnung einschließen". */
  drawing?: DrawingSnapshot;
};

function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Read the blob if one exists, else null. Defensive against bad JSON. */
export function loadUserDefaults(): UserDefaults | null {
  try {
    const raw = localStorage.getItem(USER_DEFAULTS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<UserDefaults>;
    if (!parsed || parsed.version !== 1) return null;
    if (!parsed.layout || !Array.isArray(parsed.layers) || !parsed.snap) return null;
    return parsed as UserDefaults;
  } catch {
    return null;
  }
}

export function hasUserDefaults(): boolean {
  return loadUserDefaults() !== null;
}

/**
 * Persist the current runtime/state as the user's default snapshot.
 * `includeDrawing` controls whether the live drawing (features / entities /
 * parameters) is included — users who just want a clean layout+layers starting
 * point should leave it false.
 */
export function saveCurrentAsUserDefaults(opts: { includeDrawing: boolean }): void {
  const s = runtime.snapSettings;
  const snap: SnapSnapshot = {
    end: s.end, mid: s.mid, int: s.int, center: s.center, axis: s.axis,
    grid: s.grid, tangent: s.tangent, perp: s.perp,
    gridSize: s.gridSize, showGrid: s.showGrid, showAxes: s.showAxes,
    polar: s.polar, tracking: s.tracking, polarAngleDeg: s.polarAngleDeg,
  };
  const snapshot: UserDefaults = {
    version: 1,
    savedAt: Date.now(),
    layout: snapshotLayout(),
    layers: deepClone(state.layers),
    snap,
    orthoAutoLock: runtime.orthoAutoLock,
    parametricMode: runtime.parametricMode,
  };
  if (opts.includeDrawing) {
    snapshot.drawing = {
      features: deepClone(state.features),
      entities: deepClone(state.entities),
      parameters: deepClone(state.parameters),
      nextId: state.nextId,
      activeLayer: state.activeLayer,
    };
  }
  try {
    localStorage.setItem(USER_DEFAULTS_KEY, JSON.stringify(snapshot));
  } catch {
    // Quota exceeded (drawing too big?) or storage disabled — swallow;
    // caller will surface a toast.
    throw new Error('Speichern fehlgeschlagen');
  }
}

/** Remove the user-defaults blob. Factory defaults will apply on next launch. */
export function clearUserDefaults(): void {
  try { localStorage.removeItem(USER_DEFAULTS_KEY); }
  catch { /* ignore */ }
}

/**
 * Apply a previously-saved snapshot to the current runtime/state. Called
 * exactly once at startup (from main.ts) BEFORE the first render — mutates
 * state.layers, runtime.snapSettings, etc. in place, and writes the layout
 * into the v5 key so `currentLayout()` picks it up.
 *
 * Also persists each individual loaded-flag value through its own save
 * function (saveShowAxes/saveSnapDynamic/…) so the per-setting localStorage
 * keys stay consistent with what's in runtime — otherwise the next time the
 * user toggles an unrelated pill the stale value would write back.
 */
export function applyUserDefaultsAtStartup(): boolean {
  const d = loadUserDefaults();
  if (!d) return false;

  // Layout: write to v5 key + invalidate cache so currentLayout() sees it.
  applyLayoutSnapshot(d.layout);

  // Layers: replace wholesale.
  state.layers = deepClone(d.layers);

  // Snap toolbar toggles: overwrite runtime in place (keep the reference).
  Object.assign(runtime.snapSettings, d.snap);
  saveShowAxes(d.snap.showAxes);
  saveSnapDynamic({
    polar: d.snap.polar,
    tracking: d.snap.tracking,
    polarAngleDeg: d.snap.polarAngleDeg,
  });

  // Ortho + parametric.
  runtime.orthoAutoLock = d.orthoAutoLock;
  saveOrthoAutoLock(d.orthoAutoLock);
  runtime.parametricMode = d.parametricMode;
  saveParametricMode(d.parametricMode);

  // Drawing (optional) — only if the user opted in when saving.
  if (d.drawing) {
    state.features   = deepClone(d.drawing.features);
    state.entities   = deepClone(d.drawing.entities);
    state.parameters = deepClone(d.drawing.parameters);
    state.nextId     = d.drawing.nextId;
    const maxLayer = Math.max(0, state.layers.length - 1);
    state.activeLayer = Math.min(Math.max(0, d.drawing.activeLayer), maxLayer);
  }

  return true;
}
