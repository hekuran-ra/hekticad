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

/**
 * Selector for which sub-segment of a target feature a `rayHit` PointRef
 * intersects. Kept as an enum/index rather than raw coordinates so variable-
 * driven targets (e.g. a rect whose width changes) keep working.
 */
export type FeatureEdgeRef =
  | { kind: 'rectEdge'; side: 'top' | 'right' | 'bottom' | 'left' }
  | { kind: 'lineSeg' }
  | { kind: 'polySeg'; index: number };

export type PointRef =
  | { kind: 'abs'; x: Expr; y: Expr }
  | { kind: 'endpoint'; feature: string; end: 0 | 1 }
  | { kind: 'center'; feature: string }
  | { kind: 'mid'; feature: string }
  | { kind: 'intersection'; feature1: string; feature2: string }
  /**
   * `from + (cos(angle), sin(angle)) * distance` — used when the user commits
   * a line / polyline segment via typed angle + length and either value
   * carries a parameter or formula. `angle` is in degrees. Keeps variables
   * live so changing a parameter updates the derived point.
   */
  | { kind: 'polar'; from: PointRef; angle: Expr; distance: Expr }
  /**
   * Ray-hits-edge intersection. Resolves to the point where the ray
   * `from + t·(cos(angle), sin(angle))` (t ≥ 0) crosses the `edge` of
   * `target`. Used by the line tool when the user locks an angle AND
   * snaps onto a feature's edge — this keeps the endpoint tracking the
   * edge even after the target's parameters change (e.g. rect width).
   *
   * Returns NaN when there's no forward intersection (ray parallel to
   * edge, crossing behind base, or outside the finite segment).
   */
  | { kind: 'rayHit';
      from: PointRef;
      angle: Expr;
      target: string;
      edge: FeatureEdgeRef;
    }
  /**
   * Axis-aligned composite: x is taken from `xFrom`, y from `yFrom`. Used
   * when a rectangle's diagonally-opposite corner needs to stay tied to two
   * different snapped references — e.g. the user placed corner A on one
   * xline-intersection and corner C on another. The two derived corners B
   * and D are then `{ xFrom: C, yFrom: A }` and `{ xFrom: A, yFrom: C }`
   * respectively, so when either anchor moves, the rectangle's edges follow
   * on the correct axis while staying axis-aligned (no skew).
   *
   * Chained references are fine: `xFrom` / `yFrom` can themselves be
   * `axisProject` / `polar` / `intersection` / etc. — `resolvePt` recurses
   * through whatever it's given.
   */
  | { kind: 'axisProject'; xFrom: PointRef; yFrom: PointRef };

// ────────────────────────────────────────────────────────────────────────────
// Layers + styling
// ────────────────────────────────────────────────────────────────────────────

/**
 * Line-style presets the user can pick per layer. Values are cut/gap segment
 * lengths in world mm — resolver multiplies by view.scale when rendering.
 *
 * Names follow the usual AutoCAD / ArtiosCAD conventions:
 *   - `solid`         unbroken
 *   - `dashed`        ── ── ──
 *   - `dotted`        · · · · ·
 *   - `dashdot`       ── · ── ·   (Strichpunkt / center line)
 *   - `dashdotdot`    ── · · ── · ·   (phantom)
 *   - `hidden`        short-dash (engineering "verdeckte Kante")
 *   - `cut`           long cut line (packaging: Schnittlinie)
 *   - `crease`        (packaging: Rilllinie — dash-dot)
 *   - `perforation`   short-cut / small-gap repeating
 *
 * Plus a custom option where the user types their own dash array (mm).
 */
export type LineStylePreset =
  | 'solid'
  | 'guide'
  | 'dashed'
  | 'dotted'
  | 'dashdot'
  | 'dashdotdot'
  | 'hidden'
  | 'cut'
  | 'crease'
  | 'perforation';

export type LineStyle =
  | LineStylePreset
  | { kind: 'custom'; pattern: number[] };

/**
 * World-mm dash patterns for each preset. Keep values on the small side so
 * patterns look right at human paper scale (A4 @ 1:1) but still read at zoom.
 * An empty array means "continuous" (no dash) — `solid` only.
 */
