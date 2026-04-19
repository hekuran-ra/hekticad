import type {
  Entity, EntityInit, Expr, Feature, LineEntity, PointRef, Pt, XLineEntity,
} from './types';
import { state } from './state';
import { evalExpr, exprLabel } from './params';
import { intersectLines } from './snap';

export function newFeatureId(): string {
  return 'f' + Math.random().toString(36).slice(2, 8);
}

/** Well-known IDs for the two permanent origin-axis xlines. */
export const AXIS_X_ID = '_axis_x';
export const AXIS_Y_ID = '_axis_y';

/**
 * Ensure the two locked origin xlines (X and Y axes) exist in the timeline.
 * Idempotent — call after load, clear, or any state reset.
 * The axes live on the first layer that has `locked: true`; if none exists,
 * an "Achsen" layer is appended.
 */
export function ensureAxisFeatures(): void {
  let axLayer = state.layers.findIndex(l => l.locked);
  if (axLayer < 0) {
    state.layers.push({ name: 'Achsen', color: '#4a5060', visible: true, locked: true, style: 'dash' });
    axLayer = state.layers.length - 1;
  }
  const n = (v: number) => ({ kind: 'num' as const, value: v });
  const abs0: PointRef = { kind: 'abs', x: n(0), y: n(0) };
  if (!state.features.find(f => f.id === AXIS_X_ID)) {
    state.features.unshift({
      id: AXIS_X_ID, kind: 'xline', layer: axLayer,
      p: abs0, dx: n(1), dy: n(0),
    });
  }
  if (!state.features.find(f => f.id === AXIS_Y_ID)) {
    state.features.unshift({
      id: AXIS_Y_ID, kind: 'xline', layer: axLayer,
      p: abs0, dx: n(0), dy: n(1),
    });
  }
}

/**
 * Evaluation context: the single entity produced by each feature so far,
 * keyed by feature id. Later features resolve PointRefs against this map.
 */
type EvalCtx = Map<string, Entity>;

/**
 * Stable entity id per feature. Seeded on first evaluation, reused on every
 * subsequent `evaluateTimeline()` so selection and hit-tests survive re-evals.
 * Dropped when a feature is deleted.
 */
const featureEntityIds = new Map<string, number>();

/** Inverse of `featureEntityIds` — rebuilt on every `evaluateTimeline()`. */
const entityToFeature = new Map<number, string>();

export function featureForEntity(entityId: number): Feature | null {
  const fid = entityToFeature.get(entityId);
  if (!fid) return null;
  return state.features.find(f => f.id === fid) ?? null;
}

export function entityIdForFeature(featureId: string): number | null {
  const eid = featureEntityIds.get(featureId);
  return eid ?? null;
}

/**
 * Re-assign an entity's underlying feature to a new layer. The feature is the
 * persistent truth — reassigning it is what survives timeline re-evaluation.
 * Returns true on success, false if the entity or its feature cannot be found
 * or its current layer is locked (locked-layer geometry stays put).
 */
export function moveEntityToLayer(entityId: number, layerIndex: number): boolean {
  const feat = featureForEntity(entityId);
  if (!feat) return false;
  if (state.layers[feat.layer]?.locked) return false;
  if (layerIndex < 0 || layerIndex >= state.layers.length) return false;
  feat.layer = layerIndex;
  return true;
}

function resolvePt(ref: PointRef, ctx: EvalCtx): Pt {
  switch (ref.kind) {
    case 'abs':
      return { x: evalExpr(ref.x), y: evalExpr(ref.y) };
    case 'endpoint': {
      const e = ctx.get(ref.feature);
      if (!e) return { x: NaN, y: NaN };
      return endpointOf(e, ref.end);
    }
    case 'center': {
      const e = ctx.get(ref.feature);
      if (!e) return { x: NaN, y: NaN };
      return centerOf(e);
    }
    case 'mid': {
      const e = ctx.get(ref.feature);
      if (!e) return { x: NaN, y: NaN };
      return midOf(e);
    }
    case 'intersection': {
      const e1 = ctx.get(ref.feature1);
      const e2 = ctx.get(ref.feature2);
      if (!e1 || !e2) return { x: NaN, y: NaN };
      if ((e1.type !== 'line' && e1.type !== 'xline') ||
          (e2.type !== 'line' && e2.type !== 'xline')) return { x: NaN, y: NaN };
      const ip = intersectLines(
        e1 as LineEntity | XLineEntity,
        e2 as LineEntity | XLineEntity,
      );
      return ip ?? { x: NaN, y: NaN };
    }
  }
}

