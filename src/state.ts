import type { AppState, CrossMirrorMode, DimMode, DimStyle, Entity, Layer, LineOffsetMode, ProjectMeta, Pt, RadiusMode, SnapPoint, SnapSettings, ToolCtx } from './types';
import type { Grip } from './grips';

export type DragSelect = {
  worldStart: Pt;
  startClientX: number;
  startClientY: number;
  active: boolean;
  shift: boolean;
};

/**
 * Drag-to-create state for the text tool. mousedown seeds `worldStart` and
 * `startClient*`; mousemove flips `active` once the user has dragged beyond a
 * small deadzone. mouseup inspects this: a plain click (deadzone never broken)
 * opens the text editor with the default height; a real drag uses the box
 * height as the text height and anchors the text at the bottom-left of the
 * drag box.
 */
export type DragText = {
  worldStart: Pt;
  startClientX: number;
  startClientY: number;
  active: boolean;
};

/**
 * Drag state for moving one or more text entities by dragging on the text
 * body (not a corner grip). Captured on mousedown when the click lands on a
 * text entity; mousemove past the deadzone flips `active` and translates the
 * text anchors. Mouseup commits (one undo entry) or — if the deadzone was
 * never crossed — falls through to a normal click-select.
 */
export type DragTextMove = {
  /** All entity ids that will translate together. Usually a single text, but
   *  covers the case where the user already had several selected and clicked
   *  on one of them. Only text entities go in this list. */
  entityIds: number[];
  /** Where in world-space the mousedown happened — reference for the delta. */
  startWorld: Pt;
  /** Initial anchor of each entity (same indexing as `entityIds`). */
  startAnchors: Pt[];
  /** Where the user clicked originally in screen coords (for deadzone check). */
  startClientX: number;
  startClientY: number;
  /** Has the deadzone been crossed? Before this, no mutation has occurred. */
  active: boolean;
  /** Shift state at mousedown, forwarded to `handleClick` on a no-drag
   *  release so normal click-select semantics still work. */
  shift: boolean;
};

/**
 * Drag state for resizing a Rahmentext via one of its corner grips. Captured
 * on mousedown, consumed on mousemove/mouseup in main.ts. `entityId` + the
 * initial frame edges let us compute new edges relative to the *start* of the
 * drag even after the feature's own x/boxWidth mutate on each frame.
 */
export type DragTextFrame = {
  entityId: number;
  /** Which corner was grabbed. 0=TL 1=TR 2=BR 3=BL. */
  gripIdx: 0 | 1 | 2 | 3;
  /** World-space edges at drag start — reference for deltas. */
  startLeft: number;
  startRight: number;
  startTop: number;
  /** World-space click offset inside the grip, so the cursor doesn't jump. */
  grabDx: number;
  grabDy: number;
  /** True once the user has moved past a small deadzone (prevents phantom
   *  resize on accidental sub-pixel drags). Until then, mouseup cleans up and
   *  behaves like a plain click for selection purposes. */
  active: boolean;
  startClientX: number;
  startClientY: number;
};

/**
 * Drag state for a geometry grip (line endpoint/mid, rect corner/edge, circle
 * quadrant, arc end, ellipse axis, polyline/spline vertex, text anchor). Only
 * active when `runtime.parametricMode` is OFF — in parametric mode the sidebar
 * property editor is the canonical way to edit geometry so PointRef links stay
 * intact. `startEntity` snapshots the entity at mousedown so every mousemove
 * rebuilds deltas from the original (no accumulated rounding).
 */
export type DragGrip = {
  entityId: number;
  /** The grabbed grip (kind + optional endIdx/cornerIdx/vertexIndex/…). */
  grip: Grip;
  /** The entity exactly as it was at mousedown — reference for every frame. */
  startEntity: Entity;
  /** World offset between cursor and grip centre at mousedown, so the grip
   *  doesn't jump to the cursor on the first mousemove. */
  grabDx: number;
  grabDy: number;
  /** Screen coords at mousedown for the deadzone check. */
  startClientX: number;
  startClientY: number;
  /** Flipped true once the user has moved past the deadzone; only then is
   *  undo pushed and the feature mutated. Sub-deadzone mouseups are no-ops. */
  active: boolean;
};