export const LINESTYLE_PATTERNS: Record<LineStylePreset, number[]> = {
  solid:        [],
  // `guide` = Hilfslinie — dedicated preset for construction lines. Matches
  // the fine dash used on the origin axes so the two read as the same kind of
  // reference element. Kept separate from `dashed` so users who want the
  // classic thick dash still get it via "Gestrichelt".
  guide:        [1.5, 1],
  dashed:       [5, 3],
  dotted:       [0.6, 2],
  dashdot:      [6, 2.5, 0.6, 2.5],
  dashdotdot:   [6, 2.5, 0.6, 2.5, 0.6, 2.5],
  hidden:       [2.5, 1.5],
  cut:          [8, 3],
  crease:       [4, 1.5, 0.5, 1.5],
  perforation:  [1.5, 1.5],
};

/** Human-readable labels for the preset picker. */
export const LINESTYLE_LABELS: Record<LineStylePreset, string> = {
  solid:        'Durchgezogen',
  guide:        'Hilfslinie',
  dashed:       'Gestrichelt',
  dotted:       'Punktiert',
  dashdot:      'Strichpunkt (Mittellinie)',
  dashdotdot:   'Strich-Zweipunkt',
  hidden:       'Verdeckte Kante',
  cut:          'Schnittlinie',
  crease:       'Rilllinie',
  perforation:  'Perforation',
};

/** All preset keys — drives the dropdown rendering order. Hilfslinie sits
 *  right after "Durchgezogen" because it's by far the most common "reference"
 *  pick; the other presets then go from sparse to dense. */
export const LINESTYLE_ORDER: LineStylePreset[] = [
  'solid', 'guide', 'dashed', 'dotted', 'dashdot', 'dashdotdot',
  'hidden', 'cut', 'crease', 'perforation',
];

/**
 * Resolve a Layer.style (including legacy strings) to a normalised LineStyle.
 * Accepts:
 *   - undefined → 'solid'
 *   - legacy 'dash' → 'dashed'
 *   - preset name or custom object → pass-through
 */
export function resolveLineStyle(s: Layer['style']): LineStyle {
  if (!s) return 'solid';
  if (typeof s === 'string') {
    // Legacy: the old type allowed only 'solid' | 'dash'. Map 'dash' → 'dashed'
    // so saved drawings keep the same look after the type widened.
    if ((s as string) === 'dash') return 'dashed';
    // Any other preset name is already a LineStylePreset.
    return s as LineStylePreset;
  }
  if (s.kind === 'custom') return s;
  return 'solid';
}

/** World-mm dash array for a LineStyle. `[]` means solid. */
export function patternForLineStyle(s: LineStyle): number[] {
  if (typeof s === 'string') return LINESTYLE_PATTERNS[s] ?? [];
  if (s.kind === 'custom') return s.pattern.filter(v => v > 0);
  return [];
}

export type Layer = {
  name: string;
  color: string;
  visible: boolean;
  locked?: boolean;
  /**
   * Line style. Legacy files persist the old string union (`'solid' | 'dash'`);
   * that still loads because 'solid' is a valid preset and the loader maps the
   * old `'dash'` value to the new `'dashed'` preset on read.
   */
  style?: LineStyle;
};

export type DimStyle = 'arrow' | 'open' | 'tick' | 'arch';
/** Where the dim label sits along the dim line (linear) / arc (angular) /
 *  leader (radius/diameter). `center` is the default (midpoint); `start` hugs
 *  the first-point end, `end` hugs the second-point end. */
export type DimTextAlign = 'start' | 'center' | 'end';

/**
 * Dim *mode* (not style). Controls the interaction flow of the dim tool,
 * not the visual appearance of the end-cap.
 *
 *   - `single`: classic linear — pick p1, p2, offset. Tool resets to pick1.
 *   - `chain`:  first dim picked like `single`, then every subsequent click
 *               extends the chain (new p1 = previous p2, same offset line).
 *   - `auto`:   one click per edge. The tool picks the nearest line / rect-edge /
 *               polyline segment under the cursor and auto-places a dim with
 *               a default paper-mm offset. Good for quickly dimensioning a
 *               whole polyline without three clicks per segment.
 */
