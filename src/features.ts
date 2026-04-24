import type {
  ArrayFeature, ChamferFeature, ClipFeature, CrossMirrorFeature,
  Entity, EntityInit, Expr, Feature, FeatureEdgeRef, FilletFeature, LineEntity, MirrorAxis,
  MirrorFeature, PointRef, Pt, RotateFeature, XLineEntity,
} from './types';
import type { Grip } from './grips';
import { state } from './state';
import { evalExpr, exprLabel } from './params';
import { intersectLines } from './snap';

export function newFeatureId(): string {
  return 'f' + Math.random().toString(36).slice(2, 8);
}

/**
 * Well-known IDs of the old "axes as features" implementation. The axes are
 * now drawn directly by the renderer (see drawOriginAxes in render.ts) and
 * toggled from the snap toolbar, not modelled as features / layers. These
 * constants remain only so `ensureAxisFeatures()` can strip any legacy axis
 * features when loading older drawings, and so call sites that once filtered
 * on them keep compiling.
 */
export const AXIS_X_ID = '_axis_x';
export const AXIS_Y_ID = '_axis_y';

/**
 * Legacy migration: previously the two origin axes lived as locked xline
 * features on an "Achsen" layer. They now render directly from the viewport
 * renderer, so this function strips any stale axis features and their layer
 * from freshly loaded state. Safe to call on already-migrated state — it's a
 * no-op when nothing matches.
 */
export function ensureAxisFeatures(): void {
  // Drop legacy axis features.
  const before = state.features.length;
  state.features = state.features.filter(f => f.id !== AXIS_X_ID && f.id !== AXIS_Y_ID);
  const dropped = before - state.features.length;

  // Drop any leftover "Achsen" layer (by name, for robustness across older
  // saves where the layer index varied). Re-index `activeLayer` + every
  // feature's layer pointer when a layer is removed so nothing dangles.
  const axIdx = state.layers.findIndex(l => l.name === 'Achsen' && l.locked);
  if (axIdx >= 0) {
    state.layers.splice(axIdx, 1);
    for (const f of state.features) {
      if (f.layer > axIdx) f.layer -= 1;
      else if (f.layer === axIdx) f.layer = 0;
    }
    if (state.activeLayer > axIdx) state.activeLayer -= 1;
    else if (state.activeLayer === axIdx) state.activeLayer = 0;
    state.activeLayer = Math.max(0, Math.min(state.activeLayer, state.layers.length - 1));
  }

  // If we dropped features we need to re-evaluate the timeline; but io.ts
  // already calls evaluateTimeline() after ensureAxisFeatures(), so don't
  // re-trigger here. The variable is kept as a self-documenting no-op for
  // anyone reading the function body.
  void dropped;
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
  if (fid) return state.features.find(f => f.id === fid) ?? null;
  // Fallback: sub-entity of a modifier feature (Mirror etc.). Return the
  // modifier itself — callers get the owning feature, which is what selection,
  // timeline highlight, and delete expect.
  const modFid = entityToModifier.get(entityId);
  if (modFid) return state.features.find(f => f.id === modFid) ?? null;
  return null;
}

export function entityIdForFeature(featureId: string): number | null {
  const eid = featureEntityIds.get(featureId);
  return eid ?? null;
}

/**
 * Collect every feature id that `ref` points at (directly or transitively
 * through polar/intersection chains). `abs` refs contribute nothing. Used by
 * the linked-highlight pass to paint dashed overlays on parametric neighbours
 * of the current selection.
 */
function collectRefTargets(ref: PointRef, out: Set<string>): void {
  switch (ref.kind) {
    case 'abs': return;
    case 'endpoint':
    case 'center':
    case 'mid':
      out.add(ref.feature);
      return;
    case 'intersection':
      out.add(ref.feature1);
      out.add(ref.feature2);
      return;
    case 'polar':
      collectRefTargets(ref.from, out);
      return;
    case 'rayHit':
      // Two dependencies: the ray's base point (transitive) AND the target
      // feature whose edge defines the endpoint. Missing `ref.target` here
      // breaks incremental evaluateTimeline — changing a variable on the
      // target rect (e.g. width) wouldn't mark the rayHit line dirty, so the
      // line would hold its stale cached endpoint instead of re-intersecting
      // the moved edge.
      out.add(ref.target);
      collectRefTargets(ref.from, out);
      return;
    case 'axisProject':
      collectRefTargets(ref.xFrom, out);
      collectRefTargets(ref.yFrom, out);
      return;
    case 'interpolate':
      collectRefTargets(ref.from, out);
      collectRefTargets(ref.to, out);
      return;
  }
}

/**
 * All feature ids that `f` depends on — i.e. any feature that appears in any
 * of `f`'s PointRefs. parallelXLine's `refFeature` counts too. Stable per
 * feature shape, no context needed.
 */
export function featureDependencies(f: Feature): Set<string> {
  const out = new Set<string>();
  switch (f.kind) {
    case 'line':
      collectRefTargets(f.p1, out);
      collectRefTargets(f.p2, out);
      break;
    case 'polyline':
    case 'spline':
      for (const p of f.pts) collectRefTargets(p, out);
      break;
    case 'rect':
      collectRefTargets(f.p1, out);
      break;
    case 'circle':
    case 'arc':
    case 'ellipse':
      collectRefTargets(f.center, out);
      break;
    case 'xline':
      collectRefTargets(f.p, out);
      break;
    case 'parallelXLine':
      out.add(f.refFeature);
      break;
    case 'axisParallelXLine':
      // No feature refs — the axis is a virtual renderer concept.
      break;
    case 'text':
      collectRefTargets(f.p, out);
      break;
    case 'dim':
      collectRefTargets(f.p1, out);
      collectRefTargets(f.p2, out);
      collectRefTargets(f.offset, out);
      if (f.vertex) collectRefTargets(f.vertex, out);
      if (f.ray1)   collectRefTargets(f.ray1,   out);
      if (f.ray2)   collectRefTargets(f.ray2,   out);
      break;
    case 'hatch':
      for (const p of f.pts) collectRefTargets(p, out);
      if (f.holes) for (const h of f.holes) for (const p of h) collectRefTargets(p, out);
      break;
    case 'mirror':
      for (const sid of f.sourceIds) out.add(sid);
      if (f.axis.kind === 'twoPoints') {
        collectRefTargets(f.axis.p1, out);
        collectRefTargets(f.axis.p2, out);
      }
      break;
    case 'array':
      for (const sid of f.sourceIds) out.add(sid);
      collectRefTargets(f.offset.p1, out);
      collectRefTargets(f.offset.p2, out);
      if (f.rowOffset) {
        collectRefTargets(f.rowOffset.p1, out);
        collectRefTargets(f.rowOffset.p2, out);
      }
      break;
    case 'rotate':
      for (const sid of f.sourceIds) out.add(sid);
      collectRefTargets(f.center, out);
      break;
    case 'crossMirror':
      for (const sid of f.sourceIds) out.add(sid);
      collectRefTargets(f.center, out);
      break;
    case 'clip':
      out.add(f.sourceId);
      break;
    case 'fillet':
      out.add(f.line1Id);
      out.add(f.line2Id);
      break;
    case 'chamfer':
      out.add(f.line1Id);
      out.add(f.line2Id);
      break;
  }
  return out;
}

/**
 * Does `candidateFid` transitively depend on `rootFid`? Used to detect the
 * cycle that occurs when trim / extend / fillet would link a line to a cutter
 * that itself depends on the same line (e.g. the divide tool puts xlines whose
 * geometry is pegged to the line's endpoint; trimming the line against those
 * xlines would then put the line's endpoint in a rayHit of those xlines —
 * cycle). The feature graph is a DAG in steady state, so a DFS terminates.
 */
export function featureDependsOn(candidateFid: string, rootFid: string): boolean {
  if (candidateFid === rootFid) return true;
  const feats = new Map<string, Feature>();
  for (const f of state.features) feats.set(f.id, f);
  const visited = new Set<string>();
  const stack: string[] = [candidateFid];
  while (stack.length) {
    const id = stack.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const f = feats.get(id);
    if (!f) continue;
    for (const dep of featureDependencies(f)) {
      if (dep === rootFid) return true;
      if (!visited.has(dep)) stack.push(dep);
    }
  }
  return false;
}

/**
 * Reorder `state.features` so every feature appears after all of its
 * dependencies. Insertion order is preserved among features that are not
 * transitively related — so the typical case (features created in a legal
 * order) is a no-op.
 *
 * Why this matters: evaluateTimeline walks `state.features` in order and
 * resolves PointRefs against a `ctx` that is built up as it goes. If feature
 * A depends on B but appears earlier in the array, A evaluates with B absent
 * from ctx and its rayHit/endpoint/etc. refs produce NaN geometry. This is
 * visible e.g. after the trim tool rewrites an existing line to rayHit a
 * construction xline that was created AFTER the line — the new dependency
 * goes backwards in the insertion order.
 *
 * Returns true iff the order actually changed.
 */
export function topoSortFeatures(): boolean {
  const feats = state.features;
  const n = feats.length;
  if (n < 2) return false;

  // Build id → index + adjacency (dep → list of dependents that sit earlier).
  const indexById = new Map<string, number>();
  for (let i = 0; i < n; i++) indexById.set(feats[i].id, i);

  // Kahn's algorithm with a stable tie-breaker: among nodes whose deps are
  // satisfied, pick the one with the smallest original index so unrelated
  // features keep their creation order.
  const indeg = new Array<number>(n).fill(0);
  const deps: Set<number>[] = feats.map(() => new Set());
  for (let i = 0; i < n; i++) {
    for (const dep of featureDependencies(feats[i])) {
      const di = indexById.get(dep);
      if (di == null || di === i) continue;
      if (!deps[i].has(di)) {
        deps[i].add(di);
        indeg[i]++;
      }
    }
  }

  // A tiny sorted-by-original-index "ready" set. n is small (drawings rarely
  // exceed a few thousand features) so a linear-scan ready list is fine.
  const ready: number[] = [];
  for (let i = 0; i < n; i++) if (indeg[i] === 0) ready.push(i);

  // Reverse adjacency: dependents[d] = all i that depend on d.
  const dependents: number[][] = feats.map(() => []);
  for (let i = 0; i < n; i++) for (const d of deps[i]) dependents[d].push(i);

  const outOrder: number[] = [];
  while (ready.length) {
    // Pop smallest (original index) for stable order.
    let minPos = 0;
    for (let k = 1; k < ready.length; k++) if (ready[k] < ready[minPos]) minPos = k;
    const idx = ready.splice(minPos, 1)[0];
    outOrder.push(idx);
    for (const dep of dependents[idx]) {
      indeg[dep]--;
      if (indeg[dep] === 0) ready.push(dep);
    }
  }

  // Cycle — bail out and leave order unchanged. Shouldn't happen in practice
  // (the feature graph is meant to be a DAG) but guard against silent damage.
  if (outOrder.length !== n) return false;

  // Already sorted?
  let changed = false;
  for (let i = 0; i < n; i++) if (outOrder[i] !== i) { changed = true; break; }
  if (!changed) return false;

  const reordered = outOrder.map(i => feats[i]);
  state.features = reordered;
  return true;
}

/**
 * Compute the set of *other* entity ids that are parametrically linked to the
 * given selection — either because they depend on a selected feature
 * ("downstream" = the selected entity drags them along) or because a selected
 * feature depends on them ("upstream" = they anchor the selected entity).
 * Both directions are visualised with the same dashed overlay so the user can
 * see the whole dependency cluster at a glance.
 */
