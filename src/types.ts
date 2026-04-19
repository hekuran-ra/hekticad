/**
 * Central type definitions for HektikCad.
 *
 * Three parallel representations of geometry exist:
 *   1. Feature  — persisted source of truth in the timeline. Holds Expr-valued
 *                 parameters and PointRefs that resolve at evaluation time.
 *   2. Entity   — concrete numeric instance produced by evaluating a feature.
 *                 Holds stable `id` + `layer` for selection and hit-tests.
 *   3. EntityShape / EntityInit — Entity without the `id` (and sometimes
 *                 without `layer`) used for previews, transformations, and
 *                 as input to `addEntity`.
 */

// ────────────────────────────────────────────────────────────────────────────
// Primitives
// ────────────────────────────────────────────────────────────────────────────

export type Pt = { x: number; y: number };

// ────────────────────────────────────────────────────────────────────────────
// Parameters and expressions
// ────────────────────────────────────────────────────────────────────────────

export type Parameter = {
  id: string;
  name: string;
  value: number;
  meaning?: string;
};

/** AST node produced by the formula parser (params.ts). */
export type FormulaNode =
  | { t: 'num'; v: number }
  | { t: 'const'; v: number }
  | { t: 'param'; id: string }
  | { t: 'neg'; a: FormulaNode }
  | { t: 'bin'; op: '+' | '-' | '*' | '/' | '^'; a: FormulaNode; b: FormulaNode }
  | { t: 'fn'; name: string; a: FormulaNode };

/** A parameterised numeric value — literal, parameter reference, or formula. */
export type Expr =
  | { kind: 'num'; value: number }
  | { kind: 'param'; id: string }
  | { kind: 'formula'; src: string; ast: FormulaNode; refs: string[] };

// ────────────────────────────────────────────────────────────────────────────
// Point references (used inside Features)
// ────────────────────────────────────────────────────────────────────────────

export type PointRef =
  | { kind: 'abs'; x: Expr; y: Expr }
  | { kind: 'endpoint'; feature: string; end: 0 | 1 }
  | { kind: 'center'; feature: string }
  | { kind: 'mid'; feature: string }
  | { kind: 'intersection'; feature1: string; feature2: string };

// ────────────────────────────────────────────────────────────────────────────
// Layers + styling
// ────────────────────────────────────────────────────────────────────────────

export type Layer = {
  name: string;
  color: string;
  visible: boolean;
  locked?: boolean;
  /** Optional line style (dashed layers render their geometry as dashed). */
  style?: 'solid' | 'dash';
};

export type DimStyle = 'arrow' | 'open' | 'tick' | 'arch';

// ────────────────────────────────────────────────────────────────────────────
// Concrete entity shapes (output of feature evaluation)
// ────────────────────────────────────────────────────────────────────────────

type EntityBase = { id: number; layer: number };

export type LineEntity      = EntityBase & { type: 'line';     x1: number; y1: number; x2: number; y2: number };
export type PolylineEntity  = EntityBase & { type: 'polyline'; pts: Pt[];  closed?: boolean };
export type RectEntity      = EntityBase & { type: 'rect';     x1: number; y1: number; x2: number; y2: number };
export type CircleEntity    = EntityBase & { type: 'circle';   cx: number; cy: number; r: number };
export type ArcEntity       = EntityBase & { type: 'arc';      cx: number; cy: number; r: number; a1: number; a2: number };
export type EllipseEntity   = EntityBase & { type: 'ellipse';  cx: number; cy: number; rx: number; ry: number; rot: number };
export type SplineEntity    = EntityBase & { type: 'spline';   pts: Pt[];  closed?: boolean };
export type XLineEntity     = EntityBase & { type: 'xline';    x1: number; y1: number; dx: number; dy: number };
export type TextEntity      = EntityBase & { type: 'text';     x: number;  y: number;  text: string; height: number; rotation?: number };
export type DimEntity       = EntityBase & {
  type: 'dim';
  p1: Pt; p2: Pt; offset: Pt;
  textHeight: number;
  style?: DimStyle;
};

export type Entity =
  | LineEntity | PolylineEntity | RectEntity | CircleEntity | ArcEntity
  | EllipseEntity | SplineEntity | XLineEntity | TextEntity | DimEntity;

/** Same structure as `Entity` but without the `id` — used at creation time. */
export type EntityInit =
  | Omit<LineEntity,     'id'>
  | Omit<PolylineEntity, 'id'>
  | Omit<RectEntity,     'id'>
  | Omit<CircleEntity,   'id'>
  | Omit<ArcEntity,      'id'>
  | Omit<EllipseEntity,  'id'>
  | Omit<SplineEntity,   'id'>
  | Omit<XLineEntity,    'id'>
  | Omit<TextEntity,     'id'>
  | Omit<DimEntity,      'id'>;

/**
 * Same as `Entity` but both `id` and `layer` are optional — used inside the
 * preview machinery (renderer accepts layer-less shapes and paints them with
 * the preview colour).
 */
export type EntityShape =
  | Omit<LineEntity,     'id' | 'layer'> & { layer?: number }
  | Omit<PolylineEntity, 'id' | 'layer'> & { layer?: number }
  | Omit<RectEntity,     'id' | 'layer'> & { layer?: number }
  | Omit<CircleEntity,   'id' | 'layer'> & { layer?: number }
  | Omit<ArcEntity,      'id' | 'layer'> & { layer?: number }
  | Omit<EllipseEntity,  'id' | 'layer'> & { layer?: number }
  | Omit<SplineEntity,   'id' | 'layer'> & { layer?: number }
  | Omit<XLineEntity,    'id' | 'layer'> & { layer?: number }
  | Omit<TextEntity,     'id' | 'layer'> & { layer?: number }
  | Omit<DimEntity,      'id' | 'layer'> & { layer?: number };