export type DimMode = 'single' | 'chain' | 'auto';

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
export type TextEntity      = EntityBase & {
  type: 'text';
  x: number; y: number;
  text: string; height: number;
  rotation?: number;
  /**
   * Frame width for Rahmentext (wrapped text). When set, `text` is word-wrapped
   * to `boxWidth` world-units and the anchor `(x, y)` is the TOP-LEFT of the
   * frame. When undefined, the entity is Grafiktext: no wrap, anchor is the
   * baseline of the last line (bottom-left) with extra lines stacking upward.
   */
  boxWidth?: number;
};
/**
 * A dim can be either linear (distance between two points, offset outward) or
 * angular (angle between two rays from a shared vertex).
 *
 * For angular dims, `p1`/`p2`/`offset` are kept populated with fallback values
 * (`p1` = vertex, `p2` = a point on ray 1, `offset` = arc anchor) so legacy
 * code paths that only read those three fields still produce sensible bounds
 * and hit areas. The authoritative geometry lives in `vertex`, `ray1`, `ray2`.
 *
 * `offset` for angular dims doubles as the arc anchor — its distance from
 * `vertex` sets the arc radius, and it must lie in the sector that's being
 * measured (disambiguates which of the 4 sectors around two crossing lines
 * the dim refers to).
 */
export type DimKind = 'linear' | 'angular' | 'radius' | 'diameter';
/** Sub-mode of the Radius tool: which of R/Ø the tool commits by default. */
export type RadiusMode = 'radius' | 'diameter';
export type DimEntity       = EntityBase & {
  type: 'dim';
  dimKind?: DimKind;
  p1: Pt; p2: Pt; offset: Pt;
  /** Angular only. */
  vertex?: Pt;
  ray1?: Pt;
  ray2?: Pt;
  textHeight: number;
  style?: DimStyle;
  textAlign?: DimTextAlign;
};

/**
 * Hatch / fill entity — a filled or stripe-patterned closed region.
 *
 *   mode = 'solid' → flat color fill.
 *   mode = 'lines' → parallel stripe lines at `angle` with `spacing`.
 *   mode = 'cross' → two perpendicular stripe families (cross-hatching).
 *
 * `pts` is the closed boundary polygon (copy-evaluated from the picked shape
 * at commit time; the hatch doesn't stay linked to the source shape, so if the
 * source later moves the hatch doesn't follow — a limitation that keeps v1
 * simple and matches typical CAD "explode on create" behaviour). `angle` is in
 * radians; `spacing` is in world units. `color` (optional) overrides the
 * layer colour for solid fills.
 */
export type HatchMode = 'solid' | 'lines' | 'cross';
export type HatchEntity     = EntityBase & {
  type: 'hatch';
  mode: HatchMode;
  /** Outer boundary polygon. Implicitly closed (no duplicate trailing pt). */
  pts: Pt[];
  /** Optional inner boundaries ("holes"). Rendered via even-odd fill/clip so
   *  the hatch pattern stops at each hole's edge. Each hole polygon is
   *  implicitly closed, like `pts`. */
  holes?: Pt[][];
  angle?: number;
  spacing?: number;
  color?: string;
};

export type Entity =
  | LineEntity | PolylineEntity | RectEntity | CircleEntity | ArcEntity
  | EllipseEntity | SplineEntity | XLineEntity | TextEntity | DimEntity
  | HatchEntity;

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
  | Omit<DimEntity,      'id'>
  | Omit<HatchEntity,    'id'>;

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
  | Omit<DimEntity,      'id' | 'layer'> & { layer?: number }
  | Omit<HatchEntity,    'id' | 'layer'> & { layer?: number };

/** Preview payload carried on `runtime.toolCtx.preview` and drawn by render.ts. */
export type Preview =
  | EntityShape
  | { type: 'group'; entities: EntityShape[] };

// ────────────────────────────────────────────────────────────────────────────
// Snap
// ────────────────────────────────────────────────────────────────────────────