export function linkedEntityIds(selectedEntityIds: Iterable<number>): Set<number> {
  const selFeatures = new Set<string>();
  const upstream = new Set<string>();        // features the selection depends on
  for (const eid of selectedEntityIds) {
    const f = featureForEntity(eid);
    if (!f) continue;
    selFeatures.add(f.id);
    for (const dep of featureDependencies(f)) upstream.add(dep);
  }
  if (selFeatures.size === 0) return new Set();

  const out = new Set<number>();
  for (const f of state.features) {
    if (selFeatures.has(f.id)) continue;
    let linked = upstream.has(f.id);
    if (!linked) {
      for (const dep of featureDependencies(f)) {
        if (selFeatures.has(dep)) { linked = true; break; }
      }
    }
    if (linked) {
      const eid = entityIdForFeature(f.id);
      if (eid != null) out.add(eid);
    }
  }
  return out;
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
      // Either feature id can be the origin X or Y axis — a synthetic "line"
      // through (0,0) along (1,0) or (0,1). The axes don't live in
      // `state.features`, so the intersection PointRef short-circuits them
      // here instead of doing a context lookup. That lets the line and
      // rectangle tools build intersection refs that include the axis as one
      // side (e.g. "endpoint = X axis × some xline") and have the point
      // follow any variable change on the real feature, while the axis stays
      // anchored at origin.
      const axisEntity = (id: string): XLineEntity | null => {
        if (id === AXIS_X_ID) return { id: -1, layer: 0, type: 'xline', x1: 0, y1: 0, dx: 1, dy: 0 };
        if (id === AXIS_Y_ID) return { id: -1, layer: 0, type: 'xline', x1: 0, y1: 0, dx: 0, dy: 1 };
        return null;
      };
      const e1 = axisEntity(ref.feature1) ?? ctx.get(ref.feature1);
      const e2 = axisEntity(ref.feature2) ?? ctx.get(ref.feature2);
      if (!e1 || !e2) return { x: NaN, y: NaN };
      if ((e1.type !== 'line' && e1.type !== 'xline') ||
          (e2.type !== 'line' && e2.type !== 'xline')) return { x: NaN, y: NaN };
      const ip = intersectLines(
        e1 as LineEntity | XLineEntity,
        e2 as LineEntity | XLineEntity,
      );
      return ip ?? { x: NaN, y: NaN };
    }
    case 'polar': {
      const base = resolvePt(ref.from, ctx);
      if (!Number.isFinite(base.x) || !Number.isFinite(base.y)) return { x: NaN, y: NaN };
      const a = evalExpr(ref.angle) * Math.PI / 180;
      const d = evalExpr(ref.distance);
      return { x: base.x + Math.cos(a) * d, y: base.y + Math.sin(a) * d };
    }
    case 'rayHit': {
      const base = resolvePt(ref.from, ctx);
      if (!Number.isFinite(base.x) || !Number.isFinite(base.y)) return { x: NaN, y: NaN };
      // Origin axes aren't real features, so short-circuit them the same way
      // the `intersection` case does: synthesize an infinite xline through
      // origin. Lets snap-to-axis with locked angle track the axis.
      const tgt = (ref.target === AXIS_X_ID)
        ? ({ id: -1, layer: 0, type: 'xline', x1: 0, y1: 0, dx: 1, dy: 0 } as XLineEntity)
        : (ref.target === AXIS_Y_ID)
          ? ({ id: -1, layer: 0, type: 'xline', x1: 0, y1: 0, dx: 0, dy: 1 } as XLineEntity)
          : ctx.get(ref.target);
      if (!tgt) return { x: NaN, y: NaN };
      const seg = edgeSegmentOf(tgt, ref.edge);
      if (!seg) return { x: NaN, y: NaN };
      // xlines are INFINITE — edgeSegmentOf returns a unit-length vector along
      // the direction, so we must not clamp `u` for xline targets. Finite
      // segments (rect edges, line segs, polyline segs) still clamp.
      const infiniteEdge = (ref.edge.kind === 'lineSeg' && tgt.type === 'xline');
      const a = evalExpr(ref.angle) * Math.PI / 180;
      const dx = Math.cos(a), dy = Math.sin(a);
      // Solve base + t·(dx,dy) = seg.a + u·(seg.b - seg.a)
      const ex = seg.b.x - seg.a.x, ey = seg.b.y - seg.a.y;
      const den = dx * (-ey) - dy * (-ex);
      if (Math.abs(den) < 1e-9) return { x: NaN, y: NaN };
      const rx = seg.a.x - base.x, ry = seg.a.y - base.y;
      const t = (rx * (-ey) - ry * (-ex)) / den;
      const u = (dx * ry - dy * rx) / den;
      const EPS = 1e-6;
      if (t < -EPS) return { x: NaN, y: NaN };                  // behind base
      if (!infiniteEdge && (u < -EPS || u > 1 + EPS)) return { x: NaN, y: NaN };
      return { x: base.x + t * dx, y: base.y + t * dy };
    }
    case 'axisProject': {
      // Composite: x from one source, y from another. Propagates NaN
      // defensively — if either sub-ref fails to resolve (feature deleted,
      // eval cycle, etc.) we return NaN and let downstream renderers hide
      // the degenerate geometry.
      const xp = resolvePt(ref.xFrom, ctx);
      const yp = resolvePt(ref.yFrom, ctx);
      if (!Number.isFinite(xp.x) || !Number.isFinite(yp.y)) return { x: NaN, y: NaN };
      return { x: xp.x, y: yp.y };
    }
    case 'interpolate': {
      // Linear blend between two reference points. Resolver propagates NaN
      // if either anchor fails (e.g. the referenced feature was deleted or
      // its ctx entry is missing due to an eval-order issue).
      const p0 = resolvePt(ref.from, ctx);
      const p1 = resolvePt(ref.to, ctx);
      if (!Number.isFinite(p0.x) || !Number.isFinite(p0.y)) return { x: NaN, y: NaN };
      if (!Number.isFinite(p1.x) || !Number.isFinite(p1.y)) return { x: NaN, y: NaN };
      const t = evalExpr(ref.t);
      return { x: p0.x + (p1.x - p0.x) * t, y: p0.y + (p1.y - p0.y) * t };
    }
  }
}