export const DEFAULT_LAYERS: Layer[] = [
  // Origin axes are no longer a layer — they're drawn directly by the renderer
  // and toggled from the snap toolbar (see drawOriginAxes() + `showAxes` in
  // runtime.snapSettings). This keeps the layers panel dedicated to user-owned
  // linetypes only.
  { name: '0',          color: '#ffffff', visible: true },
  { name: 'Kontur',     color: '#e06767', visible: true },
  // Uses the dedicated `guide` preset (fine [1.5, 1] mm dash — same spirit as
  // the origin axes) so the popover highlights "Hilfslinie" rather than a
  // generic custom pattern when this layer is opened.
  { name: 'Hilfslinie', color: '#8891a0', visible: true, style: 'guide' },
  { name: 'Bemaßung',   color: '#67c1ff', visible: true },
];

const PROJECT_META_STORAGE_KEY = 'hektikcad.projectMeta.v1';
const LOGO_STORAGE_KEY         = 'hektikcad.logo.v1';
const LAST_TEMPLATE_STORAGE_KEY = 'hektikcad.lastTemplate.v1';
const DIM_STYLE_STORAGE_KEY    = 'hektikcad.dimStyle.v1';
const DIM_MODE_STORAGE_KEY     = 'hektikcad.dimMode.v1';
const RADIUS_MODE_STORAGE_KEY  = 'hektikcad.radiusMode.v1';
const LINE_OFFSET_MODE_STORAGE_KEY       = 'hektikcad.lineOffsetMode.v1';
const CROSS_MIRROR_MODE_STORAGE_KEY      = 'hektikcad.crossMirrorMode.v1';
const LINE_OFFSET_USE_ANGLE_STORAGE_KEY  = 'hektikcad.lineOffsetUseAngle.v1';
// v2 bump: semantics changed from "angle between connector and line
// direction" (90° = rect) to "tilt from perpendicular" (0° = rect). Old v1
// values (e.g. 90) would read as heavy flare under the new convention, so
// the key is rotated to force a clean default.
const LINE_OFFSET_ANGLE_DEG_STORAGE_KEY  = 'hektikcad.lineOffsetAngleDeg.v2';
const PANELS_LOCKED_STORAGE_KEY = 'hektikcad.panelsLocked.v1';
const SNAP_DYNAMIC_STORAGE_KEY  = 'hektikcad.snapDynamic.v1';
const SHOW_AXES_STORAGE_KEY     = 'hektikcad.showAxes.v1';
const ORTHO_AUTO_LOCK_STORAGE_KEY = 'hektikcad.orthoAutoLock.v1';
const PARAMETRIC_MODE_STORAGE_KEY = 'hektikcad.parametricMode.v1';

/** Load the "origin axes visible" flag. Falls back to true (on). */
export function loadShowAxes(): boolean {
  try {
    const raw = localStorage.getItem(SHOW_AXES_STORAGE_KEY);
    if (raw === '1') return true;
    if (raw === '0') return false;
  } catch { /* ignore */ }
  return true;
}

/** Persist the "origin axes visible" flag. */
export function saveShowAxes(on: boolean): void {
  try { localStorage.setItem(SHOW_AXES_STORAGE_KEY, on ? '1' : '0'); }
  catch { /* ignore */ }
}

/**
 * Load the "ortho auto-lock while drawing" flag. When on (default), drawing
 * motions whose direction is within a small angle threshold of a cardinal
 * axis (0°/90°/180°/270°) get soft-snapped to that axis without needing
 * Shift. Shift still forces 15°-step ortho as before.
 */
export function loadOrthoAutoLock(): boolean {
  try {
    const raw = localStorage.getItem(ORTHO_AUTO_LOCK_STORAGE_KEY);
    if (raw === '1') return true;
    if (raw === '0') return false;
  } catch { /* ignore */ }
  return true;
}

/** Persist the ortho auto-lock flag. */
export function saveOrthoAutoLock(on: boolean): void {
  try { localStorage.setItem(ORTHO_AUTO_LOCK_STORAGE_KEY, on ? '1' : '0'); }
  catch { /* ignore */ }
}