export type SnapPoint = {
  type: 'end' | 'mid' | 'int' | 'center' | 'axis' | 'grid' | 'tangent' | 'perp'
      | 'polar' | 'track';
  x: number;
  y: number;
  entityId?: number;
  /** Second entity id for intersection snaps (the two lines being intersected). */
  entityId2?: number;
  /**
   * Polar/tracking metadata — present only on 'polar' and 'track' points.
   * `origin` is the anchor the guide emanates from (the active draw anchor
   * for polar, the acquired tracking point for track). `angleRad` is the
   * guide's direction. These let the renderer draw the dashed guide line
   * without re-deriving it from neighbours.
   */
  origin?: Pt;
  angleRad?: number;
  /**
   * Second guide origin/angle for intersections of two guides (e.g. polar ×
   * track, or track × track). When set, the renderer draws both guides.
   */
  origin2?: Pt;
  angleRad2?: number;
  /**
   * Which sub-segment of `entityId` produced this snap. Populated for
   * perp / end / mid snaps on multi-edge targets (rects, polylines) so
   * the line tool can build a parametric `rayHit` PointRef that keeps
   * tracking that specific edge when the target's variables change.
   * Absent for point-like features (circle center, intersection glyphs).
   */
  edge?: FeatureEdgeRef;
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
  /** Origin axes (X=red, Y=green, fine dashed through world-origin with X/Y
   *  labels at the positive tips). Not a snap source — purely a viewport
   *  reference. Toggleable next to the grid in the snap toolbar. */
  showAxes: boolean;
  /** Polar tracking: emit a guide from the active draw anchor at multiples
   *  of `polarAngleDeg`, and snap the cursor onto the nearest matching ray. */
  polar: boolean;
  /** Object-snap tracking: acquire hovered end/mid/center points and emit
   *  H/V guides from them. Cursor snaps onto guides (and their intersections
   *  with other guides or polar rays). */
  tracking: boolean;
  /** Polar increment in degrees (default 45). */
  polarAngleDeg: number;
};

// ────────────────────────────────────────────────────────────────────────────
// Features — persisted timeline entries
// ────────────────────────────────────────────────────────────────────────────

type FeatureBase = {
  id: string;
  layer: number;
  /**
   * True when a feature is kept alive only as a parametric reference for
   * other features (its geometry doesn't render, but `evaluateTimeline()`
   * still fills `ctx` so PointRef targets still resolve and variables still
   * propagate). Set by `deleteFeatures` when the user tries to delete a
   * feature that others still reference. Falsy / undefined → normal feature.
   */
  hidden?: boolean;
};

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
/**
 * Parallel helper line whose reference is one of the virtual origin axes
 * (rendered by the viewport, not an entity). Behaves exactly like a
 * `parallelXLine` but binds to the X or Y axis by name — so the distance
 * expression stays live when the user edits variables, even though the axes
 * themselves aren't part of the feature graph.
 *
 * `axis: 'x'` → offset from the X-axis (horizontal line, y = side·distance)
 * `axis: 'y'` → offset from the Y-axis (vertical line,   x = side·distance)
 */
export type AxisParallelXLineFeature = FeatureBase & {
  kind: 'axisParallelXLine';
  axis: 'x' | 'y';
  distance: Expr;
  side: 1 | -1;
};
export type TextFeature      = FeatureBase & {
  kind: 'text';
  p: PointRef;
  text: string;
  height: Expr;
  rotation: Expr;
  /** See TextEntity.boxWidth — undefined = Grafiktext, number = Rahmentext. */
  boxWidth?: Expr;
};
export type DimFeature       = FeatureBase & {
  kind: 'dim';
  dimKind?: DimKind;
  p1: PointRef; p2: PointRef; offset: PointRef;
  /** Angular only. */
  vertex?: PointRef;
  ray1?: PointRef;
  ray2?: PointRef;
  textHeight: Expr;
  style?: DimStyle;
  textAlign?: DimTextAlign;
};

