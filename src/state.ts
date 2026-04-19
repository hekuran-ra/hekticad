import type { AppState, DimStyle, Layer, Pt, SnapPoint, SnapSettings, ToolCtx } from './types';

export type DragSelect = {
  worldStart: Pt;
  startClientX: number;
  startClientY: number;
  active: boolean;
  shift: boolean;
};

export const DEFAULT_LAYERS: Layer[] = [
  { name: 'Achsen',     color: '#4a5060', visible: true, locked: true, style: 'dash' },
  { name: '0',          color: '#ffffff', visible: true },
  { name: 'Kontur',     color: '#e06767', visible: true },
  { name: 'Hilfslinie', color: '#8891a0', visible: true, style: 'dash' },
  { name: 'Bemaßung',   color: '#67c1ff', visible: true },
];

export const state: AppState = {
  view: { x: 0, y: 0, scale: 4 },
  entities: [],
  layers: JSON.parse(JSON.stringify(DEFAULT_LAYERS)),
  activeLayer: 1,
  tool: 'select',
  selection: new Set<number>(),
  mouseWorld: { x: 0, y: 0 },
  mouseScreen: { x: 0, y: 0 },
  nextId: 1,
  parameters: [],
  features: [],
};

/** Mutable runtime data that doesn't belong to the persisted drawing. */
export const runtime = {
  toolCtx: null as ToolCtx | null,
  pan: null as { lastX: number; lastY: number } | null,
  spacePan: false,
  snapSettings: {
    end: true, mid: true, int: true, center: true, axis: true, grid: false,
    tangent: true, perp: true, gridSize: 10, showGrid: false,
  } as SnapSettings,
  lastSnap: null as SnapPoint | null,
  dragSelect: null as DragSelect | null,
  /** Shift held: snap cursor direction to nearest 15° during drawing/move. */
  orthoSnap: false,
  /** Alt-drag started from select tool; next mouseup commits the copy. */
  dragCopy: false,
  /** Entity id currently under the cursor (for hover highlight). null = none. */
  hoveredId: null as number | null,
  /**
   * Global default dim end-cap style. Applied to new dims unless the user
   * picked a per-dim style. Editable via the dim-style picker UI.
   */
  dimStyle: 'arrow' as DimStyle,
  /**
   * Last non-pointer tool the user invoked. When the rail returns to
   * 'select' (via Esc / cancelTool) pressing Enter in idle re-enters this
   * tool — AutoCAD's space-bar repeat convention.
   */
  lastInvokedTool: null as string | null,
};

export function uid(): number {
  return state.nextId++;
}