function endpointOf(e: Entity, end: 0 | 1): Pt {
  if (e.type === 'line') return end === 0 ? { x: e.x1, y: e.y1 } : { x: e.x2, y: e.y2 };
  if (e.type === 'polyline') {
    const i = end === 0 ? 0 : e.pts.length - 1;
    return e.pts[i];
  }
  if (e.type === 'rect') {
    return end === 0 ? { x: e.x1, y: e.y1 } : { x: e.x2, y: e.y2 };
  }
  if (e.type === 'xline') {
    return end === 0 ? { x: e.x1, y: e.y1 } : { x: e.x1 + e.dx, y: e.y1 + e.dy };
  }
  return { x: NaN, y: NaN };
}

function centerOf(e: Entity): Pt {
  if (e.type === 'circle' || e.type === 'arc' || e.type === 'ellipse') return { x: e.cx, y: e.cy };
  if (e.type === 'rect') return { x: (e.x1 + e.x2) / 2, y: (e.y1 + e.y2) / 2 };
  return { x: NaN, y: NaN };
}

function midOf(e: Entity): Pt {
  if (e.type === 'line') return { x: (e.x1 + e.x2) / 2, y: (e.y1 + e.y2) / 2 };
  return { x: NaN, y: NaN };
}

function xlineBaseOf(ref: Entity): { x: number; y: number; dx: number; dy: number } | null {
  if (ref.type === 'line') {
    const dx = ref.x2 - ref.x1, dy = ref.y2 - ref.y1;
    const L = Math.hypot(dx, dy);
    if (L < 1e-9) return null;
    return { x: ref.x1, y: ref.y1, dx: dx / L, dy: dy / L };
  }
  if (ref.type === 'xline') {
    return { x: ref.x1, y: ref.y1, dx: ref.dx, dy: ref.dy };
  }
  return null;
}

/** Allocate (or look up) the stable entity id for a feature. */
function allocEntityId(fid: string): number {
  const existing = featureEntityIds.get(fid);
  if (existing !== undefined) return existing;
  const id = state.nextId++;
  featureEntityIds.set(fid, id);
  return id;
}

/**
 * Evaluate one feature. Returns the single entity it produces, or null if
 * the feature is ill-defined (e.g. parallelXLine referencing a deleted line).
 */
function buildEntity(f: Feature, ctx: EvalCtx): Entity | null {
  const id = allocEntityId(f.id);
  switch (f.kind) {
    case 'line': {
      const a = resolvePt(f.p1, ctx), b = resolvePt(f.p2, ctx);
      return { id, type: 'line', layer: f.layer, x1: a.x, y1: a.y, x2: b.x, y2: b.y };
    }
    case 'polyline': {
      const pts = f.pts.map(r => resolvePt(r, ctx));
      return { id, type: 'polyline', layer: f.layer, pts, closed: f.closed };
    }
    case 'rect': {
      const a = resolvePt(f.p1, ctx);
      const w = evalExpr(f.width), h = evalExpr(f.height);
      return {
        id, type: 'rect', layer: f.layer,
        x1: a.x, y1: a.y,
        x2: a.x + f.signX * w, y2: a.y + f.signY * h,
      };
    }
    case 'circle': {
      const c = resolvePt(f.center, ctx);
      const r = Math.max(1e-9, evalExpr(f.radius));
      return { id, type: 'circle', layer: f.layer, cx: c.x, cy: c.y, r };
    }
    case 'arc': {
      const c = resolvePt(f.center, ctx);
      const r = Math.max(1e-9, evalExpr(f.radius));
      return {
        id, type: 'arc', layer: f.layer,
        cx: c.x, cy: c.y, r,
        a1: evalExpr(f.a1), a2: evalExpr(f.a2),
      };
    }
    case 'ellipse': {
      const c = resolvePt(f.center, ctx);
      return {
        id, type: 'ellipse', layer: f.layer,
        cx: c.x, cy: c.y,
        rx: Math.max(1e-9, evalExpr(f.rx)),
        ry: Math.max(1e-9, evalExpr(f.ry)),
        rot: evalExpr(f.rot),
      };
    }
    case 'spline': {
      const pts = f.pts.map(r => resolvePt(r, ctx));
      return { id, type: 'spline', layer: f.layer, pts, closed: f.closed };
    }
    case 'xline': {
      const p = resolvePt(f.p, ctx);
      return {
        id, type: 'xline', layer: f.layer,
        x1: p.x, y1: p.y, dx: evalExpr(f.dx), dy: evalExpr(f.dy),
      };
    }
    case 'parallelXLine': {
      const ref = ctx.get(f.refFeature);
      if (!ref) return null;
      const base = xlineBaseOf(ref);
      if (!base) return null;
      const d = evalExpr(f.distance);
      const nx = -base.dy, ny = base.dx;
      return {
        id, type: 'xline', layer: f.layer,
        x1: base.x + nx * d * f.side,
        y1: base.y + ny * d * f.side,
        dx: base.dx, dy: base.dy,
      };
    }
    case 'text': {
      const p = resolvePt(f.p, ctx);
      return {
        id, type: 'text', layer: f.layer,
        x: p.x, y: p.y, text: f.text,
        height: evalExpr(f.height), rotation: evalExpr(f.rotation),
      };
    }
    case 'dim': {
      return {
        id, type: 'dim', layer: f.layer,
        p1: resolvePt(f.p1, ctx), p2: resolvePt(f.p2, ctx),
        offset: resolvePt(f.offset, ctx),
        textHeight: evalExpr(f.textHeight),
        ...(f.style ? { style: f.style } : {}),
      };
    }
  }
}