/**
 * Load the "parametric drawing" flag. When true (default), the tools capture
 * snap anchors as parametric PointRefs (endpoint/mid/center/intersection/polar)
 * so edits to one feature propagate through linked geometry. When false the
 * tools strip every PointRef to plain `abs` — geometry is drawn once at the
 * snapped coordinates, no downstream chains. Useful for quick sketches where
 * the user doesn't want the overhead (and occasional surprise moves) of
 * dependent features.
 */
export function loadParametricMode(): boolean {
  try {
    const raw = localStorage.getItem(PARAMETRIC_MODE_STORAGE_KEY);
    if (raw === '1') return true;
    if (raw === '0') return false;
  } catch { /* ignore */ }
  // Fresh install: parametric mode OFF. Most first-time sketches are ad-hoc —
  // the moment the user creates or references a variable we auto-enable it
  // (see `ensureParametricModeOn` in ./parametric-mode.ts), so they don't
  // need to know the mode exists until they actually want it.
  return false;
}

/** Persist the parametric-mode flag. */
export function saveParametricMode(on: boolean): void {
  try { localStorage.setItem(PARAMETRIC_MODE_STORAGE_KEY, on ? '1' : '0'); }
  catch { /* ignore */ }
}

/** Load the persisted global dim end-cap style. Falls back to 'arrow'. */
export function loadDimStyle(): DimStyle {
  try {
    const raw = localStorage.getItem(DIM_STYLE_STORAGE_KEY);
    if (raw === 'arrow' || raw === 'open' || raw === 'tick' || raw === 'arch') return raw;
  } catch { /* ignore */ }
  return 'arrow';
}

/** Persist the global dim end-cap style (changed via Format → Bemaßungsstil). */
export function saveDimStyle(style: DimStyle): void {
  try { localStorage.setItem(DIM_STYLE_STORAGE_KEY, style); } catch { /* ignore */ }
}

/** Load the persisted dim-tool interaction mode. Falls back to 'single'. */
export function loadDimMode(): DimMode {
  try {
    const raw = localStorage.getItem(DIM_MODE_STORAGE_KEY);
    if (raw === 'single' || raw === 'chain' || raw === 'auto') return raw;
  } catch { /* ignore */ }
  return 'single';
}

/** Persist the dim-tool mode (changed via the canvas dim-mode picker). */
export function saveDimMode(mode: DimMode): void {
  try { localStorage.setItem(DIM_MODE_STORAGE_KEY, mode); } catch { /* ignore */ }
}

/** Load the persisted radius-tool mode (R vs Ø). Falls back to 'radius'. */
export function loadRadiusMode(): RadiusMode {
  try {
    const raw = localStorage.getItem(RADIUS_MODE_STORAGE_KEY);
    if (raw === 'radius' || raw === 'diameter') return raw;
  } catch { /* ignore */ }
  return 'radius';
}

/** Persist the radius-tool mode (changed via the canvas radius picker). */
export function saveRadiusMode(mode: RadiusMode): void {
  try { localStorage.setItem(RADIUS_MODE_STORAGE_KEY, mode); } catch { /* ignore */ }
}

/** Load the persisted cross-mirror tool mode. Falls back to 'quarter'. */
export function loadCrossMirrorMode(): CrossMirrorMode {
  try {
    const raw = localStorage.getItem(CROSS_MIRROR_MODE_STORAGE_KEY);
    if (raw === 'quarter' || raw === 'half_h' || raw === 'half_v') return raw;
  } catch { /* ignore */ }
  return 'quarter';
}

/** Persist the cross-mirror tool mode (toggled via its canvas picker). */
export function saveCrossMirrorMode(mode: CrossMirrorMode): void {
  try { localStorage.setItem(CROSS_MIRROR_MODE_STORAGE_KEY, mode); } catch { /* ignore */ }
}

/** Load the persisted line-offset tool mode. Falls back to 'line'. */
export function loadLineOffsetMode(): LineOffsetMode {
  try {
    const raw = localStorage.getItem(LINE_OFFSET_MODE_STORAGE_KEY);
    if (raw === 'line' || raw === 'connect') return raw;
    // Back-compat: the old name was 'rect' before the picker was renamed
    // "Verbinden". Seamlessly migrate existing installs.
    if (raw === 'rect') return 'connect';
  } catch { /* ignore */ }
  return 'line';
}