/** Hatch / fill feature — parametric source for a HatchEntity. `pts` holds the
 *  boundary polygon as PointRefs (usually all abs-refs at commit time; future
 *  versions may link a hatch to its source shape). */
export type HatchFeature    = FeatureBase & {
  kind: 'hatch';
  mode: HatchMode;
  pts: PointRef[];
  /** Optional inner boundaries, one PointRef list per hole. */
  holes?: PointRef[][];
  angle?: Expr;
  spacing?: Expr;
  color?: string;
};

// ────────────────────────────────────────────────────────────────────────────
// Modifier features — re-executable transforms that keep the result
// parametrically linked to their sources. Unlike `transformSelection(..., copy)`,
// a modifier feature re-runs on every `evaluateTimeline()`, so when a source
// feature's variables change, the transformed copies update automatically.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Mirror axis — either defined by two arbitrary points, or bound to a virtual
 * world axis (the renderer's origin X/Y lines). `twoPoints` stores PointRefs
 * so the axis itself can be anchored to other features (endpoints of a line,
 * center of a circle, etc.) and stays parametric.
 */
export type MirrorAxis =
  | { kind: 'twoPoints'; p1: PointRef; p2: PointRef }
  | { kind: 'worldAxis'; axis: 'x' | 'y' };

/**
 * Mirror feature — reflects every source feature across `axis`. Re-evaluated
 * with the timeline, so parameter edits on the sources (or on the axis points)
 * propagate into the mirrored geometry.
 *
 * `sourceIds` are the feature ids being mirrored. Each produces one mirrored
 * sub-entity. If `keepOriginal` is false the caller removed the sources from
 * the feature list (move-style mirror); if true they stay (copy-style mirror).
 * The flag is stored for introspection / UI, not for eval logic.
 */
export type MirrorFeature = FeatureBase & {
  kind: 'mirror';
  sourceIds: string[];
  axis: MirrorAxis;
  keepOriginal: boolean;
};

/**
 * Array feature — repeats the source features along one (linear) or two
 * (matrix) step vectors. The step vectors are defined by two PointRefs each so
 * they stay parametric: if the user clicked endpoints of a line to define the
 * offset, resizing that line will resize the array step.
 *
 * `cols` × `rows` is the total count *including* the source cell (which is the
 * source feature itself). A 2×1 array adds one copy along `offset`; a 3×2
 * array adds five copies (positions (0,1),(1,0),(1,1),(2,0),(2,1)).
 */
export type ArrayFeature = FeatureBase & {
  kind: 'array';
  sourceIds: string[];
  mode: 'linear' | 'matrix';
  offset: { p1: PointRef; p2: PointRef };
  /** Total columns along `offset`. ≥1; 1 means no repeat along this axis. */
  cols: Expr;
  /** Total rows perpendicular (matrix mode only). ≥1. */
  rows: Expr;
  /** Optional explicit row step. If absent, auto-perp to `offset` (90° CCW). */
  rowOffset?: { p1: PointRef; p2: PointRef };
};

/**
 * Rotate feature — rotates the source features around `center` by `angle`
 * degrees. Single-instance rotation copy; for polar arrays use ArrayFeature
 * with a polar mode later.
 */
export type RotateFeature = FeatureBase & {
  kind: 'rotate';
  sourceIds: string[];
  center: PointRef;
  /** Rotation angle in **degrees**, evaluated live so variables propagate. */
  angle: Expr;
  keepOriginal: boolean;
};

/**
 * Cross-mirror feature — ArtiosCAD-style symmetry tool. Around a centre point,
 * a single source feature is reflected across two perpendicular axes and
 * rotated 180°, producing up to three additional copies so the user only has
 * to draw one quarter (variant='quarter') or half (variant='half') of a
 * symmetric design.
 *
 *   variant='quarter' → emits three copies per source:
 *                         m1 = reflect across axis at `angle°`
 *                         m2 = reflect across axis at `angle+90°`
 *                         m3 = rotate 180° around centre (=reflect both)
 *   variant='half'    → emits one copy per source (m1), same axis semantics.
 *
 * Re-evaluated with the timeline so moving the centre (or editing the source
 * geometry) updates every copy live. Sub-entity subkeys use the form
 * "sid@m1", "sid@m2", "sid@m3" — the `@` separator keeps them distinguishable
 * from array subkeys ("sid|col|row").
 */
export type CrossMirrorFeature = FeatureBase & {
  kind: 'crossMirror';
  sourceIds: string[];
  center: PointRef;
  /** Axis rotation in degrees (first mirror axis; second is +90° from it). */
  angle: Expr;
  variant: 'quarter' | 'half';
  keepOriginal: true;
};

export type Feature =
  | LineFeature | PolylineFeature | RectFeature | CircleFeature | ArcFeature
  | EllipseFeature | SplineFeature | XLineFeature | ParallelXLineFeature
  | AxisParallelXLineFeature
  | TextFeature | DimFeature | HatchFeature
  | MirrorFeature | ArrayFeature | RotateFeature | CrossMirrorFeature;

// ────────────────────────────────────────────────────────────────────────────
// Tool identity + per-tool state
// ────────────────────────────────────────────────────────────────────────────

export type ToolId =
  | 'select' | 'select_similar' | 'pan'
  | 'line' | 'polyline' | 'rect' | 'circle' | 'circle3' | 'arc3'
  | 'ellipse' | 'spline' | 'polygon' | 'text'
  | 'xline' | 'dim'
  | 'move' | 'copy' | 'rotate' | 'mirror' | 'cross_mirror' | 'stretch' | 'scale'
  | 'fillet' | 'chamfer' | 'extend' | 'extend_to' | 'trim' | 'offset' | 'line_offset' | 'delete'
  /* Design-file additions */
  | 'point' | 'axis' | 'ref_circle' | 'angle' | 'radius' | 'hatch' | 'fill'
  | 'divide_xline';

/**
 * Mode of the "Linie versetzen" tool:
 *   - 'line':    just duplicates the line, translated by the offset vector.
 *   - 'connect': same, plus two connector lines at the endpoints, closing the
 *                offset into a parallelogram/rectangle.
 *
 * The "Winkel" toggle (runtime.lineOffsetUseAngle) is independent of this
 * mode — it controls whether the cmdbar exposes an angle input field for
 * non-perpendicular offsets.
 */
export type LineOffsetMode = 'line' | 'connect';

/**
 * Sub-mode of the Symmetrie (cross-mirror) tool:
 *   - 'quarter': 1/4-Symmetrie — reflect across both axes + 180° rotation
 *                (three extra copies per source).
 *   - 'half_h':  1/2-Symmetrie horizontal — reflect across the vertical axis
 *                through the centre → copy flips left↔right, e.g. drawing on
 *                the left is duplicated to the right.
 *   - 'half_v':  1/2-Symmetrie vertikal — reflect across the horizontal axis
 *                through the centre → copy flips top↕bottom.
 * Persisted via localStorage; toggled via the top-of-canvas picker while the
 * cross_mirror tool is active.
 */
export type CrossMirrorMode = 'quarter' | 'half_h' | 'half_v';

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
  distanceExpr?: Expr | null;
  angleExpr?: Expr | null;
  ref?: Entity | { _axis: 'x' | 'y' };
  dir?: Pt;
  base?: Pt;
  entity?: Entity;
  entities?: Entity[];
  entity1?: Entity;
  entity2?: Entity;
  click1?: Pt;
  click2?: Pt;
  radius?: number | null;
  distance?: number | null;
  basePt?: Pt;
  /** Parametric ref for the move/copy base click. When the user snaps the
   *  base to a feature-backed point (END/MITTE/SCHN/ZENTR), we keep the link
   *  so the resulting ArrayFeature's offset tracks that anchor. */
  basePtRef?: PointRef | null;
  centerPt?: Pt;
  /** Parametric ref for the rotate/scale centre click. */
  centerPtRef?: PointRef | null;
  a1?: Pt;
  /** Parametric ref for the first mirror-axis click. */
  a1Ref?: PointRef | null;
  refLen?: number;
  textHeight?: number;
  p1Ref?: PointRef | null;
  ptRefs?: (PointRef | null)[];
  /** Parametric reference for the circle/arc/ellipse center point. When set,
   *  the commit builds the feature with this ref instead of an abs coord, so
   *  changes to the underlying entity/variable propagate into the circle. */
  centerRef?: PointRef | null;
  /** Which side of the chord the cursor is currently on during the arc tool's
   *  bulge step (+1 = left of p1→p2 direction, -1 = right). The numeric
   *  "Höhe" entry in cmdbar picks up this sign so users can type a positive
   *  magnitude and the arc honors the side they were hovering on. */
  bulgeSide?: 1 | -1;
  /** Chain-dim carry-over: absolute offset point of the previous dim segment so
   *  successive clicks reuse the same dim line. Only used by the dim tool. */
  dimOffset?: Pt;
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
  /**
   * Persisted project metadata (title block fields, logo, last-used template).
   * Survives reloads via localStorage. Separated from drawing data because
   * these values are per-user rather than per-file.
   */
  projectMeta: ProjectMeta;
};