/** Return the endpoints (a,b) of the target feature's edge referenced by `ref`. */
function edgeSegmentOf(e: Entity, ref: FeatureEdgeRef): { a: Pt; b: Pt } | null {
  if (ref.kind === 'rectEdge' && e.type === 'rect') {
    const xl = Math.min(e.x1, e.x2), xr = Math.max(e.x1, e.x2);
    const yb = Math.min(e.y1, e.y2), yt = Math.max(e.y1, e.y2);
    switch (ref.side) {
      case 'top':    return { a: { x: xl, y: yt }, b: { x: xr, y: yt } };
      case 'right':  return { a: { x: xr, y: yb }, b: { x: xr, y: yt } };
      case 'bottom': return { a: { x: xl, y: yb }, b: { x: xr, y: yb } };
      case 'left':   return { a: { x: xl, y: yb }, b: { x: xl, y: yt } };
    }
  }
  if (ref.kind === 'lineSeg') {
    if (e.type === 'line') return { a: { x: e.x1, y: e.y1 }, b: { x: e.x2, y: e.y2 } };
    if (e.type === 'xline') return { a: { x: e.x1, y: e.y1 }, b: { x: e.x1 + e.dx, y: e.y1 + e.dy } };
  }
  if (ref.kind === 'polySeg' && e.type === 'polyline') {
    const i = ref.index;
    if (i < 0 || i + 1 >= e.pts.length) return null;
    return { a: e.pts[i], b: e.pts[i + 1] };
  }
  return null;
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
  if (e.type === 'arc') {
    const a = end === 0 ? e.a1 : e.a2;
    return { x: e.cx + Math.cos(a) * e.r, y: e.cy + Math.sin(a) * e.r };
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
  if (e.type === 'arc') {
    // Midpoint of arc = point at the halfway angle between a1 and a2.
    const aMid = (e.a1 + e.a2) / 2;
    return { x: e.cx + Math.cos(aMid) * e.r, y: e.cy + Math.sin(aMid) * e.r };
  }
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
 * Stable entity id for each **sub-entity** of a multi-output feature (like
 * Mirror, and — when implemented — Array, Rotate-copy, etc.). Key is a
 * composite `${modifierFid}#${subKey}` where `subKey` is whatever the feature
 * uses to distinguish its outputs (for mirror: the source feature id).
 *
 * Independent from `featureEntityIds` so the modifier feature's own primary id
 * and its outputs don't collide. The inverse map `entityToModifier` records
 * which modifier owns a given entity id — hit-tests against a mirrored piece
 * therefore resolve back to the MirrorFeature (so the timeline panel can
 * highlight / the user can edit the mirror instead of a synthetic copy).
 */
const subEntityIds = new Map<string, number>();
const entityToModifier = new Map<number, string>();

function allocSubEntityId(modFid: string, subKey: string): number {
  const key = `${modFid}#${subKey}`;
  const existing = subEntityIds.get(key);
  if (existing !== undefined) return existing;
  const id = state.nextId++;
  subEntityIds.set(key, id);
  return id;
}

/** Lookup: does this entity belong to a modifier feature (mirror etc.)? */
export function modifierForEntity(entityId: number): Feature | null {
  const fid = entityToModifier.get(entityId);
  if (!fid) return null;
  return state.features.find(f => f.id === fid) ?? null;
}

/**
 * For an entity that belongs to a modifier feature (mirror/array/rotate),
 * return info about which source feature and (for arrays) which cell it came
 * from. Returns `null` for entities that aren't modifier outputs.
 *
 * Subkey format (see build*Entities):
 *   • mirror / rotate : subKey = source fid
 *   • array           : subKey = "sourceFid|col|row"
 *   • crossMirror     : subKey = "sourceFid@variant" (variant ∈ m1/m2/m3)
 *
 * Used by `deleteSelection` so the user can remove a single mirrored line
 * (prune that source from the mirror's `sourceIds`) instead of blowing away
 * the whole mirror feature.
 */
export function modifierOutputInfo(
  entityId: number,
): { modFid: string; sourceFid: string; cell?: { col: number; row: number } } | null {
  const modFid = entityToModifier.get(entityId);
  if (!modFid) return null;
  // Reverse the subEntityIds map for this modifier to find the key that
  // produced this entity. Map is small (one entry per modifier output), and
  // delete is not a hot path.
  const prefix = `${modFid}#`;
  // Strip the multi-output `~idx` tail (added when the source feature produces
  // more than one entity, e.g. fillet → [l1, l2, arc]). The tail is an
  // evaluation artifact; for selection/delete semantics all we care about is
  // which source feature produced the entity.
  const stripSubIdx = (s: string): string => {
    const tilde = s.indexOf('~');
    return tilde >= 0 ? s.slice(0, tilde) : s;
  };
  for (const [key, eid] of subEntityIds) {
    if (eid !== entityId) continue;
    if (!key.startsWith(prefix)) continue;
    const sub = key.slice(prefix.length);
    // CrossMirror sub-key: "sid@variant" (or "sid~idx@variant") — split out
    // the source fid so delete prunes the same sourceIds list a plain mirror would.
    const atIdx = sub.indexOf('@');
    if (atIdx > 0) {
      return { modFid, sourceFid: stripSubIdx(sub.slice(0, atIdx)) };
    }
    // Array sub-key: "sid|col|row" (or "sid~idx|col|row") — split and parse.
    const parts = sub.split('|');
    if (parts.length === 3) {
      const col = parseInt(parts[1], 10);
      const row = parseInt(parts[2], 10);
      return { modFid, sourceFid: stripSubIdx(parts[0]), cell: { col, row } };
    }
    return { modFid, sourceFid: stripSubIdx(sub) };
  }
  return null;
}

/**
 * Resolve a sub-entity that belongs to a ClipFeature to its owning feature
 * and segment index. Used by the trim tool to handle re-trimming an already-
 * clipped segment without creating a nested ClipFeature.
 *
 * Returns null for entities that don't belong to a ClipFeature.
 */
export function resolveClipSubEntity(
  entityId: number,
): { feat: ClipFeature; segIdx: number } | null {
  const modFid = entityToModifier.get(entityId);
  if (!modFid) return null;
  const feat = state.features.find(f => f.id === modFid);
  if (!feat || feat.kind !== 'clip') return null;
  const prefix = `${modFid}#seg`;
  for (const [key, eid] of subEntityIds) {
    if (eid !== entityId) continue;
    if (!key.startsWith(prefix)) continue;
    const n = parseInt(key.slice(prefix.length), 10);
    if (!isNaN(n)) return { feat, segIdx: n };
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// Mirror: resolve axis + reflect entities
// ────────────────────────────────────────────────────────────────────────────

/** Resolve a MirrorAxis to `(base, dir)` world coords. Returns null if the
 *  axis is degenerate (two coincident points) or a ref can't resolve. */
function resolveMirrorAxis(
  axis: MirrorAxis, ctx: EvalCtx,
): { base: Pt; dir: Pt } | null {
  if (axis.kind === 'worldAxis') {
    return axis.axis === 'x'
      ? { base: { x: 0, y: 0 }, dir: { x: 1, y: 0 } }
      : { base: { x: 0, y: 0 }, dir: { x: 0, y: 1 } };
  }
  const a = resolvePt(axis.p1, ctx);
  const b = resolvePt(axis.p2, ctx);
  if (!Number.isFinite(a.x) || !Number.isFinite(a.y)) return null;
  if (!Number.isFinite(b.x) || !Number.isFinite(b.y)) return null;
  const dx = b.x - a.x, dy = b.y - a.y;
  const L = Math.hypot(dx, dy);
  if (L < 1e-9) return null;
  return { base: a, dir: { x: dx / L, y: dy / L } };
}

/** Reflect a 2D point across a line defined by `base` + unit direction `dir`. */
function reflectPt(p: Pt, base: Pt, dir: Pt): Pt {
  // project = base + dot(p-base, dir) * dir
  const rx = p.x - base.x, ry = p.y - base.y;
  const t = rx * dir.x + ry * dir.y;
  const px = base.x + t * dir.x;
  const py = base.y + t * dir.y;
  // reflected = 2*proj - p
  return { x: 2 * px - p.x, y: 2 * py - p.y };
}

/**
 * Reflect an entity across the given axis, producing a new Entity with the
 * given id + layer. Returns null for entity types that aren't meaningfully
 * mirrorable (text/dim/hatch — v1 scope).
 *
 * Arc reflection needs care: reflection flips the winding, so the CCW sweep
 * from `a1` to `a2` becomes CW in the mirrored frame. We swap the endpoints
 * and recompute the angles from the reflected endpoint-vectors so the arc
 * still renders with a CCW sweep (which is what the renderer assumes).
 */
function reflectEntity(e: Entity, base: Pt, dir: Pt, id: number, layer: number): Entity | null {
  switch (e.type) {
    case 'line': {
      const a = reflectPt({ x: e.x1, y: e.y1 }, base, dir);
      const b = reflectPt({ x: e.x2, y: e.y2 }, base, dir);
      return { id, type: 'line', layer, x1: a.x, y1: a.y, x2: b.x, y2: b.y };
    }
    case 'polyline': {
      // Reverse the point order so the mirrored polyline stays CCW-consistent
      // with the source (matters for closed polylines used as hatch boundaries).
      const pts = e.pts.map(p => reflectPt(p, base, dir)).reverse();
      return { id, type: 'polyline', layer, pts, ...(e.closed ? { closed: true } : {}) };
    }
    case 'rect': {
      // Rect is axis-aligned in world coords; mirroring a non-trivial axis
      // produces a rotated quad which can't be a RectEntity. Degrade to
      // polyline for the mirrored copy.
      const p1 = reflectPt({ x: e.x1, y: e.y1 }, base, dir);
      const p2 = reflectPt({ x: e.x2, y: e.y1 }, base, dir);
      const p3 = reflectPt({ x: e.x2, y: e.y2 }, base, dir);
      const p4 = reflectPt({ x: e.x1, y: e.y2 }, base, dir);
      return {
        id, type: 'polyline', layer,
        pts: [p4, p3, p2, p1],   // reverse winding to stay CCW-consistent
        closed: true,
      };
    }
    case 'circle': {
      const c = reflectPt({ x: e.cx, y: e.cy }, base, dir);
      return { id, type: 'circle', layer, cx: c.x, cy: c.y, r: e.r };
    }
    case 'arc': {
      const c = reflectPt({ x: e.cx, y: e.cy }, base, dir);
      // Pick the arc endpoints in the source frame, reflect them, then derive
      // the new a1/a2 from the reflected directions relative to the new centre.
      const e1 = { x: e.cx + e.r * Math.cos(e.a1), y: e.cy + e.r * Math.sin(e.a1) };
      const e2 = { x: e.cx + e.r * Math.cos(e.a2), y: e.cy + e.r * Math.sin(e.a2) };
      const r1 = reflectPt(e1, base, dir);
      const r2 = reflectPt(e2, base, dir);
      // Reflection flips winding → swap start/end so renderer's CCW sweep
      // paints the same physical arc.
      const a1 = Math.atan2(r2.y - c.y, r2.x - c.x);
      const a2 = Math.atan2(r1.y - c.y, r1.x - c.x);
      return { id, type: 'arc', layer, cx: c.x, cy: c.y, r: e.r, a1, a2 };
    }
    case 'ellipse': {
      const c = reflectPt({ x: e.cx, y: e.cy }, base, dir);
      // Reflect the rotation angle. An axis-angle θ of the ellipse rotates to
      // 2α − θ where α is the axis angle; rx/ry stay the same magnitudes.
      const alpha = Math.atan2(dir.y, dir.x);
      const rot = 2 * alpha - e.rot;
      return { id, type: 'ellipse', layer, cx: c.x, cy: c.y, rx: e.rx, ry: e.ry, rot };
    }
    case 'spline': {
      const pts = e.pts.map(p => reflectPt(p, base, dir)).reverse();
      return { id, type: 'spline', layer, pts, ...(e.closed ? { closed: true } : {}) };
    }
    case 'xline': {
      const p = reflectPt({ x: e.x1, y: e.y1 }, base, dir);
      // Direction vector reflects via reflectPt with base={0,0} (it's a vector,
      // not a point — translation doesn't apply).
      const d = reflectPt({ x: e.dx, y: e.dy }, { x: 0, y: 0 }, dir);
      return { id, type: 'xline', layer, x1: p.x, y1: p.y, dx: d.x, dy: d.y };
    }
    // v1: text/dim/hatch skipped. Mirroring text produces backwards glyphs that
    // nobody wants; dims reference their source points and should mirror
    // automatically once the source mirrors; hatch is copy-evaluated at commit
    // time and cannot follow parametric edits anyway.
    case 'text':
    case 'dim':
    case 'hatch':
      return null;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Translate + rotate helpers (shared by Array / Rotate modifier features)
// ────────────────────────────────────────────────────────────────────────────

function translateEntity(e: Entity, dx: number, dy: number, id: number, layer: number): Entity | null {
  switch (e.type) {
    case 'line':
      return { id, type: 'line', layer,
        x1: e.x1 + dx, y1: e.y1 + dy, x2: e.x2 + dx, y2: e.y2 + dy };
    case 'polyline':
      return { id, type: 'polyline', layer,
        pts: e.pts.map(p => ({ x: p.x + dx, y: p.y + dy })),
        ...(e.closed ? { closed: true } : {}) };
    case 'rect':
      return { id, type: 'rect', layer,
        x1: e.x1 + dx, y1: e.y1 + dy, x2: e.x2 + dx, y2: e.y2 + dy };
    case 'circle':
      return { id, type: 'circle', layer, cx: e.cx + dx, cy: e.cy + dy, r: e.r };
    case 'arc':
      return { id, type: 'arc', layer, cx: e.cx + dx, cy: e.cy + dy, r: e.r, a1: e.a1, a2: e.a2 };
    case 'ellipse':
      return { id, type: 'ellipse', layer,
        cx: e.cx + dx, cy: e.cy + dy, rx: e.rx, ry: e.ry, rot: e.rot };
    case 'spline':
      return { id, type: 'spline', layer,
        pts: e.pts.map(p => ({ x: p.x + dx, y: p.y + dy })),
        ...(e.closed ? { closed: true } : {}) };
    case 'xline':
      return { id, type: 'xline', layer,
        x1: e.x1 + dx, y1: e.y1 + dy, dx: e.dx, dy: e.dy };
    case 'text':
    case 'dim':
    case 'hatch':
      return null;
  }
}

function rotatePt(p: Pt, c: Pt, cos: number, sin: number): Pt {
  const dx = p.x - c.x, dy = p.y - c.y;
  return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos };
}

function rotateEntity(
  e: Entity, c: Pt, ang: number, id: number, layer: number,
): Entity | null {
  const cos = Math.cos(ang), sin = Math.sin(ang);
  switch (e.type) {
    case 'line': {
      const a = rotatePt({ x: e.x1, y: e.y1 }, c, cos, sin);
      const b = rotatePt({ x: e.x2, y: e.y2 }, c, cos, sin);
      return { id, type: 'line', layer, x1: a.x, y1: a.y, x2: b.x, y2: b.y };
    }
    case 'polyline':
      return { id, type: 'polyline', layer,
        pts: e.pts.map(p => rotatePt(p, c, cos, sin)),
        ...(e.closed ? { closed: true } : {}) };
    case 'rect': {
      // Axis-aligned rect can't represent a rotation → degrade to polyline.
      const p1 = rotatePt({ x: e.x1, y: e.y1 }, c, cos, sin);
      const p2 = rotatePt({ x: e.x2, y: e.y1 }, c, cos, sin);
      const p3 = rotatePt({ x: e.x2, y: e.y2 }, c, cos, sin);
      const p4 = rotatePt({ x: e.x1, y: e.y2 }, c, cos, sin);
      return { id, type: 'polyline', layer, pts: [p1, p2, p3, p4], closed: true };
    }
    case 'circle': {
      const cc = rotatePt({ x: e.cx, y: e.cy }, c, cos, sin);
      return { id, type: 'circle', layer, cx: cc.x, cy: cc.y, r: e.r };
    }
    case 'arc': {
      const cc = rotatePt({ x: e.cx, y: e.cy }, c, cos, sin);
      return { id, type: 'arc', layer, cx: cc.x, cy: cc.y, r: e.r,
        a1: e.a1 + ang, a2: e.a2 + ang };
    }
    case 'ellipse': {
      const cc = rotatePt({ x: e.cx, y: e.cy }, c, cos, sin);
      return { id, type: 'ellipse', layer,
        cx: cc.x, cy: cc.y, rx: e.rx, ry: e.ry, rot: e.rot + ang };
    }
    case 'spline':
      return { id, type: 'spline', layer,
        pts: e.pts.map(p => rotatePt(p, c, cos, sin)),
        ...(e.closed ? { closed: true } : {}) };
    case 'xline': {
      const p = rotatePt({ x: e.x1, y: e.y1 }, c, cos, sin);
      const d = rotatePt({ x: e.dx, y: e.dy }, { x: 0, y: 0 }, cos, sin);
      return { id, type: 'xline', layer, x1: p.x, y1: p.y, dx: d.x, dy: d.y };
    }
    case 'text':
    case 'dim':
    case 'hatch':
      return null;
  }
}

/**
 * Evaluate an ArrayFeature into zero-or-more Entity outputs. Sub-entity ids
 * are keyed `${arrayFid}#${srcFid}|${i}|${j}` so they stay stable across
 * re-evals, even when the user edits `cols`/`rows` — existing cells keep
 * their ids, new cells allocate fresh ones, dropped cells get GC'd.
 */
function buildArrayEntities(f: ArrayFeature, ctx: EvalCtx): Entity[] {
  const p1 = resolvePt(f.offset.p1, ctx);
  const p2 = resolvePt(f.offset.p2, ctx);
  if (!Number.isFinite(p1.x) || !Number.isFinite(p2.x)) return [];
  const dx = p2.x - p1.x, dy = p2.y - p1.y;

  let rowDx: number, rowDy: number;
  if (f.rowOffset) {
    const r1 = resolvePt(f.rowOffset.p1, ctx);
    const r2 = resolvePt(f.rowOffset.p2, ctx);
    if (!Number.isFinite(r1.x) || !Number.isFinite(r2.x)) return [];
    rowDx = r2.x - r1.x; rowDy = r2.y - r1.y;
  } else {
    // Auto-perp: 90° CCW rotation of the column vector. Matches the
    // existing handleMatrixCopy() convention.
    rowDx = -dy; rowDy = dx;
  }

  const nc = Math.max(1, Math.floor(evalExpr(f.cols)));
  const nr = f.mode === 'matrix' ? Math.max(1, Math.floor(evalExpr(f.rows))) : 1;

  const out: Entity[] = [];
  for (const sid of f.sourceIds) {
    const srcs = resolveSourceOutputs(sid, ctx);
    for (let si = 0; si < srcs.length; si++) {
      const src = srcs[si];
      const sfx = sourceSubSuffix(srcs.length, si);   // '' or '~idx'
      for (let j = 0; j < nr; j++) {
        for (let i = 0; i < nc; i++) {
          if (i === 0 && j === 0) continue;   // (0,0) is the source itself
          const offX = i * dx + j * rowDx;
          const offY = i * dy + j * rowDy;
          const key = `${sid}${sfx}|${i}|${j}`;
          const id = allocSubEntityId(f.id, key);
          const copied = translateEntity(src, offX, offY, id, src.layer);
          if (copied) out.push(copied);
        }
      }
    }
  }
  return out;
}

function buildRotateEntities(f: RotateFeature, ctx: EvalCtx): Entity[] {
  const c = resolvePt(f.center, ctx);
  if (!Number.isFinite(c.x) || !Number.isFinite(c.y)) return [];
  const ang = evalExpr(f.angle) * Math.PI / 180;
  const out: Entity[] = [];
  for (const sid of f.sourceIds) {
    const srcs = resolveSourceOutputs(sid, ctx);
    for (let i = 0; i < srcs.length; i++) {
      const src = srcs[i];
      const subKey = `${sid}${sourceSubSuffix(srcs.length, i)}`;
      const id = allocSubEntityId(f.id, subKey);
      const rot = rotateEntity(src, c, ang, id, src.layer);
      if (rot) out.push(rot);
    }
  }
  return out;
}

/**
 * Evaluate a CrossMirrorFeature. Produces one (variant='half') or three
 * (variant='quarter') mirrored copies per source feature:
 *
 *   m1 = reflect across axis passing through centre at `angle°`
 *   m2 = reflect across axis passing through centre at `angle+90°`
 *   m3 = rotate 180° around centre (equivalent to applying m1 and m2 together)
 *
 * Sub-entity subkeys `${sid}@m1|m2|m3` stay stable across re-evals so selection
 * survives, and `modifierOutputInfo` parses the `@`-prefix to find the source
 * fid for delete-cascade.
 */
function buildCrossMirrorEntities(f: CrossMirrorFeature, ctx: EvalCtx): Entity[] {
  const c = resolvePt(f.center, ctx);
  if (!Number.isFinite(c.x) || !Number.isFinite(c.y)) return [];
  const ang = evalExpr(f.angle) * Math.PI / 180;
  const axis1: Pt = { x: Math.cos(ang), y: Math.sin(ang) };
  // axis2 is +90° from axis1 (90° CCW rotation of (cos, sin) → (-sin, cos)).
  const axis2: Pt = { x: -Math.sin(ang), y: Math.cos(ang) };
  const out: Entity[] = [];
  for (const sid of f.sourceIds) {
    const srcs = resolveSourceOutputs(sid, ctx);
    for (let i = 0; i < srcs.length; i++) {
      const src = srcs[i];
      const sfx = sourceSubSuffix(srcs.length, i);   // '' or '~idx'
      const id1 = allocSubEntityId(f.id, `${sid}${sfx}@m1`);
      const m1 = reflectEntity(src, c, axis1, id1, src.layer);
      if (m1) out.push(m1);
      if (f.variant === 'quarter') {
        const id2 = allocSubEntityId(f.id, `${sid}${sfx}@m2`);
        const m2 = reflectEntity(src, c, axis2, id2, src.layer);
        if (m2) out.push(m2);
        const id3 = allocSubEntityId(f.id, `${sid}${sfx}@m3`);
        const m3 = rotateEntity(src, c, Math.PI, id3, src.layer);
        if (m3) out.push(m3);
      }
    }
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// Clip / Fillet / Chamfer modifier builders
// ────────────────────────────────────────────────────────────────────────────

/** Interpolate a point along a line at parameter t ∈ [0,1]. */
function lerpLine(e: LineEntity, t: number): Pt {
  return { x: e.x1 + (e.x2 - e.x1) * t, y: e.y1 + (e.y2 - e.y1) * t };
}

/**
 * Emit the surviving sub-entities of a ClipFeature.
 * Each segment becomes one entity (line or arc piece); the entities share the
 * same layer as the source.  Sub-entity ids are keyed `${clipFid}#seg${i}` for
 * stability across re-evals.
 */
function buildClipEntities(f: ClipFeature, ctx: EvalCtx): Entity[] {
  const src = ctx.get(f.sourceId);
  if (!src) return [];
  const out: Entity[] = [];

  for (let i = 0; i < f.segments.length; i++) {
    const seg = f.segments[i];
    const id  = allocSubEntityId(f.id, `seg${i}`);

    if (src.type === 'line') {
      const p1 = lerpLine(src, seg.tStart);
      const p2 = lerpLine(src, seg.tEnd);
      out.push({ id, type: 'line', layer: src.layer, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y });

    } else if (src.type === 'arc') {
      // t ∈ [0,1] mapped to angle fraction along CCW sweep (a1 → a2).
      const twoPi = Math.PI * 2;
      let sweep = src.a2 - src.a1;
      while (sweep <= 0) sweep += twoPi;
      if (sweep > twoPi) sweep -= twoPi;
      const a1 = src.a1 + sweep * seg.tStart;
      const a2 = src.a1 + sweep * seg.tEnd;
      out.push({ id, type: 'arc', layer: src.layer,
        cx: src.cx, cy: src.cy, r: src.r, a1, a2 });

    } else if (src.type === 'circle') {
      // Circle clipped → arc.  tStart/tEnd are angle fractions on [0, 2π).
      const a1 = Math.PI * 2 * seg.tStart;
      const a2 = Math.PI * 2 * seg.tEnd;
      out.push({ id, type: 'arc', layer: src.layer,
        cx: src.cx, cy: src.cy, r: src.r, a1, a2 });
    }
    // Other source types (rect, polyline, etc.) are not yet supported — skip.
  }
  return out;
}

/**
 * Compute fillet geometry from two live line entities and a radius.
 * Returns the trimmed endpoints + arc params, or null if impossible.
 * Mirrors the logic in `computeFillet` in tools.ts but operates on
 * LineEntity values directly (no click-side picking needed).
 */
function computeFilletGeometry(
  l1: LineEntity, cut1End: 1 | 2,
  l2: LineEntity, cut2End: 1 | 2,
  radius: number,
): { newL1End: Pt; newL2End: Pt; arc: { cx: number; cy: number; r: number; a1: number; a2: number } } | null {
  // "Kept" end = the far end that stays; "cut" end = corner end that gets trimmed.
  // cut1End===1 → x1,y1 is the corner end; kept end is x2,y2.
  // cut1End===2 → x2,y2 is the corner end; kept end is x1,y1.
  const kept1: Pt = cut1End === 1 ? { x: l1.x2, y: l1.y2 } : { x: l1.x1, y: l1.y1 };
  const kept2: Pt = cut2End === 1 ? { x: l2.x2, y: l2.y2 } : { x: l2.x1, y: l2.y1 };

  // Find the corner P by intersecting the two infinite lines.
  // Parametric form: P = kept1 + t·dir1 = kept2 + s·dir2
  // dir = cut_end − kept_end (toward the corner).
  const cx1 = cut1End === 1 ? l1.x1 : l1.x2, cy1 = cut1End === 1 ? l1.y1 : l1.y2;
  const cx2 = cut2End === 1 ? l2.x1 : l2.x2, cy2 = cut2End === 1 ? l2.y1 : l2.y2;
  const dx1 = cx1 - kept1.x, dy1 = cy1 - kept1.y;
  const dx2 = cx2 - kept2.x, dy2 = cy2 - kept2.y;
  const denom = dx1 * dy2 - dy1 * dx2;
  if (Math.abs(denom) < 1e-9) return null;   // parallel
  const dpx = kept2.x - kept1.x, dpy = kept2.y - kept1.y;
  const t = (dpx * dy2 - dpy * dx2) / denom;
  const P: Pt = { x: kept1.x + t * dx1, y: kept1.y + t * dy1 };

  // Unit vectors FROM the corner P toward each kept end.
  // This matches the convention in `computeFillet` in tools.ts.
  const d1x = kept1.x - P.x, d1y = kept1.y - P.y;
  const d2x = kept2.x - P.x, d2y = kept2.y - P.y;
  const len1 = Math.hypot(d1x, d1y);
  const len2 = Math.hypot(d2x, d2y);
  if (len1 < 1e-9 || len2 < 1e-9) return null;
  const u1: Pt = { x: d1x / len1, y: d1y / len1 };  // P → kept1
  const u2: Pt = { x: d2x / len2, y: d2y / len2 };  // P → kept2

  // Interior angle and derived fillet geometry — identical to computeFillet.
  const cosA = Math.max(-1, Math.min(1, u1.x * u2.x + u1.y * u2.y));
  const angle = Math.acos(cosA);
  if (angle < 1e-4 || angle > Math.PI - 1e-4) return null;  // collinear or anti-parallel
  const half = angle / 2;
  const tanDist = radius / Math.tan(half);   // distance P→tangent point on each line
  const cDist   = radius / Math.sin(half);   // distance P→arc centre

  // Check both lines are long enough to fit the fillet.
  if (tanDist > len1 + 1e-6) return null;
  if (tanDist > len2 + 1e-6) return null;

  const T1: Pt = { x: P.x + u1.x * tanDist, y: P.y + u1.y * tanDist };
  const T2: Pt = { x: P.x + u2.x * tanDist, y: P.y + u2.y * tanDist };

  // Arc centre on the interior bisector.
  const bisX = u1.x + u2.x, bisY = u1.y + u2.y;
  const bisLen = Math.hypot(bisX, bisY);
  if (bisLen < 1e-9) return null;
  const C: Pt = { x: P.x + (bisX / bisLen) * cDist, y: P.y + (bisY / bisLen) * cDist };

  // Arc sweep: short arc between the two tangent points (CCW, < 180°).
  let a1 = Math.atan2(T1.y - C.y, T1.x - C.x);
  let a2 = Math.atan2(T2.y - C.y, T2.x - C.x);
  const twoPi = Math.PI * 2;
  const normA = (x: number) => ((x % twoPi) + twoPi) % twoPi;
  if (normA(a2 - a1) > Math.PI) { const tmp = a1; a1 = a2; a2 = tmp; }

  return { newL1End: T1, newL2End: T2, arc: { cx: C.x, cy: C.y, r: radius, a1, a2 } };
}

/**
 * Emit the three sub-entities of a FilletFeature (trimmed line1, trimmed
 * line2, fillet arc).  Sub-entity keys: `l1`, `l2`, `arc`.
 */
function buildFilletEntities(f: FilletFeature, ctx: EvalCtx): Entity[] {
  const src1 = ctx.get(f.line1Id);
  const src2 = ctx.get(f.line2Id);
  if (!src1 || src1.type !== 'line') return [];
  if (!src2 || src2.type !== 'line') return [];

  const geom = computeFilletGeometry(src1, f.cut1End, src2, f.cut2End, f.radius);
  if (!geom) return [];

  const idL1  = allocSubEntityId(f.id, 'l1');
  const idL2  = allocSubEntityId(f.id, 'l2');
  // Arc gets the FilletFeature's *primary* entity id so it appears in ctx and
  // entityToFeature — making it a first-class, snappable feature rather than
  // an anonymous sub-entity that lives only in entityToModifier.
  const idArc = allocEntityId(f.id);

  // Trimmed line1: kept end → tangent point.
  const kept1: Pt = f.cut1End === 1 ? { x: src1.x2, y: src1.y2 } : { x: src1.x1, y: src1.y1 };
  const l1: Entity = {
    id: idL1, type: 'line', layer: src1.layer,
    x1: kept1.x, y1: kept1.y,
    x2: geom.newL1End.x, y2: geom.newL1End.y,
  };

  // Trimmed line2: kept end → tangent point.
  const kept2: Pt = f.cut2End === 1 ? { x: src2.x2, y: src2.y2 } : { x: src2.x1, y: src2.y1 };
  const l2: Entity = {
    id: idL2, type: 'line', layer: src2.layer,
    x1: kept2.x, y1: kept2.y,
    x2: geom.newL2End.x, y2: geom.newL2End.y,
  };

  const arc: Entity = {
    id: idArc, type: 'arc', layer: f.layer,
    cx: geom.arc.cx, cy: geom.arc.cy, r: geom.arc.r,
    a1: geom.arc.a1, a2: geom.arc.a2,
  };

  return [l1, l2, arc];
}

/**
 * Compute chamfer geometry from two live line entities and a distance.
 * Returns the trimmed endpoints + cut line endpoints, or null if impossible.
 */
function computeChamferGeometry(
  l1: LineEntity, cut1End: 1 | 2,
  l2: LineEntity, cut2End: 1 | 2,
  distance: number,
): { newL1End: Pt; newL2End: Pt } | null {
  const kept1: Pt = cut1End === 1 ? { x: l1.x2, y: l1.y2 } : { x: l1.x1, y: l1.y1 };
  const cut1:  Pt = cut1End === 1 ? { x: l1.x1, y: l1.y1 } : { x: l1.x2, y: l1.y2 };
  const kept2: Pt = cut2End === 1 ? { x: l2.x2, y: l2.y2 } : { x: l2.x1, y: l2.y1 };
  const cut2:  Pt = cut2End === 1 ? { x: l2.x1, y: l2.y1 } : { x: l2.x2, y: l2.y2 };

  const len1 = Math.hypot(cut1.x - kept1.x, cut1.y - kept1.y);
  const len2 = Math.hypot(cut2.x - kept2.x, cut2.y - kept2.y);
  if (len1 < 1e-9 || len2 < 1e-9) return null;
  const u1: Pt = { x: (cut1.x - kept1.x) / len1, y: (cut1.y - kept1.y) / len1 };
  const u2: Pt = { x: (cut2.x - kept2.x) / len2, y: (cut2.y - kept2.y) / len2 };

  // Infinite intersection.
  const denom = u1.x * u2.y - u1.y * u2.x;
  if (Math.abs(denom) < 1e-9) return null;
  const dx = kept2.x - kept1.x, dy = kept2.y - kept1.y;
  const t1val = (dx * u2.y - dy * u2.x) / denom;
  const P: Pt = { x: kept1.x + u1.x * t1val, y: kept1.y + u1.y * t1val };

  if (distance > Math.hypot(P.x - kept1.x, P.y - kept1.y) + 1e-6) return null;
  if (distance > Math.hypot(P.x - kept2.x, P.y - kept2.y) + 1e-6) return null;

  const T1: Pt = { x: P.x - u1.x * distance, y: P.y - u1.y * distance };
  const T2: Pt = { x: P.x - u2.x * distance, y: P.y - u2.y * distance };
  return { newL1End: T1, newL2End: T2 };
}

/**
 * Emit the three sub-entities of a ChamferFeature (trimmed line1, trimmed
 * line2, cut line).  Sub-entity keys: `l1`, `l2`, `cut`.
 */
function buildChamferEntities(f: ChamferFeature, ctx: EvalCtx): Entity[] {
  const src1 = ctx.get(f.line1Id);
  const src2 = ctx.get(f.line2Id);
  if (!src1 || src1.type !== 'line') return [];
  if (!src2 || src2.type !== 'line') return [];

  const geom = computeChamferGeometry(src1, f.cut1End, src2, f.cut2End, f.distance);
  if (!geom) return [];

  const idL1  = allocSubEntityId(f.id, 'l1');
  const idL2  = allocSubEntityId(f.id, 'l2');
  // Cut line gets the ChamferFeature's *primary* entity id — same rationale
  // as the fillet arc: makes it snappable and reachable via ctx.
  const idCut = allocEntityId(f.id);

  const kept1: Pt = f.cut1End === 1 ? { x: src1.x2, y: src1.y2 } : { x: src1.x1, y: src1.y1 };
  const kept2: Pt = f.cut2End === 1 ? { x: src2.x2, y: src2.y2 } : { x: src2.x1, y: src2.y1 };

  const l1: Entity = {
    id: idL1, type: 'line', layer: src1.layer,
    x1: kept1.x, y1: kept1.y, x2: geom.newL1End.x, y2: geom.newL1End.y,
  };
  const l2: Entity = {
    id: idL2, type: 'line', layer: src2.layer,
    x1: kept2.x, y1: kept2.y, x2: geom.newL2End.x, y2: geom.newL2End.y,
  };
  const cut: Entity = {
    id: idCut, type: 'line', layer: f.layer,
    x1: geom.newL1End.x, y1: geom.newL1End.y,
    x2: geom.newL2End.x, y2: geom.newL2End.y,
  };
  return [l1, l2, cut];
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
    case 'axisParallelXLine': {
      // Virtual-axis parallel. Direction is intrinsic (axis='x' → horizontal,
      // axis='y' → vertical); the offset normal is `perp(dir) = (-dy, dx)` —
      // same convention `perpOffset()` uses, so the `side` captured at click
      // time maps correctly to world space. (Earlier the Y-axis case was
      // inverted — clicking right of the Y-axis produced a line on the left.)
      //
      // The distance expression stays live: editing the underlying variable
      // re-evaluates this feature on the next `evaluateTimeline()`.
      const d = evalExpr(f.distance);
      const dx = f.axis === 'x' ? 1 : 0;
      const dy = f.axis === 'x' ? 0 : 1;
      const nx = -dy, ny = dx;  // perp(dir)
      return {
        id, type: 'xline', layer: f.layer,
        x1: nx * d * f.side,
        y1: ny * d * f.side,
        dx, dy,
      };
    }
    case 'text': {
      const p = resolvePt(f.p, ctx);
      return {
        id, type: 'text', layer: f.layer,
        x: p.x, y: p.y, text: f.text,
        height: evalExpr(f.height), rotation: evalExpr(f.rotation),
        ...(f.boxWidth !== undefined ? { boxWidth: evalExpr(f.boxWidth) } : {}),
      };
    }
    case 'dim': {
      return {
        id, type: 'dim', layer: f.layer,
        ...(f.dimKind ? { dimKind: f.dimKind } : {}),
        p1: resolvePt(f.p1, ctx), p2: resolvePt(f.p2, ctx),
        offset: resolvePt(f.offset, ctx),
        ...(f.vertex ? { vertex: resolvePt(f.vertex, ctx) } : {}),
        ...(f.ray1   ? { ray1:   resolvePt(f.ray1,   ctx) } : {}),
        ...(f.ray2   ? { ray2:   resolvePt(f.ray2,   ctx) } : {}),
        textHeight: evalExpr(f.textHeight),
        ...(f.style ? { style: f.style } : {}),
        ...(f.textAlign ? { textAlign: f.textAlign } : {}),
      };
    }
    case 'hatch': {
      const pts = f.pts.map(r => resolvePt(r, ctx));
      const holes = f.holes?.map(h => h.map(r => resolvePt(r, ctx)));
      return {
        id, type: 'hatch', layer: f.layer,
        mode: f.mode,
        pts,
        ...(holes && holes.length > 0 ? { holes } : {}),
        ...(f.angle   !== undefined ? { angle:   evalExpr(f.angle)   } : {}),
        ...(f.spacing !== undefined ? { spacing: evalExpr(f.spacing) } : {}),
        ...(f.color   !== undefined ? { color: f.color } : {}),
      };
    }
    // Multi-entity modifiers are handled in evaluateTimeline() via
    // buildMirrorEntities / buildArrayEntities / buildRotateEntities so they
    // can emit one entity per source (or per source × cell).
    case 'mirror':
    case 'array':
    case 'rotate':
    case 'crossMirror':
    // Non-destructive modifiers handled via their own evaluateTimeline branch.
    case 'clip':
    case 'fillet':
    case 'chamfer':
      return null;
  }
}

/**
 * Resolve the live Entity outputs for a source feature id, used by the four
 * copy-modifiers (mirror / crossMirror / array / rotate) when iterating their
 * `sourceIds`. Most features produce a single Entity that lives in `ctx` under
 * their fid — return `[ctx.get(sid)]`. Non-destructive modifiers (clip /
 * fillet / chamfer) produce multiple outputs that are NOT individually keyed
 * in ctx; we grab them from `cachedModifierOutputs` (populated by the earlier
 * eval pass in `evaluateTimeline`). This is what lets a mirror of a filleted
 * corner carry BOTH the trimmed lines AND the arc — not just the fillet's arc
 * (which is all `ctx.get(filletFid)` returns).
 */
function resolveSourceOutputs(sid: string, ctx: EvalCtx): Entity[] {
  const feat = state.features.find(f => f.id === sid);
  if (feat && (feat.kind === 'fillet' || feat.kind === 'chamfer' || feat.kind === 'clip')) {
    const cached = cachedModifierOutputs.get(sid);
    if (cached && cached.length > 0) return cached;
  }
  const e = ctx.get(sid);
  return e ? [e] : [];
}

/**
 * Build the sub-key suffix for a multi-output source: `''` for simple
 * single-output sources (preserves existing sub-key format and selection
 * stability) and `~${idx}` for the idx-th output of a multi-output modifier
 * (fillet / chamfer / clip). The tilde is chosen because no feature id
 * contains it and no other sub-key separator uses it, so parsers can split
 * unambiguously.
 */
function sourceSubSuffix(total: number, idx: number): string {
  return total > 1 ? `~${idx}` : '';
}

/**
 * Evaluate a MirrorFeature into zero-or-more Entity outputs (one per source
 * feature that currently resolves in ctx, or N per multi-output source like a
 * fillet). Sub-entity ids are stable across re-evals so selection survives
 * variable tweaks. The MirrorFeature itself doesn't go into `ctx` — nothing
 * references it as a point source.
 */
function buildMirrorEntities(f: MirrorFeature, ctx: EvalCtx): Entity[] {
  const ax = resolveMirrorAxis(f.axis, ctx);
  if (!ax) return [];
  const out: Entity[] = [];
  for (const sid of f.sourceIds) {
    const srcs = resolveSourceOutputs(sid, ctx);
    for (let i = 0; i < srcs.length; i++) {
      const src = srcs[i];
      const subKey = `${sid}${sourceSubSuffix(srcs.length, i)}`;
      const id = allocSubEntityId(f.id, subKey);
      // Inherit each source's layer so colour/linestyle stay consistent with the
      // original; the MirrorFeature's own `layer` field is only a hint for UI.
      const mirrored = reflectEntity(src, ax.base, ax.dir, id, src.layer);
      if (mirrored) out.push(mirrored);
    }
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// Entity caches for dirty-flag rebuild
// ────────────────────────────────────────────────────────────────────────────
// Persist the last-evaluated Entity per feature id (and, for multi-output
// modifier features, the full output list). When a subsequent
// `evaluateTimeline({ changedParams, changedFeatures })` call runs, features
// that neither changed themselves nor depend transitively on a changed thing
// reuse their cached entity instead of being rebuilt. Reduces the cost of
// param-slider drags and grip drags from O(#features) to O(affected subtree).
//
// The cache is ONLY consulted when the caller passes hints. A bare
// `evaluateTimeline()` call still does a full rebuild (same behaviour as
// before), which keeps every legacy callsite correct without audit.

const cachedEntity = new Map<string, Entity>();
const cachedModifierOutputs = new Map<string, Entity[]>();

/**
 * Does any Expr inside `f` reference one of the param ids in `changed`?
 * Used by the dirty-flag propagation to translate "these params changed" into
 * "these features need rebuilding".
 */
function featureReferencesAnyParam(f: Feature, changed: Set<string>): boolean {
  const eRefs = (e: Expr): boolean => {
    if (e.kind === 'param') return changed.has(e.id);
    if (e.kind === 'formula') { for (const id of e.refs) if (changed.has(id)) return true; return false; }
    return false;
  };
  const pRefs = (p: PointRef): boolean => {
    if (p.kind === 'abs') return eRefs(p.x) || eRefs(p.y);
    if (p.kind === 'polar') return eRefs(p.angle) || eRefs(p.distance) || pRefs(p.from);
    if (p.kind === 'rayHit') return eRefs(p.angle) || pRefs(p.from);
    if (p.kind === 'axisProject') return pRefs(p.xFrom) || pRefs(p.yFrom);
    if (p.kind === 'interpolate') return eRefs(p.t) || pRefs(p.from) || pRefs(p.to);
    return false;
  };
  switch (f.kind) {
    case 'line':     return pRefs(f.p1) || pRefs(f.p2);
    case 'polyline': for (const p of f.pts) if (pRefs(p)) return true; return false;
    case 'rect':     return pRefs(f.p1) || eRefs(f.width) || eRefs(f.height);
    case 'circle':   return pRefs(f.center) || eRefs(f.radius);
    case 'arc':      return pRefs(f.center) || eRefs(f.radius) || eRefs(f.a1) || eRefs(f.a2);
    case 'ellipse':  return pRefs(f.center) || eRefs(f.rx) || eRefs(f.ry) || eRefs(f.rot);
    case 'spline':   for (const p of f.pts) if (pRefs(p)) return true; return false;
    case 'xline':    return pRefs(f.p) || eRefs(f.dx) || eRefs(f.dy);
    case 'parallelXLine':     return eRefs(f.distance);
    case 'axisParallelXLine': return eRefs(f.distance);
    case 'text':     return pRefs(f.p) || eRefs(f.height) || eRefs(f.rotation)
                          || (f.boxWidth ? eRefs(f.boxWidth) : false);
    case 'dim': {
      if (pRefs(f.p1) || pRefs(f.p2) || pRefs(f.offset)) return true;
      if (f.vertex && pRefs(f.vertex)) return true;
      if (f.ray1 && pRefs(f.ray1)) return true;
      if (f.ray2 && pRefs(f.ray2)) return true;
      if (eRefs(f.textHeight)) return true;
      return false;
    }
    case 'hatch': {
      for (const p of f.pts) if (pRefs(p)) return true;
      if (f.holes) for (const h of f.holes) for (const p of h) if (pRefs(p)) return true;
      if (f.angle && eRefs(f.angle)) return true;
      if (f.spacing && eRefs(f.spacing)) return true;
      return false;
    }
    case 'mirror':
      if (f.axis.kind === 'twoPoints') return pRefs(f.axis.p1) || pRefs(f.axis.p2);
      return false;
    case 'array':
      if (pRefs(f.offset.p1) || pRefs(f.offset.p2)) return true;
      if (eRefs(f.cols) || eRefs(f.rows)) return true;
      if (f.rowOffset) return pRefs(f.rowOffset.p1) || pRefs(f.rowOffset.p2);
      return false;
    case 'rotate':
      return pRefs(f.center) || eRefs(f.angle);
    case 'crossMirror':
      return pRefs(f.center) || eRefs(f.angle);
    // Clip/Fillet/Chamfer store numeric constants (radius, distance, t) and
    // feature-id strings — no Exprs reference params directly.
    case 'clip':
    case 'fillet':
    case 'chamfer':
      return false;
  }
}

/**
 * Re-evaluate the timeline. Without `opts`, a full rebuild runs — every feature
 * is re-evaluated and `state.entities` is replaced wholesale. This is the
 * default behaviour; every legacy callsite continues to work unchanged.
 *
 * When the caller knows *which* things changed (parameter ids the user edited,
 * feature ids the caller mutated in place), it can pass them in `opts`. The
 * evaluator then:
 *   1. Builds an initial dirty set from `opts.changedFeatures` and from any
 *      feature whose Exprs reference a `opts.changedParams` id.
 *   2. Saturates the dirty set downstream: any feature that depends on an
 *      already-dirty feature also becomes dirty. Since the timeline is linear
 *      and dependencies always point to earlier features, one forward pass
 *      suffices.
 *   3. Rebuilds only the dirty features; clean features reuse their cached
 *      Entity (or cached output list, for multi-output modifier features).
 *
 * IMPORTANT: if the caller passes `opts`, it is a contract — ALL mutated
 * feature ids must be listed in `changedFeatures`, and ALL changed param ids
 * in `changedParams`. Missing a mutation will serve a stale cached entity.
 * When in doubt, call with no opts (full rebuild).
 *
 * Structural changes (add/remove/reorder features) are NOT covered by opts —
 * call with no opts after those so caches get walked, and stale cache entries
 * for deleted features are GC'd.
 */
export function evaluateTimeline(opts?: {
  changedParams?: Iterable<string>;
  changedFeatures?: Iterable<string>;
}): void {
  const fullRebuild = !opts;

  // Build the dirty-feature set.
  const dirty = new Set<string>();
  if (opts?.changedFeatures) for (const id of opts.changedFeatures) dirty.add(id);
  if (opts?.changedParams) {
    const cp = new Set<string>(opts.changedParams);
    for (const f of state.features) {
      if (featureReferencesAnyParam(f, cp)) dirty.add(f.id);
    }
  }
  // Propagate downstream in a single forward pass: because the timeline is
  // linear and dependencies point backwards, any feature whose deps intersect
  // the dirty set must also become dirty before we reach it in the build loop.
  if (!fullRebuild) {
    for (const f of state.features) {
      if (dirty.has(f.id)) continue;
      for (const dep of featureDependencies(f)) {
        if (dirty.has(dep)) { dirty.add(f.id); break; }
      }
    }
  }

  const ctx: EvalCtx = new Map();
  const out: Entity[] = [];
  const alive = new Set<string>();
  // Track which sub-entity composite keys are still alive, so dead keys (from
  // sources that were deleted or un-targeted) can be garbage-collected and
  // selection doesn't resurrect stale ids.
  const aliveSubKeys = new Set<string>();
  for (const f of state.features) {
    alive.add(f.id);
    const isDirty = fullRebuild || dirty.has(f.id);

    if (f.kind === 'mirror') {
      let outputs: Entity[];
      if (!isDirty && cachedModifierOutputs.has(f.id)) {
        outputs = cachedModifierOutputs.get(f.id)!;
      } else {
        outputs = buildMirrorEntities(f, ctx);
        cachedModifierOutputs.set(f.id, outputs);
      }
      // Register aliveSubKeys matching the exact keys buildMirrorEntities
      // allocated. For single-output sources this is the legacy `${fid}#${sid}`;
      // for multi-output modifier sources (fillet/chamfer/clip) we append
      // `~idx` for each produced entity.
      for (const sid of f.sourceIds) {
        const n = resolveSourceOutputs(sid, ctx).length;
        for (let i = 0; i < n; i++) {
          aliveSubKeys.add(`${f.id}#${sid}${sourceSubSuffix(n, i)}`);
        }
      }
      if (!f.hidden) for (const e of outputs) out.push(e);
      continue;
    }
    if (f.kind === 'array') {
      let outputs: Entity[];
      if (!isDirty && cachedModifierOutputs.has(f.id)) {
        outputs = cachedModifierOutputs.get(f.id)!;
      } else {
        outputs = buildArrayEntities(f, ctx);
        cachedModifierOutputs.set(f.id, outputs);
      }
      // Mark every (source, i, j) cell that actually emitted. The cell loop
      // in buildArrayEntities is duplicated here so we record the keys even
      // for hidden features (consistent with buildEntity's ctx semantics).
      const nc = Math.max(1, Math.floor(evalExpr(f.cols)));
      const nr = f.mode === 'matrix' ? Math.max(1, Math.floor(evalExpr(f.rows))) : 1;
      for (const sid of f.sourceIds) {
        const n = resolveSourceOutputs(sid, ctx).length;
        if (n === 0) continue;
        for (let si = 0; si < n; si++) {
          const sfx = sourceSubSuffix(n, si);
          for (let j = 0; j < nr; j++) {
            for (let i = 0; i < nc; i++) {
              if (i === 0 && j === 0) continue;
              aliveSubKeys.add(`${f.id}#${sid}${sfx}|${i}|${j}`);
            }
          }
        }
      }
      if (!f.hidden) for (const e of outputs) out.push(e);
      continue;
    }
    if (f.kind === 'rotate') {
      let outputs: Entity[];
      if (!isDirty && cachedModifierOutputs.has(f.id)) {
        outputs = cachedModifierOutputs.get(f.id)!;
      } else {
        outputs = buildRotateEntities(f, ctx);
        cachedModifierOutputs.set(f.id, outputs);
      }
      for (const sid of f.sourceIds) {
        const n = resolveSourceOutputs(sid, ctx).length;
        for (let i = 0; i < n; i++) {
          aliveSubKeys.add(`${f.id}#${sid}${sourceSubSuffix(n, i)}`);
        }
      }
      if (!f.hidden) for (const e of outputs) out.push(e);
      continue;
    }
    if (f.kind === 'crossMirror') {
      let outputs: Entity[];
      if (!isDirty && cachedModifierOutputs.has(f.id)) {
        outputs = cachedModifierOutputs.get(f.id)!;
      } else {
        outputs = buildCrossMirrorEntities(f, ctx);
        cachedModifierOutputs.set(f.id, outputs);
      }
      // Three variant sub-keys per source (quarter) or one (half). Mirror the
      // build loop exactly so `aliveSubKeys` matches the entities that were
      // actually emitted — stale ids otherwise linger in `subEntityIds`.
      const variants = f.variant === 'quarter' ? ['m1', 'm2', 'm3'] : ['m1'];
      for (const sid of f.sourceIds) {
        const n = resolveSourceOutputs(sid, ctx).length;
        for (let i = 0; i < n; i++) {
          const sfx = sourceSubSuffix(n, i);
          for (const v of variants) {
            aliveSubKeys.add(`${f.id}#${sid}${sfx}@${v}`);
          }
        }
      }
      if (!f.hidden) for (const e of outputs) out.push(e);
      continue;
    }
    if (f.kind === 'clip') {
      let outputs: Entity[];
      if (!isDirty && cachedModifierOutputs.has(f.id)) {
        outputs = cachedModifierOutputs.get(f.id)!;
      } else {
        outputs = buildClipEntities(f, ctx);
        cachedModifierOutputs.set(f.id, outputs);
      }
      for (let i = 0; i < f.segments.length; i++) {
        aliveSubKeys.add(`${f.id}#seg${i}`);
      }
      if (!f.hidden) for (const e of outputs) out.push(e);
      continue;
    }
    if (f.kind === 'fillet') {
      let outputs: Entity[];
      if (!isDirty && cachedModifierOutputs.has(f.id)) {
        outputs = cachedModifierOutputs.get(f.id)!;
      } else {
        outputs = buildFilletEntities(f, ctx);
        cachedModifierOutputs.set(f.id, outputs);
      }
      aliveSubKeys.add(`${f.id}#l1`);
      aliveSubKeys.add(`${f.id}#l2`);
      // Arc uses featureEntityIds (not subEntityIds), so no aliveSubKeys entry.
      if (!f.hidden) for (const e of outputs) out.push(e);
      // Put the arc into ctx keyed by the FilletFeature id so downstream
      // features can snap to it (endpoint / mid / center PointRefs resolve
      // through ctx.get(filletFid) → arc entity).
      const arcPrimaryId = featureEntityIds.get(f.id);
      const arcEnt = arcPrimaryId !== undefined
        ? (outputs.find(e => e.id === arcPrimaryId) ?? null) : null;
      if (arcEnt) ctx.set(f.id, arcEnt);
      continue;
    }
    if (f.kind === 'chamfer') {
      let outputs: Entity[];
      if (!isDirty && cachedModifierOutputs.has(f.id)) {
        outputs = cachedModifierOutputs.get(f.id)!;
      } else {
        outputs = buildChamferEntities(f, ctx);
        cachedModifierOutputs.set(f.id, outputs);
      }
      aliveSubKeys.add(`${f.id}#l1`);
      aliveSubKeys.add(`${f.id}#l2`);
      // Cut line uses featureEntityIds (not subEntityIds).
      if (!f.hidden) for (const e of outputs) out.push(e);
      // Same ctx registration for the chamfer line.
      const cutPrimaryId = featureEntityIds.get(f.id);
      const cutEnt = cutPrimaryId !== undefined
        ? (outputs.find(e => e.id === cutPrimaryId) ?? null) : null;
      if (cutEnt) ctx.set(f.id, cutEnt);
      continue;
    }
    let e: Entity | null;
    if (!isDirty && cachedEntity.has(f.id)) {
      e = cachedEntity.get(f.id)!;
    } else {
      e = buildEntity(f, ctx);
      if (e) cachedEntity.set(f.id, e);
    }
    if (e) {
      // Hidden features still populate ctx — so lines snapped to a deleted
      // Hilfslinie keep resolving and stay parametric — but they don't go
      // into state.entities, so they're invisible and unselectable on canvas.
      ctx.set(f.id, e);
      if (!f.hidden) out.push(e);
    }
  }
  // Drop stable-id bindings for deleted features.
  for (const fid of Array.from(featureEntityIds.keys())) {
    if (!alive.has(fid)) featureEntityIds.delete(fid);
  }
  // Drop sub-entity ids whose composite key (`${modFid}#${srcFid}`) is no
  // longer alive — either the modifier was deleted or a source was removed
  // from its sourceIds list.
  for (const key of Array.from(subEntityIds.keys())) {
    if (!aliveSubKeys.has(key)) subEntityIds.delete(key);
  }
  // GC stale cache entries for deleted features.
  for (const fid of Array.from(cachedEntity.keys())) {
    if (!alive.has(fid)) cachedEntity.delete(fid);
  }
  for (const fid of Array.from(cachedModifierOutputs.keys())) {
    if (!alive.has(fid)) cachedModifierOutputs.delete(fid);
  }
  state.entities = out;
  entityToFeature.clear();
  entityToModifier.clear();
  for (const [fid, eid] of featureEntityIds) entityToFeature.set(eid, fid);
  for (const [key, eid] of subEntityIds) {
    const modFid = key.slice(0, key.indexOf('#'));
    entityToModifier.set(eid, modFid);
  }
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
        rotation: numE(init.rotation ?? 0),
        ...(init.boxWidth !== undefined ? { boxWidth: numE(init.boxWidth) } : {}) };
    case 'dim':
      return { id, kind: 'dim', layer,
        ...(init.dimKind ? { dimKind: init.dimKind } : {}),
        p1: absPt(init.p1), p2: absPt(init.p2),
        offset: absPt(init.offset),
        ...(init.vertex ? { vertex: absPt(init.vertex) } : {}),
        ...(init.ray1   ? { ray1:   absPt(init.ray1)   } : {}),
        ...(init.ray2   ? { ray2:   absPt(init.ray2)   } : {}),
        textHeight: numE(init.textHeight),
        ...(init.style ? { style: init.style } : {}) };
    case 'hatch':
      return { id, kind: 'hatch', layer,
        mode: init.mode,
        pts: init.pts.map(absPt),
        ...(init.holes && init.holes.length > 0
          ? { holes: init.holes.map(h => h.map(absPt)) } : {}),
        ...(init.angle   !== undefined ? { angle:   numE(init.angle)   } : {}),
        ...(init.spacing !== undefined ? { spacing: numE(init.spacing) } : {}),
        ...(init.color   !== undefined ? { color: init.color } : {}) };
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

/**
 * Remove features from the drawing. The catch: if some surviving feature
 * still references one of the requested deletes (e.g. a line was snapped to
 * a Hilfslinie's intersection), we can't actually drop the reference target
 * without either (a) freezing the dependent to a literal coordinate — which
 * severs its parametric link to the user's variables — or (b) keeping the
 * reference alive.
 *
 * We go with (b): requested deletes that still have dependents become
 * `hidden` (not rendered, not hit-tested, but still evaluated so they appear
 * in `ctx` and dependents keep resolving — including live updates when the
 * user changes variables). Requested deletes with no dependents are removed
 * outright.
 *
 * Returns `{ removed, hidden }` so the caller can toast appropriately.
 */
export function deleteFeatures(ids: Iterable<string>): { removed: number; hidden: number } {
  const requested = new Set<string>(ids);
  if (!requested.size) return { removed: 0, hidden: 0 };

  // First pass: which requested ids still have SURVIVING dependents? (A
  // "survivor" is any feature that is not itself being deleted.)
  const hide = new Set<string>();
  for (const id of requested) {
    for (const f of state.features) {
      if (requested.has(f.id)) continue;
      if (f.hidden) continue; // hidden dependents don't count — they're dormant
      if (collectFeatureRefs(f).includes(id)) { hide.add(id); break; }
    }
  }

  // Mark hides. Un-hide anything that a cleared-out dependency chain now
  // makes fully orphaned — on subsequent deletes the timeline can garbage-
  // collect the hidden feature naturally since no one references it.
  for (const f of state.features) {
    if (hide.has(f.id)) f.hidden = true;
  }

  const kill = new Set<string>();
  for (const id of requested) if (!hide.has(id)) kill.add(id);

  // parallelXLine depends on `refFeature` for its entire geometry — if its
  // base is being truly removed, the parallel can't be reconstructed either.
  // Cascade those. If the base is merely hidden, the parallel still resolves,
  // so leave it alone.
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of state.features) {
      if (kill.has(f.id)) continue;
      if (f.kind === 'parallelXLine' && kill.has(f.refFeature)) {
        kill.add(f.id); grew = true;
      }
      // Modifier features (mirror/array/rotate): prune source ids as they
      // die. If *all* sources are gone, drop the modifier itself too — it
      // has nothing left to produce.
      if (f.kind === 'mirror' || f.kind === 'array' || f.kind === 'rotate' || f.kind === 'crossMirror') {
        const before = f.sourceIds.length;
        f.sourceIds = f.sourceIds.filter(sid => !kill.has(sid));
        if (f.sourceIds.length !== before) grew = true;
        if (f.sourceIds.length === 0) {
          kill.add(f.id); grew = true;
        }
      }
    }
  }

  // When a clip/fillet/chamfer modifier is killed, its hidden source(s) should
  // be un-hidden again — they become the surviving geometry.
  for (const id of kill) {
    const f = state.features.find(x => x.id === id);
    if (!f) continue;
    if (f.kind === 'clip') {
      const src = state.features.find(x => x.id === f.sourceId);
      if (src && src.hidden) {
        // Only un-hide if no other surviving clip still references the source.
        const stillUsed = state.features.some(
          x => x.id !== id && !kill.has(x.id) && x.kind === 'clip' && x.sourceId === f.sourceId
        );
        if (!stillUsed) src.hidden = false;
      }
    }
    if (f.kind === 'fillet' || f.kind === 'chamfer') {
      for (const srcId of [f.line1Id, f.line2Id]) {
        const src = state.features.find(x => x.id === srcId);
        if (!src || !src.hidden) continue;
        const stillUsed = state.features.some(
          x => x.id !== id && !kill.has(x.id) &&
            (x.kind === 'fillet' || x.kind === 'chamfer') &&
            (x.line1Id === srcId || x.line2Id === srcId)
        );
        if (!stillUsed) src.hidden = false;
      }
    }
  }

  state.features = state.features.filter(f => !kill.has(f.id));
  evaluateTimeline();

  return { removed: kill.size, hidden: hide.size };
}

/** Restore a hidden feature so it renders + becomes selectable again. */
export function unhideFeature(featureId: string): boolean {
  const f = state.features.find(x => x.id === featureId);
  if (!f || !f.hidden) return false;
  f.hidden = false;
  evaluateTimeline();
  return true;
}

/** Every feature id this feature depends on (for dependency tracking). */
function collectFeatureRefs(f: Feature): string[] {
  const out: string[] = [];
  switch (f.kind) {
    case 'line':     out.push(...collectRefs(f.p1), ...collectRefs(f.p2)); break;
    case 'polyline': for (const p of f.pts) out.push(...collectRefs(p)); break;
    case 'rect':     out.push(...collectRefs(f.p1)); break;
    case 'circle':   out.push(...collectRefs(f.center)); break;
    case 'arc':      out.push(...collectRefs(f.center)); break;
    case 'ellipse':  out.push(...collectRefs(f.center)); break;
    case 'spline':   for (const p of f.pts) out.push(...collectRefs(p)); break;
    case 'xline':    out.push(...collectRefs(f.p)); break;
    case 'parallelXLine': out.push(f.refFeature); break;
    case 'axisParallelXLine': break;   // no feature refs (axis is virtual)
    case 'text':     out.push(...collectRefs(f.p)); break;
    case 'dim':
      out.push(...collectRefs(f.p1), ...collectRefs(f.p2), ...collectRefs(f.offset));
      if (f.vertex) out.push(...collectRefs(f.vertex));
      if (f.ray1)   out.push(...collectRefs(f.ray1));
      if (f.ray2)   out.push(...collectRefs(f.ray2));
      break;
    case 'hatch':
      for (const p of f.pts) out.push(...collectRefs(p));
      if (f.holes) for (const h of f.holes) for (const p of h) out.push(...collectRefs(p));
      break;
    case 'mirror':
      for (const sid of f.sourceIds) out.push(sid);
      if (f.axis.kind === 'twoPoints') {
        out.push(...collectRefs(f.axis.p1));
        out.push(...collectRefs(f.axis.p2));
      }
      break;
    case 'array':
      for (const sid of f.sourceIds) out.push(sid);
      out.push(...collectRefs(f.offset.p1));
      out.push(...collectRefs(f.offset.p2));
      if (f.rowOffset) {
        out.push(...collectRefs(f.rowOffset.p1));
        out.push(...collectRefs(f.rowOffset.p2));
      }
      break;
    case 'rotate':
      for (const sid of f.sourceIds) out.push(sid);
      out.push(...collectRefs(f.center));
      break;
    case 'crossMirror':
      for (const sid of f.sourceIds) out.push(sid);
      out.push(...collectRefs(f.center));
      break;
    case 'clip':
      out.push(f.sourceId);
      break;
    case 'fillet':
      out.push(f.line1Id, f.line2Id);
      break;
    case 'chamfer':
      out.push(f.line1Id, f.line2Id);
      break;
  }
  return out;
}

function collectRefs(pt: PointRef): string[] {
  if (pt.kind === 'abs') return [];
  if (pt.kind === 'intersection') return [pt.feature1, pt.feature2];
  if (pt.kind === 'polar') return collectRefs(pt.from);
  if (pt.kind === 'rayHit') return [pt.target, ...collectRefs(pt.from)];
  if (pt.kind === 'axisProject') return [...collectRefs(pt.xFrom), ...collectRefs(pt.yFrom)];
  if (pt.kind === 'interpolate') return [...collectRefs(pt.from), ...collectRefs(pt.to)];
  return [pt.feature];
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
    case 'axisParallelXLine': return 'Parallel zur Achse';
    case 'text':     return 'Text';
    case 'dim':      return 'Bemaßung';
    case 'hatch':    return f.mode === 'solid' ? 'Füllung' : 'Schraffur';
    case 'mirror':   return 'Spiegeln';
    case 'array':    return f.mode === 'matrix' ? 'Matrix-Kopie' : 'Reihenkopie';
    case 'rotate':   return 'Rotieren';
    case 'crossMirror': return f.variant === 'quarter' ? 'Symmetrie 1/4' : 'Symmetrie 1/2';
    case 'clip':    return 'Trimmen';
    case 'fillet':  return 'Verrundung';
    case 'chamfer': return 'Fase';
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
    case 'axisParallelXLine':
      return `‖ ${f.axis === 'x' ? 'X-Achse' : 'Y-Achse'} · d = ${exprLabel(f.distance)}`;
    case 'text':
      return `"${f.text.slice(0, 14)}${f.text.length > 14 ? '…' : ''}"`;
    case 'dim':
      return `${ptLabel(f.p1)} ↔ ${ptLabel(f.p2)}`;
    case 'hatch': {
      const holes = f.holes?.length ?? 0;
      const holeTag = holes > 0 ? ` · ${holes} Loch` + (holes === 1 ? '' : 'er') : '';
      if (f.mode === 'solid') return `${f.pts.length} Punkte${holeTag}`;
      return `${f.pts.length} Punkte · d ${f.spacing ? exprLabel(f.spacing) : '5'}${holeTag}`;
    }
    case 'mirror': {
      const n = f.sourceIds.length;
      const axisLbl = f.axis.kind === 'worldAxis'
        ? (f.axis.axis === 'x' ? 'X-Achse' : 'Y-Achse')
        : 'Achse';
      return `${n} × ${axisLbl}`;
    }
    case 'array': {
      const n = f.sourceIds.length;
      if (f.mode === 'matrix') {
        return `${n} × ${exprLabel(f.cols)}×${exprLabel(f.rows)}`;
      }
      return `${n} × ${exprLabel(f.cols)} Stk.`;
    }
    case 'rotate':
      return `${f.sourceIds.length} × ${exprLabel(f.angle)}°`;
    case 'crossMirror': {
      const n = f.sourceIds.length;
      // Show the orientation for 1/2 since angle=0 → oben↕unten, angle=90 → links↔rechts.
      if (f.variant === 'half') {
        const deg = f.angle.kind === 'num' ? f.angle.value : null;
        const tag = deg === 90 ? ' ↔' : deg === 0 ? ' ↕' : '';
        return `${n} × 1/2${tag} · ${exprLabel(f.angle)}°`;
      }
      return `${n} × 1/4 · ${exprLabel(f.angle)}°`;
    }
    case 'clip':
      return `${f.segments.length} Seg. ← ${f.sourceId.slice(0, 4)}`;
    case 'fillet':
      return `r = ${f.radius.toFixed(2)} · ${f.line1Id.slice(0, 4)} × ${f.line2Id.slice(0, 4)}`;
    case 'chamfer':
      return `d = ${f.distance.toFixed(2)} · ${f.line1Id.slice(0, 4)} × ${f.line2Id.slice(0, 4)}`;
  }
}

function ptLabel(pt: PointRef): string {
  if (pt.kind === 'abs') return '·';
  if (pt.kind === 'intersection') {
    return `∩(${pt.feature1.slice(0, 4)}×${pt.feature2.slice(0, 4)})`;
  }
  if (pt.kind === 'polar') {
    return `${ptLabel(pt.from)}→${exprLabel(pt.distance)}@${exprLabel(pt.angle)}°`;
  }
  if (pt.kind === 'rayHit') {
    return `${ptLabel(pt.from)}→${pt.target.slice(0, 4)}@${exprLabel(pt.angle)}°`;
  }
  if (pt.kind === 'axisProject') {
    return `⊓(x:${ptLabel(pt.xFrom)}, y:${ptLabel(pt.yFrom)})`;
  }
  if (pt.kind === 'interpolate') {
    return `${ptLabel(pt.from)}—${exprLabel(pt.t)}—${ptLabel(pt.to)}`;
  }
  return `${pt.kind}(${pt.feature.slice(0, 4)})`;
}

// ============================================================================
// Driving Dimensions
// ============================================================================

/**
 * Describes how a dim's measured value *could* be driven, if at all. Returned
 * by `analyseDrivingDim` so the caller (dbl-click handler) can decide whether
 * to show the edit prompt at all, and so `applyDrivingDim` knows exactly what
 * to mutate.
 */
export type DrivingDimPlan =
  | {
      kind: 'lineLength';
      /** Feature id of the line whose length is being driven. */
      lineId: string;
      /** Which endpoint of the line to KEEP fixed (dim's p1 is anchored here).
       *  The other endpoint becomes a polar-from-keeper with the new distance. */
      keeperEnd: 0 | 1;
      /** Current angle of the line in degrees (captured at click time). Used
       *  as the angle Expr of the polar PointRef so the line's direction is
       *  preserved even when the distance Expr later re-evaluates. */
      currentAngleDeg: number;
    }
  | {
      kind: 'absTranslate';
      /** Current unit direction from dim.p1 → dim.p2 (for preserving
       *  direction when we recompute the abs endpoint). */
      ux: number;
      uy: number;
      /** World position of dim.p1 (the anchor we keep). */
      p1World: Pt;
    };

/**
 * Inspect the dim feature and decide the best driving strategy.
 *
 *   • "lineLength" — the strong case: both dim endpoints are `endpoint` refs
 *     to the same `line` feature, at opposite ends. We can rebuild the line's
 *     non-keeper endpoint as a polar-from-keeper, so the new length is an
 *     Expr (literal / param / formula) and stays live under parameter edits.
 *   • "absTranslate" — weak fallback: both dim endpoints are abs. We just
 *     translate dim.p2 along the current direction so the measured distance
 *     equals the new value. Parametric links aren't created, but the dim's
 *     numeric value lands where the user wants.
 *   • null — the dim doesn't fit either case (e.g. endpoints on two different
 *     features, or already linked but not both to the same line). Caller
 *     should surface "nicht fahrbar" or similar.
 */
export function analyseDrivingDim(dimFeatureId: string): DrivingDimPlan | null {
  const f = state.features.find(x => x.id === dimFeatureId);
  if (!f || f.kind !== 'dim') return null;
  // Driving only for linear dims — angular/radius/diameter have different
  // semantics and would need per-kind inverse-resolve logic.
  if (f.dimKind && f.dimKind !== 'linear') return null;

  const p1 = f.p1, p2 = f.p2;

  // Strong case: both endpoints are `endpoint` refs on the same line feature.
  if (p1.kind === 'endpoint' && p2.kind === 'endpoint' && p1.feature === p2.feature) {
    const line = state.features.find(x => x.id === p1.feature);
    if (line && line.kind === 'line' && p1.end !== p2.end) {
      // Resolve current world positions to capture the line's direction.
      const ctx = buildCtxUpTo(line.id);
      const lineEnt = ctx.get(line.id);
      if (lineEnt && lineEnt.type === 'line') {
        const a = p1.end === 0 ? { x: lineEnt.x1, y: lineEnt.y1 } : { x: lineEnt.x2, y: lineEnt.y2 };
        const b = p1.end === 0 ? { x: lineEnt.x2, y: lineEnt.y2 } : { x: lineEnt.x1, y: lineEnt.y1 };
        const dx = b.x - a.x, dy = b.y - a.y;
        if (Math.hypot(dx, dy) > 1e-9) {
          return {
            kind: 'lineLength',
            lineId: line.id,
            keeperEnd: p1.end,
            currentAngleDeg: Math.atan2(dy, dx) * 180 / Math.PI,
          };
        }
      }
    }
  }

  // Weak fallback: both endpoints abs → we can at least move the numeric p2.
  if (p1.kind === 'abs' && p2.kind === 'abs'
      && p1.x.kind === 'num' && p1.y.kind === 'num'
      && p2.x.kind === 'num' && p2.y.kind === 'num') {
    const dx = p2.x.value - p1.x.value;
    const dy = p2.y.value - p1.y.value;
    const L = Math.hypot(dx, dy);
    if (L > 1e-9) {
      return {
        kind: 'absTranslate',
        ux: dx / L, uy: dy / L,
        p1World: { x: p1.x.value, y: p1.y.value },
      };
    }
  }

  return null;
}

/**
 * Evaluate the timeline up to (but not including) the given feature id, so
 * we can resolve `ctx` entries the dim references (without the dim itself or
 * anything after it affecting resolution). Used by driving-dim analysis to
 * capture a line's current world direction.
 */
function buildCtxUpTo(stopFid: string): EvalCtx {
  const ctx: EvalCtx = new Map();
  for (const f of state.features) {
    if (f.id === stopFid) break;
    if (f.kind === 'mirror' || f.kind === 'array' || f.kind === 'rotate' || f.kind === 'crossMirror') continue;
    const e = buildEntity(f, ctx);
    if (e) ctx.set(f.id, e);
  }
  // Also include the stopFid itself, because some callers (line-length driving)
  // need its current geometry as the source of truth.
  const target = state.features.find(x => x.id === stopFid);
  if (target && target.kind !== 'mirror' && target.kind !== 'array' && target.kind !== 'rotate' && target.kind !== 'crossMirror') {
    const e = buildEntity(target, ctx);
    if (e) ctx.set(target.id, e);
  }
  return ctx;
}

/** Outcome of an `applyDrivingDim` call. */
export type DrivingDimResult = {
  /** Feature whose tree must rebuild. */
  mutatedFid: string;
  /** Parameter ids whose values were driven. Empty when the dim edit was
   *  structural (PointRef rewrite) rather than a bare-param update. */
  changedParams: string[];
};

/**
 * Apply a driving-dim plan, mutating the underlying feature(s) so the dim's
 * measured value matches `newValue`. Pass the Expr (not a raw number) so the
 * link stays parametric — e.g. driving with a param ref makes the geometry
 * re-evaluate whenever that param changes.
 *
 * **Direct Interaction on dims.** If the line is already driven by a bare
 * parameter ref (i.e. its non-keeper end is `polar(..., distance = param P)`)
 * AND the user types a plain number, we update P's value instead of rewriting
 * the polar — so siblings that reference P follow.
 *
 * Returns `{ mutatedFid, changedParams }` or `null` if the plan couldn't be
 * applied.
 */
export function applyDrivingDim(
  dimFeatureId: string,
  plan: DrivingDimPlan,
  newValue: Expr,
): DrivingDimResult | null {
  if (plan.kind === 'lineLength') {
    const line = state.features.find(x => x.id === plan.lineId);
    if (!line || line.kind !== 'line') return null;
    const keeper = plan.keeperEnd === 0 ? line.p1 : line.p2;
    const nonKeeperRef = plan.keeperEnd === 0 ? line.p2 : line.p1;

    // Direct-interaction shortcut: if the line is currently driven by a
    // polar(from=keeper, distance = param P) and newValue is a literal,
    // drive P's value rather than replace the whole polar — so anything
    // else referencing P follows.
    if (newValue.kind === 'num'
        && nonKeeperRef.kind === 'polar'
        && nonKeeperRef.distance.kind === 'param') {
      const pid = driveExprValue(nonKeeperRef.distance, newValue.value);
      if (pid) return { mutatedFid: line.id, changedParams: [pid] };
    }

    // A rayHit endpoint is length-derived: the length is whatever makes the
    // line hit its target edge. Driving the dim to a numeric length would
    // have to silently break the rayHit link — refuse instead, so the user
    // consciously rebuilds the line if they want a fixed length.
    if (nonKeeperRef.kind === 'rayHit') return null;

    // Otherwise: rewrite the non-keeper endpoint as polar(keeper, angle, distance).
    const polar: PointRef = {
      kind: 'polar',
      from: keeper,
      angle: { kind: 'num', value: plan.currentAngleDeg },
      distance: newValue,
    };
    if (plan.keeperEnd === 0) line.p2 = polar;
    else                      line.p1 = polar;
    return { mutatedFid: line.id, changedParams: [] };
  }
  // absTranslate: move dim.p2 to p1 + dir * newLen. We need a numeric length
  // here; evaluate the Expr once and write literals. (The link is lost anyway
  // because both endpoints were abs to start with — there's no upstream to
  // bind to.)
  const f = state.features.find(x => x.id === dimFeatureId);
  if (!f || f.kind !== 'dim') return null;
  const len = evalExpr(newValue);
  if (!Number.isFinite(len) || len <= 0) return null;
  f.p2 = {
    kind: 'abs',
    x: { kind: 'num', value: plan.p1World.x + plan.ux * len },
    y: { kind: 'num', value: plan.p1World.y + plan.uy * len },
  };
  return { mutatedFid: f.id, changedParams: [] };
}

// ============================================================================
// Grip-drag without flatten
// ============================================================================
//
// `replaceFeatureFromInit` (the old grip-drag target) rebuilds the feature
// from an EntityInit, which means ALL PointRefs become abs and ALL Exprs
// become num — every parametric link on the touched feature is lost, even if
// the user only grabbed a single endpoint.
//
// The functions below take a surgical approach: for each grip kind, we
// mutate ONLY the Exprs / PointRefs the grip is actually supposed to edit.
// Everything else is left alone, so:
//   • dragging a line endpoint detaches just that end; the other end keeps
//     its ref to whatever it was snapped to.
//   • dragging a circle's radius quadrant updates the radius Expr; the
//     centre's PointRef stays intact.
//   • dragging a polyline vertex flattens ONE PointRef; the neighbours keep
//     theirs.
//   • dragging a rect edge adjusts width/height Exprs and can keep F.p1's
//     PointRef if the anchor corner stays put in world coords.
//
// When the feature's current shape can't support an in-place edit (e.g. a
// move-grip on a line whose endpoints are both linked — translating would
// desynchronise them from their anchors), this function returns `false` and
// the caller falls back to `replaceFeatureFromInit` (legacy flatten path).

const absPtE = (p: Pt): PointRef =>
  ({ kind: 'abs', x: numE(p.x), y: numE(p.y) });

/** True when the PointRef is an `abs` ref whose x/y Exprs are both plain
 *  literals (i.e. safe to translate by mutating the numbers in place). */
function isPlainAbs(r: PointRef): boolean {
  return r.kind === 'abs' && r.x.kind === 'num' && r.y.kind === 'num';
}

/** In-place translate a plain-abs PointRef. Returns true iff the ref was
 *  actually mutable (plain abs). Exprs that are `param` / `formula` aren't
 *  touched, and non-abs refs aren't touched either. */
function translatePlainAbs(r: PointRef, dx: number, dy: number): boolean {
  if (r.kind !== 'abs') return false;
  if (r.x.kind !== 'num' || r.y.kind !== 'num') return false;
  r.x.value += dx;
  r.y.value += dy;
  return true;
}

/**
 * Direct-interaction helper: if an Expr is a bare parameter reference, drive
 * the VARIABLE's value instead of overwriting the Expr with a literal. This
 * preserves parametric behaviour across ALL consumers of the variable —
 * e.g. dragging the quadrant grip of a circle whose `radius = R` updates
 * `R`, so every other feature that references `R` follows.
 *
 * Returns the parameter id if the Expr was a bare param ref and we drove it;
 * returns `null` otherwise — the caller should overwrite the Expr with a
 * fresh `numE(newValue)`. Formula Exprs are not inverted (yet) — we fall
 * through to literal overwrite in that case, which IS a link loss, but
 * formulas can't be trivially inverted (2*L+5 vs L^2 vs sin(L)) so that's
 * an acceptable corner case for now.
 */
function driveExprValue(current: Expr, newValue: number): string | null {
  if (current.kind === 'param') {
    const p = state.parameters.find(x => x.id === current.id);
    if (!p) return null;
    p.value = newValue;
    return p.id;
  }
  return null;
}

/** Outcome of an in-place grip drag. */
export type GripDragResult = {
  /** Feature ids whose subtree must be rebuilt. Always contains the dragged
   *  feature itself. */
  changedFeatures: string[];
  /** Parameter ids whose values were driven by the drag. Empty when the drag
   *  only mutated literal Exprs. The caller passes these into
   *  `evaluateTimeline` so geometry elsewhere that references the same
   *  parameter re-evaluates, and refreshes the parameter panel. */
  changedParams: string[];
};

/**
 * Apply a grip drag directly to the feature's data, preserving as many
 * PointRefs / Exprs as possible.
 *
 * Returns:
 *   • a `GripDragResult` — the drag was handled in-place. The result lists
 *     the feature ids (always includes the dragged feature) and parameter
 *     ids whose values were driven by the drag. The caller passes both into
 *     `evaluateTimeline` so sibling geometry that references the same
 *     parameter follows, and refreshes the parameter panel.
 *   • `null` — the feature's current shape cannot support an in-place edit
 *     for this grip (e.g. move-grip on a line whose endpoints are both
 *     linked). The caller should fall back to `replaceFeatureFromInit`.
 *
 * **Direct Interaction.** When a feature's Expr is a bare parameter ref
 * (e.g. `radius = R`), dragging the corresponding grip drives R's VALUE
 * rather than overwriting the Expr with a literal. This is the core of
 * parametric behaviour: the variable is the source of truth, and direct
 * manipulation on any view of it is a write TO the variable.
 *
 * `startEntity` is the entity state at mousedown — used as a stable baseline
 * so accumulated mousemoves don't drift.
 */
export function applyGripDragInPlace(
  feat: Feature,
  grip: Grip,
  startEntity: Entity,
  newPoint: Pt,
  delta: Pt,
): GripDragResult | null {
  const { x: nx, y: ny } = newPoint;
  const { x: dx, y: dy } = delta;

  const changedParams: string[] = [];
  const ok = (): GripDragResult => ({ changedFeatures: [feat.id], changedParams });

  // Assign a numeric value to an Expr-typed field on `feat`, driving a
  // parameter if the current Expr is a bare param ref, else overwriting with
  // a literal. `feat` is a discriminated union; we've already narrowed to
  // the right variant at each callsite, so accept the field name as a string
  // and rely on the callsite's narrowing for correctness.
  const driveOrSet = (key: string, val: number): void => {
    const bag = feat as unknown as Record<string, Expr>;
    const cur = bag[key];
    const pid = driveExprValue(cur, val);
    if (pid) changedParams.push(pid);
    else bag[key] = numE(val);
  };

  // ── line ────────────────────────────────────────────────────────────────
  if (feat.kind === 'line' && startEntity.type === 'line') {
    if (grip.kind === 'endpoint') {
      // Detach exactly the grabbed endpoint. The other end keeps its ref.
      if (grip.endIdx === 0) feat.p1 = absPtE({ x: nx, y: ny });
      else                   feat.p2 = absPtE({ x: nx, y: ny });
      return ok();
    }
    if (grip.kind === 'move') {
      // Translate both endpoints. Only plain-abs ends can be translated in
      // place; linked ends would desynchronise from their anchors. If any
      // endpoint is linked, fallback — user intent is ambiguous.
      if (!isPlainAbs(feat.p1) || !isPlainAbs(feat.p2)) return null;
      translatePlainAbs(feat.p1, dx, dy);
      translatePlainAbs(feat.p2, dx, dy);
      return ok();
    }
    return null;
  }

  // ── circle ──────────────────────────────────────────────────────────────
  if (feat.kind === 'circle' && startEntity.type === 'circle') {
    if (grip.kind === 'move') {
      if (!translatePlainAbs(feat.center, dx, dy)) return null;
      return ok();
    }
    if (grip.kind === 'circle-quad') {
      const r = Math.hypot(nx - startEntity.cx, ny - startEntity.cy);
      if (r < 1e-9) return null;
      driveOrSet('radius', r);
      return ok();
    }
    return null;
  }

  // ── arc ─────────────────────────────────────────────────────────────────
  if (feat.kind === 'arc' && startEntity.type === 'arc') {
    if (grip.kind === 'move' || grip.kind === 'arc-mid') {
      if (!translatePlainAbs(feat.center, dx, dy)) return null;
      return ok();
    }
    if (grip.kind === 'arc-end') {
      const ang = Math.atan2(ny - startEntity.cy, nx - startEntity.cx);
      const r = Math.hypot(nx - startEntity.cx, ny - startEntity.cy);
      if (r < 1e-9) return null;
      driveOrSet('radius', r);
      if (grip.arcEnd === 0) driveOrSet('a1', ang);
      else                   driveOrSet('a2', ang);
      return ok();
    }
    return null;
  }

  // ── ellipse ─────────────────────────────────────────────────────────────
  if (feat.kind === 'ellipse' && startEntity.type === 'ellipse') {
    if (grip.kind === 'move') {
      if (!translatePlainAbs(feat.center, dx, dy)) return null;
      return ok();
    }
    if (grip.kind === 'ellipse-axis') {
      const vx = nx - startEntity.cx, vy = ny - startEntity.cy;
      const L = Math.hypot(vx, vy);
      if (L < 1e-9) return null;
      if (grip.ellipseAxis === 'rx') {
        const side = grip.ellipseSide ?? 1;
        driveOrSet('rx', L);
        driveOrSet('rot', Math.atan2(vy * side, vx * side));
      } else {
        // Nebenachse: Länge entlang der senkrechten Richtung (aus startEntity
        // abgeleitet, damit die Achse ihrer Rotation treu bleibt).
        const nxA = -Math.sin(startEntity.rot), nyA = Math.cos(startEntity.rot);
        const proj = Math.abs(vx * nxA + vy * nyA);
        if (proj < 1e-9) return null;
        driveOrSet('ry', proj);
      }
      return ok();
    }
    return null;
  }

  // ── rect ────────────────────────────────────────────────────────────────
  if (feat.kind === 'rect' && startEntity.type === 'rect') {
    const s = startEntity;
    const xl0 = Math.min(s.x1, s.x2), xr0 = Math.max(s.x1, s.x2);
    const yb0 = Math.min(s.y1, s.y2), yt0 = Math.max(s.y1, s.y2);

    // Compute new edges from the grip kind. Mirrors the geometry in
    // grips.ts::computeGripDragInit but keeps things local so no
    // cross-module dep on a helper we don't expose.
    let xl = xl0, xr = xr0, yb = yb0, yt = yt0;
    if (grip.kind === 'move') {
      xl += dx; xr += dx; yb += dy; yt += dy;
    } else if (grip.kind === 'rect-corner') {
      if (grip.cornerIdx === 0) { xl = nx; yt = ny; }
      if (grip.cornerIdx === 1) { xr = nx; yt = ny; }
      if (grip.cornerIdx === 2) { xr = nx; yb = ny; }
      if (grip.cornerIdx === 3) { xl = nx; yb = ny; }
    } else if (grip.kind === 'rect-edge') {
      if (grip.edge === 'top')    yt = ny;
      if (grip.edge === 'bottom') yb = ny;
      if (grip.edge === 'left')   xl = nx;
      if (grip.edge === 'right')  xr = nx;
    } else {
      return null;
    }

    // If the user dragged across the anchor corner, sign flips would be
    // required and F.p1's "meaning" (which corner) would have to change.
    // That's doable but annoying to get right while preserving links; for
    // now fall back to flatten in that edge case.
    if (!(xr > xl + 1e-9) || !(yt > yb + 1e-9)) return null;

    // F.p1's corner (before the drag) — derived from signs.
    // sign=+1 on X means p1.x = xl, sign=-1 means p1.x = xr. Same for Y.
    const p1WasXL = feat.signX === 1;
    const p1WasYB = feat.signY === 1;
    const newP1x = p1WasXL ? xl : xr;
    const newP1y = p1WasYB ? yb : yt;

    // Preserve F.p1's PointRef if its world position doesn't move.
    const ctx = buildCtxUpTo(feat.id);
    const p1Now = resolvePt(feat.p1, ctx);
    const p1Moved = Math.abs(p1Now.x - newP1x) > 1e-6 || Math.abs(p1Now.y - newP1y) > 1e-6;
    if (p1Moved) {
      // F.p1 must move — only possible if it's plain abs. Linked refs can't
      // move without desyncing from their anchor; fallback to flatten there.
      if (feat.p1.kind !== 'abs') return null;
      if (feat.p1.x.kind !== 'num' || feat.p1.y.kind !== 'num') return null;
      feat.p1.x.value = newP1x;
      feat.p1.y.value = newP1y;
    }
    driveOrSet('width',  xr - xl);
    driveOrSet('height', yt - yb);
    // signs unchanged — we bailed on inversions above.
    return ok();
  }

  // ── polyline ────────────────────────────────────────────────────────────
  if (feat.kind === 'polyline' && startEntity.type === 'polyline') {
    if (grip.kind === 'vertex' && grip.vertexIndex != null) {
      const i = grip.vertexIndex;
      if (i < 0 || i >= feat.pts.length) return null;
      // Detach exactly this vertex. Neighbours keep their refs (e.g. a
      // closed polyline sharing corners with a neighbour line stays linked
      // everywhere except the grabbed vertex).
      feat.pts[i] = absPtE({ x: nx, y: ny });
      return ok();
    }
    if (grip.kind === 'move') {
      // Require every vertex to be plain-abs — translating a linked vertex
      // would desync it from its anchor.
      for (const p of feat.pts) if (!isPlainAbs(p)) return null;
      for (const p of feat.pts) translatePlainAbs(p, dx, dy);
      return ok();
    }
    return null;
  }

  // ── spline ──────────────────────────────────────────────────────────────
  if (feat.kind === 'spline' && startEntity.type === 'spline') {
    if (grip.kind === 'vertex' && grip.vertexIndex != null) {
      const i = grip.vertexIndex;
      if (i < 0 || i >= feat.pts.length) return null;
      feat.pts[i] = absPtE({ x: nx, y: ny });
      return ok();
    }
    if (grip.kind === 'move') {
      for (const p of feat.pts) if (!isPlainAbs(p)) return null;
      for (const p of feat.pts) translatePlainAbs(p, dx, dy);
      return ok();
    }
    return null;
  }

  // ── text ────────────────────────────────────────────────────────────────
  if (feat.kind === 'text' && startEntity.type === 'text') {
    if (grip.kind === 'move') {
      if (!translatePlainAbs(feat.p, dx, dy)) return null;
      return ok();
    }
    return null;
  }

  return null;
}