/** Persist the line-offset tool mode (toggled via its canvas picker). */
export function saveLineOffsetMode(mode: LineOffsetMode): void {
  try { localStorage.setItem(LINE_OFFSET_MODE_STORAGE_KEY, mode); } catch { /* ignore */ }
}

/**
 * Load the "Winkel" toggle for the line-offset tool. When true, the cmdbar
 * exposes an angle input field so the user can offset at a non-perpendicular
 * angle. Off by default — 90° is by far the common case.
 */
export function loadLineOffsetUseAngle(): boolean {
  try { return localStorage.getItem(LINE_OFFSET_USE_ANGLE_STORAGE_KEY) === '1'; }
  catch { return false; }
}

/** Persist the "Winkel" toggle state. */
export function saveLineOffsetUseAngle(on: boolean): void {
  try { localStorage.setItem(LINE_OFFSET_USE_ANGLE_STORAGE_KEY, on ? '1' : '0'); }
  catch { /* ignore */ }
}

/**
 * Load the persisted connector tilt angle (degrees) for the line-offset
 * tool. Semantics: 0° = perpendicular connectors (rectangle). Positive α =
 * both connectors tilt α° inward toward each other → symmetric trapezoid
 * that's narrower on the offset side. Negative α = flared outward. Falls
 * back to 15° — the requested default.
 */
export function loadLineOffsetAngleDeg(): number {
  try {
    const raw = localStorage.getItem(LINE_OFFSET_ANGLE_DEG_STORAGE_KEY);
    if (raw == null) return 15;
    const n = parseFloat(raw);
    if (Number.isFinite(n) && n > -90 && n < 90) return n;
  } catch { /* ignore */ }
  return 15;
}

/** Persist the connector angle (degrees). */
export function saveLineOffsetAngleDeg(deg: number): void {
  try { localStorage.setItem(LINE_OFFSET_ANGLE_DEG_STORAGE_KEY, String(deg)); }
  catch { /* ignore */ }
}

/** Load the "tool palettes locked" flag. Falls back to false (unlocked). */
export function loadPanelsLocked(): boolean {
  try { return localStorage.getItem(PANELS_LOCKED_STORAGE_KEY) === '1'; }
  catch { return false; }
}

/** Persist the "tool palettes locked" flag. */
export function savePanelsLocked(locked: boolean): void {
  try { localStorage.setItem(PANELS_LOCKED_STORAGE_KEY, locked ? '1' : '0'); }
  catch { /* ignore */ }
}

/**
 * Persisted sub-settings for the dynamic guide system (polar tracking +
 * object-snap tracking). Shape is { polar, tracking, polarAngleDeg }.
 */