// ────────────────────────────────────────────────────────────────────────────
// Import / Export
// ────────────────────────────────────────────────────────────────────────────

/** File formats supported by the I/O router. SVG export is legacy. */
export type ExportFormat = 'pdf' | 'dxf' | 'eps' | 'svg';

/**
 * Built-in PDF print templates. `custom-1to1` is a special case: the paper
 * dimensions are derived from the drawing's bbox + margin, and no title block
 * or plot frame is drawn.
 */
export type PdfTemplateId =
  | 'a4-landscape-1to50'
  | 'a4-landscape-1to100'
  | 'a4-portrait-fit'
  | 'a3-landscape-1to50'
  | 'a3-landscape-1to100'
  | 'a2-landscape-1to50'
  | 'custom-1to1';

/**
 * Title-block data for PDF export. Every field is optional; missing values
 * render as an em-dash ("—") so labels stay visible.
 */
export type TitleBlockData = {
  projectName?: string;
  drawingTitle?: string;
  drawingNumber?: string;
  author?: string;
  revision?: string;
  date?: string;            // DD.MM.YYYY — auto-set on export if missing
  format?: string;          // e.g. "A3 Querformat", auto-derived from template
  scale?: string;           // e.g. "1:50" / "1:1", auto-derived from template
  companyAddress?: string;  // 3 lines max, rendered below the block
  /** DataURL of user-uploaded logo (PNG/JPEG). Empty → logo cell stays blank. */
  logoDataUrl?: string;
};