/**
 * Re-evaluate the entire timeline. Rebuilds `state.entities` from features in
 * order. Entity ids are stable across re-evaluations (via featureEntityIds),
 * so current selection and tool contexts remain valid.
 */
export function evaluateTimeline(): void {
  const ctx: EvalCtx = new Map();
  const out: Entity[] = [];
  const alive = new Set<string>();
  for (const f of state.features) {
    alive.add(f.id);
    const e = buildEntity(f, ctx);
    if (e) {
      out.push(e);
      ctx.set(f.id, e);
    }
  }
  // Drop stable-id bindings for deleted features.
  for (const fid of Array.from(featureEntityIds.keys())) {
    if (!alive.has(fid)) featureEntityIds.delete(fid);
  }
  state.entities = out;
  entityToFeature.clear();
  for (const [fid, eid] of featureEntityIds) entityToFeature.set(eid, fid);
}

// ============================================================================
// Feature construction + editing helpers
// ============================================================================

function numE(v: number): Expr { return { kind: 'num', value: v }; }
function absPt(p: Pt): PointRef {
  return { kind: 'abs', x: numE(p.x), y: numE(p.y) };
}

/** Build a feature whose geometry matches `init` with all-abs, all-num values. */
export function featureFromEntityInit(init: EntityInit, id: string = newFeatureId()): Feature {
  const layer = init.layer;
  switch (init.type) {
    case 'line':
      return { id, kind: 'line', layer,
        p1: absPt({ x: init.x1, y: init.y1 }),
        p2: absPt({ x: init.x2, y: init.y2 }) };
    case 'polyline':
      return { id, kind: 'polyline', layer,
        pts: init.pts.map(absPt), closed: !!init.closed };
    case 'rect':
      return { id, kind: 'rect', layer,
        p1: absPt({ x: init.x1, y: init.y1 }),
        width:  numE(Math.abs(init.x2 - init.x1)),
        height: numE(Math.abs(init.y2 - init.y1)),
        signX: init.x2 >= init.x1 ? 1 : -1,
        signY: init.y2 >= init.y1 ? 1 : -1 };
    case 'circle':
      return { id, kind: 'circle', layer,
        center: absPt({ x: init.cx, y: init.cy }),
        radius: numE(init.r) };
    case 'arc':
      return { id, kind: 'arc', layer,
        center: absPt({ x: init.cx, y: init.cy }),
        radius: numE(init.r),
        a1: numE(init.a1), a2: numE(init.a2) };
    case 'ellipse':
      return { id, kind: 'ellipse', layer,
        center: absPt({ x: init.cx, y: init.cy }),
        rx: numE(init.rx), ry: numE(init.ry),
        rot: numE(init.rot) };
    case 'spline':
      return { id, kind: 'spline', layer,
        pts: init.pts.map(absPt), closed: !!init.closed };
    case 'xline':
      return { id, kind: 'xline', layer,
        p: absPt({ x: init.x1, y: init.y1 }),
        dx: numE(init.dx), dy: numE(init.dy) };
    case 'text':
      return { id, kind: 'text', layer,
        p: absPt({ x: init.x, y: init.y }),
        text: init.text,
        height: numE(init.height),
        rotation: numE(init.rotation ?? 0) };
    case 'dim':
      return { id, kind: 'dim', layer,
        p1: absPt(init.p1), p2: absPt(init.p2),
        offset: absPt(init.offset),
        textHeight: numE(init.textHeight),
        ...(init.style ? { style: init.style } : {}) };
  }
}

/**
 * Append a feature built from an EntityInit. Returns its feature id so callers
 * can resolve back to the generated entity id via `entityIdForFeature`.
 */
export function addFeatureFromInit(init: EntityInit): string {
  const f = featureFromEntityInit(init);
  state.features.push(f);
  evaluateTimeline();
  return f.id;
}

/**
 * Replace an existing feature's geometry by rebuilding it from a fresh
 * EntityInit, keeping the same feature id (and thus the same entity id).
 * Use when a transform keeps the source feature alive (move, rotate, mirror,
 * fillet-truncated lines, trim-survivor).
 */