export function loadSnapDynamic(): { polar: boolean; tracking: boolean; polarAngleDeg: number } {
  const fallback = { polar: true, tracking: true, polarAngleDeg: 45 };
  try {
    const raw = localStorage.getItem(SNAP_DYNAMIC_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<typeof fallback>;
    return {
      polar:         typeof parsed.polar === 'boolean'    ? parsed.polar    : fallback.polar,
      tracking:      typeof parsed.tracking === 'boolean' ? parsed.tracking : fallback.tracking,
      polarAngleDeg: typeof parsed.polarAngleDeg === 'number' && parsed.polarAngleDeg > 0
        ? parsed.polarAngleDeg : fallback.polarAngleDeg,
    };
  } catch { return fallback; }
}

export function saveSnapDynamic(cfg: { polar: boolean; tracking: boolean; polarAngleDeg: number }): void {
  try { localStorage.setItem(SNAP_DYNAMIC_STORAGE_KEY, JSON.stringify(cfg)); }
  catch { /* ignore */ }
}

/**
 * Produce a fresh default `ProjectMeta`. Used when the persisted copy is
 * missing or malformed. Falls back to empty strings — the title-block
 * renderer treats empty as em-dash.
 */
export function defaultProjectMeta(): ProjectMeta {
  return {
    name: '',
    drawingTitle: '',
    drawingNumber: '',
    author: '',
    revision: '',
    companyAddress: '',
    logoDataUrl: '',
    lastTemplate: 'a4-landscape-1to100',
  };
}

/**
 * Load persisted project metadata from localStorage. Logo and last-template
 * live under their own keys (cleaner versioning, easier to clear) and get
 * merged in here.
 */
export function loadProjectMeta(): ProjectMeta {
  const fallback = defaultProjectMeta();
  try {
    const raw = localStorage.getItem(PROJECT_META_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ProjectMeta>;
      fallback.name           = typeof parsed.name === 'string' ? parsed.name : '';
      fallback.drawingTitle   = typeof parsed.drawingTitle === 'string' ? parsed.drawingTitle : '';
      fallback.drawingNumber  = typeof parsed.drawingNumber === 'string' ? parsed.drawingNumber : '';
      fallback.author         = typeof parsed.author === 'string' ? parsed.author : '';
      fallback.revision       = typeof parsed.revision === 'string' ? parsed.revision : '';
      fallback.companyAddress = typeof parsed.companyAddress === 'string' ? parsed.companyAddress : '';
    }
    const logo = localStorage.getItem(LOGO_STORAGE_KEY);
    if (logo) fallback.logoDataUrl = logo;
    const tpl = localStorage.getItem(LAST_TEMPLATE_STORAGE_KEY);
    if (tpl) fallback.lastTemplate = tpl as ProjectMeta['lastTemplate'];
  } catch {
    /* localStorage unavailable or JSON invalid → use defaults. */
  }
  return fallback;
}

/** Persist the project meta to localStorage. Logo stored under its own key. */
export function saveProjectMeta(meta: ProjectMeta): void {
  try {
    const { logoDataUrl, lastTemplate, ...rest } = meta;
    localStorage.setItem(PROJECT_META_STORAGE_KEY, JSON.stringify(rest));
    if (logoDataUrl) localStorage.setItem(LOGO_STORAGE_KEY, logoDataUrl);
    else             localStorage.removeItem(LOGO_STORAGE_KEY);
    localStorage.setItem(LAST_TEMPLATE_STORAGE_KEY, lastTemplate);
  } catch { /* swallow */ }
}

export const state: AppState = {
  view: { x: 0, y: 0, scale: 4 },
  entities: [],
  layers: JSON.parse(JSON.stringify(DEFAULT_LAYERS)),
  // Layer 0 is the default drawing layer (the "0" layer); axes no longer
  // occupy index 0.
  activeLayer: 0,
  tool: 'select',
  selection: new Set<number>(),
  mouseWorld: { x: 0, y: 0 },
  mouseScreen: { x: 0, y: 0 },
  nextId: 1,
  parameters: [],
  features: [],
  projectMeta: loadProjectMeta(),
};

/** Mutable runtime data that doesn't belong to the persisted drawing. */
export const runtime = {
  toolCtx: null as ToolCtx | null,
  pan: null as { lastX: number; lastY: number } | null,
  spacePan: false,
  snapSettings: (() => {
    const dyn = loadSnapDynamic();
    return {
      end: true, mid: true, int: true, center: true, axis: true, grid: false,
      tangent: true, perp: true, gridSize: 10, showGrid: true,
      showAxes: loadShowAxes(),
      polar: dyn.polar, tracking: dyn.tracking, polarAngleDeg: dyn.polarAngleDeg,
    } as SnapSettings;
  })(),
  lastSnap: null as SnapPoint | null,
  dragSelect: null as DragSelect | null,
  dragText: null as DragText | null,
  dragTextFrame: null as DragTextFrame | null,
  dragTextMove: null as DragTextMove | null,
  /**
   * Geometry-grip drag (line endpoint, rect corner, circle quadrant, …).
   * Only initialised in free-draw mode (`parametricMode === false`). In
   * parametric mode the sidebar property editor is the canonical way to
   * edit geometry so linked PointRefs stay intact.
   */
  dragGrip: null as DragGrip | null,
  /** Shift held: snap cursor direction to nearest 15° during drawing/move. */
  orthoSnap: false,
  /**
   * Soft ortho auto-lock while drawing. When true and no snap is active, the
   * cursor direction is nudged onto the nearest cardinal axis if it's already
   * within a small threshold. Shift-ortho still works independently.
   */
  orthoAutoLock: loadOrthoAutoLock(),
  /** Alt-drag started from select tool; next mouseup commits the copy. */
  dragCopy: false,
  /** Entity id currently under the cursor (for hover highlight). null = none. */
  hoveredId: null as number | null,
  /**
   * Global default dim end-cap style. Applied to new dims unless the user
   * picked a per-dim style. Editable via Format → Bemaßungsstil; persisted
   * to localStorage so it survives reloads.
   */
  dimStyle: loadDimStyle() as DimStyle,
  /**
   * Global dim-tool interaction mode. Controls how successive clicks are
   * interpreted when the dim tool is active. Persisted to localStorage;
   * changed via the canvas dim-mode picker (visible while the dim tool is
   * active).
   */
  dimMode: loadDimMode() as DimMode,
  /**
   * Sub-mode of the Radius tool: which value is committed when the user
   * picks a circle/arc. Persisted, toggled via the canvas radius picker.
   */
  radiusMode: loadRadiusMode() as RadiusMode,
  /**
   * Sub-mode of the "Linie versetzen" tool:
   *   'line'    → just the offset line.
   *   'connect' → offset line + two connector lines at the endpoints.
   * Persisted; toggled via the canvas line-offset picker.
   */
  lineOffsetMode: loadLineOffsetMode() as LineOffsetMode,
  /**
   * Sub-mode of the Symmetrie (cross-mirror) tool: 1/4, 1/2 horizontal
   * (left↔right flip), or 1/2 vertical (top↕bottom flip). Persisted; toggled
   * via the canvas cross-mirror picker while the tool is active.
   */
  crossMirrorMode: loadCrossMirrorMode() as CrossMirrorMode,
  /**
   * Parametric-drawing master flag. When off, the tools stop capturing snap
   * anchors as linked PointRefs — every new feature is stored with plain
   * `abs` coordinates, so changes don't propagate through chains. Acts as a
   * global switch without changing any individual tool's UX. Persisted via
   * `saveParametricMode`, toggled from the PARAM button in the snap toolbar.
   */
  parametricMode: loadParametricMode(),
  /**
   * Independent "Winkel" toggle for the line-offset tool. When on, the
   * picker exposes an angle input field so the user can offset at a non-
   * perpendicular angle, producing a symmetric trapezoid. When off
   * (default), the offset is 90° — the classic perpendicular offset.
   */
  lineOffsetUseAngle: loadLineOffsetUseAngle(),
  /**
   * Angle (degrees) between each connector and the source line. 90° =
   * rectangle. <90° = trapezoid narrower on the offset side. >90° =
   * trapezoid wider on the offset side. Only consulted when
   * `lineOffsetUseAngle` is true. Edited via the number input next to the
   * Winkel toggle in the canvas picker.
   */
  lineOffsetAngleDeg: loadLineOffsetAngleDeg(),
  /**
   * User-togglable lock for the tool palette rail. When true, palette
   * headers can't be dragged, palettes can't be undocked/reordered, and
   * individual tool buttons can't be dragged between palettes. Click-to-
   * activate still works, as do the right-click context menus (colour,
   * orientation, etc.). Persisted via `savePanelsLocked`, toggled from
   * Einstellungen → "Werkzeugpaletten sperren".
   */
  panelsLocked: loadPanelsLocked(),
  /**
   * Last non-pointer tool the user invoked. When the rail returns to
   * 'select' (via Esc / cancelTool) pressing Enter in idle re-enters this
   * tool — AutoCAD's space-bar repeat convention.
   */
  lastInvokedTool: null as string | null,
  /**
   * Matrix dimensions for the Kopieren (copy) tool. Defaults to 1×1 which
   * degenerates to a single copy — matching the tool's historical behaviour.
   * When either >1, the copy tool produces a grid of instances at every
   * cell of the rectangle spanned by the click vector (cols) and its 90° CCW
   * perpendicular (rows). Edited via the two integer fields in the cmdbar
   * while the copy tool is in the 'target' step.
   */
  copyCols: 1,
  copyRows: 1,
};

export function uid(): number {
  return state.nextId++;
}