/**
 * Persisted project metadata — lives in `state.projectMeta` and localStorage.
 * Note the overlap with `TitleBlockData`: these fields default into the
 * title-block fields on every export, but the export dialog may override them
 * for a single export without mutating the persisted copy.
 */
export type ProjectMeta = {
  name: string;
  drawingTitle: string;
  drawingNumber: string;
  author: string;
  revision: string;
  companyAddress: string;
  /** DataURL (PNG/JPEG). Empty string = no logo. */
  logoDataUrl: string;
  /** Last-used PDF template, pre-selected in the export dialog. */
  lastTemplate: PdfTemplateId;
};

/** Options consumed by `exportDrawing()` — discriminated by `format`. */
export type ExportOptions =
  | { format: 'pdf'; template: PdfTemplateId; titleBlock: TitleBlockData; filename?: string }
  | { format: 'dxf'; filename?: string }
  | { format: 'eps'; filename?: string }
  | { format: 'svg'; filename?: string };

/**
 * Result returned by every import parser. `skipped` counts entities the
 * parser recognised but chose not to import (text, hatches, splines in
 * phase 1, etc.) — shown to the user as a toast.
 */
export type ImportResult = {
  entities: EntityInit[];
  /** Per-category skip counters. Any key with count > 0 surfaces in the toast. */
  skipped: {
    text?: number;
    hatch?: number;
    spline?: number;
    insert?: number;
    unknown?: number;
  };
  /** Source filename (for the confirmation toast). */
  filename: string;
  /** Detected source format — lets the toast say "DXF" vs "EPS" vs "PDF". */
  format: Exclude<ExportFormat, 'svg'>;
};