export function replaceFeatureFromInit(oldId: string, init: EntityInit): boolean {
  const idx = state.features.findIndex(f => f.id === oldId);
  if (idx < 0) return false;
  const prev = state.features[idx];
  const next = featureFromEntityInit(init, oldId);
  // Preserve layer if the caller didn't explicitly change it.
  if (init.layer === undefined) next.layer = prev.layer;
  state.features[idx] = next;
  return true;
}

/** Drop a feature and cascade-delete anything that referenced it. */
export function deleteFeatures(ids: Iterable<string>): void {
  const kill = new Set<string>(ids);
  // Cascade: any feature whose refs point into `kill` also dies.
  let grew = true;
  while (grew) {
    grew = false;
    for (const d of findDependents(kill)) {
      if (!kill.has(d)) { kill.add(d); grew = true; }
    }
  }
  state.features = state.features.filter(f => !kill.has(f.id));
  evaluateTimeline();
}

/** Collect all feature-id strings that a PointRef depends on. */
function collectRefs(pt: PointRef): string[] {
  if (pt.kind === 'abs') return [];
  if (pt.kind === 'intersection') return [pt.feature1, pt.feature2];
  return [pt.feature];
}

function findDependents(killed: Set<string>): string[] {
  const result: string[] = [];
  for (const f of state.features) {
    if (killed.has(f.id)) continue;
    const seen: string[] = [];
    switch (f.kind) {
      case 'line':     seen.push(...collectRefs(f.p1), ...collectRefs(f.p2)); break;
      case 'polyline': for (const p of f.pts) seen.push(...collectRefs(p)); break;
      case 'rect':     seen.push(...collectRefs(f.p1)); break;
      case 'circle':   seen.push(...collectRefs(f.center)); break;
      case 'arc':      seen.push(...collectRefs(f.center)); break;
      case 'ellipse':  seen.push(...collectRefs(f.center)); break;
      case 'spline':   for (const p of f.pts) seen.push(...collectRefs(p)); break;
      case 'xline':    seen.push(...collectRefs(f.p)); break;
      case 'parallelXLine': seen.push(f.refFeature); break;
      case 'text':     seen.push(...collectRefs(f.p)); break;
      case 'dim':      seen.push(...collectRefs(f.p1), ...collectRefs(f.p2), ...collectRefs(f.offset)); break;
    }
    if (seen.some(r => killed.has(r))) result.push(f.id);
  }
  return result;
}

// ============================================================================
// Timeline UI helpers
// ============================================================================

/** Short human-readable summary of a feature for the timeline panel. */
export function featureLabel(f: Feature): string {
  switch (f.kind) {
    case 'line':     return 'Linie';
    case 'polyline': return f.closed ? 'Polygon' : 'Polylinie';
    case 'rect':     return 'Rechteck';
    case 'circle':   return 'Kreis';
    case 'arc':      return 'Bogen';
    case 'ellipse':  return 'Ellipse';
    case 'spline':   return 'Spline';
    case 'xline':    return 'Hilfslinie';
    case 'parallelXLine': return 'Parallel';
    case 'text':     return 'Text';
    case 'dim':      return 'Bemaßung';
  }
}

/** Compact detail string (parameters, refs) for a feature. */
export function featureDetail(f: Feature): string {
  switch (f.kind) {
    case 'line':     return `${ptLabel(f.p1)} → ${ptLabel(f.p2)}`;
    case 'polyline': return `${f.pts.length} Punkte${f.closed ? ' (geschl.)' : ''}`;
    case 'rect':     return `${exprLabel(f.width)} × ${exprLabel(f.height)}`;
    case 'circle':   return `r = ${exprLabel(f.radius)}`;
    case 'arc':      return `r = ${exprLabel(f.radius)}`;
    case 'ellipse':  return `${exprLabel(f.rx)} × ${exprLabel(f.ry)}`;
    case 'spline':   return `${f.pts.length} Stützpunkte`;
    case 'xline':    return `(${exprLabel(f.dx)}, ${exprLabel(f.dy)})`;
    case 'parallelXLine':
      return `‖ ${f.refFeature.slice(0, 4)} · d = ${exprLabel(f.distance)}`;
    case 'text':
      return `"${f.text.slice(0, 14)}${f.text.length > 14 ? '…' : ''}"`;
    case 'dim':
      return `${ptLabel(f.p1)} ↔ ${ptLabel(f.p2)}`;
  }
}

function ptLabel(pt: PointRef): string {
  if (pt.kind === 'abs') return '·';
  if (pt.kind === 'intersection') {
    return `∩(${pt.feature1.slice(0, 4)}×${pt.feature2.slice(0, 4)})`;
  }
  return `${pt.kind}(${pt.feature.slice(0, 4)})`;
}