/** Preview payload carried on `runtime.toolCtx.preview` and drawn by render.ts. */
export type Preview =
  | EntityShape
  | { type: 'group'; entities: EntityShape[] };

// ────────────────────────────────────────────────────────────────────────────
// Snap
// ────────────────────────────────────────────────────────────────────────────

export type SnapPoint = {
  type: 'end' | 'mid' | 'int' | 'center' | 'axis' | 'grid' | 'tangent' | 'perp';
  x: number;
  y: number;
  entityId?: number;
  /** Second entity id for intersection snaps (the two lines being intersected). */
  entityId2?: number;
};

export type SnapSettings = {
  end: boolean;
  mid: boolean;
  int: boolean;
  center: boolean;
  axis: boolean;
  grid: boolean;
  tangent: boolean;
  perp: boolean;
  gridSize: number;
  showGrid: boolean;
};

// ────────────────────────────────────────────────────────────────────────────
// Features — persisted timeline entries
// ────────────────────────────────────────────────────────────────────────────

type FeatureBase = { id: string; layer: number };

export type LineFeature      = FeatureBase & { kind: 'line';      p1: PointRef; p2: PointRef };
export type PolylineFeature  = FeatureBase & { kind: 'polyline';  pts: PointRef[]; closed: boolean };
export type RectFeature      = FeatureBase & {
  kind: 'rect';
  p1: PointRef;
  width: Expr; height: Expr;
  /** +1 / -1 relative to p1 — lets the rect grow in any quadrant. */
  signX: 1 | -1;
  signY: 1 | -1;
};
export type CircleFeature    = FeatureBase & { kind: 'circle';   center: PointRef; radius: Expr };
export type ArcFeature       = FeatureBase & { kind: 'arc';      center: PointRef; radius: Expr; a1: Expr; a2: Expr };
export type EllipseFeature   = FeatureBase & { kind: 'ellipse';  center: PointRef; rx: Expr; ry: Expr; rot: Expr };
export type SplineFeature    = FeatureBase & { kind: 'spline';   pts: PointRef[]; closed: boolean };
export type XLineFeature     = FeatureBase & { kind: 'xline';    p: PointRef; dx: Expr; dy: Expr };
export type ParallelXLineFeature = FeatureBase & {
  kind: 'parallelXLine';
  refFeature: string;
  distance: Expr;
  side: 1 | -1;
};
export type TextFeature      = FeatureBase & {
  kind: 'text';
  p: PointRef;
  text: string;
  height: Expr;
  rotation: Expr;
};
export type DimFeature       = FeatureBase & {
  kind: 'dim';
  p1: PointRef; p2: PointRef; offset: PointRef;
  textHeight: Expr;
  style?: DimStyle;
};

export type Feature =
  | LineFeature | PolylineFeature | RectFeature | CircleFeature | ArcFeature
  | EllipseFeature | SplineFeature | XLineFeature | ParallelXLineFeature
  | TextFeature | DimFeature;

// ────────────────────────────────────────────────────────────────────────────
// Tool identity + per-tool state
// ────────────────────────────────────────────────────────────────────────────

export type ToolId =
  | 'select' | 'select_similar' | 'pan'
  | 'line' | 'polyline' | 'rect' | 'circle' | 'circle3' | 'arc3'
  | 'ellipse' | 'spline' | 'polygon' | 'text'
  | 'xline' | 'dim'
  | 'move' | 'copy' | 'rotate' | 'mirror' | 'stretch' | 'scale'
  | 'fillet' | 'chamfer' | 'extend' | 'trim' | 'offset' | 'delete'
  /* Design-file additions */
  | 'point' | 'axis' | 'ref_circle' | 'angle' | 'hatch';

/**
 * Loosely-typed per-tool state machine. Each tool uses a subset of these
 * fields depending on its current `step` — keeping the shape open avoids a
 * 30-branch discriminated union that would obscure the tool code.
 */
export type ToolCtx = {
  step: string;
  preview?: Preview | null;
  p1?: Pt;
  pts?: Pt[];
  lockedDir?: Pt | null;
  angleDeg?: number | null;
  cx?: number;
  cy?: number;
  vertical?: number | null;
  horizontal?: number | null;
  verticalExpr?: Expr | null;
  horizontalExpr?: Expr | null;
  radiusExpr?: Expr | null;
  ref?: Entity | { _axis: 'x' | 'y' };
  dir?: Pt;
  base?: Pt;
  entity?: Entity;
  entity1?: Entity;
  entity2?: Entity;
  click1?: Pt;
  click2?: Pt;
  radius?: number | null;
  distance?: number | null;
  basePt?: Pt;
  centerPt?: Pt;
  a1?: Pt;
  refLen?: number;
  textHeight?: number;
  p1Ref?: PointRef | null;
  ptRefs?: (PointRef | null)[];
};

// ────────────────────────────────────────────────────────────────────────────
// Top-level application state
// ────────────────────────────────────────────────────────────────────────────

export type AppState = {
  view: { x: number; y: number; scale: number };
  entities: Entity[];
  layers: Layer[];
  activeLayer: number;
  tool: ToolId;
  selection: Set<number>;
  mouseWorld: Pt;
  mouseScreen: Pt;
  nextId: number;
  parameters: Parameter[];
  features: Feature[];
};
