import type { ArcEntity, CircleEntity, ClipSegment, CrossMirrorMode, EllipseEntity, Entity, EntityInit, EntityShape, Expr, Feature, FeatureEdgeRef, LineEntity, LineFeature, PointRef, Pt, RadiusMode, RectEntity, SnapPoint, ToolCtx, ToolId } from './types';
import { state, runtime, savePanelsLocked } from './state';
import {
  add, dist, dot, len, norm, orthoSnap, perp, perpOffset, scale, sub,
} from './math';
import { angleInSweep, hitTest, nearestPolySegment, nearestRectEdge, pickReference } from './hittest';
import { requestRender as render } from './render';
import { dom } from './dom';
import {
  renderLayers, setPrompt, setTip, syncDimPicker, toast, updateSelStatus, updateStats,
} from './ui';
import { pushUndo } from './undo';
import { evalExpr } from './params';
import {
  addFeatureFromInit, AXIS_X_ID, AXIS_Y_ID, deleteFeatures, entityIdForFeature,
  evaluateTimeline, featureForEntity, featureFromEntityInit, modifierOutputInfo,
  newFeatureId, replaceFeatureFromInit, resolveClipSubEntity,
} from './features';
import { showConfirm } from './modal';
import { layoutText } from './textlayout';
import { showInlineTextEditor } from './textinline';
import { getShortcutKey, onShortcutsChange } from './shortcuts';

// When user shortcuts change (via Einstellungen → Tastenkürzel), re-render
// the tool rail so each button's tooltip/data-key reflects the new binding.
// The rail won't exist yet when this module first evaluates, so the listener
// is stashed and only takes effect on the next render cycle.
onShortcutsChange(() => renderToolsPanel());

const numE = (v: number): Expr => ({ kind: 'num', value: v });

/**
 * Convert a snap point into a PointRef — parametric link whenever possible,
 * flat abs coords otherwise. "Link whenever possible" is the default: if the
 * user snaps to an existing feature's endpoint / centre / midpoint / axis
 * intersection, we record a PointRef that resolves through
 * `evaluateTimeline()`. That's what keeps downstream geometry parametric when
 * the source's variables change.
 *
 * Callers that *don't* want links (modifier tools like move/rotate/scale,
 * which explicitly flatten via `featureFromEntityInit`) bypass this helper.
 */
function snapToPointRef(snap: SnapPoint | null, fallback: Pt): PointRef {
  const abs = (p: Pt): PointRef => ({ kind: 'abs', x: numE(p.x), y: numE(p.y) });
  const pt: Pt = snap ?? fallback;

  // Free-drawing mode: skip the entire ref-upgrade path and emit plain abs
  // coordinates. No downstream chains, no surprise moves when unrelated
  // features change. Toggled globally via the PARAM button in the snap bar.
  if (!runtime.parametricMode) return abs(pt);

  // Axis-intersection snap: one side is a real feature, the other is the X
  // or Y origin axis (transported as reserved entity ids -1001 / -1002 — see
  // snap.ts). Translate both sides into their PointRef feature-id form
  // (AXIS_X_ID / AXIS_Y_ID for the axes, real string id for the feature)
  // and return an `intersection` PointRef. Resolves via the short-circuit
  // branch in features.ts → `resolvePt` which fabricates an axis xline.
  if (snap?.type === 'int' && snap.entityId !== undefined && snap.entityId2 !== undefined) {
    const axisRefOf = (eid: number): string | null => {
      if (eid === -1001) return AXIS_X_ID;
      if (eid === -1002) return AXIS_Y_ID;
      return null;
    };
    const ax1 = axisRefOf(snap.entityId);
    const ax2 = axisRefOf(snap.entityId2);
    if (ax1 || ax2) {
      const side = (ax: string | null, eid: number): string | null => {
        if (ax) return ax;
        const f = featureForEntity(eid);
        return f ? f.id : null;
      };
      const id1 = side(ax1, snap.entityId);
      const id2 = side(ax2, snap.entityId2);
      if (id1 && id2) return { kind: 'intersection', feature1: id1, feature2: id2 };
      // One side is the axis but the other feature is gone / untracked —
      // fall through to abs rather than fabricating a broken ref.
    }
  }

  // Intersection of two lines/xlines: link to both features so the point tracks
  // when either feature or its parameters change.
  if (snap?.type === 'int' && snap.entityId !== undefined && snap.entityId2 !== undefined) {
    const feat1 = featureForEntity(snap.entityId);
    const feat2 = featureForEntity(snap.entityId2);
    if (feat1 && feat2) {
      return { kind: 'intersection', feature1: feat1.id, feature2: feat2.id };
    }
  }

  if (!snap?.entityId) return abs(pt);
  const feat = featureForEntity(snap.entityId);
  if (!feat) return abs(pt);
  const fid = feat.id;
  if (snap.type === 'center') return { kind: 'center', feature: fid };
  if (snap.type === 'mid')    return { kind: 'mid',    feature: fid };
  if (snap.type === 'end') {
    const ent = state.entities.find(e => e.id === snap.entityId);
    if (!ent) return abs(pt);
    if (ent.type === 'line') {
      const d0 = dist(snap, { x: ent.x1, y: ent.y1 });
      const d1 = dist(snap, { x: ent.x2, y: ent.y2 });
      return { kind: 'endpoint', feature: fid, end: d0 <= d1 ? 0 : 1 };
    }
    if (ent.type === 'xline') return { kind: 'endpoint', feature: fid, end: 0 };
    if (ent.type === 'polyline') {
      const d0 = dist(snap, ent.pts[0]);
      const dL = dist(snap, ent.pts[ent.pts.length - 1]);
      return { kind: 'endpoint', feature: fid, end: d0 <= dL ? 0 : 1 };
    }
    if (ent.type === 'rect') {
      // Rects have 4 corners but the endpoint PointRef only addresses p1 (0)
      // and p2 (1) — the two feature-defined corners. Pick whichever of those
      // is closer; fall back to abs for the two derived corners.
      const d0 = dist(snap, { x: ent.x1, y: ent.y1 });
      const d1 = dist(snap, { x: ent.x2, y: ent.y2 });
      const TOL = 1e-6;
      if (d0 < TOL) return { kind: 'endpoint', feature: fid, end: 0 };
      if (d1 < TOL) return { kind: 'endpoint', feature: fid, end: 1 };
      // Other corner — derive via intersection of the two edges through it.
      // Skipped for v1: abs keeps geometry but not parametric link.
      return abs(pt);
    }
    if (ent.type === 'arc') {
      // Arc endpoints at a1/a2 → end 0 / end 1. Must compare against the live
      // endpoint positions, not the snapped pt, because floating snap tol can
      // otherwise flip which end we pick.
      const e1 = { x: ent.cx + Math.cos(ent.a1) * ent.r, y: ent.cy + Math.sin(ent.a1) * ent.r };
      const e2 = { x: ent.cx + Math.cos(ent.a2) * ent.r, y: ent.cy + Math.sin(ent.a2) * ent.r };
      const d0 = dist(snap, e1);
      const d1 = dist(snap, e2);
      return { kind: 'endpoint', feature: fid, end: d0 <= d1 ? 0 : 1 };
    }
  }
  return abs(pt);
}

/**
 * Upgrade a free-point PointRef to a rigid-body link from an anchor when
 * possible. Called at commit time for tools where the user draws two (or
 * more) points and the second click lands at a truly free world location:
 *
 *   • If the candidate is already a parametric ref (endpoint, center, mid,
 *     intersection, polar, rayHit) — return it unchanged, the user explicitly
 *     snapped to something.
 *   • If the candidate is `abs` but the `anchorRef` is parametric — return a
 *     `polar { from: anchorRef, angle, distance }` ref capturing the current
 *     relative vector from the anchor's world-space position to the free
 *     point. When the anchor later moves (param change on its source
 *     feature), the free point moves rigidly with it, preserving the sketched
 *     angle and length. This is what users intuitively expect from a
 *     parametric CAD tool — "the point I drew relative to that corner stays
 *     relative to that corner".
 *   • If both are abs — return the candidate as-is (there's nothing to tie
 *     it to, so an honest abs ref is correct).
 *
 * The `from` chain preserves dependency tracking via `collectRefTargets`, so
 * `evaluateTimeline` correctly re-evaluates this point whenever any feature
 * upstream of `anchorRef` becomes dirty.
 */
function linkPointRefToAnchor(
  candidate: PointRef,
  anchorRef: PointRef | null | undefined,
  anchorPt: Pt,
  freePt: Pt,
): PointRef {
  // Free-drawing mode: never upgrade abs candidates to polar links — the
  // whole point of the mode is "draw once, no chains".
  if (!runtime.parametricMode) return candidate;
  if (candidate.kind !== 'abs') return candidate;
  if (!anchorRef || anchorRef.kind === 'abs') return candidate;
  const dx = freePt.x - anchorPt.x;
  const dy = freePt.y - anchorPt.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 1e-9) return candidate;   // degenerate: same point as anchor
  const angleDeg = Math.atan2(dy, dx) * 180 / Math.PI;
  return {
    kind: 'polar',
    from: anchorRef,
    angle: numE(angleDeg),
    distance: numE(distance),
  };
}

/**
 * Given a locked ray (base + t·dir) and a snap, return the length along the
 * ray so that the endpoint lies on the snap's *axis through itself* —
 * intersect the ray with the horizontal line y = snap.y and the vertical
 * line x = snap.x, take whichever positive intersection comes first. That
 * matches user expectation of "die Linie endet bei der Achse des Snaps"
 * and stops the line from overshooting an ACHS/END/MITTE… marker even
 * though the angle stays locked.
 *
 * Falls back to the perpendicular-foot projection if neither axis is
 * reached forward along the ray (e.g. ray nearly parallel to an axis).
 */
function lengthToSnapAxis(base: Pt, dir: Pt, snap: Pt): number {
  const dx = snap.x - base.x;
  const dy = snap.y - base.y;
  const EPS = 1e-9;
  const tX = Math.abs(dir.x) > EPS ? dx / dir.x : Infinity;
  const tY = Math.abs(dir.y) > EPS ? dy / dir.y : Infinity;
  const candidates: number[] = [];
  if (tX > 1e-6 && isFinite(tX)) candidates.push(tX);
  if (tY > 1e-6 && isFinite(tY)) candidates.push(tY);
  if (candidates.length > 0) return Math.min(...candidates);
  // Both intersections behind the base — fall back to perpendicular foot.
  return dx * dir.x + dy * dir.y;
}

type EdgeRef =
  | { kind: 'rectEdge'; side: 'top' | 'right' | 'bottom' | 'left' }
  | { kind: 'lineSeg' }
  | { kind: 'polySeg'; index: number };

/** Forward ray-vs-segment intersection. Returns the hit pt + ray parameter t. */
function raySegmentIntersect(base: Pt, dir: Pt, a: Pt, b: Pt, clampU: boolean): Pt | null {
  const ex = b.x - a.x, ey = b.y - a.y;
  const den = dir.x * (-ey) - dir.y * (-ex);
  if (Math.abs(den) < 1e-9) return null;
  const rx = a.x - base.x, ry = a.y - base.y;
  const t = (rx * (-ey) - ry * (-ex)) / den;
  const u = (dir.x * ry - dir.y * rx) / den;
  const EPS = 1e-6;
  if (t < EPS) return null;
  if (clampU && (u < -EPS || u > 1 + EPS)) return null;
  return { x: base.x + t * dir.x, y: base.y + t * dir.y };
}

/** Segment endpoints of a single rect side. */
function rectEdgeSegment(e: RectEntity, side: 'top' | 'right' | 'bottom' | 'left'): { a: Pt; b: Pt } {
  const xl = Math.min(e.x1, e.x2), xr = Math.max(e.x1, e.x2);
  const yb = Math.min(e.y1, e.y2), yt = Math.max(e.y1, e.y2);
  switch (side) {
    case 'top':    return { a: { x: xl, y: yt }, b: { x: xr, y: yt } };
    case 'right':  return { a: { x: xr, y: yb }, b: { x: xr, y: yt } };
    case 'bottom': return { a: { x: xl, y: yb }, b: { x: xr, y: yb } };
    case 'left':   return { a: { x: xl, y: yb }, b: { x: xl, y: yt } };
  }
}

/**
 * Compute the actual world-space intersection of a ray (base, dir, t≥0) with
 * the edge `edgeRef` of entity `entityId`. Returns null when the ray doesn't
 * cross the finite segment ahead of the base. Used at commit time so the
 * drawn endpoint geometry matches what the `rayHit` resolver will recompute
 * on every subsequent timeline evaluation.
 */
function rayEdgeIntersect(base: Pt, dir: Pt, entityId: number, edgeRef: EdgeRef): Pt | null {
  const e = state.entities.find(x => x.id === entityId);
  if (!e) return null;
  let a: Pt | null = null, b: Pt | null = null;
  let clampU = true;
  if (edgeRef.kind === 'rectEdge' && e.type === 'rect') {
    ({ a, b } = rectEdgeSegment(e, edgeRef.side));
  } else if (edgeRef.kind === 'lineSeg') {
    if (e.type === 'line')  { a = { x: e.x1, y: e.y1 }; b = { x: e.x2, y: e.y2 }; }
    if (e.type === 'xline') { a = { x: e.x1, y: e.y1 }; b = { x: e.x1 + e.dx, y: e.y1 + e.dy }; clampU = false; }
  } else if (edgeRef.kind === 'polySeg' && e.type === 'polyline') {
    const i = edgeRef.index;
    if (i >= 0 && i + 1 < e.pts.length) { a = e.pts[i]; b = e.pts[i + 1]; }
  }
  if (!a || !b) return null;
  return raySegmentIntersect(base, dir, a, b, clampU);
}

/**
 * When the snap landed on a rect corner, the incoming `edgeRef` is arbitrary
 * (snap.ts picks top/bottom by convention). The user's ray may prefer the
 * adjacent edge — especially the edge more perpendicular to the ray, since
 * that's the edge whose position *moves* when the rect resizes along the
 * ray axis. Pick the most-perpendicular adjacent edge that the ray actually
 * crosses. Returns `edgeRef` unchanged when the snap isn't on a rect corner.
 */
function pickBestRectCornerEdge(base: Pt, dir: Pt, entityId: number, snapped: Pt, edgeRef: EdgeRef): EdgeRef {
  const e = state.entities.find(x => x.id === entityId);
  if (!e || e.type !== 'rect' || edgeRef.kind !== 'rectEdge') return edgeRef;
  const xl = Math.min(e.x1, e.x2), xr = Math.max(e.x1, e.x2);
  const yb = Math.min(e.y1, e.y2), yt = Math.max(e.y1, e.y2);
  const TOL = 1e-6;
  const sides: ('top' | 'right' | 'bottom' | 'left')[] = [];
  if (Math.abs(snapped.y - yt) < TOL) sides.push('top');
  if (Math.abs(snapped.y - yb) < TOL) sides.push('bottom');
  if (Math.abs(snapped.x - xl) < TOL) sides.push('left');
  if (Math.abs(snapped.x - xr) < TOL) sides.push('right');
  if (sides.length < 2) return edgeRef;               // not on a corner
  let best: typeof sides[number] = edgeRef.side;
  let bestScore = -Infinity;
  for (const s of sides) {
    const seg = rectEdgeSegment(e, s);
    if (!raySegmentIntersect(base, dir, seg.a, seg.b, true)) continue;
    const isHoriz = (s === 'top' || s === 'bottom');
    // Edge normal is (0,±1) for horizontal, (±1,0) for vertical — score by
    // |ray·normal| (higher = more perpendicular to ray).
    const score = isHoriz ? Math.abs(dir.y) : Math.abs(dir.x);
    if (score > bestScore) { bestScore = score; best = s; }
  }
  return { kind: 'rectEdge', side: best };
}

/**
 * Identify which `FeatureEdgeRef` on a cutter best describes the piece of edge
 * nearest `hitPt`. Used by trim / extend / extend-to to turn an "abs-coord
 * cut point" into a parametric `rayHit` PointRef so the cut end keeps tracking
 * the cutter when its variables later change.
 *
 * Returns `null` for cutter types rayHit can't resolve (circles, arcs) — the
 * caller then falls back to an abs PointRef. That mirrors pre-v0.2.4 behaviour
 * for those cutters: the parametric link is a bonus, not a correctness
 * requirement.
 */
function featureEdgeForCutter(cutter: Entity, hitPt: Pt): FeatureEdgeRef | null {
  if (cutter.type === 'line' || cutter.type === 'xline') {
    return { kind: 'lineSeg' };
  }
  if (cutter.type === 'rect') {
    const xl = Math.min(cutter.x1, cutter.x2), xr = Math.max(cutter.x1, cutter.x2);
    const yb = Math.min(cutter.y1, cutter.y2), yt = Math.max(cutter.y1, cutter.y2);
    const sides: { side: 'top' | 'right' | 'bottom' | 'left'; d: number }[] = [
      { side: 'top',    d: Math.abs(hitPt.y - yt) + (hitPt.x < xl ? xl - hitPt.x : hitPt.x > xr ? hitPt.x - xr : 0) },
      { side: 'bottom', d: Math.abs(hitPt.y - yb) + (hitPt.x < xl ? xl - hitPt.x : hitPt.x > xr ? hitPt.x - xr : 0) },
      { side: 'left',   d: Math.abs(hitPt.x - xl) + (hitPt.y < yb ? yb - hitPt.y : hitPt.y > yt ? hitPt.y - yt : 0) },
      { side: 'right',  d: Math.abs(hitPt.x - xr) + (hitPt.y < yb ? yb - hitPt.y : hitPt.y > yt ? hitPt.y - yt : 0) },
    ];
    sides.sort((a, b) => a.d - b.d);
    return { kind: 'rectEdge', side: sides[0].side };
  }
  if (cutter.type === 'polyline') {
    let bestIdx = -1;
    let bestD = Infinity;
    const distSeg = (a: Pt, b: Pt): number => {
      const ax = b.x - a.x, ay = b.y - a.y;
      const L2 = ax * ax + ay * ay;
      if (L2 < 1e-12) return Math.hypot(hitPt.x - a.x, hitPt.y - a.y);
      let t = ((hitPt.x - a.x) * ax + (hitPt.y - a.y) * ay) / L2;
      t = Math.max(0, Math.min(1, t));
      return Math.hypot(hitPt.x - (a.x + ax * t), hitPt.y - (a.y + ay * t));
    };
    for (let i = 0; i + 1 < cutter.pts.length; i++) {
      const d = distSeg(cutter.pts[i], cutter.pts[i + 1]);
      if (d < bestD) { bestD = d; bestIdx = i; }
    }
    if (cutter.closed && cutter.pts.length >= 2) {
      const i = cutter.pts.length - 1;
      const d = distSeg(cutter.pts[i], cutter.pts[0]);
      if (d < bestD) { bestD = d; bestIdx = i; }
    }
    return bestIdx >= 0 ? { kind: 'polySeg', index: bestIdx } : null;
  }
  return null;
}

/**
 * Build a parametric override for a cut end (trim / extend / extend-to) as a
 * `rayHit` PointRef: ray from the kept end at the current cut-direction angle,
 * hitting the cutter feature's edge.
 *
 * Why not `intersection(selfFid, cutterFid)`? Because the timeline evaluator
 * populates `ctx` in order: `buildEntity(f, ctx)` runs BEFORE `ctx.set(f.id,
 * e)`, so a self-reference resolves to undefined → NaN, and the line vanishes
 * on the next re-evaluation. `rayHit` sidesteps this: its `from` is an
 * independent PointRef (the kept end) and its `target` is the *cutter*, never
 * self. The only context lookup is the cutter, which was already evaluated
 * upstream.
 *
 * Returns `null` when the cutter isn't rayHit-resolvable (circle/arc) or when
 * cut/kept coincide — caller should fall back to an abs PointRef.
 */
function buildRayHitCutOverride(
  keptRef: PointRef,
  keptPt: Pt,
  cutPt: Pt,
  cutter: Entity,
  cutterFeatureId: string,
): PointRef | null {
  const dx = cutPt.x - keptPt.x;
  const dy = cutPt.y - keptPt.y;
  if (dx * dx + dy * dy < 1e-18) return null;
  const edge = featureEdgeForCutter(cutter, cutPt);
  if (!edge) return null;
  const angleDeg = Math.atan2(dy, dx) * 180 / Math.PI;
  return {
    kind: 'rayHit',
    from: keptRef,
    angle: numE(angleDeg),
    target: cutterFeatureId,
    edge,
  };
}

export type ToolDef = {
  id: ToolId | 'delete';
  label: string;
  key: string;
  group: 'pointer' | 'guide' | 'construct' | 'modify' | 'annot';
  icon: string;
  action?: 'delete';
};

export const TOOLS: ToolDef[] = [
  // ── Pointer ──
  { id: 'select', label: 'Auswahl', key: 'Esc', group: 'pointer',
    icon: '<path d="M4 2 L4 16 L7.5 12.5 L10 18.5 L12 17.5 L9.5 11.5 L14 11.5 Z" fill="currentColor" stroke="none"/>' },
  // Was on 'Q' but that clashed with Strecken ('stretch') — Strecken is a
  // primary modify action that deserves a letter, Ähnliche-auswählen is a
  // selection helper and moves to a free digit.
  { id: 'select_similar', label: 'Ähnliche auswählen', key: '3', group: 'pointer',
    icon: '<path d="M3 2 L3 14 L6 11.5 L8 16 L9.5 15.3 L7.6 11 L11 11 Z" fill="currentColor" stroke="none"/><path d="M12 9 L12 19 L14.5 17 L16 20 L17 19.5 L15.6 17 L18.5 17 Z" fill="currentColor" stroke="none" opacity="0.45"/>' },
  { id: 'pan',    label: 'Canvas verschieben', key: 'Z', group: 'pointer',
    icon: '<path d="M9 11 L9 4.5 Q9 3.3 10 3.3 Q11 3.3 11 4.5 L11 10 M11 10 L11 3.5 Q11 2.3 12 2.3 Q13 2.3 13 3.5 L13 10 M13 10 L13 4 Q13 2.8 14 2.8 Q15 2.8 15 4 L15 11 M15 11 L15 6 Q15 5 16 5 Q17 5 17 6 L17 13 Q17 18 13 19.5 L10 19.5 Q7 18.5 6.5 16 L4.5 13 Q4 11.5 5 11 Q6 10.5 7 12 L9 14 Z"/>' },

  // ── Hilfen ──
  { id: 'xline',      label: 'Hilfslinie',    key: 'H', group: 'guide',
    icon: '<line x1="1" y1="19" x2="21" y2="3" stroke-dasharray="3.5 2.5" stroke-linecap="round"/>' },
  { id: 'dim',        label: 'Bemaßung',      key: 'D', group: 'guide',
    icon: '<path d="M4 5 L4 11 M18 5 L18 11"/><path d="M4 8 L18 8"/><path d="M6 6 L4 8 L6 10 M16 6 L18 8 L16 10" fill="currentColor" stroke="none"/><path d="M4 15 L18 15" stroke-dasharray="2.5 2"/>' },
  { id: 'ref_circle', label: 'Hilfskreis',    key: 'K', group: 'guide',
    icon: '<circle cx="11" cy="11" r="7" stroke-dasharray="3 2"/><path d="M11 4.5 L11 17.5 M4.5 11 L17.5 11" stroke-width="0.8" opacity="0.45" stroke-dasharray="1 1.5"/><circle cx="11" cy="11" r="1" fill="currentColor" stroke="none"/>' },
  { id: 'angle',      label: 'Winkel bemaßen', key: 'W', group: 'guide',
    icon: '<path d="M4 18 L4 4 M4 18 L18 18"/><path d="M4 12 A 6 6 0 0 1 10 18" stroke-dasharray="2 1.8"/><circle cx="4" cy="18" r="1.2" fill="currentColor" stroke="none"/>' },
  // Was on 'U' but that clashed with Versatz ('offset') — Versatz is used
  // far more often in normal workflow, so the dim variant yields the letter
  // and moves to a free digit (alongside the other dim shortcuts W/D).
  { id: 'radius',     label: 'Radius/Ø',       key: '4', group: 'guide',
    icon: '<circle cx="11" cy="11" r="7"/><path d="M11 11 L18 6"/><path d="M16 4 L18 6 L16 8" fill="none"/><circle cx="11" cy="11" r="0.9" fill="currentColor" stroke="none"/>' },

  // ── Zeichnen ──
  { id: 'line',     label: 'Linie',     key: 'L', group: 'construct',
    icon: '<line x1="4" y1="18" x2="18" y2="4"/><circle cx="4" cy="18" r="1.4" fill="currentColor"/><circle cx="18" cy="4" r="1.4" fill="currentColor"/>' },
  // Moved Y → P: P is the natural mnemonic for Polylinie, and leaving Y
  // free lets Bis-Linie (extend-to) keep Y without conflict. Knock-on
  // change: Symmetrie (cross_mirror) loses P and moves to a digit.
  { id: 'polyline', label: 'Polylinie', key: 'P', group: 'construct',
    icon: '<polyline points="3,17 7,9 12,13 16,5 19,9"/><circle cx="3" cy="17" r="1.2" fill="currentColor"/><circle cx="19" cy="9" r="1.2" fill="currentColor"/>' },
  { id: 'rect',     label: 'Rechteck',  key: 'R', group: 'construct',
    icon: '<rect x="4" y="6" width="14" height="10"/>' },
  { id: 'circle',   label: 'Kreis',     key: 'C', group: 'construct',
    icon: '<circle cx="11" cy="11" r="7"/><circle cx="11" cy="11" r="0.9" fill="currentColor" stroke="none"/>' },
  { id: 'arc3',     label: 'Bogen',     key: 'A', group: 'construct',
    icon: '<path d="M3 16 A 9 9 0 0 1 19 16"/><circle cx="3" cy="16" r="1.3" fill="currentColor" stroke="none"/><circle cx="19" cy="16" r="1.3" fill="currentColor" stroke="none"/><circle cx="11" cy="7" r="1.1" fill="currentColor" stroke="none"/>' },
  { id: 'ellipse',  label: 'Ellipse',   key: 'E', group: 'construct',
    icon: '<ellipse cx="11" cy="11" rx="8" ry="5"/><path d="M3 11 L19 11" stroke-dasharray="1.5 1.5" opacity="0.5"/><circle cx="11" cy="11" r="0.9" fill="currentColor" stroke="none"/>' },
  { id: 'spline',   label: 'Spline',    key: 'N', group: 'construct',
    icon: '<path d="M3 14 C 6 6, 10 18, 13 10 S 18 6, 19 8"/>' },

  // ── Beschriftung ──
  // Text, Schraffur, Füllung: Werkzeuge, die auf bestehende Flächen aufsetzen
  // oder Zusatzinformation in die Zeichnung eintragen. Eigene Toolgruppe, weil
  // sie weder „Zeichnen" (Primitive) noch „Ändern" (Transformationen) sind.
  { id: 'text',     label: 'Text',          key: 'T', group: 'annot',
    icon: '<path d="M3 5 L19 5 M3 5 L3 8 M19 5 L19 8 M11 5 L11 17 M8 17 L14 17"/>' },
  { id: 'hatch',    label: 'Schraffieren',  key: '7', group: 'annot',
    icon: '<rect x="3.5" y="3.5" width="15" height="15"/><line x1="6.5" y1="18.5" x2="18.5" y2="6.5" stroke-width="1"/><line x1="3.5" y1="15.5" x2="15.5" y2="3.5" stroke-width="1"/><line x1="9.5" y1="18.5" x2="18.5" y2="9.5" stroke-width="1"/><line x1="3.5" y1="12.5" x2="12.5" y2="3.5" stroke-width="1"/>' },
  { id: 'fill',     label: 'Füllen',        key: '8', group: 'annot',
    icon: '<rect x="3.5" y="3.5" width="15" height="15" fill="currentColor"/>' },

  // ── Ändern ──
  { id: 'move',   label: 'Verschieben', key: 'V', group: 'modify',
    icon: '<path d="M11 2.5 L11 19.5 M2.5 11 L19.5 11"/><path d="M11 2.5 L8.5 5 M11 2.5 L13.5 5 M11 19.5 L8.5 17 M11 19.5 L13.5 17 M2.5 11 L5 8.5 M2.5 11 L5 13.5 M19.5 11 L17 8.5 M19.5 11 L17 13.5" stroke-linecap="round" stroke-linejoin="round"/>' },
  { id: 'copy',   label: 'Kopieren',    key: 'J', group: 'modify',
    icon: '<rect x="3.5" y="7" width="10" height="11" rx="1"/><rect x="8" y="3.5" width="10.5" height="11" rx="1" opacity="0.55"/>' },
  { id: 'rotate', label: 'Drehen',      key: 'O', group: 'modify',
    icon: '<path d="M18 11 A 7 7 0 1 1 11 4" stroke-linecap="round" fill="none"/><path d="M8.5 2.5 L11 4 L9.5 6.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/><circle cx="11" cy="11" r="1.2" fill="currentColor" stroke="none"/>' },
  { id: 'scale',  label: 'Skalieren',   key: 'S', group: 'modify',
    icon: '<rect x="4" y="4" width="6" height="6"/><rect x="4" y="4" width="14" height="14" stroke-dasharray="2.2 1.8" opacity="0.55"/><path d="M10 10 L17 17" stroke-linecap="round"/><path d="M14.5 17 L17 17 L17 14.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>' },
  { id: 'mirror', label: 'Spiegeln',    key: 'M', group: 'modify',
    icon: '<line x1="11" y1="2.5" x2="11" y2="19.5" stroke-dasharray="2 1.8"/><path d="M3 17 L9 5 L9 17 Z"/><path d="M19 17 L13 5 L13 17 Z" opacity="0.35"/>' },
  // Symmetrie lost P to Polylinie (P is the natural mnemonic there). Moved
  // to '2' — cross-mirror is a niche symmetry helper, not a primary
  // modify, so a digit is acceptable for the default. Users who prefer a
  // letter can remap via Einstellungen → Tastenkürzel.
  { id: 'cross_mirror', label: 'Symmetrie', key: '2', group: 'modify',
    icon: '<line x1="2.5" y1="11" x2="19.5" y2="11" stroke-dasharray="2 1.8"/><line x1="11" y1="2.5" x2="11" y2="19.5" stroke-dasharray="2 1.8"/><path d="M3 9 L9 3 L9 9 Z"/><path d="M19 9 L13 3 L13 9 Z" opacity="0.5"/><path d="M3 13 L9 19 L9 13 Z" opacity="0.5"/><path d="M19 13 L13 19 L13 13 Z" opacity="0.35"/><circle cx="11" cy="11" r="1.1" fill="currentColor" stroke="none"/>' },
  { id: 'trim',   label: 'Stutzen',     key: 'B', group: 'modify',
    icon: '<path d="M3 11 L8 11 M14 11 L19 11"/><path d="M11 3 L11 19" stroke-dasharray="2 1.8" opacity="0.6"/><path d="M8 8 L14 14 M14 8 L8 14"/>' },
  { id: 'extend', label: 'Verlängern',  key: 'X', group: 'modify',
    icon: '<path d="M3 11 L12 11"/><path d="M10 8 L13 11 L10 14" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M16 3 L16 19" stroke-dasharray="2 1.8" opacity="0.6"/>' },
  { id: 'extend_to', label: 'Bis Linie',  key: 'Y', group: 'modify',
    icon: '<path d="M3 14 L12 14"/><path d="M10 11 L13 14 L10 17" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 6 L17 6" opacity="0.75"/><path d="M17 2.5 L17 17" stroke-dasharray="2 1.8" opacity="0.55"/>' },
  { id: 'fillet', label: 'Abrunden',    key: 'G', group: 'modify',
    icon: '<path d="M4 11 L4 18 L11 18" stroke-dasharray="2 1.8" opacity="0.35"/><path d="M4 4 L4 11 A 7 7 0 0 0 11 18 L18 18" stroke-linecap="round" fill="none"/>' },
  { id: 'chamfer', label: 'Fase',       key: 'F', group: 'modify',
    icon: '<path d="M4 4 L4 18 L18 18" stroke-dasharray="2 2" opacity="0.35"/><path d="M4 4 L4 10 L12 18 L18 18"/>' },
  { id: 'offset', label: 'Versatz',     key: 'U', group: 'modify',
    icon: '<rect x="2.5" y="2.5" width="15" height="15"/><rect x="6.5" y="6.5" width="7" height="7"/>' },
  { id: 'line_offset', label: 'Linie versetzen', key: 'I', group: 'modify',
    icon: '<line x1="3" y1="17" x2="17" y2="3" stroke-linecap="round"/><line x1="6" y1="20" x2="20" y2="6" opacity="0.55" stroke-linecap="round"/><line x1="3" y1="17" x2="6" y2="20" stroke-dasharray="1.5 1.3" opacity="0.4"/><line x1="17" y1="3" x2="20" y2="6" stroke-dasharray="1.5 1.3" opacity="0.4"/>' },
  { id: 'stretch', label: 'Strecken', key: 'Q', group: 'modify',
    icon: '<rect x="3.5" y="6" width="10" height="10" stroke-dasharray="2 1.8" opacity="0.45"/><rect x="7.5" y="6" width="10" height="10"/><path d="M2.5 11 L8 11 M14 11 L19.5 11" stroke-linecap="round"/><path d="M4.5 9 L2.5 11 L4.5 13 M17.5 9 L19.5 11 L17.5 13" fill="none" stroke-linecap="round" stroke-linejoin="round"/>' },
  { id: 'divide_xline', label: 'Linie teilen', key: '9', group: 'guide',
    icon: '<line x1="2" y1="11" x2="20" y2="11"/><line x1="5.6" y1="4" x2="5.6" y2="18" stroke-dasharray="2 1.8" opacity="0.7"/><line x1="9.2" y1="4" x2="9.2" y2="18" stroke-dasharray="2 1.8" opacity="0.7"/><line x1="12.8" y1="4" x2="12.8" y2="18" stroke-dasharray="2 1.8" opacity="0.7"/><line x1="16.4" y1="4" x2="16.4" y2="18" stroke-dasharray="2 1.8" opacity="0.7"/>' },
  { id: 'delete', label: 'Löschen',     key: 'Del', group: 'modify', action: 'delete',
    icon: '<path d="M3 6 L19 6 M8 6 L8 4 L14 4 L14 6 M5.5 6 L7 18 L15 18 L16.5 6 M9 9 L9.5 16 M11 9 L11 16 M13 9 L12.5 16"/>' },
];

/**
 * Tools that operate on existing geometry — they need at least one selected
 * entity before they're useful. The rail renders them greyed-out until the
 * user selects something, and clicking them without a selection surfaces a
 * short toast instead of activating the tool. Fillet/chamfer/trim/extend are
 * NOT in this set: they pick their targets via direct clicks (no preselect),
 * and their workflow would get worse if we forced a selection step first.
 */
const TOOLS_REQUIRING_SELECTION: ReadonlySet<string> = new Set([
  'move', 'copy', 'rotate', 'mirror', 'cross_mirror', 'scale', 'offset', 'delete',
]);

export function toolRequiresSelection(id: string): boolean {
  return TOOLS_REQUIRING_SELECTION.has(id);
}

/**
 * Toggle the `.disabled` class on every rail button whose tool needs a
 * selection. Called from `renderToolsPanel` (initial render) and from
 * `updateSelStatus` (selection changed), so the rail stays in sync without
 * explicit wiring at every selection mutation site.
 */
export function syncToolAvailability(): void {
  const hasSel = state.selection.size > 0;
  document.querySelectorAll<HTMLElement>('.tool-btn').forEach(b => {
    const id = b.dataset.tool;
    if (!id) return;
    const gated = TOOLS_REQUIRING_SELECTION.has(id);
    b.classList.toggle('disabled', gated && !hasSel);
  });
}

// ---------------- Tool-rail: dockable + free-floating palettes ----------------
//
// Each "palette" (a named group of tool buttons) is either **docked** into the
// narrow left-edge column (`#tools`) or **floating** over the canvas inside
// the `#tool-palettes` overlay. The user switches between the two by dragging
// the palette's header: dragging *out* of the dock undocks; dropping *into*
// the dock zone on mouseup redocks. Multiple docked palettes stack
// vertically; you can reorder them by dragging the header and dropping
// between siblings.
//
// Administration is entirely right-click-driven. Right-clicking any palette
// (or the empty dock background) opens a compact context menu with:
//   • a colour row (8 presets) — changes the palette's accent
//   • Ausrichtung: vertikal / horizontal
//   • Palette löschen
//   • Neue Palette
//   • Werkzeugleiste zurücksetzen
//
// There is no global lock and no +add button in the UI — those legacy
// affordances have been removed in favour of the context menu and direct
// drag-to-dock behaviour.
//
// Palette z-order (for floating palettes) is managed in-memory: clicking any
// palette promotes it to the top.
//
// Persistence: `hekticad.toolOrder.v5` stores `{ panels: [...] }` where each
// panel has a `docked: boolean` field. Migrations from v4 (locked + x/y),
// v3 (rows × columns), v2 (fixed 3 columns + order), and v1 (just column
// memberships) all converge to v5 — users never lose their personalization
// across upgrades.

type ColumnAccent = 'accent' | 'guides' | 'draw' | 'modify' | 'purple' | 'pink' | 'green' | 'neutral';
type PanelOrientation = 'vertical' | 'horizontal';

/** Order in which accents appear in the colour picker. The four "semantic"
 *  colours come first so existing users see the colours they know from v3. */
const ACCENT_ORDER: ColumnAccent[] = ['accent', 'guides', 'draw', 'modify', 'purple', 'pink', 'green', 'neutral'];
/** CSS colour string for the colour-picker option swatches (the palette
 *  itself uses the CSS class to drive --col-accent; this is just for the
 *  preview dots in the popover). */
const ACCENT_CSS: Record<ColumnAccent, string> = {
  accent:  'var(--accent)',
  guides:  'var(--guides)',
  draw:    'var(--draw)',
  modify:  'var(--modify)',
  purple:  '#a78bfa',
  pink:    '#ec4899',
  green:   '#22c55e',
  neutral: 'var(--fg-dim)',
};

type Panel = {
  id: string;
  label: string;
  /** Preset accent name. Always present as a fallback. When `customColor` is
   *  also set, the custom hex wins visually — but we keep the preset so a
   *  broken/legacy deserialization still has a sensible base colour. */
  accent: ColumnAccent;
  /** Optional user-picked hex colour (e.g. `#ff6633`). When set, renders as an
   *  inline `--col-accent` override on the palette element, taking precedence
   *  over the `.tool-col--…` class defined by `accent`. Picking a preset from
   *  the swatch row clears this field. */
  customColor?: string;
  orientation: PanelOrientation;
  tools: string[];
  /** Docked into the left-edge #tools column? When true, `x`/`y` are ignored;
   *  position is determined by `dockColumn` and array order within that column. */
  docked: boolean;
  /** Which dock column the palette sits in (only meaningful when `docked`).
   *  Palettes with the same dockColumn stack vertically. The dock itself
   *  renders columns left-to-right sorted by this integer — so a user can
   *  place palettes side-by-side to make more tools visible at once.
   *  Fractional values are temporarily valid (e.g. dropping "between"
   *  columns uses an in-between number); `normalizeLayoutV5` compacts them
   *  back to 0..N-1 on every save. */
  dockColumn: number;
  /** Left offset in px, relative to #canvaswrap (only meaningful when !docked). */
  x: number;
  /** Top offset in px, relative to #canvaswrap (only meaningful when !docked). */
  y: number;
};

export type ToolLayout = {
  panels: Panel[];
};

const ORDER_STORAGE_KEY_V1 = 'hekticad.toolOrder.v1';
const ORDER_STORAGE_KEY_V2 = 'hekticad.toolOrder.v2';
const ORDER_STORAGE_KEY_V3 = 'hekticad.toolOrder.v3';
const ORDER_STORAGE_KEY_V4 = 'hekticad.toolOrder.v4';
const ORDER_STORAGE_KEY_V5 = 'hekticad.toolOrder.v5';

// ── Legacy helpers shared by migrations ──────────────────────────────────────
type LegacyColKey = 'guide' | 'construct' | 'annot' | 'modify';
const LEGACY_COLS: LegacyColKey[] = ['guide', 'construct', 'annot', 'modify'];
const LEGACY_META: Record<LegacyColKey, { label: string; accent: ColumnAccent }> = {
  guide:     { label: 'Hilfen',       accent: 'guides' },
  construct: { label: 'Zeichnen',     accent: 'draw' },
  annot:     { label: 'Beschriftung', accent: 'purple' },
  modify:    { label: 'Ändern',       accent: 'modify' },
};
function legacyColumnOf(t: ToolDef): LegacyColKey {
  return t.group === 'pointer' ? 'guide' : (t.group as LegacyColKey);
}
function defaultColumnMembership(col: LegacyColKey): string[] {
  const out: string[] = [];
  if (col === 'guide') {
    for (const t of TOOLS) if (t.group === 'pointer') out.push(String(t.id));
    for (const t of TOOLS) if (t.group === 'guide')   out.push(String(t.id));
  } else {
    for (const t of TOOLS) if (t.group === col) out.push(String(t.id));
  }
  return out;
}
function genId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-3)}`;
}

// ── Default + normalization ──────────────────────────────────────────────────

/** Approximate default stagger for placing palettes. Coordinates are inside
 *  #canvaswrap (which starts right after the control strip). The top-left
 *  corner is now free (snap toolbar moved to the right cluster), so default
 *  palettes dock to x=0 and start near the top. */
const INITIAL_PANEL_X = 0;
const INITIAL_PANEL_Y = 12;
const INITIAL_PANEL_STEP_X = 48;

/** First-run default: the three legacy categories as separate vertical
 *  palettes, each docked into its own column so every tool is visible on
 *  a typical viewport height without any palette overflowing vertically. */
function defaultLayout(): ToolLayout {
  const panels: Panel[] = LEGACY_COLS.map((k, i): Panel => ({
    id: k,
    label: LEGACY_META[k].label,
    accent: LEGACY_META[k].accent,
    orientation: 'vertical',
    tools: defaultColumnMembership(k),
    docked: true,
    dockColumn: i,
    x: INITIAL_PANEL_X,
    y: INITIAL_PANEL_Y,
  }));
  return { panels };
}

const VALID_ACCENTS: ReadonlySet<ColumnAccent> = new Set(ACCENT_ORDER);
const VALID_ORIENTATIONS: ReadonlySet<PanelOrientation> = new Set(['vertical', 'horizontal']);

type RawPanel = {
  id?: unknown;
  label?: unknown;
  accent?: unknown;
  customColor?: unknown;
  orientation?: unknown;
  tools?: unknown;
  docked?: unknown;
  dockColumn?: unknown;
  x?: unknown;
  y?: unknown;
};

/** Strict 6-digit hex (#rrggbb) with a leading `#`. We keep parsing tight so a
 *  corrupt/tampered localStorage value can't inject arbitrary CSS via the
 *  inline `--col-accent` variable. 3-digit shorthand and rgba() are not
 *  accepted — the colour picker always emits #rrggbb. */
const CUSTOM_COLOR_RE = /^#[0-9a-f]{6}$/i;
type RawLayoutV5 = { panels?: unknown };

/**
 * Normalize a raw layout from storage into a usable `ToolLayout`. Defensive:
 * drops unknown tool ids, dedupes (a tool appears in exactly one panel),
 * guarantees every tool is placed somewhere, guarantees at least one panel
 * exists. Never throws.
 */
function normalizeLayoutV5(raw: RawLayoutV5): ToolLayout {
  const validTools = new Set(TOOLS.map(t => String(t.id)));
  const seen = new Set<string>();
  const usedIds = new Set<string>();
  const panels: Panel[] = [];
  const rawPanels = Array.isArray(raw.panels) ? raw.panels : [];
  for (const rp of rawPanels as RawPanel[]) {
    let id = typeof rp.id === 'string' && rp.id.length > 0 ? rp.id : genId('pan');
    while (usedIds.has(id)) id = genId('pan');
    usedIds.add(id);
    const label = typeof rp.label === 'string' && rp.label.trim().length > 0
      ? rp.label.trim() : 'Werkzeuge';
    const accent: ColumnAccent = typeof rp.accent === 'string' && VALID_ACCENTS.has(rp.accent as ColumnAccent)
      ? rp.accent as ColumnAccent : 'accent';
    const customColor: string | undefined = typeof rp.customColor === 'string' && CUSTOM_COLOR_RE.test(rp.customColor)
      ? rp.customColor.toLowerCase() : undefined;
    const orientation: PanelOrientation = typeof rp.orientation === 'string' && VALID_ORIENTATIONS.has(rp.orientation as PanelOrientation)
      ? rp.orientation as PanelOrientation : 'vertical';
    const tools: string[] = [];
    const rawTools = Array.isArray(rp.tools) ? rp.tools : [];
    for (const t of rawTools) {
      if (typeof t !== 'string') continue;
      if (!validTools.has(t) || seen.has(t)) continue;
      tools.push(t); seen.add(t);
    }
    const docked = typeof rp.docked === 'boolean' ? rp.docked : true;
    const dockColumn = typeof rp.dockColumn === 'number' && isFinite(rp.dockColumn)
      ? rp.dockColumn : 0;
    const x = typeof rp.x === 'number' && isFinite(rp.x) ? rp.x : INITIAL_PANEL_X;
    const y = typeof rp.y === 'number' && isFinite(rp.y) ? rp.y : INITIAL_PANEL_Y;
    const panel: Panel = { id, label, accent, orientation, tools, docked, dockColumn, x, y };
    if (customColor) panel.customColor = customColor;
    panels.push(panel);
  }
  // Any tool not yet placed: append to a panel that matches its legacy group,
  // or create a new panel if none matches.
  if (panels.length === 0) {
    // Empty storage — start from defaults.
    return defaultLayout();
  }
  const placeIntoDefault = (toolId: string): void => {
    const def = TOOLS.find(t => String(t.id) === toolId);
    if (!def) return;
    const target: LegacyColKey = legacyColumnOf(def);
    const match = panels.find(p => p.id === target || (p.accent === LEGACY_META[target].accent && p.label === LEGACY_META[target].label));
    if (match) { match.tools.push(toolId); return; }
    // Fallback: append to the first panel.
    panels[0].tools.push(toolId);
  };
  for (const t of TOOLS) {
    const id = String(t.id);
    if (!seen.has(id)) { placeIntoDefault(id); seen.add(id); }
  }
  compactDockColumns(panels);
  return { panels };
}

/** Renumber every docked palette's dockColumn to 0..N-1 based on sorted
 *  unique values. Lets the rest of the code use fractional column numbers
 *  temporarily (e.g. "drop between columns 1 and 2" → col 1.5), which are
 *  then compacted back to clean integers on save/load. */
function compactDockColumns(panels: Panel[]): void {
  const docked = panels.filter(p => p.docked);
  if (docked.length === 0) return;
  const used = new Set<number>();
  for (const p of docked) used.add(p.dockColumn);
  const sorted = Array.from(used).sort((a, b) => a - b);
  const remap = new Map<number, number>();
  sorted.forEach((v, i) => remap.set(v, i));
  for (const p of docked) p.dockColumn = remap.get(p.dockColumn) ?? 0;
}

// ── Migrations ───────────────────────────────────────────────────────────────

type V3RawCol = { id?: unknown; label?: unknown; accent?: unknown; tools?: unknown };
type V3RawRow = { id?: unknown; columns?: unknown };
type V3RawLayout = { locked?: unknown; rows?: unknown };
type V4RawLayout = { locked?: unknown; panels?: unknown };

/** v4 → v5. Drop the global `locked` flag (removed from UI) and decide
 *  docked/floating based on the saved x: panels that were snapped along
 *  the left edge become docked with their x translated into a dockColumn
 *  index. Palettes elsewhere stay floating in place. Users who had a
 *  cascaded sidebar layout get automatic side-by-side docked columns. */
function migrateV4(raw: V4RawLayout): ToolLayout {
  const rawPanels = Array.isArray(raw.panels) ? raw.panels : [];
  const panels: RawPanel[] = (rawPanels as RawPanel[]).map((rp) => {
    const x = typeof rp.x === 'number' ? rp.x : 0;
    // v4 stored panels along the left in a 48px cascade — convert to an
    // integer dockColumn. Anything further right stays floating.
    const docked = x <= 200;
    const dockColumn = docked ? Math.max(0, Math.round(x / INITIAL_PANEL_STEP_X)) : 0;
    return {
      id: rp.id, label: rp.label, accent: rp.accent,
      orientation: rp.orientation, tools: rp.tools,
      docked, dockColumn, x: rp.x, y: rp.y,
    };
  });
  return normalizeLayoutV5({ panels });
}

/** v3 → v5 via v4. Each v3 (row, column) pair becomes a vertical palette;
 *  column-0 panels in row 0 become docked. */
function migrateV3(raw: V3RawLayout): ToolLayout {
  const rows = Array.isArray(raw.rows) ? raw.rows : [];
  const panels: RawPanel[] = [];
  rows.forEach((rr, ri) => {
    const cols = Array.isArray((rr as V3RawRow).columns) ? (rr as V3RawRow).columns as V3RawCol[] : [];
    cols.forEach((cc, ci) => {
      const x = INITIAL_PANEL_X + ci * INITIAL_PANEL_STEP_X;
      const y = INITIAL_PANEL_Y + ri * 220;
      // Row 0 → dock columns (so users who arranged rows along the top get
      // nice side-by-side docked palettes); other rows stay floating.
      panels.push({
        id: typeof cc.id === 'string' ? cc.id : undefined,
        label: cc.label,
        accent: cc.accent,
        orientation: 'vertical',
        tools: cc.tools,
        docked: ri === 0,
        dockColumn: ci,
        x, y,
      });
    });
  });
  return normalizeLayoutV5({ panels });
}

/** v2 → v5. All three legacy columns become docked vertical palettes. */
function migrateV2(raw: { locked?: unknown; columnOrder?: unknown; columns?: Partial<Record<LegacyColKey, string[]>> }): ToolLayout {
  const order: LegacyColKey[] = Array.isArray(raw.columnOrder)
    ? (raw.columnOrder.filter((k): k is LegacyColKey => LEGACY_COLS.includes(k as LegacyColKey)))
    : LEGACY_COLS.slice();
  for (const k of LEGACY_COLS) if (!order.includes(k)) order.push(k);
  const panels: RawPanel[] = order.map((k, i) => ({
    id: k,
    label: LEGACY_META[k].label,
    accent: LEGACY_META[k].accent,
    orientation: 'vertical' as PanelOrientation,
    tools: raw.columns?.[k] ?? [],
    docked: true,
    dockColumn: i,
    x: INITIAL_PANEL_X,
    y: INITIAL_PANEL_Y,
  }));
  return normalizeLayoutV5({ panels });
}

/** v1 → v5 via v2. */
function migrateV1(raw: Partial<Record<LegacyColKey, string[]>>): ToolLayout {
  return migrateV2({ locked: false, columnOrder: LEGACY_COLS.slice(), columns: raw });
}

function loadLayout(): ToolLayout {
  try {
    const v5 = localStorage.getItem(ORDER_STORAGE_KEY_V5);
    if (v5) return normalizeLayoutV5(JSON.parse(v5) as RawLayoutV5);
    const v4 = localStorage.getItem(ORDER_STORAGE_KEY_V4);
    if (v4) { const m = migrateV4(JSON.parse(v4) as V4RawLayout); saveLayout(m); return m; }
    const v3 = localStorage.getItem(ORDER_STORAGE_KEY_V3);
    if (v3) { const m = migrateV3(JSON.parse(v3) as V3RawLayout); saveLayout(m); return m; }
    const v2 = localStorage.getItem(ORDER_STORAGE_KEY_V2);
    if (v2) { const m = migrateV2(JSON.parse(v2)); saveLayout(m); return m; }
    const v1 = localStorage.getItem(ORDER_STORAGE_KEY_V1);
    if (v1) { const m = migrateV1(JSON.parse(v1) as Partial<Record<LegacyColKey, string[]>>); saveLayout(m); return m; }
  } catch { /* corrupt storage — fall through */ }
  return defaultLayout();
}
function saveLayout(layout: ToolLayout): void {
  try { localStorage.setItem(ORDER_STORAGE_KEY_V5, JSON.stringify(layout)); }
  catch { /* quota or disabled — ignore */ }
}

/** In-memory cache to avoid re-parsing localStorage on every drop-handler tick. */
let layoutCache: ToolLayout | null = null;
function currentLayout(): ToolLayout {
  if (!layoutCache) layoutCache = loadLayout();
  return layoutCache;
}

/**
 * Expose the current in-memory layout to the user-defaults snapshot system.
 * Returned reference is deep-clone-safe via JSON (Panels are plain data).
 */
export function snapshotLayout(): ToolLayout {
  return JSON.parse(JSON.stringify(currentLayout())) as ToolLayout;
}

/**
 * Overwrite the layout (used by the user-defaults restore path at startup).
 * Persists to the v5 key so subsequent reloads see the same state, and
 * invalidates the in-memory cache so the next `currentLayout()` call rereads.
 */
export function applyLayoutSnapshot(layout: ToolLayout): void {
  const normalized = normalizeLayoutV5({ panels: layout.panels as unknown[] });
  saveLayout(normalized);
  layoutCache = normalized;
}
function mutateLayout(fn: (l: ToolLayout) => void): void {
  const l = currentLayout();
  fn(l);
  // Empty panels are allowed (the user might want a bare container waiting to
  // receive tools). Only guarantee that at least one panel exists so the rail
  // isn't completely unreachable.
  if (l.panels.length === 0) {
    l.panels.push({
      id: genId('pan'), label: 'Werkzeuge', accent: 'accent',
      orientation: 'vertical', tools: [], docked: true, dockColumn: 0,
      x: INITIAL_PANEL_X, y: INITIAL_PANEL_Y,
    });
  }
  // Compact fractional dockColumn values back to clean integers. Drop logic
  // uses fractions ("drop between columns 1 and 2" → 1.5) to express insert
  // positions without renumbering; compacting here makes the persisted state
  // always have consecutive 0..N-1 column indices.
  compactDockColumns(l.panels);
  layoutCache = l;
  saveLayout(l);
}

function findPanel(l: ToolLayout, id: string): { panel: Panel; index: number } | null {
  for (let i = 0; i < l.panels.length; i++) {
    if (l.panels[i].id === id) return { panel: l.panels[i], index: i };
  }
  return null;
}

// ── Rendering ────────────────────────────────────────────────────────────────

const PALETTES_OVERLAY_ID = 'tool-palettes';

/** Ensure the `#tool-palettes` overlay exists inside `#canvaswrap`. Created
 *  lazily on first render so the HTML template doesn't need to mention it. */
function ensurePalettesOverlay(): HTMLElement {
  const existing = document.getElementById(PALETTES_OVERLAY_ID);
  if (existing) return existing;
  const wrap = document.getElementById('canvaswrap');
  const overlay = document.createElement('div');
  overlay.id = PALETTES_OVERLAY_ID;
  (wrap ?? document.body).appendChild(overlay);
  return overlay;
}

/** Z-index counter — every click on a palette promotes it to `++zTop`. Not
 *  persisted; after reload the DOM order is authoritative. */
let zTop = 100;
const zMap = new Map<string, number>();
function bringPanelToFront(el: HTMLElement, id: string): void {
  zTop += 1;
  zMap.set(id, zTop);
  el.style.zIndex = String(zTop);
}

export function renderToolsPanel(): void {
  const layout = currentLayout();
  renderDockZone(layout);
  renderFloatingPalettes(layout);
  syncToolAvailability();
}

/** Render all docked palettes as explicit columns inside #tools. Each
 *  column is a flex-direction:column div; columns themselves are laid out
 *  left-to-right in #tools (flex-direction:row). This lets the user park
 *  palettes side-by-side so every tool is visible, instead of relying on
 *  auto-wrap (which cuts off tall palettes). */
function renderDockZone(layout: ToolLayout): void {
  const panel = dom.toolsPanel;
  panel.innerHTML = '';
  panel.classList.add('tools-strip');

  // Right-click on the dock (bubbles up when no palette catches it) opens
  // the global context menu (no panel-specific actions).
  panel.oncontextmenu = (ev) => {
    if ((ev.target as HTMLElement | null)?.closest('.tool-palette')) return;
    ev.preventDefault();
    showPaletteContextMenu(null, ev.clientX, ev.clientY);
  };

  // Group docked panels by dockColumn (already compacted to 0..N-1).
  const docked = layout.panels.filter(p => p.docked);
  if (docked.length === 0) return;
  const byCol = new Map<number, Panel[]>();
  for (const p of docked) {
    const list = byCol.get(p.dockColumn);
    if (list) list.push(p);
    else byCol.set(p.dockColumn, [p]);
  }
  const sortedCols = Array.from(byCol.keys()).sort((a, b) => a - b);
  for (const col of sortedCols) {
    const colEl = document.createElement('div');
    colEl.className = 'tool-dock-column';
    colEl.dataset.dockColumn = String(col);
    for (const p of byCol.get(col)!) {
      colEl.appendChild(renderPalette(p, /*docked*/true));
    }
    panel.appendChild(colEl);
  }
}

function renderFloatingPalettes(layout: ToolLayout): void {
  const overlay = ensurePalettesOverlay();
  overlay.innerHTML = '';
  for (const p of layout.panels) {
    if (p.docked) continue;
    overlay.appendChild(renderPalette(p, /*docked*/false));
  }
  // Clamp floating palettes to the viewport one frame later.
  requestAnimationFrame(() => clampAllPalettes());
}

function renderPalette(p: Panel, docked: boolean): HTMLElement {
  const el = document.createElement('div');
  el.className = `tool-palette tool-col--${p.accent}` + (docked ? ' docked' : '');
  // Custom colour wins over the preset class by setting --col-accent inline —
  // all downstream styles (button icon colour, active marker, hover tint) read
  // from this variable, so a single assignment re-tints the whole palette.
  if (p.customColor) el.style.setProperty('--col-accent', p.customColor);
  el.dataset.panelId = p.id;
  el.dataset.orient = p.orientation;
  if (!docked) {
    el.style.left = `${Math.round(p.x)}px`;
    el.style.top = `${Math.round(p.y)}px`;
    // A floating palette flush against x=0 gets the "snapped-left" look so it
    // reads as part of the sidebar without actually being docked.
    if (p.x === 0) el.classList.add('snapped-left');
    const z = zMap.get(p.id) ?? ++zTop;
    zMap.set(p.id, z);
    el.style.zIndex = String(z);
  }

  if (!docked) {
    el.addEventListener('mousedown', () => bringPanelToFront(el, p.id), { capture: true });
  }

  // Right-click anywhere on the palette (body or header) opens the context
  // menu with panel-specific items (colour, orientation, delete) + global
  // items (new panel, reset).
  el.addEventListener('contextmenu', (ev) => {
    // Don't interfere with native controls inside tool buttons.
    ev.preventDefault();
    ev.stopPropagation();
    showPaletteContextMenu(p.id, ev.clientX, ev.clientY);
  });

  // ── Header — pure drag handle, tinted with the accent colour. No text,
  //    no buttons; everything lives in the right-click context menu. ──
  const hdr = document.createElement('div');
  hdr.className = 'tool-palette-hdr';
  hdr.dataset.panelId = p.id;
  hdr.title = runtime.panelsLocked
    ? 'Toolgruppen gesperrt (Einstellungen → Toolgruppen sperren)'
    : 'Ziehen zum Verschieben · Rechtsklick für Menü';
  el.appendChild(hdr);

  // ── Body ──
  const body = document.createElement('div');
  body.className = 'tool-palette-body';
  const byId = new Map<string, ToolDef>(TOOLS.map(t => [String(t.id), t]));
  for (const tid of p.tools) {
    const def = byId.get(tid);
    if (def) body.appendChild(mkToolBtn(def));
  }
  el.appendChild(body);

  wirePaletteDrag(el, hdr, p.id);
  wirePaletteToolDrop(el, body);
  return el;
}

function mkToolBtn(t: ToolDef): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'tool-btn';
  b.dataset.tool = String(t.id);
  b.dataset.label = t.label;
  // Display the effective shortcut (override or default) so a user who
  // remapped in Einstellungen → Tastenkürzel sees their custom key in the
  // tooltip, not the stale built-in.
  const effectiveKey = getShortcutKey(String(t.id), t.key);
  b.dataset.key = effectiveKey;
  if (t.action) b.dataset.action = t.action;
  b.title = `${t.label}  [${effectiveKey}]  — ziehen zum Umsortieren`;
  b.innerHTML = `<svg viewBox="0 0 22 22">${t.icon}</svg>`;
  // `draggable` is toggled in `renderToolsPanel` based on `runtime.panelsLocked`
  // — set the initial value to the opposite of the lock so locked layouts
  // render with drag disabled from the first frame.
  b.draggable = !runtime.panelsLocked;
  b.onclick = () => {
    if (TOOLS_REQUIRING_SELECTION.has(String(t.id)) && state.selection.size === 0) {
      toast('Erst Objekte wählen');
      return;
    }
    if (t.action === 'delete') { deleteSelection(); return; }
    setTool(t.id as ToolId);
  };
  b.addEventListener('dragstart', (ev) => {
    if (!ev.dataTransfer) return;
    ev.dataTransfer.effectAllowed = 'move';
    ev.dataTransfer.setData('text/x-hekticad-tool', String(t.id));
    b.classList.add('dragging');
  });
  b.addEventListener('dragend', () => {
    b.classList.remove('dragging');
    clearDropHints();
  });
  return b;
}

function clearDropHints(): void {
  document.querySelectorAll<HTMLElement>(
    '.tool-btn.drop-before, .tool-btn.drop-after, .tool-palette-body.drop-target'
  ).forEach(el => el.classList.remove('drop-before', 'drop-after', 'drop-target'));
}

// ── Palette drag (custom pointer-drag, NOT HTML5 DnD) ────────────────────────

/** Threshold (px) below which a drag is treated as a no-op click. Prevents
 *  a sloppy mousedown from accidentally undocking a palette. */
const DRAG_DEADZONE = 4;

/** Snap distance (px) for floating-palette magnetic alignment. */
const SNAP_PX = 10;

/**
 * Wire the palette's header so mousedown + drag repositions or dock-toggles
 * the whole element. Handles three modes:
 *
 *   1. Docked → Docked (reorder inside #tools). If the cursor stays inside
 *      the sidebar, we just move the palette element between siblings and
 *      update the panels array order.
 *   2. Docked → Floating (undock). Cursor leaves the sidebar: detach from
 *      #tools, reparent into the overlay, and start live-positioning with
 *      absolute coords (in #canvaswrap space).
 *   3. Floating → Floating / Floating → Docked. Free positioning with
 *      magnetic snap; mouseup inside the sidebar redocks.
 *
 * Raw pointer events (not HTML5 drag) — HTML5 DnD doesn't give live cursor
 * position and renders a ghost, neither of which fits "pick up and move".
 */
function wirePaletteDrag(panel: HTMLElement, hdr: HTMLElement, panelId: string): void {
  hdr.addEventListener('mousedown', (ev) => {
    // Allow regular pointer events (e.g. right-click) to pass through.
    if (ev.button !== 0) return;
    // Ignore mousedowns that originated in a button inside the header.
    if ((ev.target as HTMLElement).closest('button')) return;
    // Tool palettes can be locked from Einstellungen → Werkzeugpaletten sperren.
    // When locked, dragging is suppressed entirely; the click still bubbles
    // up so right-click menus (colour/orientation) remain usable.
    if (runtime.panelsLocked) return;
    ev.preventDefault();

    const wrap = document.getElementById('canvaswrap') ?? document.body;
    const dock = document.getElementById('tools') ?? document.body;
    const overlay = ensurePalettesOverlay();
    const wrapRect = wrap.getBoundingClientRect();
    const panelRectAtStart = panel.getBoundingClientRect();

    // Cursor offset inside the panel (preserved across undock so the panel
    // doesn't "jump" under the cursor).
    const offsetX = ev.clientX - panelRectAtStart.left;
    const offsetY = ev.clientY - panelRectAtStart.top;
    const startClientX = ev.clientX;
    const startClientY = ev.clientY;

    let wasDocked = panel.classList.contains('docked');
    let isFloating = !wasDocked;
    let lastX = panel.offsetLeft;
    let lastY = panel.offsetTop;
    let moved = false;

    if (!wasDocked) bringPanelToFront(panel, panelId);
    document.body.classList.add('palette-dragging');

    // Snapshot every OTHER palette's geometry at drag start. Only needed for
    // magnetic snap while floating, but cheap to compute once. In canvaswrap
    // coordinates.
    const captureOthers = (): Array<{ left: number; top: number; right: number; bottom: number }> => {
      const out: Array<{ left: number; top: number; right: number; bottom: number }> = [];
      document.querySelectorAll<HTMLElement>('.tool-palette').forEach((el) => {
        if (el === panel) return;
        // Only floating palettes are useful as snap targets (docked ones
        // live outside the canvas area entirely).
        if (el.classList.contains('docked')) return;
        const r = el.getBoundingClientRect();
        out.push({
          left:   r.left   - wrapRect.left,
          top:    r.top    - wrapRect.top,
          right:  r.right  - wrapRect.left,
          bottom: r.bottom - wrapRect.top,
        });
      });
      return out;
    };
    const others = captureOthers();

    /** Snap a single axis-start value against viewport edges + other palettes. */
    const snapAxis = (
      startRaw: number, size: number, viewportMax: number,
      otherStarts: number[], otherEnds: number[],
    ): number => {
      const targets: number[] = [0, viewportMax - size];
      for (const os of otherStarts) { targets.push(os); targets.push(os - size); }
      for (const oe of otherEnds)   { targets.push(oe); targets.push(oe - size); }
      let best = startRaw, bestDist = SNAP_PX;
      for (const t of targets) {
        const d = Math.abs(startRaw - t);
        if (d < bestDist) { bestDist = d; best = t; }
      }
      return best;
    };

    /** Cursor inside the dock zone? Bounding-box test against live rect. */
    const isOverDock = (mv: MouseEvent): boolean => {
      const r = dock.getBoundingClientRect();
      return mv.clientX >= r.left && mv.clientX <= r.right
          && mv.clientY >= r.top  && mv.clientY <= r.bottom;
    };

    /** Detach a docked palette into the overlay, preserving its current
     *  on-screen position so the undock feels physical. */
    const detachToFloat = (): void => {
      const currentRect = panel.getBoundingClientRect();
      panel.classList.remove('docked');
      overlay.appendChild(panel);
      const fx = currentRect.left - wrapRect.left;
      const fy = currentRect.top  - wrapRect.top;
      panel.style.left = `${Math.round(fx)}px`;
      panel.style.top  = `${Math.round(fy)}px`;
      lastX = fx; lastY = fy;
      bringPanelToFront(panel, panelId);
      isFloating = true;
    };

    /** Pick the drop target inside the dock.
     *
     * Dock layout: horizontal list of `.tool-dock-column` children, each
     * stacking one-or-more `.tool-palette.docked` vertically.
     *
     * Result fields:
     *   • `dockColumn` — the numeric column the palette should land in,
     *     possibly fractional (e.g. 1.5 to mean "new column between 1 and 2")
     *     or `maxCol + 1` to mean "new column at the right end".
     *   • `target` + `before` — if non-null, reorder within an existing
     *     column relative to this palette; otherwise append to the column.
     */
    type DockTarget = {
      dockColumn: number;
      target: HTMLElement | null;
      before: boolean;
    };
    const pickDockTarget = (mv: MouseEvent): DockTarget => {
      const columns = Array.from(dock.querySelectorAll<HTMLElement>('.tool-dock-column'));
      if (columns.length === 0) {
        return { dockColumn: 0, target: null, before: false };
      }
      // Figure out which column the cursor is over — or between.
      // We walk left-to-right looking at each column's x-range.
      type ColRect = { el: HTMLElement; left: number; right: number; col: number };
      const cols: ColRect[] = columns.map((c) => {
        const r = c.getBoundingClientRect();
        return { el: c, left: r.left, right: r.right, col: parseFloat(c.dataset.dockColumn ?? '0') };
      });

      // Case 1: past the last column's right edge → new column at the end.
      const last = cols[cols.length - 1];
      if (mv.clientX > last.right) {
        return { dockColumn: last.col + 1, target: null, before: false };
      }
      // Case 2: before the first column's left edge → new column at the start.
      const first = cols[0];
      if (mv.clientX < first.left) {
        return { dockColumn: first.col - 1, target: null, before: false };
      }
      // Case 3: cursor inside a column → drop in that column.
      for (const c of cols) {
        if (mv.clientX >= c.left && mv.clientX <= c.right) {
          // Find the nearest sibling palette in this column by Y.
          const siblings = Array.from(c.el.querySelectorAll<HTMLElement>('.tool-palette.docked'))
            .filter(el => el !== panel);
          if (siblings.length === 0) return { dockColumn: c.col, target: null, before: false };
          let best = siblings[0];
          let bestDist = Infinity;
          let before = false;
          for (const s of siblings) {
            const r = s.getBoundingClientRect();
            const midY = (r.top + r.bottom) / 2;
            const d = Math.abs(mv.clientY - midY);
            if (d < bestDist) { bestDist = d; best = s; before = mv.clientY < midY; }
          }
          return { dockColumn: c.col, target: best, before };
        }
      }
      // Case 4: in the gap between two columns → new column in between.
      for (let i = 0; i < cols.length - 1; i++) {
        if (mv.clientX > cols[i].right && mv.clientX < cols[i + 1].left) {
          return { dockColumn: (cols[i].col + cols[i + 1].col) / 2, target: null, before: false };
        }
      }
      // Fallback — shouldn't happen given the exhaustive checks above.
      return { dockColumn: last.col, target: null, before: false };
    };

    const clearDockHints = (): void => {
      document.querySelectorAll<HTMLElement>('.tool-palette.dock-drop-before, .tool-palette.dock-drop-after')
        .forEach(el => el.classList.remove('dock-drop-before', 'dock-drop-after'));
      document.querySelectorAll<HTMLElement>('.tool-dock-column.dock-drop-into')
        .forEach(el => el.classList.remove('dock-drop-into'));
      document.querySelectorAll<HTMLElement>('.tool-dock-new-column-hint')
        .forEach(el => el.remove());
    };

    /** Paint the dock drop indicator matching `pickDockTarget`'s result. */
    const paintDockHint = (res: DockTarget): void => {
      clearDockHints();
      if (res.target) {
        res.target.classList.add(res.before ? 'dock-drop-before' : 'dock-drop-after');
        return;
      }
      // No specific target — either a new column, or appending to an empty
      // existing column. Check: does a column with this dockColumn exist?
      const existing = dock.querySelector<HTMLElement>(
        `.tool-dock-column[data-dock-column="${res.dockColumn}"]`
      );
      if (existing) {
        // Appending to an existing column (which is empty aside from the
        // dragged palette) — tint it.
        existing.classList.add('dock-drop-into');
        return;
      }
      // Brand-new column — insert a ghost vertical bar at the right insert
      // position. We find the nearest real column and place the hint
      // before/after it.
      const cols = Array.from(dock.querySelectorAll<HTMLElement>('.tool-dock-column'));
      if (cols.length === 0) return;
      const hint = document.createElement('div');
      hint.className = 'tool-dock-new-column-hint';
      let insertBefore: HTMLElement | null = null;
      for (const c of cols) {
        const cCol = parseFloat(c.dataset.dockColumn ?? '0');
        if (res.dockColumn < cCol) { insertBefore = c; break; }
      }
      if (insertBefore) dock.insertBefore(hint, insertBefore);
      else dock.appendChild(hint);
    };

    const onMove = (mv: MouseEvent): void => {
      const dx = mv.clientX - startClientX;
      const dy = mv.clientY - startClientY;
      if (!moved && Math.hypot(dx, dy) < DRAG_DEADZONE) return;
      moved = true;

      const overDock = isOverDock(mv);
      if (overDock && !isFloating) {
        // Reorder within the dock: paint a drop-indicator for the target.
        paintDockHint(pickDockTarget(mv));
        return;
      }
      if (!overDock && !isFloating) {
        // First time leaving the dock this drag: undock live.
        detachToFloat();
      }
      // Live-position the floating palette.
      let nx = mv.clientX - wrapRect.left - offsetX;
      let ny = mv.clientY - wrapRect.top  - offsetY;
      const pw = panel.offsetWidth;
      const ph = panel.offsetHeight;
      nx = Math.max(0, Math.min(nx, wrap.clientWidth  - pw));
      ny = Math.max(0, Math.min(ny, wrap.clientHeight - ph));
      nx = snapAxis(nx, pw, wrap.clientWidth,  others.map(o => o.left), others.map(o => o.right));
      ny = snapAxis(ny, ph, wrap.clientHeight, others.map(o => o.top),  others.map(o => o.bottom));
      lastX = nx; lastY = ny;
      panel.style.left = `${Math.round(nx)}px`;
      panel.style.top  = `${Math.round(ny)}px`;
      panel.classList.toggle('snapped-left', nx === 0);

      // Show a dock hint when the cursor has re-entered the dock zone
      // while we're floating — previews the re-dock.
      clearDockHints();
      if (overDock && isFloating) {
        paintDockHint(pickDockTarget(mv));
      }
    };
    const onUp = (mv: MouseEvent): void => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.classList.remove('palette-dragging');
      clearDockHints();
      if (!moved) return;

      const overDock = isOverDock(mv);
      if (overDock) {
        // Commit to docked state, with an explicit dockColumn (possibly
        // fractional for "new column between two existing ones" — mutate
        // compacts back to integers).
        const res = pickDockTarget(mv);
        mutateLayout((l) => {
          const f = findPanel(l, panelId);
          if (!f) return;
          const [me] = l.panels.splice(f.index, 1);
          me.docked = true;
          me.dockColumn = res.dockColumn;
          let insertAt = l.panels.length;
          if (res.target) {
            const tid = res.target.dataset.panelId;
            const idx = l.panels.findIndex(p => p.id === tid);
            if (idx >= 0) insertAt = res.before ? idx : idx + 1;
          }
          l.panels.splice(insertAt, 0, me);
        });
      } else {
        // Commit floating position.
        mutateLayout((l) => {
          const f = findPanel(l, panelId);
          if (f) {
            f.panel.docked = false;
            f.panel.x = lastX;
            f.panel.y = lastY;
          }
        });
      }
      // Re-render to reconcile DOM with new model (moves palette into the
      // correct container and reorders siblings).
      renderToolsPanel();
      restoreActiveHighlight();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// ── Tool DnD into palettes (HTML5 drag-and-drop) ─────────────────────────────

function wirePaletteToolDrop(panelEl: HTMLElement, body: HTMLElement): void {
  const draggedBtn = (): HTMLElement | null =>
    document.querySelector<HTMLElement>('.tool-btn.dragging');

  body.addEventListener('dragover', (ev) => {
    const src = draggedBtn();
    if (!src) return;
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';

    document.querySelectorAll<HTMLElement>('.tool-btn.drop-before, .tool-btn.drop-after')
      .forEach(el => el.classList.remove('drop-before', 'drop-after'));
    document.querySelectorAll<HTMLElement>('.tool-palette-body.drop-target')
      .forEach(el => el.classList.remove('drop-target'));

    const orient = panelEl.dataset.orient as PanelOrientation | undefined;
    const target = (ev.target as HTMLElement | null)?.closest<HTMLElement>('.tool-btn');
    if (target && target !== src) {
      const rect = target.getBoundingClientRect();
      const before = orient === 'horizontal'
        ? ev.clientX < rect.left + rect.width / 2
        : ev.clientY < rect.top + rect.height / 2;
      target.classList.add(before ? 'drop-before' : 'drop-after');
    } else {
      body.classList.add('drop-target');
    }
  });
  body.addEventListener('dragleave', (ev) => {
    if (ev.target === body) body.classList.remove('drop-target');
  });
  body.addEventListener('drop', (ev) => {
    const src = draggedBtn();
    if (!src) return;
    ev.preventDefault();
    const orient = panelEl.dataset.orient as PanelOrientation | undefined;
    const target = (ev.target as HTMLElement | null)?.closest<HTMLElement>('.tool-btn');
    if (target && target !== src) {
      const rect = target.getBoundingClientRect();
      const before = orient === 'horizontal'
        ? ev.clientX < rect.left + rect.width / 2
        : ev.clientY < rect.top + rect.height / 2;
      target.parentElement?.insertBefore(src, before ? target : target.nextSibling);
    } else if (target !== src) {
      body.appendChild(src);
    }
    clearDropHints();
    persistToolsFromDOM();
  });
}

/** Read the DOM after a tool-drop and write the resulting memberships back to
 *  `layout.panels`. Using the DOM as source of truth keeps the code small —
 *  the browser already did the heavy lifting for insertBefore/appendChild. */
function persistToolsFromDOM(): void {
  mutateLayout((l) => {
    const byId = new Map<string, Panel>(l.panels.map(p => [p.id, p]));
    document.querySelectorAll<HTMLElement>('.tool-palette').forEach(palEl => {
      const pid = palEl.dataset.panelId;
      if (!pid) return;
      const panel = byId.get(pid);
      if (!panel) return;
      panel.tools = [];
      palEl.querySelectorAll<HTMLElement>('.tool-btn').forEach(btn => {
        if (btn.dataset.tool) panel.tools.push(btn.dataset.tool);
      });
    });
  });
}

// ── Viewport clamping (on load / on window resize) ───────────────────────────

function clampAllPalettes(): void {
  const wrap = document.getElementById('canvaswrap');
  if (!wrap) return;
  const maxW = wrap.clientWidth;
  const maxH = wrap.clientHeight;
  let changed = false;
  const layout = currentLayout();
  // Only clamp floating palettes — docked ones are flex-laid-out inside
  // #tools and their positions are owned by the layout engine.
  document.querySelectorAll<HTMLElement>('#tool-palettes .tool-palette').forEach(el => {
    const id = el.dataset.panelId;
    if (!id) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const panel = layout.panels.find(p => p.id === id);
    if (!panel || panel.docked) return;
    const nx = Math.max(0, Math.min(panel.x, Math.max(0, maxW - w)));
    const ny = Math.max(0, Math.min(panel.y, Math.max(0, maxH - h)));
    if (nx !== panel.x || ny !== panel.y) {
      panel.x = nx; panel.y = ny;
      el.style.left = `${Math.round(nx)}px`;
      el.style.top = `${Math.round(ny)}px`;
      changed = true;
    }
    el.classList.toggle('snapped-left', panel.x === 0);
  });
  if (changed) saveLayout(layout);
}
window.addEventListener('resize', () => clampAllPalettes());

// ── User flows (add / delete / toggle orientation / set accent) ─────────────

/** Create a new empty palette. No name prompt — palettes are identified by
 *  colour, not by text. New palettes are created as floating near the
 *  top-left of the canvas so the user can see them land, with a neutral
 *  accent so they don't clash with existing ones. */
function addPanelFlow(): void {
  const layout = currentLayout();
  // Cascade floating new-palettes so they don't stack invisibly on top of
  // each other. Use whatever other floating palettes already exist as the
  // reference; fall back to the top-left of the canvas if this is the first.
  const floating = layout.panels.filter(p => !p.docked);
  const last = floating[floating.length - 1];
  const nx = Math.min((last?.x ?? INITIAL_PANEL_X) + 20, 400);
  const ny = (last?.y ?? INITIAL_PANEL_Y) + 20;
  mutateLayout((l) => {
    l.panels.push({
      id: genId('pan'),
      label: '',
      accent: 'neutral',
      orientation: 'vertical',
      tools: [],
      docked: false,
      dockColumn: 0,
      x: nx,
      y: ny,
    });
  });
  renderToolsPanel();
  restoreActiveHighlight();
}

async function deletePanelFlow(panelId: string): Promise<void> {
  const layout = currentLayout();
  const found = findPanel(layout, panelId);
  if (!found) return;
  if (layout.panels.length <= 1) {
    toast('Mindestens eine Toolgruppe muss bleiben');
    return;
  }
  const hasTools = found.panel.tools.length > 0;
  const ok = hasTools ? await showConfirm({
    title: 'Toolgruppe löschen?',
    message: `Die ${found.panel.tools.length} Werkzeug(e) werden automatisch auf andere Toolgruppen verteilt.`,
    okText: 'Löschen',
  }) : true;
  if (!ok) return;
  mutateLayout((l) => {
    const f = findPanel(l, panelId);
    if (!f) return;
    const homeless = f.panel.tools.slice();
    l.panels.splice(f.index, 1);
    // Re-home homeless tools via normalize's unplaced-tool fallback.
    const serialized: RawLayoutV5 = {
      panels: l.panels.map(p => ({
        id: p.id, label: p.label, accent: p.accent, customColor: p.customColor,
        orientation: p.orientation, tools: p.tools.slice(),
        docked: p.docked, dockColumn: p.dockColumn, x: p.x, y: p.y,
      })),
    };
    const homelessSet = new Set(homeless);
    for (const rp of serialized.panels as RawPanel[]) {
      const t = rp.tools as string[];
      rp.tools = t.filter(id => !homelessSet.has(id));
    }
    const repaired = normalizeLayoutV5(serialized);
    l.panels = repaired.panels;
  });
  renderToolsPanel();
  restoreActiveHighlight();
}

function setPanelAccent(panelId: string, accent: ColumnAccent): void {
  mutateLayout((l) => {
    const f = findPanel(l, panelId);
    if (f) {
      f.panel.accent = accent;
      // Picking a preset swatch is an explicit "use this palette colour" act —
      // any previously-stashed custom colour should step aside.
      delete f.panel.customColor;
    }
  });
  renderToolsPanel();
  restoreActiveHighlight();
}

/** Apply a user-chosen hex colour to the palette. The hex is validated against
 *  `CUSTOM_COLOR_RE`; invalid values are silently rejected. Does not touch the
 *  preset accent (kept as a fallback in case the custom colour is ever
 *  cleared). */
function setPanelCustomColor(panelId: string, hex: string): void {
  if (!CUSTOM_COLOR_RE.test(hex)) return;
  const lower = hex.toLowerCase();
  mutateLayout((l) => {
    const f = findPanel(l, panelId);
    if (f) f.panel.customColor = lower;
  });
  renderToolsPanel();
  restoreActiveHighlight();
}

function toggleOrientation(panelId: string): void {
  mutateLayout((l) => {
    const f = findPanel(l, panelId);
    if (!f) return;
    f.panel.orientation = f.panel.orientation === 'vertical' ? 'horizontal' : 'vertical';
  });
  renderToolsPanel();
  restoreActiveHighlight();
}

// ── Right-click context menu ────────────────────────────────────────────────

function closeAnyContextMenu(): void {
  document.querySelectorAll('.tool-ctx-menu').forEach(el => el.remove());
}

/**
 * Open the palette context menu at (clientX, clientY).
 *
 * When `panelId` is non-null, the menu includes panel-specific items
 * (colour row, orientation toggle, delete) plus the global items (new
 * palette, reset). When `panelId` is null (right-click in the empty dock
 * background), only the global items are shown.
 */
function showPaletteContextMenu(panelId: string | null, clientX: number, clientY: number): void {
  closeAnyContextMenu();

  const panel = panelId ? findPanel(currentLayout(), panelId)?.panel ?? null : null;
  const menu = document.createElement('div');
  menu.className = 'tool-ctx-menu';
  menu.setAttribute('role', 'menu');

  const mkItem = (
    label: string,
    onPick: () => void,
    opts: { danger?: boolean; disabled?: boolean } = {},
  ): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tool-ctx-item' + (opts.danger ? ' danger' : '');
    b.setAttribute('role', 'menuitem');
    if (opts.disabled) b.setAttribute('aria-disabled', 'true');
    b.textContent = label;
    b.onclick = () => {
      if (opts.disabled) return;
      closeAnyContextMenu();
      onPick();
    };
    return b;
  };
  const mkSep = (): HTMLElement => {
    const s = document.createElement('div');
    s.className = 'tool-ctx-sep';
    return s;
  };

  if (panel) {
    // Colour row — inline 8 preset dots + a custom-colour picker trigger.
    // A click on a preset replaces any custom colour; clicking the rainbow
    // "+" swatch opens a native <input type="color"> so users aren't locked
    // to the 8 palette colours.
    const colors = document.createElement('div');
    colors.className = 'tool-ctx-colors';
    const activePanel = panel; // lexical capture — satisfies the type narrower
    const hasCustom = !!activePanel.customColor;
    for (const a of ACCENT_ORDER) {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'tool-ctx-color-dot' + (!hasCustom && a === activePanel.accent ? ' current' : '');
      dot.style.setProperty('--c', ACCENT_CSS[a]);
      dot.title = a;
      dot.setAttribute('aria-label', `Farbe ${a}`);
      dot.onclick = (ev) => {
        ev.stopPropagation();
        closeAnyContextMenu();
        setPanelAccent(activePanel.id, a);
      };
      colors.appendChild(dot);
    }
    // Custom-colour swatch: if a custom colour is active it shows that colour
    // and is marked current; otherwise it shows a conic rainbow hint. Click
    // opens the native colour picker. The hidden <input> lives inside the
    // swatch so closing the menu on outside-click doesn't tear it down before
    // the picker can fire (the click is inside `.tool-ctx-menu`).
    const customDot = document.createElement('button');
    customDot.type = 'button';
    customDot.className = 'tool-ctx-color-dot custom' + (hasCustom ? ' current' : '');
    if (hasCustom) customDot.style.setProperty('--c', activePanel.customColor as string);
    customDot.title = 'Eigene Farbe …';
    customDot.setAttribute('aria-label', 'Eigene Farbe wählen');
    const picker = document.createElement('input');
    picker.type = 'color';
    picker.className = 'tool-ctx-color-input';
    picker.value = hasCustom ? (activePanel.customColor as string) : '#3b82f6';
    picker.tabIndex = -1;
    // Live preview while the user drags around the native picker; `change`
    // fires on commit. Close the menu only on `change` so the preview doesn't
    // tear itself down mid-drag.
    picker.oninput = (ev) => {
      ev.stopPropagation();
      setPanelCustomColor(activePanel.id, (ev.target as HTMLInputElement).value);
    };
    picker.onchange = (ev) => {
      ev.stopPropagation();
      setPanelCustomColor(activePanel.id, (ev.target as HTMLInputElement).value);
      closeAnyContextMenu();
    };
    customDot.appendChild(picker);
    customDot.onclick = (ev) => {
      ev.stopPropagation();
      picker.click();
    };
    colors.appendChild(customDot);
    menu.appendChild(colors);
    menu.appendChild(mkSep());

    menu.appendChild(mkItem(
      panel.orientation === 'vertical' ? 'Horizontal ausrichten' : 'Vertikal ausrichten',
      () => toggleOrientation(panel.id),
    ));
    const canDelete = currentLayout().panels.length > 1;
    menu.appendChild(mkItem(
      'Toolgruppe löschen',
      () => { void deletePanelFlow(panel.id); },
      { danger: true, disabled: !canDelete },
    ));
    menu.appendChild(mkSep());
  }

  menu.appendChild(mkItem('Neue Toolgruppe', () => addPanelFlow()));
  menu.appendChild(mkItem('Werkzeuge zurücksetzen', () => {
    void showConfirm({
      title: 'Werkzeugleiste zurücksetzen?',
      message: 'Alle Toolgruppen und Positionen werden auf die Standard-Anordnung zurückgesetzt.',
      okText: 'Zurücksetzen',
    }).then((ok) => { if (ok) resetToolOrder(); });
  }));

  document.body.appendChild(menu);

  // Position at (clientX, clientY) and clamp to viewport so the menu never
  // disappears past the edge of the screen.
  menu.style.left = `${Math.round(clientX)}px`;
  menu.style.top  = `${Math.round(clientY)}px`;
  requestAnimationFrame(() => {
    const r = menu.getBoundingClientRect();
    if (r.right  > window.innerWidth  - 6) menu.style.left = `${Math.round(window.innerWidth  - r.width  - 6)}px`;
    if (r.bottom > window.innerHeight - 6) menu.style.top  = `${Math.round(window.innerHeight - r.height - 6)}px`;
  });

  // Click anywhere outside / Escape / scroll closes.
  const onDocDown = (ev: MouseEvent): void => {
    if (menu.contains(ev.target as Node)) return;
    closeAnyContextMenu();
    document.removeEventListener('mousedown', onDocDown, true);
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') {
      closeAnyContextMenu();
      document.removeEventListener('mousedown', onDocDown, true);
      document.removeEventListener('keydown', onKey, true);
    }
  };
  setTimeout(() => {
    document.addEventListener('mousedown', onDocDown, true);
    document.addEventListener('keydown', onKey, true);
  }, 0);
}

function restoreActiveHighlight(): void {
  document.querySelectorAll<HTMLElement>('.tool-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.tool === state.tool);
  });
}

/**
 * Toggle the "palettes locked" runtime flag. When locked, headers can't be
 * dragged and tool buttons can't be reordered; the rail is re-rendered so
 * every tool button gets `draggable = false` and every header picks up the
 * locked title attribute. Applies a `panels-locked` class on <body> so CSS
 * can flip cursors and other visual affordances without per-element state.
 *
 * Exposed for the Einstellungen menu. The caller doesn't have to pass the
 * current value — toggling is the common case and matches the menu UX.
 */
export function setPanelsLocked(locked: boolean): void {
  runtime.panelsLocked = locked;
  savePanelsLocked(locked);
  document.body.classList.toggle('panels-locked', locked);
  renderToolsPanel();
  restoreActiveHighlight();
  // Keep the native (Tauri) menu's ✓ state aligned. Under a plain browser
  // build this listener is never registered, so the fire-and-forget is a
  // harmless no-op there. Under Tauri the listener lives in tauribridge.ts
  // and forwards into a Rust command that updates the CheckMenuItem — without
  // this, the native check can drift from the actual state (Windows muda
  // doesn't sync back from JS on its own).
  for (const fn of panelsLockedListeners) {
    try { fn(locked); } catch { /* ignore listener errors */ }
  }
}

type PanelsLockedListener = (locked: boolean) => void;
const panelsLockedListeners: PanelsLockedListener[] = [];
/**
 * Register a callback that fires whenever `setPanelsLocked` flips the state.
 * Used by `tauribridge.ts` to push updates into the native menu check item.
 * Callbacks run synchronously after the app state has been updated and the
 * DOM re-rendered.
 */
export function onPanelsLockedChange(fn: PanelsLockedListener): void {
  panelsLockedListeners.push(fn);
}

/** Read accessor so menu code can render a ✓ prefix without importing runtime. */
export function getPanelsLocked(): boolean {
  return runtime.panelsLocked;
}

/** Reset: wipe every persisted version and re-render from defaults. */
export function resetToolOrder(): void {
  try {
    localStorage.removeItem(ORDER_STORAGE_KEY_V5);
    localStorage.removeItem(ORDER_STORAGE_KEY_V4);
    localStorage.removeItem(ORDER_STORAGE_KEY_V3);
    localStorage.removeItem(ORDER_STORAGE_KEY_V2);
    localStorage.removeItem(ORDER_STORAGE_KEY_V1);
  } catch { /* ignore */ }
  layoutCache = null;
  zMap.clear();
  zTop = 100;
  renderToolsPanel();
  restoreActiveHighlight();
}

export function setTool(id: ToolId): void {
  // Remember the last "working" tool so Enter in idle can re-invoke it.
  // Pointer tools are just navigation modes — they don't count.
  if (id !== 'select' && id !== 'select_similar' && id !== 'pan') {
    runtime.lastInvokedTool = id;
  }
  state.tool = id;
  runtime.toolCtx = null;
  document.querySelectorAll<HTMLElement>('.tool-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.tool === id);
  });
  const t = TOOLS.find(x => x.id === id);
  dom.stTool.innerHTML = `Werkzeug: <b>${t ? t.label : id}</b>`;
  if (id === 'select') {
    state.selection.clear();
    updateSelStatus();
    dom.cv.style.cursor = '';
    setPrompt('Kommando');
  } else if (id === 'select_similar') {
    dom.cv.style.cursor = '';
    setPrompt('Objekt anklicken — alle mit gleichem Typ & Layer werden gewählt (Shift = ergänzen)');
  } else if (id === 'pan') {
    runtime.toolCtx = { step: 'idle' };
    dom.cv.style.cursor = 'grab';
    setPrompt('Canvas ziehen');
  } else if (id === 'line')     { runtime.toolCtx = { step: 'p1' }; setPrompt('Erster Punkt'); }
  else if (id === 'polyline')   { runtime.toolCtx = { step: 'p1', pts: [] }; setPrompt('Erster Punkt'); }
  else if (id === 'xline')      { runtime.toolCtx = { step: 'ref' }; setPrompt('Referenzlinie/-achse oder Snap-Punkt'); }
  else if (id === 'rect')       { runtime.toolCtx = { step: 'p1' }; setPrompt('Erster Eckpunkt'); }
  else if (id === 'circle')     { runtime.toolCtx = { step: 'p1' }; setPrompt('Mittelpunkt'); }
  else if (id === 'circle3')    { runtime.toolCtx = { step: 'p1', pts: [] }; setPrompt('Erster Punkt auf Kreis'); }
  else if (id === 'arc3')       { runtime.toolCtx = { step: 'p1', pts: [] }; setPrompt('Startpunkt des Bogens'); }
  else if (id === 'ellipse')    { runtime.toolCtx = { step: 'center' }; setPrompt('Mittelpunkt der Ellipse'); }
  else if (id === 'spline')     { runtime.toolCtx = { step: 'p1', pts: [] }; setPrompt('Erster Punkt der Spline'); }
  else if (id === 'polygon')    { runtime.toolCtx = { step: 'center' }; setPrompt(`Mittelpunkt (n=${lastPolygonSides}, Zahl ändert)`); }
  else if (id === 'offset') {
    // Offset works on a group: user selects 1-N entities, then picks a side
    // (inside / outside the group) with the mouse. Distance is the nearest-
    // edge distance from the cursor, or an explicit typed value. Mirrors the
    // move/copy/rotate pattern: existing selection → skip straight to 'side'.
    if (state.selection.size) {
      const ents = state.entities.filter(e => state.selection.has(e.id));
      runtime.toolCtx = { step: 'side', entities: ents, distance: null };
      setPrompt('Abstand eingeben oder Seite klicken');
    } else {
      runtime.toolCtx = { step: 'pick' };
      setPrompt('Objekte wählen, dann Enter');
    }
  }
  else if (id === 'move') {
    runtime.toolCtx = state.selection.size ? { step: 'base' } : { step: 'pick' };
    setPrompt(runtime.toolCtx.step === 'base' ? 'Basispunkt · Shift = Kopie' : 'Objekte wählen, dann Enter');
  } else if (id === 'copy') {
    runtime.toolCtx = state.selection.size ? { step: 'base' } : { step: 'pick' };
    setPrompt(runtime.toolCtx.step === 'base' ? 'Basispunkt' : 'Objekte wählen, dann Enter');
  } else if (id === 'rotate') {
    runtime.toolCtx = state.selection.size ? { step: 'center' } : { step: 'pick' };
    setPrompt(runtime.toolCtx.step === 'center' ? 'Drehzentrum · Shift = Kopie' : 'Objekte wählen, dann Enter');
  } else if (id === 'mirror') {
    runtime.toolCtx = state.selection.size ? { step: 'axis1' } : { step: 'pick' };
    setPrompt(runtime.toolCtx.step === 'axis1' ? 'Spiegelachse: erster Punkt · Shift = Kopie' : 'Objekte wählen, dann Enter');
  } else if (id === 'cross_mirror') {
    // Symmetrie-Tool (ArtiosCAD-Stil): ein Klick auf den Symmetriemittelpunkt
    // erzeugt — abhängig vom aktiven Modus im HUD-Picker — entweder 1/4-
    // Symmetrie (drei gespiegelte Kopien) oder 1/2-Symmetrie horizontal/
    // vertikal (eine gespiegelte Kopie, je nach Achse). Die Mode-Wahl ist
    // sticky (localStorage); die Achsen lassen sich später im Timeline-Panel
    // parametrisch drehen.
    runtime.toolCtx = state.selection.size ? { step: 'center' } : { step: 'pick' };
    setPrompt(runtime.toolCtx.step === 'center'
      ? crossMirrorPrompt(runtime.crossMirrorMode)
      : 'Objekte wählen, dann Enter');
  } else if (id === 'stretch') {
    runtime.toolCtx = { step: 'pickbox' };
    setPrompt('Bereich aufziehen (Drag-Select) — Crossing-Box bestimmt bewegte Endpunkte');
  } else if (id === 'divide_xline') {
    // Sticky last count (module-level) is preloaded into toolCtx so the user
    // can click a line immediately — no need to re-enter N every activation.
    // To change the count, the user edits the top-docked panel input; Enter
    // commits the new value and stays at 'pick'. Pressing Enter on an empty
    // cmdbar also refocuses the count field (via promptDivideCount).
    runtime.toolCtx = { step: 'pick', radius: lastDivideCount };
    setPrompt(`Objekt wählen (N=${lastDivideCount}) · Enter = Anzahl ändern`);
  } else if (id === 'fillet') {
    runtime.toolCtx = { step: 'pick1' };
    setPrompt('Erste Linie wählen');
  } else if (id === 'chamfer') {
    runtime.toolCtx = { step: 'pick1' };
    setPrompt('Erste Linie wählen');
  } else if (id === 'extend') {
    runtime.toolCtx = { step: 'pick' };
    setPrompt('Linie am zu verlängernden Ende anklicken');
  } else if (id === 'extend_to') {
    runtime.toolCtx = { step: 'pick1' };
    setPrompt('Linie am zu verlängernden/verkürzenden Ende anklicken');
  } else if (id === 'trim') {
    runtime.toolCtx = { step: 'pick' };
    setPrompt('Linien-Abschnitt anklicken (wird bis zum nächsten Schnittpunkt gestutzt)');
  } else if (id === 'text') {
    // Text: single click drops at cursor; click-and-drag frames a box whose
    // height becomes the text height. Either way the actual text content is
    // entered in a modal editor — never in the bottom cmdbar.
    runtime.toolCtx = { step: 'pt', textHeight: lastTextHeight };
    setPrompt('Text: klicken (Standardhöhe) oder Rahmen aufziehen');
  } else if (id === 'dim') {
    const dm = runtime.dimMode;
    runtime.toolCtx = (dm === 'chain' || dm === 'auto')
      ? { step: 'collect', pts: [], ptRefs: [] }
      : { step: 'pick1' };
    setPrompt(
      dm === 'auto'  ? 'Erste Linie klicken (automatische Erkennung dazwischen)' :
      dm === 'chain' ? 'Erster Punkt der Kette' :
                       'Erster Messpunkt'
    );
  } else if (id === 'point') {
    runtime.toolCtx = { step: 'pt' };
    setPrompt('Punkt setzen');
  } else if (id === 'axis') {
    runtime.toolCtx = { step: 'pt' };
    setPrompt('Bezugsachse: Ursprungspunkt');
  } else if (id === 'ref_circle') {
    runtime.toolCtx = { step: 'center' };
    setPrompt('Hilfskreis: Mittelpunkt');
  } else if (id === 'angle') {
    runtime.toolCtx = { step: 'pick' };
    setPrompt('Winkel bemaßen: zwischen zwei Linien klicken');
  } else if (id === 'radius') {
    runtime.toolCtx = { step: 'pickCircle' };
    setPrompt(runtime.radiusMode === 'diameter'
      ? 'Durchmesser: Kreis/Bogen anklicken'
      : 'Radius: Kreis/Bogen anklicken');
  } else if (id === 'scale') {
    runtime.toolCtx = state.selection.size ? { step: 'base' } : { step: 'pick' };
    setPrompt(runtime.toolCtx.step === 'base' ? 'Basispunkt · Shift = Kopie' : 'Objekte wählen, dann Enter');
  } else if (id === 'line_offset') {
    runtime.toolCtx = { step: 'pick' };
    setPrompt('Linie wählen');
  } else if (id === 'hatch') {
    // Schraffur: user clicks inside a closed shape; we auto-detect the
    // enclosing polygon and stripe-fill it. No selection step — the pick IS
    // the commit, same feel as fillet/trim (you click exactly where you want
    // the effect).
    runtime.toolCtx = { step: 'pick' };
    setPrompt('Geschlossene Fläche anklicken (schraffieren)');
  } else if (id === 'fill') {
    runtime.toolCtx = { step: 'pick' };
    setPrompt('Geschlossene Fläche anklicken (füllen)');
  }
  syncDimPicker();
  render();
}

export function cancelTool(): void {
  runtime.dragSelect = null;
  runtime.dragText = null;
  if (state.tool === 'polyline' && runtime.toolCtx?.pts && runtime.toolCtx.pts.length >= 2) {
    finishPolyline(false);
    return;
  }
  if (state.tool === 'spline' && runtime.toolCtx?.pts && runtime.toolCtx.pts.length >= 2) {
    finishSpline(false);
    return;
  }
  runtime.toolCtx = null;
  setTool('select');
}

/**
 * Create an entity by appending a feature to the timeline. Every user-visible
 * creation flows through here so the timeline stays authoritative. Returns the
 * stable entity id allocated for the new feature (0 if allocation fails).
 */
export function addEntity(e: EntityInit): number {
  pushUndo();
  const fid = addFeatureFromInit(e);
  updateStats();
  return entityIdForFeature(fid) ?? 0;
}

export function deleteSelection(): void {
  if (!state.selection.size) return;
  pushUndo();
  const fids = new Set<string>();
  // Per-modifier set of source fids the user is effectively "unmirroring"
  // (or "unrotating" / "uncopying"). For mirror and rotate this fully removes
  // that particular output copy without touching the source or the modifier's
  // other outputs. For array the cell-level delete is more nuanced (a cell
  // identifies a specific (col,row) offset rather than a whole source), so we
  // fall back to whole-feature delete in that case — see the array branch
  // below for why.
  const pruneSources = new Map<string, Set<string>>(); // modFid → Set<sourceFid>
  for (const id of state.selection) {
    const ent = state.entities.find(e => e.id === id);
    if (ent && state.layers[ent.layer]?.locked) continue;

    // Modifier-output case: deleting a single mirror/rotate image must only
    // remove that one image, not the whole modifier. We do this by dropping
    // the corresponding source fid from the modifier's `sourceIds` list —
    // the source feature itself stays (it was drawn independently before the
    // mirror was created), we just stop reflecting it.
    const info = modifierOutputInfo(id);
    if (info) {
      const mod = state.features.find(f => f.id === info.modFid);
      if (mod && (mod.kind === 'mirror' || mod.kind === 'rotate' || mod.kind === 'crossMirror')) {
        let set = pruneSources.get(info.modFid);
        if (!set) { set = new Set<string>(); pruneSources.set(info.modFid, set); }
        set.add(info.sourceFid);
        continue;
      }
      // Array cell delete isn't addressable by sourceFid alone (a source
      // spans nc×nr cells). Treat as "delete the whole array feature" for
      // now — user can rebuild with the desired cell count if they want a
      // subset. A proper per-cell exclusion would need an `excluded:
      // Set<"col|row">` field on ArrayFeature and resolver support.
      if (mod && mod.kind === 'array') {
        fids.add(mod.id);
        continue;
      }
    }

    const f = featureForEntity(id);
    if (f) fids.add(f.id);
  }

  // Apply the per-modifier source prunes. If a modifier ends up with zero
  // sources we drop it entirely — nothing left to produce.
  for (const [modFid, srcSet] of pruneSources) {
    const mod = state.features.find(f => f.id === modFid);
    if (!mod) continue;
    if (mod.kind !== 'mirror' && mod.kind !== 'rotate' && mod.kind !== 'crossMirror') continue;
    mod.sourceIds = mod.sourceIds.filter(s => !srcSet.has(s));
    if (mod.sourceIds.length === 0) fids.add(mod.id);
  }

  const { hidden } = deleteFeatures(fids);
  // Always re-evaluate — we may have mutated sourceIds without touching the
  // feature list, in which case deleteFeatures was a no-op but the mirrors
  // still need rebuilding.
  evaluateTimeline();
  state.selection.clear();
  updateStats();
  updateSelStatus();
  render();
  if (hidden) {
    toast(`${hidden} Objekt${hidden === 1 ? '' : 'e'} ausgeblendet (noch als Bezug verwendet)`);
  }
}

/** Strip the persistent `id` from an Entity so it can feed back into the feature builder. */
function entityInit<T extends Entity>(e: T): EntityInit {
  const { id: _id, ...rest } = e;
  return rest as EntityInit;
}

// ---------------- Transforms ----------------

type TransformFn = (p: Pt) => Pt;

function transformEntity(
  e: Entity,
  fn: TransformFn,
  opts: { pureTranslation?: boolean } = {},
): EntityInit[] {
  const pureTranslation = opts.pureTranslation ?? false;
  if (e.type === 'line') {
    const a = fn({ x: e.x1, y: e.y1 });
    const b = fn({ x: e.x2, y: e.y2 });
    return [{ type: 'line', x1: a.x, y1: a.y, x2: b.x, y2: b.y, layer: e.layer }];
  }
  if (e.type === 'xline') {
    const base = fn({ x: e.x1, y: e.y1 });
    const tip  = fn({ x: e.x1 + e.dx, y: e.y1 + e.dy });
    const d = norm(sub(tip, base));
    return [{ type: 'xline', x1: base.x, y1: base.y, dx: d.x, dy: d.y, layer: e.layer }];
  }
  if (e.type === 'rect') {
    if (pureTranslation) {
      const a = fn({ x: e.x1, y: e.y1 });
      const b = fn({ x: e.x2, y: e.y2 });
      return [{ type: 'rect', x1: a.x, y1: a.y, x2: b.x, y2: b.y, layer: e.layer }];
    }
    const xl = Math.min(e.x1, e.x2), xr = Math.max(e.x1, e.x2);
    const yb = Math.min(e.y1, e.y2), yt = Math.max(e.y1, e.y2);
    const corners = [{ x: xl, y: yb }, { x: xr, y: yb }, { x: xr, y: yt }, { x: xl, y: yt }];
    return [{ type: 'polyline', pts: corners.map(fn), closed: true, layer: e.layer }];
  }
  if (e.type === 'circle') {
    const c = fn({ x: e.cx, y: e.cy });
    return [{ type: 'circle', cx: c.x, cy: c.y, r: e.r, layer: e.layer }];
  }
  if (e.type === 'arc') {
    // Sample three points on the arc and re-fit to stay correct under rotation/mirror.
    const c = fn({ x: e.cx, y: e.cy });
    const pa = fn({ x: e.cx + Math.cos(e.a1) * e.r, y: e.cy + Math.sin(e.a1) * e.r });
    const pb = fn({ x: e.cx + Math.cos(e.a2) * e.r, y: e.cy + Math.sin(e.a2) * e.r });
    const am = (e.a1 + e.a2) / 2;
    const pm = fn({ x: e.cx + Math.cos(am) * e.r, y: e.cy + Math.sin(am) * e.r });
    let a1 = Math.atan2(pa.y - c.y, pa.x - c.x);
    let a2 = Math.atan2(pb.y - c.y, pb.x - c.x);
    const amNew = Math.atan2(pm.y - c.y, pm.x - c.x);
    // Ensure mid lies within [a1, a2] CCW sweep; otherwise swap (mirror flips winding).
    const twoPi = Math.PI * 2;
    const normA = (x: number) => ((x % twoPi) + twoPi) % twoPi;
    const sweepForward = normA(a2 - a1);
    const deltaMid = normA(amNew - a1);
    if (deltaMid > sweepForward) { const t = a1; a1 = a2; a2 = t; }
    return [{ type: 'arc', cx: c.x, cy: c.y, r: e.r, a1, a2, layer: e.layer }];
  }
  if (e.type === 'ellipse') {
    // Sample center + axis tips, recover new axes from them. Handles conformal
    // transforms (rotate, mirror, translate) correctly; shear/non-uniform scale
    // would deform the ellipse, so we just re-derive from the tip images.
    const cos0 = Math.cos(e.rot), sin0 = Math.sin(e.rot);
    const c = fn({ x: e.cx, y: e.cy });
    const a = fn({ x: e.cx + e.rx * cos0,      y: e.cy + e.rx * sin0 });
    const b = fn({ x: e.cx - e.ry * sin0,      y: e.cy + e.ry * cos0 });
    const rx = Math.hypot(a.x - c.x, a.y - c.y);
    const ry = Math.hypot(b.x - c.x, b.y - c.y);
    const rot = Math.atan2(a.y - c.y, a.x - c.x);
    return [{ type: 'ellipse', cx: c.x, cy: c.y, rx, ry, rot, layer: e.layer }];
  }
  if (e.type === 'spline') {
    return [{ type: 'spline', pts: e.pts.map(fn), closed: !!e.closed, layer: e.layer }];
  }
  if (e.type === 'polyline') {
    return [{ type: 'polyline', pts: e.pts.map(fn), closed: !!e.closed, layer: e.layer }];
  }
  if (e.type === 'text') {
    const anchor = fn({ x: e.x, y: e.y });
    const common = {
      type: 'text' as const,
      x: anchor.x, y: anchor.y,
      text: e.text, height: e.height,
      layer: e.layer,
      ...(e.boxWidth !== undefined ? { boxWidth: e.boxWidth } : {}),
    };
    if (pureTranslation) {
      return [{ ...common, rotation: e.rotation }];
    }
    // Sample a unit vector along baseline to recover rotation + mirroring.
    const base0 = { x: e.x, y: e.y };
    const base1 = { x: e.x + Math.cos(e.rotation ?? 0), y: e.y + Math.sin(e.rotation ?? 0) };
    const p0 = fn(base0), p1 = fn(base1);
    const rot = Math.atan2(p1.y - p0.y, p1.x - p0.x);
    return [{ ...common, rotation: rot }];
  }
  if (e.type === 'dim') {
    return [{
      type: 'dim',
      p1: fn(e.p1), p2: fn(e.p2), offset: fn(e.offset),
      textHeight: e.textHeight, layer: e.layer,
    }];
  }
  return [];
}

function transformSelection(
  fn: TransformFn,
  { copy = false, pureTranslation = false }: { copy?: boolean; pureTranslation?: boolean } = {},
): void {
  const ids = [...state.selection];
  if (!ids.length) return;
  pushUndo();
  const keepFids: string[] = [];
  const removedFids = new Set<string>();
  for (const id of ids) {
    const e = state.entities.find(x => x.id === id);
    if (!e) continue;
    const srcFid = featureForEntity(id)?.id ?? null;
    const transformed = transformEntity(e, fn, { pureTranslation });
    if (!transformed.length) continue;
    if (copy) {
      for (const t of transformed) {
        const f = featureFromEntityInit(t);
        state.features.push(f);
        keepFids.push(f.id);
      }
    } else if (srcFid) {
      // Keep the feature id when the entity type is preserved (line→line, etc.)
      // so the stable entity id is retained and selection survives the transform.
      if (transformed.length === 1 && transformed[0].type === e.type) {
        replaceFeatureFromInit(srcFid, transformed[0]);
        keepFids.push(srcFid);
      } else {
        removedFids.add(srcFid);
        for (const t of transformed) {
          const f = featureFromEntityInit(t);
          state.features.push(f);
          keepFids.push(f.id);
        }
      }
    }
  }
  if (removedFids.size) {
    state.features = state.features.filter(f => !removedFids.has(f.id));
  }
  evaluateTimeline();
  if (!copy) state.selection.clear();
  for (const fid of keepFids) {
    const eid = entityIdForFeature(fid);
    if (eid !== null) state.selection.add(eid);
  }
  updateStats();
  updateSelStatus();
}

// ---------------- Offset / parallel ----------------

function offsetInfo(e: Entity, pt: Pt): { dist: number; sign: 1 | -1 } | null {
  if (e.type === 'line') {
    const a = { x: e.x1, y: e.y1 }, b = { x: e.x2, y: e.y2 };
    const dir = norm(sub(b, a));
    const n = perp(dir);
    const rel = sub(pt, a);
    const sd = dot(rel, n);
    return { dist: Math.abs(sd), sign: sd >= 0 ? 1 : -1 };
  }
  if (e.type === 'xline') {
    const n = perp({ x: e.dx, y: e.dy });
    const rel = sub(pt, { x: e.x1, y: e.y1 });
    const sd = dot(rel, n);
    return { dist: Math.abs(sd), sign: sd >= 0 ? 1 : -1 };
  }
  if (e.type === 'rect') {
    const xl = Math.min(e.x1, e.x2), xr = Math.max(e.x1, e.x2);
    const yb = Math.min(e.y1, e.y2), yt = Math.max(e.y1, e.y2);
    const inside = pt.x > xl && pt.x < xr && pt.y > yb && pt.y < yt;
    const d = inside
      ? Math.min(pt.x - xl, xr - pt.x, pt.y - yb, yt - pt.y)
      : Math.min(
          distPtSeg(pt, { x: xl, y: yb }, { x: xr, y: yb }),
          distPtSeg(pt, { x: xr, y: yb }, { x: xr, y: yt }),
          distPtSeg(pt, { x: xr, y: yt }, { x: xl, y: yt }),
          distPtSeg(pt, { x: xl, y: yt }, { x: xl, y: yb }),
        );
    return { dist: d, sign: inside ? -1 : 1 };
  }
  if (e.type === 'circle') {
    const d = dist(pt, { x: e.cx, y: e.cy });
    return { dist: Math.abs(d - e.r), sign: d > e.r ? 1 : -1 };
  }
  if (e.type === 'arc') {
    const d = dist(pt, { x: e.cx, y: e.cy });
    return { dist: Math.abs(d - e.r), sign: d > e.r ? 1 : -1 };
  }
  if (e.type === 'ellipse') {
    // Approximate: transform click into the ellipse's axis-aligned frame.
    const c = { x: pt.x - e.cx, y: pt.y - e.cy };
    const ca = Math.cos(-e.rot), sa = Math.sin(-e.rot);
    const lx = c.x * ca - c.y * sa;
    const ly = c.x * sa + c.y * ca;
    // Normalised "radius" in unit-circle space — <1 inside, >1 outside.
    const r = Math.hypot(lx / Math.max(1e-9, e.rx), ly / Math.max(1e-9, e.ry));
    // Distance estimate — good enough to pick a side; the exact offset curve
    // isn't an ellipse anyway so we approximate by scaling both axes.
    const approxR = Math.hypot(lx, ly);
    const ref = Math.hypot(lx * (e.rx / Math.max(1e-9, Math.hypot(lx, ly))),
                           ly * (e.ry / Math.max(1e-9, Math.hypot(lx, ly))));
    return { dist: Math.abs(approxR - ref), sign: r > 1 ? 1 : -1 };
  }
  if (e.type === 'polyline') {
    if (!e.pts || e.pts.length < 2) return null;
    // Nearest edge + signed side of that edge.
    let bestD = Infinity;
    let bestEdge = 0;
    for (let i = 0; i < e.pts.length - 1; i++) {
      const d = distPtSeg(pt, e.pts[i], e.pts[i + 1]);
      if (d < bestD) { bestD = d; bestEdge = i; }
    }
    if (e.closed) {
      const d = distPtSeg(pt, e.pts[e.pts.length - 1], e.pts[0]);
      if (d < bestD) { bestD = d; bestEdge = e.pts.length - 1; }
    }
    // Sign: for closed polyline use inside/outside via ray casting; for open,
    // use left/right of the nearest edge.
    if (e.closed) {
      const inside = pointInPolygon(pt, e.pts);
      return { dist: bestD, sign: inside ? -1 : 1 };
    }
    const a = e.pts[bestEdge];
    const b = e.pts[(bestEdge + 1) % e.pts.length];
    const dir = norm(sub(b, a));
    const n = perp(dir);
    const sd = dot(sub(pt, a), n);
    return { dist: bestD, sign: sd >= 0 ? 1 : -1 };
  }
  return null;
}

function pointInPolygon(p: Pt, pts: Pt[]): boolean {
  // Standard even-odd ray casting. Treats the polygon as closed regardless of
  // whether the first/last vertices coincide.
  let inside = false;
  const n = pts.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = pts[i].x, yi = pts[i].y;
    const xj = pts[j].x, yj = pts[j].y;
    const intersect = ((yi > p.y) !== (yj > p.y)) &&
      (p.x < ((xj - xi) * (p.y - yi)) / ((yj - yi) || 1e-12) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function distPtSeg(p: Pt, a: Pt, b: Pt): number {
  const ab = sub(b, a);
  const ap = sub(p, a);
  const L2 = dot(ab, ab);
  if (L2 < 1e-12) return len(ap);
  let t = dot(ap, ab) / L2;
  t = Math.max(0, Math.min(1, t));
  return len(sub(ap, scale(ab, t)));
}

export function makeOffsetPreview(e: Entity, d: number, sign: 1 | -1): EntityShape | null {
  if (e.type === 'line') {
    const a = { x: e.x1, y: e.y1 }, b = { x: e.x2, y: e.y2 };
    const dir = norm(sub(b, a));
    const n = perp(dir);
    const off = scale(n, d * sign);
    return { type: 'line', x1: a.x + off.x, y1: a.y + off.y, x2: b.x + off.x, y2: b.y + off.y };
  }
  if (e.type === 'xline') {
    const n = perp({ x: e.dx, y: e.dy });
    const off = scale(n, d * sign);
    return { type: 'xline', x1: e.x1 + off.x, y1: e.y1 + off.y, dx: e.dx, dy: e.dy };
  }
  if (e.type === 'rect') {
    const xl = Math.min(e.x1, e.x2), xr = Math.max(e.x1, e.x2);
    const yb = Math.min(e.y1, e.y2), yt = Math.max(e.y1, e.y2);
    const dd = d * sign;
    return { type: 'rect', x1: xl - dd, y1: yb - dd, x2: xr + dd, y2: yt + dd };
  }
  if (e.type === 'circle') {
    const nr = e.r + d * sign;
    return { type: 'circle', cx: e.cx, cy: e.cy, r: Math.max(0.001, nr) };
  }
  if (e.type === 'arc') {
    const nr = e.r + d * sign;
    if (nr < 0.001) return null;
    return { type: 'arc', cx: e.cx, cy: e.cy, r: nr, a1: e.a1, a2: e.a2 };
  }
  if (e.type === 'ellipse') {
    // Approximation: grow both semi-axes by d·sign. Not a geometric parallel
    // curve (which would not be an ellipse), but visually intuitive and what
    // most CAD users expect.
    const nrx = e.rx + d * sign;
    const nry = e.ry + d * sign;
    if (nrx < 0.001 || nry < 0.001) return null;
    return { type: 'ellipse', cx: e.cx, cy: e.cy, rx: nrx, ry: nry, rot: e.rot };
  }
  if (e.type === 'polyline') {
    const off = offsetPolyline(e.pts, d * sign, !!e.closed);
    if (!off || off.length < 2) return null;
    return { type: 'polyline', pts: off, closed: !!e.closed };
  }
  return null;
}

/**
 * Offset each edge of a polyline by `signedDist` along its left-hand normal,
 * then reconstruct vertices by intersecting adjacent offset edges. For closed
 * polylines the first/last edges wrap. Collinear neighbours just get the
 * perpendicularly-translated endpoint.
 */
function offsetPolyline(pts: Pt[], signedDist: number, closed: boolean): Pt[] | null {
  const n = pts.length;
  if (n < 2) return null;

  // Per-edge offset line defined by a point and a direction.
  const segCount = closed ? n : n - 1;
  const edges: { a: Pt; dir: Pt }[] = [];
  for (let i = 0; i < segCount; i++) {
    const p0 = pts[i], p1 = pts[(i + 1) % n];
    const dir = norm(sub(p1, p0));
    if (len(dir) < 1e-9) return null;
    const nrm = perp(dir);
    const shift = scale(nrm, signedDist);
    edges.push({ a: add(p0, shift), dir });
  }

  const out: Pt[] = new Array(n);

  // For each vertex, intersect the two edges that meet there.
  for (let i = 0; i < n; i++) {
    let prevIdx: number, nextIdx: number;
    if (closed) {
      prevIdx = (i - 1 + segCount) % segCount;
      nextIdx = i % segCount;
    } else {
      if (i === 0) {
        // Start vertex: just translate perpendicularly to the first edge.
        out[i] = edges[0].a;
        continue;
      }
      if (i === n - 1) {
        // End vertex: translate perpendicularly to the last edge.
        const last = edges[segCount - 1];
        out[i] = add(last.a, scale(last.dir, len(sub(pts[n - 1], pts[n - 2]))));
        continue;
      }
      prevIdx = i - 1;
      nextIdx = i;
    }
    const e1 = edges[prevIdx], e2 = edges[nextIdx];
    const x = intersectLines(e1.a, e1.dir, e2.a, e2.dir);
    if (x) {
      out[i] = x;
    } else {
      // Parallel/collinear — fall back to the offset endpoint of the prev edge.
      const segLen = len(sub(pts[i], pts[(i - 1 + n) % n]));
      out[i] = add(e1.a, scale(e1.dir, segLen));
    }
  }
  return out;
}

/** Intersect two infinite lines given as (point, direction). Returns null if parallel. */
function intersectLines(a: Pt, da: Pt, b: Pt, db: Pt): Pt | null {
  const det = da.x * db.y - da.y * db.x;
  if (Math.abs(det) < 1e-9) return null;
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = (dx * db.y - dy * db.x) / det;
  return { x: a.x + da.x * t, y: a.y + da.y * t };
}

function hilfslinieLayer(): number {
  let layer = state.layers.findIndex(L => L.name.toLowerCase().includes('hilfslin'));
  if (layer < 0) layer = state.activeLayer;
  return layer;
}

/**
 * Create a parallel helper line. When `refEntity` is a line or xline that maps
 * to a feature, the result is a `parallelXLine` feature bound to that source —
 * moving or reshaping the source then moves the parallel automatically.
 * Falls back to a plain, absolute xline when no feature binding is available.
 */
export function makeParallelXLine(
  base: Pt, dir: Pt, distExpr: Expr, sign: 1 | -1,
  refEntity?: Entity,
): void {
  const layer = hilfslinieLayer();
  // Parametric mode: bind the parallel to the source feature so it tracks
  // whenever the source moves/rotates or its driving variables change.
  // Free-draw mode: emit a plain abs xline and drop the link.
  if (runtime.parametricMode
      && refEntity
      && (refEntity.type === 'line' || refEntity.type === 'xline')) {
    const refFeat = featureForEntity(refEntity.id);
    if (refFeat) {
      pushUndo();
      state.features.push({
        id: newFeatureId(),
        kind: 'parallelXLine',
        refFeature: refFeat.id,
        distance: distExpr,
        side: sign,
        layer,
      });
      evaluateTimeline();
      updateStats();
      return;
    }
  }
  const distance = evalExpr(distExpr);
  const n = perp(dir);
  const offsetBase = add(base, scale(n, distance * sign));
  addEntity({
    type: 'xline',
    x1: offsetBase.x, y1: offsetBase.y,
    dx: dir.x, dy: dir.y,
    layer,
  });
}

/**
 * Create a helper line parallel to one of the virtual origin axes. The origin
 * axes aren't features, so we can't bind them via `parallelXLine`'s
 * `refFeature` — but we still need the distance expression to stay LIVE when
 * the user edits a variable. A dedicated `axisParallelXLine` feature keeps the
 * Expr intact and re-evaluates on every timeline pass.
 */
export function makeAxisParallelXLine(
  axis: 'x' | 'y', distExpr: Expr, sign: 1 | -1,
): void {
  // Free-draw mode: no implicit link to the origin axis — emit a plain xline
  // at the evaluated distance. The distance Expr stops being live, but that
  // matches the "no chains, no surprises" guarantee free mode promises.
  //
  // Offset uses the same `perp(dir) = (-dy, dx)` normal the parametric
  // evaluator uses (features.ts `axisParallelXLine`), so the `side` captured
  // by `perpOffset()` at click time lands on the same side in both modes.
  // Earlier the Y-axis free-mode branch used `x1 = distance * sign` directly,
  // which flipped the result: clicking left of the Y-axis produced the xline
  // on the right.
  if (!runtime.parametricMode) {
    const distance = evalExpr(distExpr);
    const layer = hilfslinieLayer();
    const dx = axis === 'x' ? 1 : 0;
    const dy = axis === 'x' ? 0 : 1;
    const nx = -dy, ny = dx;
    addEntity({
      type: 'xline',
      x1: nx * distance * sign,
      y1: ny * distance * sign,
      dx, dy,
      layer,
    });
    return;
  }
  pushUndo();
  state.features.push({
    id: newFeatureId(),
    kind: 'axisParallelXLine',
    axis,
    distance: distExpr,
    side: sign,
    layer: hilfslinieLayer(),
  });
  evaluateTimeline();
  updateStats();
}

export function makeXLineThrough(pt: Pt, dir: Pt): void {
  addEntity({
    type: 'xline',
    x1: pt.x, y1: pt.y,
    dx: dir.x, dy: dir.y,
    layer: hilfslinieLayer(),
  });
}

/**
 * Parametric variant of `makeXLineThrough`: places an xline through a
 * PointRef-linked origin at a given direction. When `pRef` is parametric
 * (endpoint/center/mid/intersection/polar/rayHit), the resulting xline feature
 * tracks the origin via `evaluateTimeline` — change the upstream variables,
 * and the xline's origin moves with them while the direction stays fixed.
 *
 * Falls back to the abs-entity path when `pRef` is null/abs so we never
 * create a dead parametric feature that's no more useful than a raw entity.
 *
 * Used by the xline tool's "through a point at an angle" path — previously
 * that path always flattened to an abs entity, so any xline drawn from a
 * parametric snap (rect corner, line mid, intersection, …) lost its link to
 * the origin and stayed frozen in world space when variables moved.
 */
export function makeXLineThroughRef(pRef: PointRef | null, pt: Pt, dir: Pt): void {
  if (!pRef || pRef.kind === 'abs') {
    makeXLineThrough(pt, dir);
    return;
  }
  pushUndo();
  state.features.push({
    id: newFeatureId(),
    kind: 'xline',
    layer: hilfslinieLayer(),
    p: pRef,
    dx: numE(dir.x),
    dy: numE(dir.y),
  });
  evaluateTimeline();
  updateStats();
}

// ---------------- Click dispatch ----------------

/**
 * Entry point for canvas clicks and keyboard-driven commits.
 *
 * When `opts.useSnap` is true (default — mouse clicks), we replace `worldPt`
 * with `runtime.lastSnap` if the cursor is near a snappable feature, and tool
 * handlers may read `runtime.lastSnap` to capture parametric PointRefs.
 *
 * When `opts.useSnap` is false (keyboard commits — cmdbar typing a length or
 * explicit coordinates), we honour `worldPt` exactly AND mask `runtime.lastSnap`
 * for the duration of the dispatch so tool handlers don't accidentally link
 * the typed point to whatever random feature the cursor is hovering over. The
 * snap visual is restored afterwards.
 */
export function handleClick(
  worldPt: Pt,
  shiftKey = false,
  opts: { useSnap?: boolean } = {},
): void {
  const useSnap = opts.useSnap ?? true;
  if (!useSnap) {
    const savedSnap = runtime.lastSnap;
    runtime.lastSnap = null;
    try { dispatchClick(worldPt, worldPt, shiftKey); }
    finally { runtime.lastSnap = savedSnap; }
    return;
  }
  const snap = runtime.lastSnap;
  const p: Pt = snap ? { x: snap.x, y: snap.y } : worldPt;
  dispatchClick(p, worldPt, shiftKey);
}

function dispatchClick(p: Pt, worldPt: Pt, shiftKey: boolean): void {

  if (state.tool === 'select') {
    const hit = hitTest(worldPt);
    if (!shiftKey) state.selection.clear();
    if (hit) state.selection.add(hit.id);
    updateSelStatus();
    render();
    return;
  }
  if (state.tool === 'select_similar') {
    const hit = hitTest(worldPt);
    if (!shiftKey) state.selection.clear();
    if (hit) {
      for (const e of state.entities) {
        if (e.type !== hit.type) continue;
        if (e.layer !== hit.layer) continue;
        const layer = state.layers[e.layer];
        if (!layer || !layer.visible || layer.locked) continue;
        state.selection.add(e.id);
      }
      const layerName = state.layers[hit.layer]?.name ?? `#${hit.layer}`;
      toast(`${state.selection.size} × ${hit.type} auf „${layerName}" gewählt`);
    }
    updateSelStatus();
    render();
    return;
  }
  if (state.tool === 'line')     { handleLineClick(p); return; }
  if (state.tool === 'polyline') { handlePolylineClick(p); return; }
  if (state.tool === 'rect')     { handleRectClick(p); return; }
  if (state.tool === 'circle')   { handleCircleClick(p); return; }
  if (state.tool === 'circle3')  { handleCircle3Click(p); return; }
  if (state.tool === 'arc3')     { handleArc3Click(p); return; }
  if (state.tool === 'ellipse')  { handleEllipseClick(p); return; }
  if (state.tool === 'spline')   { handleSplineClick(p); return; }
  if (state.tool === 'polygon')  { handlePolygonClick(p); return; }
  if (state.tool === 'xline')    { handleXLineClick(p, worldPt); return; }
  if (state.tool === 'divide_xline') { handleDivideXLineClick(worldPt); return; }
  if (state.tool === 'offset')   { handleOffsetClick(p, worldPt); return; }
  if (state.tool === 'line_offset') { handleLineOffsetClick(p, worldPt); return; }
  if (state.tool === 'move')     { handleMoveCopyClick(p, worldPt, false, shiftKey); return; }
  if (state.tool === 'copy')     { handleMoveCopyClick(p, worldPt, true, shiftKey); return; }
  if (state.tool === 'rotate')   { handleRotateClick(p, worldPt, shiftKey); return; }
  if (state.tool === 'mirror')   { handleMirrorClick(p, worldPt, shiftKey); return; }
  if (state.tool === 'cross_mirror') { handleCrossMirrorClick(p, worldPt, shiftKey); return; }
  if (state.tool === 'stretch')  { handleStretchClick(p, worldPt); return; }
  if (state.tool === 'fillet')   { handleFilletClick(worldPt); return; }
  if (state.tool === 'chamfer')  { handleChamferClick(worldPt); return; }
  if (state.tool === 'extend')   { handleExtendClick(worldPt); return; }
  if (state.tool === 'extend_to'){ handleExtendToClick(worldPt); return; }
  if (state.tool === 'trim')     { handleTrimClick(worldPt); return; }
  if (state.tool === 'text')     { handleTextClick(p); return; }
  if (state.tool === 'dim')      { handleDimClick(p); return; }
  if (state.tool === 'ref_circle') { handleRefCircleClick(p); return; }
  if (state.tool === 'angle')    { handleAngleClick(p); return; }
  if (state.tool === 'radius')   { handleRadiusClick(p); return; }
  if (state.tool === 'scale')    { handleScaleClick(p, worldPt, shiftKey); return; }
  if (state.tool === 'hatch')    { handleHatchOrFillClick(worldPt, 'lines'); return; }
  if (state.tool === 'fill')     { handleHatchOrFillClick(worldPt, 'solid'); return; }
}

/**
 * If Shift is held and no geometry snap is active, lock direction to 15°
 * steps. Otherwise, if `orthoAutoLock` is on (default) and no snap is active,
 * soft-snap to the nearest cardinal axis (0°/90°/180°/270°) but *only* when
 * the cursor direction is already within `AUTO_LOCK_TOL_DEG` of that axis —
 * outside that wedge we pass the cursor through untouched. This gives the
 * "looks horizontal → stays horizontal" feel without trapping diagonals.
 */
const AUTO_LOCK_TOL_DEG = 3;
function maybeOrtho(ref: Pt, p: Pt): Pt {
  if (runtime.lastSnap) return p;
  if (runtime.orthoSnap) return orthoSnap(ref, p);
  if (!runtime.orthoAutoLock) return p;
  // Auto-lock to cardinal if we're in the tolerance wedge.
  const dx = p.x - ref.x, dy = p.y - ref.y;
  const L = Math.hypot(dx, dy);
  if (L < 1e-9) return p;
  const angDeg = Math.atan2(dy, dx) * 180 / Math.PI;      // (-180, 180]
  // Distance from the nearest multiple of 90°.
  const mod90 = ((angDeg % 90) + 90) % 90;
  const delta = Math.min(mod90, 90 - mod90);
  if (delta > AUTO_LOCK_TOL_DEG) return p;
  return orthoSnap(ref, p, 90);  // snap to nearest 90° step
}

function handleLineClick(p: Pt): void {
  const snap = runtime.lastSnap;
  const tc = runtime.toolCtx;
  if (!tc || tc.step === 'p1') {
    const p1Ref = snapToPointRef(snap, p);
    runtime.toolCtx = { step: 'p2', p1: p, p1Ref, lockedDir: null, angleDeg: null };
    setPrompt('Zahl = Winkel 0-90° (dann Länge) oder Endpunkt klicken');
  } else if (tc.p1) {
    let endPt: Pt;
    let endRef: PointRef;
    if (tc.lockedDir) {
      // Angle-lock wins: the line stays on the typed ray, always. The snap
      // only constrains the LENGTH. Two cases:
      //  1. Snap is on a feature's edge (edge + entityId resolved) → build a
      //     parametric `rayHit` PointRef: endpoint = ray × that edge. This
      //     keeps the line tracking the target's moving edge when variables
      //     change (e.g. rect width grows → line still meets the right edge).
      //  2. No edge info → fall back to polar-from-p1 with length derived from
      //     ray-vs-snap-axis intersection (or raw cursor projection if no snap).
      const p1RefParam: PointRef = tc.p1Ref ?? { kind: 'abs', x: numE(tc.p1.x), y: numE(tc.p1.y) };
      const angleDegAbs = Math.atan2(tc.lockedDir.y, tc.lockedDir.x) * 180 / Math.PI;

      const rayHit = (runtime.parametricMode && snap && snap.entityId != null && snap.edge)
        ? (() => {
            const feat = featureForEntity(snap.entityId!);
            if (!feat) return null;
            // Modifier features (mirror/array/rotate) don't put their outputs
            // into the resolve-ctx — a rayHit whose target is a modifier would
            // resolve to NaN on the next timeline eval. Fall back to polar in
            // that case so the line at least keeps its typed angle/length.
            if (feat.kind === 'mirror' || feat.kind === 'array' || feat.kind === 'rotate' || feat.kind === 'crossMirror') return null;
            // For corner snaps, the snap's `edge` is arbitrarily top/bottom;
            // upgrade to the adjacent edge that's more perpendicular to the
            // ray so the endpoint tracks the edge that actually moves when
            // the rect resizes along the ray axis.
            const edge = pickBestRectCornerEdge(
              tc.p1!, tc.lockedDir!, snap.entityId!,
              { x: snap.x, y: snap.y }, snap.edge!,
            );
            const hit = rayEdgeIntersect(tc.p1!, tc.lockedDir!, snap.entityId!, edge);
            if (!hit) return null;
            const ref: PointRef = {
              kind: 'rayHit',
              from: p1RefParam,
              angle: numE(angleDegAbs),
              target: feat.id,
              edge,
            };
            return { pt: hit, ref };
          })()
        : null;

      if (rayHit) {
        endPt = rayHit.pt;
        endRef = rayHit.ref;
      } else {
        let length: number;
        if (snap) {
          length = lengthToSnapAxis(tc.p1, tc.lockedDir, { x: snap.x, y: snap.y });
        } else {
          // Project the incoming click onto the locked direction. For mouse
          // clicks `p` equals the cursor position, so this matches the old
          // behaviour exactly; for cmdbar-driven clicks (useSnap=false, p =
          // tc.p1 + dir*typedLength) the projection recovers the typed length
          // instead of silently falling back to the cursor. Previously this
          // path read `state.mouseWorld` directly, which caused the "typed 50,
          // got cursor distance" bug after locking the angle.
          const ap = sub(p, tc.p1);
          length = dot(ap, tc.lockedDir);
        }
        if (length < 1e-6) { toast('Klick auf die andere Seite oder Länge eintippen'); return; }
        endPt = add(tc.p1, scale(tc.lockedDir, length));
        // Store the endpoint parametrically as polar-from-p1 so that when p1Ref
        // links to a feature (e.g. rect corner), the line swings rigidly with
        // it when that feature's variables change — preserving the typed angle
        // and length. Without this the endpoint would be flat abs coords and
        // the line would break the instant p1's source moved.
        // Free-draw mode: plain abs endpoint, no implicit link to p1.
        endRef = runtime.parametricMode
          ? {
              kind: 'polar',
              from: p1RefParam,
              angle: numE(angleDegAbs),
              distance: numE(length),
            }
          : { kind: 'abs', x: numE(endPt.x), y: numE(endPt.y) };
      }
    } else {
      endPt = maybeOrtho(tc.p1, p);
      // Only use snap-ref when ortho didn't alter the point.
      const cand = snapToPointRef(endPt === p ? snap : null, endPt);
      // Free-point fallback: if the endpoint resolved to abs but p1 is
      // parametric, rigid-body-link the endpoint to p1 via polar so the whole
      // line translates with p1 under param changes. Without this, p1 moves
      // with its source feature and p2 stays put — detaching the line.
      endRef = linkPointRefToAnchor(cand, tc.p1Ref, tc.p1, endPt);
    }
    const p1Ref: PointRef = tc.p1Ref ?? { kind: 'abs', x: numE(tc.p1.x), y: numE(tc.p1.y) };
    pushUndo();
    const feat: Feature = {
      id: newFeatureId(), kind: 'line', layer: state.activeLayer,
      p1: p1Ref, p2: endRef,
    };
    state.features.push(feat);
    evaluateTimeline();
    updateStats();
    // LINE tool: each click pair creates ONE independent segment. After commit,
    // reset to p1 and wait for a fresh start point. For a chained workflow the
    // user picks POLYLINE instead (that tool keeps the previous endpoint as
    // the next p1 until Enter/Esc).
    runtime.toolCtx = { step: 'p1' };
    setPrompt('Erster Punkt');
  }
  render();
}

/**
 * Polyline click handler — each click materialises the just-drawn segment
 * as a real line feature, so subsequent clicks (and any other tool) can snap
 * to the placed endpoints/midpoints immediately, without having to wait for
 * the user to end the polyline with Enter / right-click. The chaining UX
 * (previous point becomes next start) stays identical.
 *
 * Segments are committed one per click so each is its own undo step —
 * matches AutoCAD's behaviour where `U` inside a polyline rolls back one
 * vertex and matches our LINE tool's per-commit undo granularity.
 */
export function handlePolylineClick(p: Pt): void {
  const tc = runtime.toolCtx;
  if (!tc) return;
  if (!tc.pts)    tc.pts    = [];
  if (!tc.ptRefs) tc.ptRefs = [];
  const prevPt  = tc.pts.length    > 0 ? tc.pts[tc.pts.length - 1]          : null;
  const prevRef = tc.ptRefs.length > 0 ? tc.ptRefs[tc.ptRefs.length - 1] as PointRef : null;

  let pt: Pt;
  let ref: PointRef;

  if (tc.lockedDir && prevPt && prevRef) {
    // ── Angle-lock path — mirrors handleLineClick's locked branch exactly ──
    //
    // The preview already showed the correct ray; now commit the endpoint
    // on that same ray. Two sub-cases:
    //   1. Snap is on a feature edge → build a parametric rayHit ref so
    //      the endpoint keeps tracking that edge when variables change.
    //   2. No edge info → polar-from-prevRef with length derived from
    //      ray-vs-snap-axis (or raw cursor projection when no snap).
    const snap = runtime.lastSnap;
    const angleDegAbs = Math.atan2(tc.lockedDir.y, tc.lockedDir.x) * 180 / Math.PI;

    const rayHitResult = (runtime.parametricMode && snap && snap.entityId != null && snap.edge)
      ? (() => {
          const feat = featureForEntity(snap.entityId!);
          if (!feat) return null;
          // Modifier sub-entities aren't in the resolve-ctx → fall back to polar.
          if (feat.kind === 'mirror' || feat.kind === 'array' ||
              feat.kind === 'rotate' || feat.kind === 'crossMirror') return null;
          const edge = pickBestRectCornerEdge(
            prevPt, tc.lockedDir!, snap.entityId!,
            { x: snap.x, y: snap.y }, snap.edge!,
          );
          const hit = rayEdgeIntersect(prevPt, tc.lockedDir!, snap.entityId!, edge);
          if (!hit) return null;
          const r: PointRef = {
            kind: 'rayHit', from: prevRef,
            angle: numE(angleDegAbs), target: feat.id, edge,
          };
          return { pt: hit, ref: r };
        })()
      : null;

    if (rayHitResult) {
      pt  = rayHitResult.pt;
      ref = rayHitResult.ref;
    } else {
      let length: number;
      if (snap) {
        length = lengthToSnapAxis(prevPt, tc.lockedDir, { x: snap.x, y: snap.y });
      } else {
        length = dot(sub(p, prevPt), tc.lockedDir);
      }
      if (length < 1e-6) { toast('Klick auf die andere Seite oder Länge eintippen'); return; }
      pt = add(prevPt, scale(tc.lockedDir, length));
      ref = runtime.parametricMode
        ? { kind: 'polar', from: prevRef, angle: numE(angleDegAbs), distance: numE(length) }
        : { kind: 'abs', x: numE(pt.x), y: numE(pt.y) };
    }
  } else {
    // ── Free-direction path (original logic) ─────────────────────────────
    pt = prevPt ? maybeOrtho(prevPt, p) : p;
    // When ortho altered the point, snap-ref doesn't apply — use abs.
    const snap = (pt === p) ? runtime.lastSnap : null;
    const cand = snapToPointRef(snap, pt);
    // Free-point fallback: if this vertex resolved to abs but the previous
    // vertex is parametric, rigid-body-link this vertex to the previous one
    // via polar. Then when an upstream parameter change moves the previous
    // vertex, this vertex (and everything after it in the chain) follows
    // with the same relative offset — preserving each segment's angle and
    // length. Without this, a single abs vertex anywhere in the chain breaks
    // the parametric link for every subsequent segment.
    ref = prevPt && prevRef
      ? linkPointRefToAnchor(cand, prevRef, prevPt, pt)
      : cand;
  }

  tc.pts.push(pt);
  tc.ptRefs.push(ref);

  // First click just anchors the start vertex — no segment yet.
  // Every subsequent click commits a single line feature from the previous
  // vertex to this one; the entity is live in state immediately, so the snap
  // engine can index its endpoints/midpoints on the next mousemove.
  if (prevPt && tc.ptRefs.length >= 2) {
    const prevRef = tc.ptRefs[tc.ptRefs.length - 2] as PointRef;
    pushUndo();
    state.features.push({
      id: newFeatureId(),
      kind: 'line',
      layer: state.activeLayer,
      p1: prevRef,
      p2: ref,
    });
    evaluateTimeline();
    updateStats();
  }

  tc.lockedDir = null;
  tc.angleDeg = null;
  setPrompt(tc.pts.length === 1 ? 'Nächster Punkt' : 'Nächster Punkt (Enter beendet)');
  render();
}

/**
 * Finish the running polyline. Most segments are already committed live on
 * each click (see `handlePolylineClick`), so this only needs to:
 *   • add the closing segment (last → first) when `closed` is true — used
 *     by the polygon close command; otherwise nothing more to commit;
 *   • reset the tool state so the next click starts a fresh polyline.
 */
export function finishPolyline(closed: boolean): void {
  const tc = runtime.toolCtx;
  if (closed && tc && tc.ptRefs && tc.ptRefs.length >= 3) {
    const firstRef = tc.ptRefs[0] as PointRef;
    const lastRef  = tc.ptRefs[tc.ptRefs.length - 1] as PointRef;
    pushUndo();
    state.features.push({
      id: newFeatureId(),
      kind: 'line',
      layer: state.activeLayer,
      p1: lastRef,
      p2: firstRef,
    });
    evaluateTimeline();
    updateStats();
  }
  runtime.toolCtx = { step: 'p1', pts: [] };
  setPrompt('Erster Punkt');
  render();
}

/**
 * Break a polyline into N (or N+1 if closed) independent line features so
 * each segment is individually selectable/editable AND every vertex behaves
 * as a first-class line endpoint — the snap engine already knows how to find
 * those, so a fresh line drawn between two ex-polyline vertices "just works".
 * Used by both the polyline tool and the polygon tool.
 */
function commitPolylineAsLines(refs: PointRef[], closed: boolean, layer: number): void {
  if (refs.length < 2) return;
  const n = refs.length;
  const segCount = closed ? n : n - 1;
  for (let i = 0; i < segCount; i++) {
    const a = refs[i];
    const b = refs[(i + 1) % n];
    state.features.push({
      id: newFeatureId(),
      kind: 'line',
      layer,
      p1: a,
      p2: b,
    });
  }
}

function handleRectClick(p: Pt): void {
  const tc = runtime.toolCtx;
  if (!tc || tc.step === 'p1') {
    // Capture the snap ref too — if the user snaps the first corner onto an
    // existing feature (endpoint/center/intersection), the whole rectangle
    // stays tied to that anchor when parameters change.
    const p1Ref = snapToPointRef(runtime.lastSnap, p);
    runtime.toolCtx = { step: 'dims', p1: p, p1Ref, vertical: null, horizontal: null };
    setPrompt('Breite + Höhe eingeben');
  } else if (tc.step === 'dims' && tc.p1) {
    // Also capture a PointRef for the diagonal corner. When BOTH corners are
    // parametric (e.g. each one snapped onto an xline × xline intersection),
    // the rectangle's other two corners can be expressed as `axisProject`
    // refs that share x with one corner and y with the other. That ties the
    // whole rectangle to its two anchor intersections, so if a variable
    // moves either xline the rectangle reshapes to keep each corner glued
    // to its intersection.
    const p3Ref = snapToPointRef(runtime.lastSnap, p);
    let x1 = tc.p1.x, y1 = tc.p1.y, x2 = p.x, y2 = p.y;
    if (tc.vertical != null)   y2 = y1 + (Math.sign(p.y - y1) || 1) * tc.vertical;
    if (tc.horizontal != null) x2 = x1 + (Math.sign(p.x - x1) || 1) * tc.horizontal;
    if (Math.abs(x2 - x1) < 1e-6 || Math.abs(y2 - y1) < 1e-6) {
      toast('Rechteck zu klein');
      return;
    }
    const aIsParam = tc.p1Ref && tc.p1Ref.kind !== 'abs';
    const cIsParam = p3Ref && p3Ref.kind !== 'abs';
    const dimsLocked = tc.vertical != null || tc.horizontal != null;
    if (aIsParam && cIsParam && !dimsLocked) {
      // Full parametric path: A = p1Ref, C = p3Ref, B/D = axisProject.
      commitRectFromCorners(tc.p1Ref!, p3Ref!, state.activeLayer);
    } else if (aIsParam) {
      // Partial parametric: only the first corner anchors. Fall back to
      // polar-off-A so corners B/C/D at least follow A rigidly when its
      // source feature moves. Dimensions are numeric (click-click path).
      const sX: 1 | -1 = (x2 - x1) >= 0 ? 1 : -1;
      const sY: 1 | -1 = (y2 - y1) >= 0 ? 1 : -1;
      const width  = Math.abs(x2 - x1);
      const height = Math.abs(y2 - y1);
      commitRectAsLinesExpr(tc.p1Ref!, numE(width), numE(height), sX, sY, state.activeLayer);
    } else {
      commitRectAsLines(x1, y1, x2, y2);
    }
    runtime.toolCtx = { step: 'p1' };
    setPrompt('Erster Eckpunkt');
  }
  render();
}

/**
 * Commit a rectangle as 4 line features given two opposite corners A and C
 * as parametric PointRefs. The other two corners (B = A.x extended to C.y,
 * D = C.x with A.y — or the mirror depending on which diagonal was drawn)
 * use the new `axisProject` PointRef kind so they derive their x from one
 * anchor corner and their y from the other.
 *
 *   A ◄─────────► B         B.x = C, B.y = A  → axisProject(xFrom:C, yFrom:A)
 *   │             │         D.x = A, D.y = C  → axisProject(xFrom:A, yFrom:C)
 *   D ◄─────────► C
 *
 * Because evaluateTimeline walks the ref dependency graph, moving either A
 * or C (e.g. by changing a variable that drives one of the intersecting
 * xlines) reshapes the rectangle automatically. The x/y separation is what
 * makes an axis-aligned rectangle stay axis-aligned under two free-roaming
 * anchor corners — a plain polar link would rotate the rectangle instead.
 */
export function commitRectFromCorners(
  A: PointRef,
  C: PointRef,
  layer: number,
): void {
  const B: PointRef = { kind: 'axisProject', xFrom: C, yFrom: A };
  const D: PointRef = { kind: 'axisProject', xFrom: A, yFrom: C };
  const edges: [PointRef, PointRef][] = [[A, B], [B, C], [C, D], [D, A]];
  pushUndo();
  for (const [p1, p2] of edges) {
    state.features.push({
      id: newFeatureId(),
      kind: 'line',
      layer,
      p1,
      p2,
    });
  }
  evaluateTimeline();
  updateStats();
}

/**
 * Rectangle tool commits as 4 independent LINE features (not a `rect`
 * entity). This makes the rectangle immediately editable edge-by-edge —
 * select a single side and offset it, trim, extend, delete, etc. — which
 * matches how draftspeople think of "ein Rechteck aus 4 Linien". All four
 * lines land under a single undo step.
 *
 * Exported so the cmdbar path (width+height entered numerically) can take
 * the same route and not leave a single `rect` feature behind.
 */
export function commitRectAsLines(x1: number, y1: number, x2: number, y2: number): void {
  const corners: Pt[] = [
    { x: x1, y: y1 },
    { x: x2, y: y1 },
    { x: x2, y: y2 },
    { x: x1, y: y2 },
  ];
  pushUndo();
  for (let i = 0; i < 4; i++) {
    const a = corners[i], b = corners[(i + 1) % 4];
    state.features.push({
      id: newFeatureId(),
      kind: 'line',
      layer: state.activeLayer,
      p1: { kind: 'abs', x: numE(a.x), y: numE(a.y) },
      p2: { kind: 'abs', x: numE(b.x), y: numE(b.y) },
    });
  }
  evaluateTimeline();
  updateStats();
}

/**
 * Parametric rectangle commit. Same 4-line shape as `commitRectAsLines`, but
 * corners B/C/D are expressed as `polar` PointRefs against corner A so that
 * a user-typed width/height *expression* (variable or formula) survives and
 * keeps the rectangle live: when the user later changes the underlying
 * parameter, `evaluateTimeline` re-resolves the corners and the rectangle
 * resizes. Falls back to absolute numbers only if the caller passes a
 * purely numeric Expr.
 *
 *   A ────────────► B        angleX = sX>=0 ? 0 : 180°
 *   │               │        angleY = sY>=0 ? 90 : -90°
 *   │               │        B = polar(A, angleX, width)
 *   D ────────────► C        D = polar(A, angleY, height)
 *                            C = polar(B, angleY, height)
 */
export function commitRectAsLinesExpr(
  p1Ref: PointRef,
  widthExpr: Expr,
  heightExpr: Expr,
  sX: 1 | -1,
  sY: 1 | -1,
  layer: number,
): void {
  const angleX: Expr = numE(sX >= 0 ? 0 : 180);
  const angleY: Expr = numE(sY >= 0 ? 90 : -90);
  const A: PointRef = p1Ref;
  const B: PointRef = { kind: 'polar', from: A, angle: angleX, distance: widthExpr };
  const D: PointRef = { kind: 'polar', from: A, angle: angleY, distance: heightExpr };
  const C: PointRef = { kind: 'polar', from: B, angle: angleY, distance: heightExpr };
  const edges: [PointRef, PointRef][] = [[A, B], [B, C], [C, D], [D, A]];
  pushUndo();
  for (const [p1, p2] of edges) {
    state.features.push({
      id: newFeatureId(),
      kind: 'line',
      layer,
      p1,
      p2,
    });
  }
  evaluateTimeline();
  updateStats();
}

function handleCircleClick(p: Pt): void {
  const tc = runtime.toolCtx;
  if (!tc || tc.step === 'p1') {
    // PointRef am Mittelpunkt festhalten — bei Snap auf einen Achsen-/Linien-/
    // Kreis-/Vertex-Punkt liefert snapToPointRef eine parametrische Referenz,
    // sodass der Kreis beim Verändern der Referenz oder einer Variable
    // automatisch nachzieht. Ohne Snap → abs (Koordinaten fix).
    const centerRef = snapToPointRef(runtime.lastSnap, p);
    runtime.toolCtx = { step: 'r', cx: p.x, cy: p.y, centerRef };
    setPrompt('Radius eingeben oder Punkt klicken');
  } else if (tc.cx != null && tc.cy != null) {
    const r = dist(p, { x: tc.cx, y: tc.cy });
    if (r < 1e-6) return;
    commitCircleFromCtx(tc, numE(r), state.activeLayer);
    runtime.toolCtx = { step: 'p1' };
    setPrompt('Mittelpunkt');
  }
  render();
}

/**
 * Build a circle feature from a ToolCtx (cx/cy fallback, optional centerRef)
 * plus a radius Expr and layer. Shared by the click-radius path and the
 * Hilfskreis variant; commitCircle in cmdbar uses a similar pattern.
 */
function commitCircleFromCtx(tc: ToolCtx, radius: Expr, layer: number): void {
  if (tc.cx == null || tc.cy == null) return;
  pushUndo();
  const center: PointRef = tc.centerRef
    ?? { kind: 'abs', x: numE(tc.cx), y: numE(tc.cy) };
  state.features.push({
    id: newFeatureId(),
    kind: 'circle',
    layer,
    center,
    radius,
  });
  evaluateTimeline();
  updateStats();
}

/**
 * Hilfskreis: same UX flow as circle, but commits onto the Hilfslinie layer
 * (dashed/ghost style via layer property). Useful as a construction aid that
 * isn't part of the printed drawing. Reuses the 'circle' cmdbar schema via
 * the shared 'r' step + cx/cy.
 */
function handleRefCircleClick(p: Pt): void {
  const tc = runtime.toolCtx;
  if (!tc || tc.step === 'center') {
    const centerRef = snapToPointRef(runtime.lastSnap, p);
    runtime.toolCtx = { step: 'r', cx: p.x, cy: p.y, centerRef };
    setPrompt('Radius eingeben oder Punkt klicken');
  } else if (tc.cx != null && tc.cy != null) {
    const r = dist(p, { x: tc.cx, y: tc.cy });
    if (r < 1e-6) return;
    commitCircleFromCtx(tc, numE(r), hilfslinieLayer());
    runtime.toolCtx = { step: 'center' };
    setPrompt('Hilfskreis: Mittelpunkt');
  }
  render();
}

/**
 * Shared pick: return the two nearest non-parallel line-ish segments to p,
 * plus their infinite-line intersection. Used by both the click handler and
 * the live preview so what the user sees matches what they'd commit.
 *
 * Returns null when there aren't two suitable segments (e.g. only one line in
 * the scene, or the two nearest lines are parallel).
 */
function findAnglePickLines(p: Pt): {
  V: Pt; ray1: Pt; ray2: Pt; radius: number;
} | null {
  type Cand = { a: Pt; b: Pt; d: number };
  const candidates: Cand[] = [];
  for (const ent of state.entities) {
    const layer = state.layers[ent.layer];
    if (!layer || !layer.visible) continue;
    if (ent.type === 'line') {
      const a = { x: ent.x1, y: ent.y1 }, b = { x: ent.x2, y: ent.y2 };
      candidates.push({ a, b, d: distPtSeg(p, a, b) });
    } else if (ent.type === 'xline') {
      const T = 1e6;
      const a = { x: ent.x1 - ent.dx * T, y: ent.y1 - ent.dy * T };
      const b = { x: ent.x1 + ent.dx * T, y: ent.y1 + ent.dy * T };
      candidates.push({ a, b, d: distPtSeg(p, a, b) });
    } else if (ent.type === 'polyline') {
      for (let i = 1; i < ent.pts.length; i++) {
        candidates.push({ a: ent.pts[i - 1], b: ent.pts[i], d: distPtSeg(p, ent.pts[i - 1], ent.pts[i]) });
      }
      if (ent.closed && ent.pts.length > 2) {
        const a = ent.pts[ent.pts.length - 1], b = ent.pts[0];
        candidates.push({ a, b, d: distPtSeg(p, a, b) });
      }
    } else if (ent.type === 'rect') {
      const xl = Math.min(ent.x1, ent.x2), xr = Math.max(ent.x1, ent.x2);
      const yb = Math.min(ent.y1, ent.y2), yt = Math.max(ent.y1, ent.y2);
      const edges: [Pt, Pt][] = [
        [{ x: xl, y: yb }, { x: xr, y: yb }],
        [{ x: xr, y: yb }, { x: xr, y: yt }],
        [{ x: xr, y: yt }, { x: xl, y: yt }],
        [{ x: xl, y: yt }, { x: xl, y: yb }],
      ];
      for (const [a, b] of edges) candidates.push({ a, b, d: distPtSeg(p, a, b) });
    }
  }
  if (candidates.length < 2) return null;
  candidates.sort((x, y) => x.d - y.d);
  const L1 = candidates[0];
  const d1x = L1.b.x - L1.a.x, d1y = L1.b.y - L1.a.y;
  const len1 = Math.hypot(d1x, d1y);
  let L2: Cand | null = null;
  for (let i = 1; i < candidates.length; i++) {
    const C = candidates[i];
    const d2x = C.b.x - C.a.x, d2y = C.b.y - C.a.y;
    const len2 = Math.hypot(d2x, d2y);
    if (len1 < 1e-9 || len2 < 1e-9) continue;
    const cross = (d1x * d2y - d1y * d2x) / (len1 * len2);
    if (Math.abs(cross) < 0.02) continue;
    L2 = C; break;
  }
  if (!L2) return null;
  const V = lineIntersectionInfinite(
    { x1: L1.a.x, y1: L1.a.y, x2: L1.b.x, y2: L1.b.y },
    { x1: L2.a.x, y1: L2.a.y, x2: L2.b.x, y2: L2.b.y },
  );
  if (!V) return null;
  const R = Math.max(1, Math.hypot(p.x - V.x, p.y - V.y));
  const chooseRay = (a: Pt, b: Pt): Pt => {
    const dx = b.x - a.x, dy = b.y - a.y;
    const L = Math.hypot(dx, dy);
    if (L < 1e-9) return a;
    const ux = dx / L, uy = dy / L;
    const s = ((p.x - V.x) * ux + (p.y - V.y) * uy) >= 0 ? 1 : -1;
    return { x: V.x + ux * s * R, y: V.y + uy * s * R };
  };
  return { V, ray1: chooseRay(L1.a, L1.b), ray2: chooseRay(L2.a, L2.b), radius: R };
}

/** Build the Preview payload for the angle tool at cursor position p. */
function buildAnglePreview(p: Pt): { shape: EntityShape; deg: number } | null {
  const pick = findAnglePickLines(p);
  if (!pick) return null;
  const { V, ray1, ray2 } = pick;
  // Compute the measured sweep (sector containing p) for the tooltip read-out.
  const TAU = Math.PI * 2;
  const norm2pi = (x: number) => ((x % TAU) + TAU) % TAU;
  const a1 = Math.atan2(ray1.y - V.y, ray1.x - V.x);
  const a2 = Math.atan2(ray2.y - V.y, ray2.x - V.x);
  const aO = Math.atan2(p.y - V.y, p.x - V.x);
  const sweep12 = norm2pi(a2 - a1);
  const sweep1O = norm2pi(aO - a1);
  const sweep = (sweep1O <= sweep12 + 1e-9) ? sweep12 : norm2pi(a1 - a2);
  const deg = sweep * 180 / Math.PI;
  const shape: EntityShape = {
    type: 'dim',
    dimKind: 'angular',
    p1: V, p2: ray1, offset: p,
    vertex: V, ray1, ray2,
    textHeight: lastTextHeight,
    ...(runtime.dimStyle ? { style: runtime.dimStyle } : {}),
  };
  return { shape, deg };
}

/**
 * Winkel bemaßen — one click inside the angular sector between two lines
 * creates a full angular DimEntity.
 *
 * Picks the two segments nearest the click (distance to the visible extent),
 * intersects their infinite supporting lines for the vertex, then orients the
 * two rays so the click lies in the measured sector. The click point doubles
 * as the arc anchor: distance to vertex is the arc radius, its angular
 * position disambiguates which of the four sectors around the crossing is
 * the one being dimensioned.
 */
function handleAngleClick(p: Pt): void {
  const pick = findAnglePickLines(p);
  if (!pick) {
    toast('Keine zwei, nicht-parallelen Linien in der Nähe gefunden');
    render();
    return;
  }
  const { V, ray1, ray2 } = pick;
  pushUndo();
  const init: EntityInit = {
    type: 'dim',
    dimKind: 'angular',
    layer: dimLayer(),
    // Legacy fallback fields (used by bounds/hit/etc when angular-aware
    // branches aren't hit). vertex/ray1/ray2 carry the authoritative geometry.
    p1: V, p2: ray1, offset: p,
    vertex: V, ray1, ray2,
    textHeight: lastTextHeight,
    ...(runtime.dimStyle ? { style: runtime.dimStyle } : {}),
  };
  addFeatureFromInit(init);
  evaluateTimeline();
  updateStats();
  // Loop so the user can bemaß several angles in a row.
  runtime.toolCtx = { step: 'pick' };
  setPrompt('Winkel bemaßen: zwischen zwei Linien klicken');
  render();
}

// ---------------- Radius / Diameter dim ----------------

/**
 * Given a world point, find the nearest pickable curve (circle or arc) and
 * return its centre + radius. Returns null if nothing suitable is close
 * enough — the "close enough" check leans on the existing hit-test tolerance
 * so the pick feels the same as clicking any other entity.
 */
function findNearestCircleLike(p: Pt): { cx: number; cy: number; r: number } | null {
  let best: { cx: number; cy: number; r: number; d: number } | null = null;
  for (const ent of state.entities) {
    const layer = state.layers[ent.layer];
    if (!layer || !layer.visible) continue;
    if (ent.type === 'circle') {
      const d = Math.abs(Math.hypot(p.x - ent.cx, p.y - ent.cy) - ent.r);
      if (!best || d < best.d) best = { cx: ent.cx, cy: ent.cy, r: ent.r, d };
    } else if (ent.type === 'arc') {
      const d = Math.abs(Math.hypot(p.x - ent.cx, p.y - ent.cy) - ent.r);
      if (!best || d < best.d) best = { cx: ent.cx, cy: ent.cy, r: ent.r, d };
    }
  }
  return best;
}

/**
 * Build a preview shape for the radius/diameter tool. Runs on every mouse
 * move: picks the circle nearest the cursor (fixed on first click via
 * `tc.centerPt`/`tc.refLen`, otherwise re-picked every frame) and lays out
 * the dim with the cursor as the label anchor. Returns null when there's no
 * suitable circle in range — the caller clears the preview.
 */
function buildRadiusPreview(p: Pt): { shape: EntityShape; value: number; mode: RadiusMode } | null {
  const tc = runtime.toolCtx;
  const mode: RadiusMode = runtime.radiusMode;
  let picked: { cx: number; cy: number; r: number } | null = null;
  if (tc && tc.step === 'place' && tc.centerPt && tc.refLen != null) {
    picked = { cx: tc.centerPt.x, cy: tc.centerPt.y, r: tc.refLen };
  } else {
    picked = findNearestCircleLike(p);
  }
  if (!picked) return null;
  const { cx, cy, r } = picked;
  const center: Pt = { x: cx, y: cy };
  // Near-edge point on the ray from center through cursor. When the cursor
  // sits exactly at the centre we fall back to a canonical direction so the
  // preview still shows something.
  let ux = p.x - cx, uy = p.y - cy;
  const ul = Math.hypot(ux, uy);
  if (ul < 1e-9) { ux = 1; uy = 0; } else { ux /= ul; uy /= ul; }
  const edge: Pt = { x: cx + ux * r, y: cy + uy * r };
  const value = mode === 'diameter' ? 2 * r : r;
  const shape: EntityShape = {
    type: 'dim',
    dimKind: mode,
    p1: center, p2: edge, offset: p,
    vertex: center, ray1: edge,
    textHeight: lastTextHeight,
    ...(runtime.dimStyle ? { style: runtime.dimStyle } : {}),
  };
  return { shape, value, mode };
}

/**
 * Radius/diameter click handler. Two phases:
 *  1. `pickCircle` — click on or near a circle/arc. Stores centre + radius
 *     in the tool context and advances to the placement phase.
 *  2. `place` — click to commit the dim; the click position becomes the
 *     label anchor (`offset`) and determines which edge point the leader
 *     points at. Loops back to phase 1 so multiple dims can be created in
 *     a row without re-selecting the tool.
 *
 * The DimKind (`radius` vs `diameter`) comes from the current `runtime.radiusMode`
 * — switching it mid-tool via the picker changes what the next commit stores
 * but leaves any already-placed dims alone.
 */
function handleRadiusClick(p: Pt): void {
  const tc = runtime.toolCtx;
  if (!tc) return;
  if (tc.step === 'pickCircle') {
    const pick = findNearestCircleLike(p);
    if (!pick) {
      toast('Kein Kreis oder Bogen in der Nähe');
      return;
    }
    runtime.toolCtx = {
      step: 'place',
      centerPt: { x: pick.cx, y: pick.cy },
      refLen: pick.r,
    };
    setPrompt(runtime.radiusMode === 'diameter'
      ? 'Durchmesser: Beschriftung platzieren'
      : 'Radius: Beschriftung platzieren');
    render();
    return;
  }
  if (tc.step === 'place' && tc.centerPt && tc.refLen != null) {
    const cx = tc.centerPt.x, cy = tc.centerPt.y, r = tc.refLen;
    // Near-edge point along the center→click direction.
    let ux = p.x - cx, uy = p.y - cy;
    const ul = Math.hypot(ux, uy);
    if (ul < 1e-9) { ux = 1; uy = 0; } else { ux /= ul; uy /= ul; }
    const edge: Pt = { x: cx + ux * r, y: cy + uy * r };
    pushUndo();
    const init: EntityInit = {
      type: 'dim',
      dimKind: runtime.radiusMode,
      layer: dimLayer(),
      p1: { x: cx, y: cy }, p2: edge, offset: p,
      vertex: { x: cx, y: cy }, ray1: edge,
      textHeight: lastTextHeight,
      ...(runtime.dimStyle ? { style: runtime.dimStyle } : {}),
    };
    addFeatureFromInit(init);
    evaluateTimeline();
    updateStats();
    runtime.toolCtx = { step: 'pickCircle' };
    setPrompt(runtime.radiusMode === 'diameter'
      ? 'Durchmesser: Kreis/Bogen anklicken'
      : 'Radius: Kreis/Bogen anklicken');
    render();
  }
}

// ---------------- Polygon ----------------

let lastPolygonSides = 6;

export function setPolygonSides(n: number): void {
  if (n >= 3 && n <= 64) lastPolygonSides = Math.floor(n);
}

export function getPolygonSides(): number { return lastPolygonSides; }

function polygonPoints(cx: number, cy: number, r: number, n: number, startAng: number): Pt[] {
  const pts: Pt[] = [];
  const step = 2 * Math.PI / n;
  for (let i = 0; i < n; i++) {
    const a = startAng + i * step;
    pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
  }
  return pts;
}

function handlePolygonClick(p: Pt): void {
  const tc = runtime.toolCtx;
  if (!tc || tc.step === 'center') {
    runtime.toolCtx = { step: 'radius', cx: p.x, cy: p.y };
    setPrompt(`Radius eingeben oder Eckpunkt klicken (n=${lastPolygonSides})`);
    updatePreview();
    render();
    return;
  }
  if (tc.step === 'radius' && tc.cx != null && tc.cy != null) {
    const r = dist(p, { x: tc.cx, y: tc.cy });
    if (r < 1e-6) return;
    const startAng = Math.atan2(p.y - tc.cy, p.x - tc.cx);
    const pts = polygonPoints(tc.cx, tc.cy, r, lastPolygonSides, startAng);
    const refs: PointRef[] = pts.map((pt): PointRef => ({
      kind: 'abs', x: numE(pt.x), y: numE(pt.y),
    }));
    pushUndo();
    commitPolylineAsLines(refs, true, state.activeLayer);
    evaluateTimeline();
    updateStats();
    runtime.toolCtx = { step: 'center' };
    setPrompt(`Mittelpunkt (n=${lastPolygonSides}, Zahl ändert)`);
    render();
  }
}

// ---------------- 3-Punkt-Kreis / 3-Punkt-Bogen ----------------

/**
 * Circumscribed circle through three points. Returns null for collinear points.
 */
function circleFrom3(a: Pt, b: Pt, c: Pt): { cx: number; cy: number; r: number } | null {
  const ax = a.x, ay = a.y, bx = b.x, by = b.y, cx = c.x, cy = c.y;
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-9) return null;
  const ux = ((ax * ax + ay * ay) * (by - cy) +
              (bx * bx + by * by) * (cy - ay) +
              (cx * cx + cy * cy) * (ay - by)) / d;
  const uy = ((ax * ax + ay * ay) * (cx - bx) +
              (bx * bx + by * by) * (ax - cx) +
              (cx * cx + cy * cy) * (bx - ax)) / d;
  const r = Math.hypot(ax - ux, ay - uy);
  return { cx: ux, cy: uy, r };
}

function handleCircle3Click(p: Pt): void {
  const tc = runtime.toolCtx;
  if (!tc) return;
  if (!tc.pts) tc.pts = [];
  tc.pts.push(p);
  if (tc.pts.length === 1) {
    tc.step = 'p2';
    setPrompt('Zweiter Punkt auf Kreis');
  } else if (tc.pts.length === 2) {
    tc.step = 'p3';
    setPrompt('Dritter Punkt auf Kreis');
  } else {
    const [a, b, c] = tc.pts;
    const circ = circleFrom3(a, b, c);
    if (!circ) {
      toast('Punkte sind kollinear');
      runtime.toolCtx = { step: 'p1', pts: [] };
      setPrompt('Erster Punkt auf Kreis');
      render();
      return;
    }
    addEntity({ type: 'circle', cx: circ.cx, cy: circ.cy, r: circ.r, layer: state.activeLayer });
    runtime.toolCtx = { step: 'p1', pts: [] };
    setPrompt('Erster Punkt auf Kreis');
  }
  render();
}

/**
 * Arc from start→through→end. Sweep direction (CCW vs CW) is determined so
 * the `through` point lies on the resulting arc. Stored with a1 < a2 (CCW sweep);
 * if the natural sweep is CW, start/end are swapped.
 */
function arcFrom3(a: Pt, mid: Pt, c: Pt): { cx: number; cy: number; r: number; a1: number; a2: number } | null {
  const circ = circleFrom3(a, mid, c);
  if (!circ) return null;
  const angA = Math.atan2(a.y - circ.cy, a.x - circ.cx);
  const angM = Math.atan2(mid.y - circ.cy, mid.x - circ.cx);
  const angC = Math.atan2(c.y - circ.cy, c.x - circ.cx);
  // Try CCW sweep from A to C; check if M lies within it
  let a1 = angA, a2 = angC;
  while (a2 < a1) a2 += 2 * Math.PI;
  const mCcw = ((angM - a1) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
  if (mCcw < a2 - a1) {
    return { cx: circ.cx, cy: circ.cy, r: circ.r, a1, a2 };
  }
  // Otherwise CCW sweep from C to A contains M
  a1 = angC; a2 = angA;
  while (a2 < a1) a2 += 2 * Math.PI;
  return { cx: circ.cx, cy: circ.cy, r: circ.r, a1, a2 };
}

/**
 * Bogen-Tool, "Sehne + Bogenhöhe" (Sagitta) Workflow:
 *   1) Start anklicken
 *   2) Ende anklicken     → die Sehne steht fest
 *   3) Maus ziehen         → Bogen bläst sich perpendikular zur Sehne auf,
 *      klicken ODER Höhe eintippen → committen.
 *
 * Intern wird aus Sehne + signierter Höhe `h` ein Durchgangspunkt am
 * Scheitelpunkt konstruiert und `arcFrom3(start, scheitel, ende)` liefert
 * Kreismittelpunkt, Radius und Winkelintervall.
 */
function handleArc3Click(p: Pt): void {
  const tc = runtime.toolCtx;
  if (!tc) return;
  if (!tc.pts) tc.pts = [];

  if (tc.pts.length === 0) {
    tc.pts.push(p);
    tc.step = 'p2';
    setPrompt('Endpunkt des Bogens');
  } else if (tc.pts.length === 1) {
    tc.pts.push(p);
    tc.step = 'bulge';
    setPrompt('Bogen auf eine Seite ziehen · oder Höhe eingeben');
  } else {
    // Dritter Klick committet mit cursor-bestimmter Höhe.
    const [a, b] = tc.pts;
    const arc = arcFromChordBulgePoint(a, b, p);
    if (!arc) {
      toast('Bogenhöhe zu klein — Seite wählen');
      return;
    }
    addEntity({ type: 'arc', cx: arc.cx, cy: arc.cy, r: arc.r, a1: arc.a1, a2: arc.a2, layer: state.activeLayer });
    runtime.toolCtx = { step: 'p1', pts: [] };
    setPrompt('Startpunkt des Bogens');
  }
  render();
}

/**
 * Gemeinsame Berechnung für Click-Commit und Preview:
 * Bestimmt den perpendikularen Offset des Punkts `cursor` zur Sehne a→b und
 * liefert den Bogen durch (a, Scheitel, b). Gibt null zurück wenn der Bogen
 * degeneriert wäre (Sehne zu kurz / Cursor fast auf der Sehne).
 */
function arcFromChordBulgePoint(
  a: Pt, b: Pt, cursor: Pt,
): { cx: number; cy: number; r: number; a1: number; a2: number } | null {
  const dx = b.x - a.x, dy = b.y - a.y;
  const L = Math.hypot(dx, dy);
  if (L < 1e-9) return null;
  const nx = -dy / L, ny = dx / L;
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  const h = (cursor.x - mx) * nx + (cursor.y - my) * ny;
  return arcFromChordBulge(a, b, h);
}

/** Wie oben, aber mit direkt angegebener signierter Bogenhöhe h. */
function arcFromChordBulge(
  a: Pt, b: Pt, h: number,
): { cx: number; cy: number; r: number; a1: number; a2: number } | null {
  if (Math.abs(h) < 1e-6) return null;
  const dx = b.x - a.x, dy = b.y - a.y;
  const L = Math.hypot(dx, dy);
  if (L < 1e-9) return null;
  const nx = -dy / L, ny = dx / L;
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  const apex: Pt = { x: mx + nx * h, y: my + ny * h };
  return arcFrom3(a, apex, b);
}

/** Für cmdbar: committet mit eingetippter Höhe (Betrag) · Vorzeichen aus dem
 *  zuletzt beobachteten Cursor-Side (tc.bulgeSide). Negatives Input kehrt die
 *  Seite explizit um — so kann der Nutzer die Seite auch via Tastatur wählen. */
export function commitArcBulge(tc: ToolCtx, h: number): void {
  if (!tc.pts || tc.pts.length !== 2) return;
  if (!isFinite(h) || Math.abs(h) < 1e-6) { toast('Höhe eingeben'); return; }
  const [a, b] = tc.pts;
  const side = tc.bulgeSide ?? 1;
  // Der Nutzer tippt i.d.R. einen positiven Betrag (die Seite steht durch
  // cursor bereits fest). Negativ → andere Seite.
  const signedH = h * side;
  const arc = arcFromChordBulge(a, b, signedH);
  if (!arc) { toast('Bogen ungültig'); return; }
  addEntity({ type: 'arc', cx: arc.cx, cy: arc.cy, r: arc.r, a1: arc.a1, a2: arc.a2, layer: state.activeLayer });
  runtime.toolCtx = { step: 'p1', pts: [] };
  setPrompt('Startpunkt des Bogens');
  render();
}

// ---------------- Ellipse ----------------

function handleEllipseClick(p: Pt): void {
  const tc = runtime.toolCtx;
  if (!tc || tc.step === 'center') {
    runtime.toolCtx = { step: 'axis1', centerPt: p };
    setPrompt('Ende der ersten Halbachse');
    render();
    return;
  }
  if (tc.step === 'axis1' && tc.centerPt) {
    const c = tc.centerPt;
    // Wenn der Nutzer zuvor per cmdbar nur einen Winkel eingegeben hat, ist die
    // Richtung gesperrt — den Klick dann auf die gesperrte Achse projizieren,
    // damit genau in dieser Richtung gearbeitet wird (analog zu Linie/Polylinie).
    let endPt = p;
    let rot: number;
    let rx: number;
    if (tc.lockedDir) {
      const v = sub(p, c);
      const d = dot(v, tc.lockedDir);
      if (Math.abs(d) < 1e-6) return;
      // Vorzeichen der Projektion erhalten, damit der Nutzer auch "rückwärts"
      // an der Achse entlang klicken könnte; Länge ist der Betrag.
      const signedDir = d >= 0 ? tc.lockedDir : { x: -tc.lockedDir.x, y: -tc.lockedDir.y };
      rx = Math.abs(d);
      endPt = add(c, scale(signedDir, rx));
      rot = Math.atan2(signedDir.y, signedDir.x);
    } else {
      const dx = p.x - c.x, dy = p.y - c.y;
      rx = Math.hypot(dx, dy);
      if (rx < 1e-6) return;
      rot = Math.atan2(dy, dx);
    }
    runtime.toolCtx = { step: 'axis2', centerPt: c, a1: endPt, angleDeg: rot, radius: rx };
    setPrompt('Länge der zweiten Halbachse');
    render();
    return;
  }
  if (tc.step === 'axis2' && tc.centerPt && tc.a1 && tc.radius != null && tc.angleDeg != null) {
    const c = tc.centerPt;
    // Perpendicular distance from cursor to first axis = ry
    const rot = tc.angleDeg;
    const nx = -Math.sin(rot), ny = Math.cos(rot);
    const ry = Math.abs((p.x - c.x) * nx + (p.y - c.y) * ny);
    if (ry < 1e-6) return;
    addEntity({ type: 'ellipse', cx: c.x, cy: c.y, rx: tc.radius, ry, rot, layer: state.activeLayer });
    runtime.toolCtx = { step: 'center' };
    setPrompt('Mittelpunkt der Ellipse');
    render();
  }
}

// ---------------- Spline ----------------

function handleSplineClick(p: Pt): void {
  const tc = runtime.toolCtx;
  if (!tc) return;
  if (!tc.pts) tc.pts = [];
  tc.pts.push(p);
  setPrompt(tc.pts.length === 1 ? 'Nächster Stützpunkt' : 'Nächster Stützpunkt (Enter beendet)');
  render();
}

export function finishSpline(closed: boolean): void {
  const tc = runtime.toolCtx;
  if (tc && tc.pts && tc.pts.length >= 2) {
    addEntity({
      type: 'spline',
      pts: [...tc.pts],
      closed: !!closed,
      layer: state.activeLayer,
    });
  }
  runtime.toolCtx = { step: 'p1', pts: [] };
  setPrompt('Erster Punkt der Spline');
  render();
}

// ---------------- Stretch ----------------

function isPtInBox(p: Pt, a: Pt, b: Pt): boolean {
  const xmin = Math.min(a.x, b.x), xmax = Math.max(a.x, b.x);
  const ymin = Math.min(a.y, b.y), ymax = Math.max(a.y, b.y);
  return p.x >= xmin && p.x <= xmax && p.y >= ymin && p.y <= ymax;
}

/**
 * Apply delta to every vertex of `e` that falls inside the crossing box [w1,w2].
 * Vertices outside stay put. For rect, promotes to polyline if only one corner
 * is inside (otherwise stays a rect).
 */
function stretchEntity(e: Entity, w1: Pt, w2: Pt, delta: Pt): Entity | null {
  const shift = (p: Pt) => isPtInBox(p, w1, w2) ? { x: p.x + delta.x, y: p.y + delta.y } : p;
  if (e.type === 'line') {
    const p1 = shift({ x: e.x1, y: e.y1 });
    const p2 = shift({ x: e.x2, y: e.y2 });
    return { ...e, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y };
  }
  if (e.type === 'polyline') {
    const pts = e.pts.map(shift);
    return { ...e, pts };
  }
  if (e.type === 'rect') {
    const c1 = { x: e.x1, y: e.y1 };
    const c2 = { x: e.x2, y: e.y1 };
    const c3 = { x: e.x2, y: e.y2 };
    const c4 = { x: e.x1, y: e.y2 };
    const corners = [c1, c2, c3, c4];
    const moved = corners.map(c => isPtInBox(c, w1, w2));
    const movedCount = moved.filter(Boolean).length;
    if (movedCount === 0) return e;
    if (movedCount === 4) {
      return { ...e, x1: e.x1 + delta.x, y1: e.y1 + delta.y, x2: e.x2 + delta.x, y2: e.y2 + delta.y };
    }
    // Partial: promote to polyline
    const shifted = corners.map(shift);
    return {
      id: e.id,
      layer: e.layer,
      type: 'polyline',
      pts: shifted,
      closed: true,
    };
  }
  if (e.type === 'text') {
    const p = shift({ x: e.x, y: e.y });
    return { ...e, x: p.x, y: p.y };
  }
  if (e.type === 'dim') {
    const p1 = shift(e.p1);
    const p2 = shift(e.p2);
    return { ...e, p1, p2 };
  }
  // Circle, arc, xline: translate whole entity if center/base is inside the box
  if (e.type === 'circle') {
    const c = shift({ x: e.cx, y: e.cy });
    return { ...e, cx: c.x, cy: c.y };
  }
  if (e.type === 'arc') {
    const c = shift({ x: e.cx, y: e.cy });
    return { ...e, cx: c.x, cy: c.y };
  }
  if (e.type === 'xline') {
    const b = shift({ x: e.x1, y: e.y1 });
    return { ...e, x1: b.x, y1: b.y };
  }
  return e;
}

/**
 * Called by main.ts when the stretch tool's drag-select ends. The box goes
 * into click1/click2; we advance to the 'base' step. We deliberately do NOT
 * touch state.selection — the box is a crossing region, not an entity picker.
 */
export function setStretchBox(a: Pt, b: Pt): void {
  runtime.toolCtx = { step: 'base', click1: a, click2: b };
  setPrompt('Basispunkt wählen');
  render();
}

function handleStretchClick(p: Pt, _worldPt: Pt): void {
  const tc = runtime.toolCtx;
  if (!tc) return;
  // 'pickbox' is consumed by the main.ts mousedown/mouseup wiring; a plain
  // click at this step is a no-op (user probably clicked instead of dragging).
  if (tc.step === 'pickbox') {
    toast('Bereich aufziehen (klicken und ziehen)');
    return;
  }
  if (tc.step === 'base' && tc.click1 && tc.click2) {
    runtime.toolCtx = {
      step: 'direction',
      click1: tc.click1, click2: tc.click2, basePt: p,
      lockedDir: null,
    };
    setPrompt('Richtung klicken oder Winkel eingeben');
    render();
    return;
  }
  if (tc.step === 'direction' && tc.click1 && tc.click2 && tc.basePt) {
    const snappedPt = maybeOrtho(tc.basePt, p);
    const v = sub(snappedPt, tc.basePt);
    if (len(v) < 1e-9) { toast('Andere Richtung klicken oder Winkel eingeben'); return; }
    runtime.toolCtx = {
      ...tc,
      step: 'distance',
      lockedDir: norm(v),
    };
    setPrompt('Abstand klicken oder eingeben');
    render();
    return;
  }
  if (tc.step === 'distance' && tc.click1 && tc.click2 && tc.basePt) {
    // Click = project cursor onto locked direction (dragging beyond the base
    // along the locked line). Typing the distance goes through
    // commitStretchDistance in cmdbar.ts.
    let target: Pt;
    if (tc.lockedDir) {
      const v = sub(p, tc.basePt);
      const d = dot(v, tc.lockedDir);
      if (Math.abs(d) < 1e-9) { toast('Kein Versatz in Richtung'); return; }
      target = add(tc.basePt, scale(tc.lockedDir, d));
    } else {
      target = maybeOrtho(tc.basePt, p);
    }
    applyStretchTarget(tc, target);
    return;
  }
  // Backward-compat: legacy 'target' step (unused by the new flow, but kept in
  // case external callers still dispatch to it).
  if (tc.step === 'target' && tc.click1 && tc.click2 && tc.basePt) {
    applyStretchTarget(tc, maybeOrtho(tc.basePt, p));
    return;
  }
}

/**
 * Commit the stretch: move all endpoints inside the crossing box by
 * `target - basePt`. Shared by click-commit and cmdbar-typed-distance.
 */
export function applyStretchTarget(tc: ToolCtx, target: Pt): void {
  if (!tc.click1 || !tc.click2 || !tc.basePt) return;
  const delta = sub(target, tc.basePt);
  if (len(delta) < 1e-9) { toast('Kein Versatz'); return; }
  pushUndo();
  const w1 = tc.click1, w2 = tc.click2;
  const snapshot = [...state.entities];
  for (const e of snapshot) {
    const replaced = stretchEntity(e, w1, w2, delta);
    if (!replaced || replaced === e) continue;
    const fid = featureForEntity(e.id)?.id;
    if (!fid) continue;
    if (replaced.type === e.type) {
      replaceFeatureFromInit(fid, entityInit(replaced));
    } else {
      state.features = state.features.filter(f => f.id !== fid);
      state.features.push(featureFromEntityInit(entityInit(replaced)));
    }
  }
  evaluateTimeline();
  runtime.toolCtx = { step: 'pickbox' };
  setPrompt('Bereich aufziehen (Drag-Select)');
  render();
}

function handleXLineClick(p: Pt, worldPt: Pt): void {
  const tc = runtime.toolCtx;
  if (!tc || tc.step === 'ref') {
    const snap = runtime.lastSnap;
    // `axis` snaps are just cursor→axis projections — they should not take
    // precedence over treating the axis itself as a reference for parallels.
    if (snap && (snap.type === 'end' || snap.type === 'mid' ||
                 snap.type === 'int' || snap.type === 'center')) {
      // Capture the parametric ref to the anchor point so the xline through
      // it tracks the anchor's feature under variable changes. Without this,
      // `makeXLineThrough` would bake the world-space coords into an abs
      // entity and the helper line would stay frozen when upstream params
      // moved the corner/mid/intersection/center it was drawn from.
      const p1Ref = snapToPointRef(snap, p);
      runtime.toolCtx = { step: 'angle-pt', p1: p, p1Ref };
      setPrompt('Winkel 0-90° eingeben oder Richtung klicken');
      render();
      return;
    }
    const ref = pickReference(worldPt);
    if (!ref) {
      toast('Linie, Achse, Rechteck-Kante oder Polylinien-Segment wählen');
      return;
    }
    runtime.toolCtx = { step: 'dist', dir: ref.dir, base: ref.base, ref: ref.entity };
    setPrompt('Abstand eingeben oder Seite klicken');
  } else if (tc.step === 'angle-pt' && tc.p1) {
    const v = sub(p, tc.p1);
    if (len(v) < 1e-9) { toast('Andere Richtung klicken oder Winkel eingeben'); return; }
    makeXLineThroughRef(tc.p1Ref ?? null, tc.p1, norm(v));
    runtime.toolCtx = { step: 'ref' };
    setPrompt('Referenzlinie wählen');
  } else if (tc.step === 'dist' && tc.dir && tc.base) {
    const off = perpOffset(tc.base, tc.dir, p);
    if (Math.abs(off.dist) < 1e-6) return;
    // Virtual origin axis → dedicated axisParallelXLine feature so the
    // distance Expr (constant here, but still a feature-level value) stays
    // editable and consistent with the cmdbar path that accepts variables.
    if (tc.ref && '_axis' in tc.ref) {
      makeAxisParallelXLine(tc.ref._axis, numE(Math.abs(off.dist)), off.sign);
    } else {
      makeParallelXLine(tc.base, tc.dir, numE(Math.abs(off.dist)), off.sign, tc.ref);
    }
    runtime.toolCtx = { step: 'ref' };
    setPrompt('Referenzlinie wählen');
  }
  render();
}

/**
 * "Linie mit Hilfslinien teilen" — ask the user for N first, then on each
 * line-click emit N-1 perpendicular xlines on the Hilfslinien-Layer that
 * divide the line into N equal segments. The xlines are abs (unlinked); the
 * source line is untouched. The count is sticky: once set, the user can keep
 * clicking lines and each one is divided by the same N until the tool is
 * exited or the count is re-entered (Enter re-opens the input).
 */
function handleDivideXLineClick(worldPt: Pt): void {
  const tc = runtime.toolCtx;
  if (!tc) return;
  if (tc.step === 'count') {
    // Count not yet set — nudge the user toward the top panel and refocus
    // its input so a keystroke goes into the field. Clicking a line is a
    // no-op until the count has been committed.
    toast('Erst Anzahl eingeben (Panel oben)');
    const el = document.getElementById('divide-count') as HTMLInputElement | null;
    if (el) { el.focus(); el.select(); }
    return;
  }
  if (tc.step === 'pick') {
    const hit = hitTest(worldPt);
    if (!hit) { toast('Bitte eine Linie, Kreis, Ellipse oder Bogen anklicken'); return; }
    const n = tc.radius != null ? tc.radius : 0;  // reusing numeric slot for count
    if (!Number.isInteger(n) || n < 2) { toast('Anzahl nicht gesetzt'); return; }
    if (hit.type === 'line')         applyDivideXLine(hit, n);
    else if (hit.type === 'circle')  applyDivideCircleXLines(hit, n);
    else if (hit.type === 'arc')     applyDivideArcXLines(hit, n);
    else if (hit.type === 'ellipse') applyDivideEllipseXLines(hit, n);
    else toast('Nur Linie, Kreis, Ellipse oder Bogen teilbar');
    return;
  }
}

/**
 * Emit n-1 perpendicular xlines that divide the given line into n equal
 * segments. All emitted under a single undo step.
 */
function applyDivideXLine(l: LineEntity, n: number): void {
  if (!Number.isInteger(n) || n < 2 || n > 200) {
    toast('Anzahl 2-200'); return;
  }
  // Persist the N used for this operation so the next activation defaults
  // to it (matches fillet/chamfer's "remember last" behaviour).
  lastDivideCount = n;
  const dx = l.x2 - l.x1, dy = l.y2 - l.y1;
  const L = Math.hypot(dx, dy);
  if (L < 1e-9) { toast('Linie zu kurz'); return; }
  const ux = dx / L, uy = dy / L;
  // Perpendicular direction for the xline — any non-colinear direction works
  // (an xline extends both ways), so we just take the left-normal.
  const nx = -uy, ny = ux;
  const layer = hilfslinieLayer();
  pushUndo();
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const px = l.x1 + dx * t;
    const py = l.y1 + dy * t;
    state.features.push({
      id: newFeatureId(),
      kind: 'xline',
      layer,
      p: { kind: 'abs', x: numE(px), y: numE(py) },
      dx: numE(nx),
      dy: numE(ny),
    });
  }
  evaluateTimeline();
  updateStats();
  render();
}

/**
 * Emit N radial xlines around a full circle at equal angular intervals. The
 * xlines pass through the circle centre and a division point on the circle
 * (so each one marks a pie-slice boundary). Unlike the line case there's no
 * "internal" vs "endpoint" distinction on a closed curve — all N points
 * contribute an xline. Note that diametrically opposite points produce the
 * same xline (an xline extends both ways), so for even N the user gets N/2
 * distinct lines; we still emit N entries because the duplicates are cheap
 * and deleting half would surprise on odd N where they're all distinct.
 */
function applyDivideCircleXLines(c: CircleEntity, n: number): void {
  if (!Number.isInteger(n) || n < 2 || n > 200) { toast('Anzahl 2-200'); return; }
  lastDivideCount = n;
  if (c.r < 1e-9) { toast('Kreis zu klein'); return; }
  const layer = hilfslinieLayer();
  pushUndo();
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const dx = Math.cos(a), dy = Math.sin(a);
    state.features.push({
      id: newFeatureId(),
      kind: 'xline',
      layer,
      // Anchor at the centre — the xline then points through the i-th division
      // point on the circumference along (dx, dy).
      p: { kind: 'abs', x: numE(c.cx), y: numE(c.cy) },
      dx: numE(dx),
      dy: numE(dy),
    });
  }
  evaluateTimeline();
  updateStats();
  render();
}

/**
 * Emit N-1 radial xlines that divide an arc into N equal-angle segments.
 * Arcs have endpoints (a1, a2), so like the line case we emit only the
 * internal division points — the endpoints are already on screen. Direction
 * respects the arc's sweep (a1 → a2 in its stored order; handled by
 * normalising the sweep to [0, 2π)).
 */
function applyDivideArcXLines(a: ArcEntity, n: number): void {
  if (!Number.isInteger(n) || n < 2 || n > 200) { toast('Anzahl 2-200'); return; }
  lastDivideCount = n;
  if (a.r < 1e-9) { toast('Bogen zu klein'); return; }
  // Canonicalise sweep as in rendering: go CCW from a1, wrap to +2π when a2
  // lies on the other side. Matches how ArcEntity arcs are drawn throughout.
  let sweep = a.a2 - a.a1;
  while (sweep <= 0) sweep += Math.PI * 2;
  if (sweep > Math.PI * 2) sweep -= Math.PI * 2;
  const layer = hilfslinieLayer();
  pushUndo();
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const ang = a.a1 + sweep * t;
    const dx = Math.cos(ang), dy = Math.sin(ang);
    state.features.push({
      id: newFeatureId(),
      kind: 'xline',
      layer,
      p: { kind: 'abs', x: numE(a.cx), y: numE(a.cy) },
      dx: numE(dx),
      dy: numE(dy),
    });
  }
  evaluateTimeline();
  updateStats();
  render();
}

/**
 * Emit N radial xlines around an ellipse. Division is in parameter space
 * (equal Δt of 2π/N), not arc length — matching typical CAD "equal division"
 * behaviour on ellipses. Each xline anchors at the ellipse centre and points
 * toward the i-th parametric point, so it's effectively a radial construction
 * line through the centre (rotated by the ellipse's own `rot`).
 */
function applyDivideEllipseXLines(e: EllipseEntity, n: number): void {
  if (!Number.isInteger(n) || n < 2 || n > 200) { toast('Anzahl 2-200'); return; }
  lastDivideCount = n;
  if (e.rx < 1e-9 || e.ry < 1e-9) { toast('Ellipse zu klein'); return; }
  const cos = Math.cos(e.rot), sin = Math.sin(e.rot);
  const layer = hilfslinieLayer();
  pushUndo();
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    // Local ellipse point, then rotate into world frame. Anchor on centre so
    // the xline direction is from centre toward the division point.
    const lx = Math.cos(t) * e.rx;
    const ly = Math.sin(t) * e.ry;
    const dx = lx * cos - ly * sin;
    const dy = lx * sin + ly * cos;
    const L = Math.hypot(dx, dy);
    if (L < 1e-9) continue;
    state.features.push({
      id: newFeatureId(),
      kind: 'xline',
      layer,
      p: { kind: 'abs', x: numE(e.cx), y: numE(e.cy) },
      dx: numE(dx / L),
      dy: numE(dy / L),
    });
  }
  evaluateTimeline();
  updateStats();
  render();
}

/**
 * cmdbar entry: stash the count in toolCtx and advance to 'pick'. The count
 * is stored in `tc.radius` (the generic numeric slot on ToolCtx — we reuse it
 * here to avoid bloating the context type with a one-off field).
 */
export function commitDivideXLine(_tc: ToolCtx, n: number): number {
  if (!Number.isInteger(n) || n < 2) { toast('Anzahl ≥ 2'); return 0; }
  lastDivideCount = n;
  runtime.toolCtx = { step: 'pick', radius: n };
  setPrompt(`Objekt wählen (N=${n}) · Enter = Anzahl ändern`);
  toast(`N = ${n}`);
  render();
  return n;
}

/**
 * Send focus to the top-docked divide-picker count input and (optionally)
 * rewind the tool to its 'count' step. Used by both the cmdbar's bareEnter
 * handler (Enter at 'pick' → user wants to change N) and the ui.ts picker-
 * sync path (tool activation → focus the input so the user can just start
 * typing). No modal is involved; the field lives at the top of the canvas.
 */
export function promptDivideCount(): void {
  // Rewind to the count step if we're somewhere else — matches the old
  // modal's "reopen the count input" semantics. Carry over the current
  // count (or fall back to the sticky last value) so the input shows a
  // sensible starting value instead of a blank field.
  if (!runtime.toolCtx || runtime.toolCtx.step !== 'count') {
    const carry = runtime.toolCtx?.radius ?? lastDivideCount;
    runtime.toolCtx = { step: 'count', radius: carry };
    setPrompt('Anzahl Teile eingeben (oben) · dann Objekt anklicken');
  }
  // Defer focus to the next frame — the picker unhides via syncDividePicker
  // on state change, and focusing a hidden input silently no-ops.
  requestAnimationFrame(() => {
    const el = document.getElementById('divide-count') as HTMLInputElement | null;
    if (el) { el.focus(); el.select(); }
  });
  render();
}

function handleOffsetClick(p: Pt, worldPt: Pt): void {
  const tc = runtime.toolCtx;
  if (!tc) return;

  // Pick step: add/remove entities from the selection set (same UX as
  // move/copy). Enter (handleBareEnter) advances to 'side'.
  if (tc.step === 'pick') {
    const hit = hitTest(worldPt);
    if (hit) {
      if (state.selection.has(hit.id)) state.selection.delete(hit.id);
      else state.selection.add(hit.id);
      updateSelStatus();
      render();
    }
    return;
  }

  // Side step: cursor position decides inside/outside for each selected
  // entity independently (each entity's own sign via offsetInfo), while the
  // distance is the typed value or — falling back — the distance to the
  // entity currently nearest the cursor. Clicking commits one offset per
  // selected entity, all under a single undo.
  if (tc.step === 'side' && tc.entities && tc.entities.length > 0) {
    applyGroupOffsetAt(p);
  }
}

/**
 * Commit the group offset using `p` as the "which side" cursor position.
 * Called both from the mouse-click handler and from the cmdbar (Enter after
 * typing a distance — no click needed, we just reuse the current mouse
 * position to decide inside vs outside).
 */
export function applyGroupOffsetAt(p: Pt): void {
  const tc = runtime.toolCtx;
  if (!tc || tc.step !== 'side' || !tc.entities || tc.entities.length === 0) return;
  const shapes = computeGroupOffsetShapes(tc.entities, p, tc.distance);
  if (!shapes || shapes.length === 0) return;
  pushUndo();
  for (const { shape, layer } of shapes) {
    state.features.push(
      featureFromEntityInit({ ...shape, layer } as EntityInit),
    );
  }
  evaluateTimeline();
  updateStats();
  // Keep selection + entities so the user can immediately apply another
  // offset on the same source without re-selecting. Reset distance so the
  // next Enter recomputes from the cursor unless a new value is typed.
  if (runtime.toolCtx) {
    runtime.toolCtx.distance = null;
    runtime.toolCtx.step = 'side';
  }
  setPrompt('Abstand eingeben oder Seite klicken');
  render();
}

// ---------------- Linie versetzen ----------------

/**
 * "Linie versetzen" tool — the grown-up counterpart to the group offset. It
 * targets a *single* line and offers three extra degrees of freedom that the
 * plain offset doesn't:
 *
 *   1. Distance *and* angle are configurable. The angle is measured from the
 *      original line's direction: 90° = classic perpendicular offset (same
 *      as the Versatz tool), 45° = diagonal slide-copy, 0° would be a bogus
 *      colinear clone (caller is responsible for stopping that).
 *   2. Two modes via the canvas picker:
 *        • "Linie"     — only the offset line is emitted.
 *        • "Rechteck"  — the offset line plus two connector lines at the
 *                        original endpoints, closing the pair into a
 *                        parallelogram (which *is* a rectangle when angle=90°).
 *   3. The distance expression is preserved: the offset line's endpoints are
 *      polar PointRefs off the source line's endpoints (kind: 'endpoint'),
 *      so changing a parameter the distance depends on keeps the offset live.
 *      The connector lines inherit the same PointRefs on their shared
 *      endpoints, so "Rechteck" mode stays coherent under parameter changes.
 */
function handleLineOffsetClick(p: Pt, worldPt: Pt): void {
  const tc = runtime.toolCtx;
  if (!tc) return;

  if (tc.step === 'pick') {
    const hit = hitTest(worldPt);
    if (!hit || hit.type !== 'line') {
      toast('Bitte eine Linie anklicken');
      return;
    }
    state.selection.clear();
    state.selection.add(hit.id);
    updateSelStatus();
    runtime.toolCtx = {
      step: 'side',
      entity1: hit,
      distance: null,
      angleDeg: 90,  // default = classic perpendicular offset
      distanceExpr: null,
      angleExpr: null,
    };
    setPrompt('Abstand eingeben oder Seite klicken');
    render();
    return;
  }

  if (tc.step === 'side' && tc.entity1 && tc.entity1.type === 'line') {
    const d = tc.distance != null ? tc.distance : perpDistLineToPt(tc.entity1, p);
    if (!(d > 1e-6)) { toast('Abstand zu klein'); return; }
    applyLineOffsetAt(p, d);
  }
}

/**
 * Perpendicular distance from the infinite line to a point. Used as the
 * cursor-driven fallback distance when the user hasn't typed a value — the
 * line "snaps" to the cursor the same way the Versatz tool does.
 */
function perpDistLineToPt(l: LineEntity, p: Pt): number {
  const dx = l.x2 - l.x1, dy = l.y2 - l.y1;
  const L = Math.hypot(dx, dy);
  if (L < 1e-9) return 0;
  return Math.abs((p.x - l.x1) * dy - (p.y - l.y1) * dx) / L;
}

/**
 * Clamp the requested offset distance to the apex of the inward-tilting
 * trapezoid. When both connectors tilt α° inward, they meet at a single
 * point at distance L / (2·sin α) from the source line (L = source line
 * length). Beyond that the connectors cross and the offset line flips to
 * the other side — visually wrong. For α ≤ 0 (rectangle or flared) no
 * clamping is needed because the connectors never converge.
 */
function clampLineOffsetDistance(l: LineEntity, d: number, tiltDeg: number): number {
  if (tiltDeg <= 0) return d;
  const L = Math.hypot(l.x2 - l.x1, l.y2 - l.y1);
  if (L < 1e-9) return d;
  const sinT = Math.sin(tiltDeg * Math.PI / 180);
  if (sinT < 1e-9) return d;
  const apex = L / (2 * sinT);
  return d > apex ? apex : d;
}

/**
 * Compute the sign (+1 / -1) that puts the offset on the same side of the
 * source line as the cursor. "Side" is measured against the line's left
 * normal (perp of line direction). Flipping the sign flips which side.
 */
function sideSignForOffset(l: LineEntity, cursor: Pt): 1 | -1 {
  const dx = l.x2 - l.x1, dy = l.y2 - l.y1;
  const L = Math.hypot(dx, dy);
  if (L < 1e-9) return 1;
  // Cross product gives signed side: positive = left of line (using screen
  // Y, which flips the usual math convention). We return +1 for "left of
  // the line direction", -1 for right. The commit path treats this sign
  // as the multiplier on the offset angle relative to line direction.
  const cross = (cursor.x - l.x1) * dy - (cursor.y - l.y1) * dx;
  return cross >= 0 ? 1 : -1;
}

/**
 * Commit the line-offset using the cursor at `p` to decide the side. Kept
 * separate from `handleLineOffsetClick` so the cmdbar's Enter path can call
 * it directly (no second click required when the user typed a distance).
 */
export function applyLineOffsetAt(p: Pt, distance: number): void {
  const tc = runtime.toolCtx;
  if (!tc || !tc.entity1 || tc.entity1.type !== 'line') return;
  const l = tc.entity1;
  const srcFeat = featureForEntity(l.id);
  const fid = srcFeat?.id;
  if (!fid) return;

  const sign = sideSignForOffset(l, p);
  const lineAngleDeg = Math.atan2(l.y2 - l.y1, l.x2 - l.x1) * 180 / Math.PI;
  // Tilt from perpendicular (new semantics): 0 = rect, positive = connectors
  // lean α° inward toward each other → symmetric trapezoid narrower on the
  // offset side. Only consulted when the "Winkel" toggle is on; otherwise
  // forced to 0 (= perpendicular rectangle).
  const tiltDeg = runtime.lineOffsetUseAngle ? runtime.lineOffsetAngleDeg : 0;

  // Clamp to the apex so the committed geometry mirrors the preview — past
  // the apex the two connectors cross and the offset line flips sides, which
  // looks broken and has no reasonable CAD meaning. If the user typed a
  // distance bigger than the apex, quietly commit at the apex and toast so
  // they know why.
  const clampedDist = clampLineOffsetDistance(l, distance, tiltDeg);
  const wasClamped = clampedDist < distance - 1e-6;
  if (wasClamped) toast(`Abstand auf Spitze begrenzt (${clampedDist.toFixed(2)})`);

  // Base perpendicular on the cursor side is lineAngle − sign·90°. Adding
  // sign·tilt at endpoint 0 rotates that vector toward the line direction
  // (i.e. toward endpoint 1) by the tilt angle; the mirrored expression at
  // endpoint 1 rotates toward endpoint 0 — producing the symmetric trapezoid
  // the user sketched.
  const worldAngle0Deg = lineAngleDeg - sign * (90 - tiltDeg);
  const worldAngle1Deg = lineAngleDeg + 180 + sign * (90 - tiltDeg);

  // Distance expression — preserved if user typed a variable/formula, so the
  // offset tracks the parameter. Falls back to the numeric cursor distance.
  // When the clamp kicked in we drop the Expr and commit numerically: the
  // Expr system has no min() primitive, so keeping the original Expr would
  // re-introduce the flip as soon as the param changes back above apex.
  const distExpr: Expr = wasClamped
    ? numE(clampedDist)
    : (tc.distanceExpr ?? numE(distance));
  const angleExpr0: Expr = numE(worldAngle0Deg);
  const angleExpr1: Expr = numE(worldAngle1Deg);

  // Endpoint refs on the source line — these follow the line itself if the
  // line is parametric, which is the whole point of going through the
  // feature system instead of pushing absolute coords. Only used in the
  // "verknüpft" branch below; the abs branch computes numeric endpoints.
  const endRef0: PointRef = { kind: 'endpoint', feature: fid, end: 0 };
  const endRef1: PointRef = { kind: 'endpoint', feature: fid, end: 1 };
  const newA: PointRef = { kind: 'polar', from: endRef0, angle: angleExpr0, distance: distExpr };
  const newB: PointRef = { kind: 'polar', from: endRef1, angle: angleExpr1, distance: distExpr };

  const mode = runtime.lineOffsetMode;
  // Link when (a) the source is a true `line` feature AND (b) we're in
  // parametric mode. Free-draw mode opts out of all implicit links — the
  // offset should be an independent copy that doesn't track the source.
  //
  // Sub-line entities of polylines/rects share the parent feature id, but
  // `endpoint` PointRefs with end 0/1 resolve to the parent's corners — not
  // the clicked sub-segment's endpoints — so for those we must fall back to
  // absolute geometry regardless of mode. Only pure `line` features have
  // endpoint semantics that match the source segment we picked.
  const linked = !!srcFeat && srcFeat.kind === 'line' && runtime.parametricMode;
  pushUndo();

  if (linked) {
    // Parametric branch — the offset line's endpoints reference the source
    // line's endpoints via polar PointRefs, so moving/rotating/parameter-
    // editing the source updates this offset live.
    state.features.push({
      id: newFeatureId(),
      kind: 'line',
      layer: l.layer,
      p1: newA,
      p2: newB,
    });

    // "Verbinden" mode: two connector lines at the endpoints, closing the
    // pair. Each connector reuses the shared endpoint refs, so all four lines
    // stay consistent under parameter changes.
    if (mode === 'connect') {
      state.features.push({
        id: newFeatureId(),
        kind: 'line',
        layer: l.layer,
        p1: endRef0,
        p2: newA,
      });
      state.features.push({
        id: newFeatureId(),
        kind: 'line',
        layer: l.layer,
        p1: endRef1,
        p2: newB,
      });
    }
  } else {
    // Independent-copy branch — commit the same geometry with *absolute*
    // numeric endpoints. No PointRefs into the source line, so changing the
    // source later leaves this offset untouched. Semantics match the plain
    // Versatz (group offset) tool.
    const a0 = { x: l.x1, y: l.y1 };
    const a1 = { x: l.x2, y: l.y2 };
    const ang0 = worldAngle0Deg * Math.PI / 180;
    const ang1 = worldAngle1Deg * Math.PI / 180;
    const A = { x: a0.x + Math.cos(ang0) * clampedDist, y: a0.y + Math.sin(ang0) * clampedDist };
    const B = { x: a1.x + Math.cos(ang1) * clampedDist, y: a1.y + Math.sin(ang1) * clampedDist };
    // Push features directly (not through addEntity) so all emitted lines
    // sit under the single undo step opened above.
    state.features.push(featureFromEntityInit({
      type: 'line', x1: A.x, y1: A.y, x2: B.x, y2: B.y, layer: l.layer,
    }));
    if (mode === 'connect') {
      state.features.push(featureFromEntityInit({
        type: 'line', x1: a0.x, y1: a0.y, x2: A.x, y2: A.y, layer: l.layer,
      }));
      state.features.push(featureFromEntityInit({
        type: 'line', x1: a1.x, y1: a1.y, x2: B.x, y2: B.y, layer: l.layer,
      }));
    }
  }

  evaluateTimeline();
  updateStats();
  state.selection.clear();
  updateSelStatus();
  runtime.toolCtx = { step: 'pick' };
  setPrompt('Linie wählen');
  render();
}

/**
 * For a group offset, the "reference distance" is the perpendicular distance
 * from the cursor to whichever selected entity is currently nearest. That
 * matches user intuition: dragging the cursor toward the selection shrinks
 * the offset, pulling away from it grows the offset, regardless of how many
 * entities are selected.
 */
function nearestOffsetInfo(ents: Entity[], p: Pt): { dist: number; sign: 1 | -1 } | null {
  let best: { dist: number; sign: 1 | -1 } | null = null;
  for (const e of ents) {
    const info = offsetInfo(e, p);
    if (!info) continue;
    if (!best || info.dist < best.dist) best = info;
  }
  return best;
}

/**
 * Core of the group offset: produces the offset EntityShapes that should
 * become previews (and, on commit, features). Handles two regimes:
 *
 *   1. All selected entities are lines that chain into a closed polygon
 *      (typical case: the four lines of a rectangle). We then offset the
 *      polygon as a whole and re-split it back into line shapes. This is the
 *      only way to get a clean parallel rectangle — independent per-line
 *      offsets would use each line's own cursor-side sign, which for an
 *      enclosing cursor makes opposite edges shift in opposite directions
 *      and the rectangle falls apart.
 *
 *   2. Otherwise, fall back to independent per-entity offset with the
 *      per-entity cursor-side sign from `offsetInfo`. Correct for open
 *      shapes, arcs/circles, mixed selections, etc.
 */
function computeGroupOffsetShapes(
  ents: Entity[], p: Pt, typedDist: number | null | undefined,
): Array<{ shape: EntityShape; layer: number }> | null {
  const nearest = nearestOffsetInfo(ents, p);
  if (!nearest) return null;
  const d = typedDist != null ? typedDist : nearest.dist;
  if (d < 1e-6) return null;

  // Try to chain selected lines into a closed polygon.
  const chain = chainLinesToPolygon(ents);
  if (chain) {
    const layer = (ents[0] as Entity).layer;
    const inside = pointInPolygon(p, chain);
    const orient = signedArea(chain) >= 0 ? 1 : -1;
    // `inside ? orient : -orient` — see offsetPolyline header for why this
    // sign convention consistently moves each edge inward vs outward
    // regardless of polygon orientation (CCW/CW).
    const sign = (inside ? orient : -orient) as 1 | -1;
    const off = offsetPolyline(chain, d * sign, true);
    if (off && off.length === chain.length) {
      return off.map((a, i) => {
        const b = off[(i + 1) % off.length];
        return {
          shape: { type: 'line', x1: a.x, y1: a.y, x2: b.x, y2: b.y } as EntityShape,
          layer,
        };
      });
    }
    // Offset collapsed (e.g. inward offset larger than half-width) — bail out.
    return null;
  }

  // Fallback: independent per-entity offset.
  const out: Array<{ shape: EntityShape; layer: number }> = [];
  for (const e of ents) {
    const info = offsetInfo(e, p);
    if (!info) continue;
    const shape = makeOffsetPreview(e, d, info.sign);
    if (shape) out.push({ shape, layer: e.layer });
  }
  return out;
}

/**
 * If every selected entity is a line and the lines form a single closed
 * loop (each endpoint shared with exactly one neighbour, chain returns to
 * start), return the ordered polygon vertices. Returns `null` for any other
 * configuration (open chain, disjoint islands, non-line entities, < 3 lines).
 */
function chainLinesToPolygon(ents: Entity[]): Pt[] | null {
  if (ents.length < 3) return null;
  const lines = ents.filter((e): e is Extract<Entity, { type: 'line' }> => e.type === 'line');
  if (lines.length !== ents.length) return null;

  const EPS = 1e-6;
  const eq = (a: Pt, b: Pt) => Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS;

  const used = new Set<number>();
  used.add(0);
  const polygon: Pt[] = [
    { x: lines[0].x1, y: lines[0].y1 },
    { x: lines[0].x2, y: lines[0].y2 },
  ];

  while (used.size < lines.length) {
    const tail = polygon[polygon.length - 1];
    let found = false;
    for (let i = 0; i < lines.length; i++) {
      if (used.has(i)) continue;
      const L = lines[i];
      const a = { x: L.x1, y: L.y1 };
      const b = { x: L.x2, y: L.y2 };
      if (eq(a, tail))      { polygon.push(b); used.add(i); found = true; break; }
      else if (eq(b, tail)) { polygon.push(a); used.add(i); found = true; break; }
    }
    if (!found) return null;
  }

  // Closed loop: last vertex must meet first.
  if (!eq(polygon[polygon.length - 1], polygon[0])) return null;
  polygon.pop();
  return polygon;
}

function signedArea(pts: Pt[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

function handleMoveCopyClick(p: Pt, worldPt: Pt, isCopy: boolean, shiftKey = false): void {
  const tc = runtime.toolCtx;
  if (!tc) return;
  if (tc.step === 'pick') {
    const hit = hitTest(worldPt);
    if (hit) state.selection.add(hit.id);
    updateSelStatus();
    render();
    return;
  }
  if (tc.step === 'base') {
    tc.basePt = p;
    // Capture the parametric ref to the base click too — the copy's offset
    // vector is stored as (basePtRef, targetRef), so when either side snaps
    // to feature geometry (END/MITTE/SCHN/ZENTR), the offset follows that
    // geometry under variable changes.
    tc.basePtRef = snapToPointRef(runtime.lastSnap, p);
    tc.step = 'target';
    setPrompt(isCopy ? 'Zielpunkt (mehrfach möglich)' : 'Zielpunkt · Shift = Kopie');
    updatePreview();
    render();
    return;
  }
  if (tc.step === 'target' && tc.basePt) {
    const target = maybeOrtho(tc.basePt, p);
    const delta = sub(target, tc.basePt);
    const copy = isCopy || shiftKey;
    // Parametric target ref for the same reason as basePtRef above. When
    // ortho altered the cursor, snap-ref doesn't apply — pass null and the
    // array feature stores the (ortho-snapped) abs coord.
    const targetRef = snapToPointRef(target === p ? runtime.lastSnap : null, target);
    // Parametric copy path: create an ArrayFeature that references the source
    // features, so later variable edits propagate into the copies. Used for
    // linear (single-copy) and matrix copies alike. Falls back to the flatten
    // transformSelection path for pure-move (no parametric link to preserve).
    if (copy && tryCreateArrayFeature([...state.selection], tc.basePt, target,
        isCopy ? runtime.copyCols : 1,
        isCopy ? runtime.copyRows : 1,
        tc.basePtRef ?? null, targetRef)) {
      // handled — selection now includes freshly added array copies
    } else if (isCopy && (runtime.copyCols > 1 || runtime.copyRows > 1)) {
      applyMatrixCopy(delta, runtime.copyCols, runtime.copyRows);
    } else {
      transformSelection(pt => add(pt, delta), { copy, pureTranslation: true });
    }
    if (isCopy) {
      setPrompt('Zielpunkt (Rechtsklick beendet)');
    } else {
      // Keep the now-moved/copied entities selected so the user can chain
      // another modifier on them without having to re-select.
      runtime.toolCtx = { step: 'base' };
      setPrompt('Basispunkt · Shift = Kopie');
    }
    render();
  }
}

/**
 * Try to create a parametric ArrayFeature referencing the current selection.
 * Returns true on success, false when no source entity is eligible (e.g. user
 * selected only text/dim/hatch, which the modifier can't translate yet). The
 * caller then falls back to flatten-copy.
 *
 * `cols` / `rows` count the source cell too — same convention as
 * `applyMatrixCopy` so a 1×1 matrix is a no-op and a 2×1 is "add one copy".
 */
function tryCreateArrayFeature(
  entityIds: number[], basePt: Pt, targetPt: Pt,
  cols: number, rows: number,
  basePtRef?: PointRef | null, targetPtRef?: PointRef | null,
): boolean {
  const nc = Math.max(1, Math.floor(cols));
  const nr = Math.max(1, Math.floor(rows));
  if (nc === 1 && nr === 1) return false;   // nothing to copy
  const sourceFids: string[] = [];
  for (const id of entityIds) {
    const ent = state.entities.find(e => e.id === id);
    if (!ent) continue;
    if (ent.type === 'text' || ent.type === 'dim' || ent.type === 'hatch') continue;
    const feat = featureForEntity(id);
    if (!feat) continue;
    if (feat.kind === 'mirror' || feat.kind === 'array' || feat.kind === 'rotate' || feat.kind === 'crossMirror') continue;
    sourceFids.push(feat.id);
  }
  if (!sourceFids.length) return false;
  pushUndo();
  const arrFid = newFeatureId();
  // Use the parametric refs when the user snapped either endpoint of the
  // offset vector to feature geometry (END/MITTE/SCHN/ZENTR). The array
  // feature's offset = target − base is then re-evaluated every timeline
  // tick, so the copies translate with the anchor when upstream variables
  // move. Falls back to abs for free-point clicks — matches user intuition
  // ("only the snapped anchor stays linked").
  const p1: PointRef = basePtRef && basePtRef.kind !== 'abs'
    ? basePtRef
    : { kind: 'abs', x: numE(basePt.x),   y: numE(basePt.y)   };
  const p2: PointRef = targetPtRef && targetPtRef.kind !== 'abs'
    ? targetPtRef
    : { kind: 'abs', x: numE(targetPt.x), y: numE(targetPt.y) };
  const arr: Feature = {
    id: arrFid,
    kind: 'array',
    layer: state.activeLayer,
    sourceIds: sourceFids,
    mode: nr > 1 ? 'matrix' : 'linear',
    offset: { p1, p2 },
    cols: numE(nc),
    rows: numE(nr),
  };
  state.features.push(arr);
  evaluateTimeline();
  for (const ent of state.entities) {
    const mod = featureForEntity(ent.id);
    if (mod && mod.id === arrFid) state.selection.add(ent.id);
  }
  updateStats();
  updateSelStatus();
  return true;
}

/**
 * Matrix copy: place `cols × rows` instances of the current selection along
 * the clicked offset vector `d` (columns) and its 90° CCW perpendicular
 * (rows). The original source is included (cell 0,0), so a 1×1 matrix is a
 * no-op and a 2×1 matrix duplicates once along `d`.
 *
 * Each cell runs transformSelection with copy=true, but we restore the
 * ORIGINAL selection before each pass — otherwise each iteration would see
 * the previously-added copies too and duplicate them, producing an
 * exponential explosion of entities.
 */
export function applyMatrixCopy(d: Pt, cols: number, rows: number): void {
  const nc = Math.max(1, Math.floor(cols));
  const nr = Math.max(1, Math.floor(rows));
  if (nc === 1 && nr === 1) {
    transformSelection(pt => add(pt, d), { copy: true, pureTranslation: true });
    return;
  }
  const rowStep: Pt = { x: -d.y, y: d.x }; // 90° CCW perp
  const originalSelection = [...state.selection];
  const restoreSelection = () => {
    state.selection.clear();
    for (const id of originalSelection) state.selection.add(id);
  };
  for (let j = 0; j < nr; j++) {
    for (let i = 0; i < nc; i++) {
      if (i === 0 && j === 0) continue;
      const off = { x: i * d.x + j * rowStep.x, y: i * d.y + j * rowStep.y };
      restoreSelection();
      transformSelection(pt => add(pt, off), { copy: true, pureTranslation: true });
    }
  }
  // Leave the source selected — matches user expectation that the "selection
  // handle" remains on the originals they chose.
  restoreSelection();
  updateSelStatus();
}

function handleRotateClick(p: Pt, worldPt: Pt, shiftKey = false): void {
  const tc = runtime.toolCtx;
  if (!tc) return;
  if (tc.step === 'pick') {
    const hit = hitTest(worldPt);
    if (hit) state.selection.add(hit.id);
    updateSelStatus();
    render();
    return;
  }
  if (tc.step === 'center') {
    tc.centerPt = p;
    // Keep the parametric ref to the rotation centre so a rotate around a
    // feature-backed point (rect corner, line midpoint, intersection) stays
    // tied to it under variable changes — moves with the anchor, keeping
    // the rotated output coherent with the source geometry.
    tc.centerPtRef = snapToPointRef(runtime.lastSnap, p);
    tc.step = 'angle';
    setPrompt('Winkel (°) eingeben oder Referenzpunkt klicken · Shift = Kopie');
    updatePreview();
    render();
    return;
  }
  if (tc.step === 'angle' && tc.centerPt) {
    const v = sub(p, tc.centerPt);
    if (len(v) < 1e-6) return;
    const ang = Math.atan2(v.y, v.x);
    if (shiftKey) {
      // Copy-rotate → parametric RotateFeature (live on variable changes).
      // Falls back to flatten-copy if no eligible sources.
      if (!tryCreateRotateFeature([...state.selection], tc.centerPt, ang, tc.centerPtRef ?? null)) {
        applyRotate(tc.centerPt, ang, true);
      }
    } else {
      applyRotate(tc.centerPt, ang, false);
    }
    // Selection is preserved by transformSelection — reset to the "pick a
    // rotation centre" step so the user can rotate again (or switch to a
    // different modifier) without re-selecting.
    runtime.toolCtx = { step: 'center' };
    setPrompt('Drehzentrum · Shift = Kopie');
    render();
  }
}

/**
 * Try to create a parametric RotateFeature. Angle is stored in **degrees** as
 * an `Expr` so the user can later edit it to a variable/formula via the
 * timeline panel.
 */
function tryCreateRotateFeature(
  entityIds: number[], centerPt: Pt, angRad: number,
  centerRef?: PointRef | null,
): boolean {
  const sourceFids: string[] = [];
  for (const id of entityIds) {
    const ent = state.entities.find(e => e.id === id);
    if (!ent) continue;
    if (ent.type === 'text' || ent.type === 'dim' || ent.type === 'hatch') continue;
    const feat = featureForEntity(id);
    if (!feat) continue;
    if (feat.kind === 'mirror' || feat.kind === 'array' || feat.kind === 'rotate' || feat.kind === 'crossMirror') continue;
    sourceFids.push(feat.id);
  }
  if (!sourceFids.length) return false;
  pushUndo();
  const rotFid = newFeatureId();
  // Parametric centre when the user snapped to feature geometry — rotation
  // tracks the anchor under variable changes. Free-point picks stay abs.
  const center: PointRef = centerRef && centerRef.kind !== 'abs'
    ? centerRef
    : { kind: 'abs', x: numE(centerPt.x), y: numE(centerPt.y) };
  const angDeg = angRad * 180 / Math.PI;
  const rot: Feature = {
    id: rotFid,
    kind: 'rotate',
    layer: state.activeLayer,
    sourceIds: sourceFids,
    center,
    angle: numE(angDeg),
    keepOriginal: true,
  };
  state.features.push(rot);
  evaluateTimeline();
  for (const ent of state.entities) {
    const mod = featureForEntity(ent.id);
    if (mod && mod.id === rotFid) state.selection.add(ent.id);
  }
  updateStats();
  updateSelStatus();
  return true;
}

export function applyRotate(center: Pt, rad: number, copy = false): void {
  const cos = Math.cos(rad), sin = Math.sin(rad);
  transformSelection(pt => {
    const dx = pt.x - center.x, dy = pt.y - center.y;
    return { x: center.x + dx * cos - dy * sin, y: center.y + dx * sin + dy * cos };
  }, { pureTranslation: false, copy });
}

/**
 * Scale: three-step tool (pick → base → factor).
 *   pick    — accumulate selection, Enter to advance (handleBareEnter).
 *   base    — click the scaling centre (immovable point).
 *   factor  — click reference length, commits factor = current/reference distance.
 *             OR type a plain factor in the cmdbar (commitScaleFactor).
 * Refuses factors ≤ 0 (toast) to keep geometry sane.
 */
function handleScaleClick(p: Pt, worldPt: Pt, shiftKey = false): void {
  const tc = runtime.toolCtx;
  if (!tc) return;
  if (tc.step === 'pick') {
    const hit = hitTest(worldPt);
    if (hit) state.selection.add(hit.id);
    updateSelStatus();
    render();
    return;
  }
  if (tc.step === 'base') {
    tc.basePt = p;
    tc.step = 'refLen';
    setPrompt('Referenzpunkt klicken (definiert Ausgangslänge) · Shift = Kopie');
    updatePreview();
    render();
    return;
  }
  if (tc.step === 'refLen' && tc.basePt) {
    const refLen = dist(p, tc.basePt);
    if (refLen < 1e-6) { toast('Punkt zu nah am Basispunkt'); return; }
    tc.refLen = refLen;
    tc.step = 'factor';
    setPrompt('Neue Länge klicken — oder Faktor eingeben (z.B. 2, 0.5) · Shift = Kopie');
    updatePreview();
    render();
    return;
  }
  if (tc.step === 'factor' && tc.basePt && tc.refLen != null) {
    const newLen = dist(p, tc.basePt);
    if (newLen < 1e-6) { toast('Punkt zu nah am Basispunkt'); return; }
    const k = newLen / tc.refLen;
    applyScale(tc.basePt, k, shiftKey);
    // Selection stays (transformSelection re-added the scaled entity ids),
    // reset to the first interactive step so the user can scale again.
    runtime.toolCtx = { step: 'base' };
    setPrompt('Basispunkt · Shift = Kopie');
    render();
  }
}

export function applyScale(center: Pt, k: number, copy = false): void {
  if (!(k > 0) || !isFinite(k)) return;
  transformSelection(pt => ({
    x: center.x + (pt.x - center.x) * k,
    y: center.y + (pt.y - center.y) * k,
  }), { pureTranslation: false, copy });
}

function handleMirrorClick(p: Pt, worldPt: Pt, shiftKey = false): void {
  const tc = runtime.toolCtx;
  if (!tc) return;
  if (tc.step === 'pick') {
    const hit = hitTest(worldPt);
    if (hit) state.selection.add(hit.id);
    updateSelStatus();
    render();
    return;
  }
  if (tc.step === 'axis1') {
    tc.a1 = p;
    // Keep the parametric ref to the first axis click so a mirror drawn
    // through a feature anchor (rect corner, line midpoint, intersection)
    // re-evaluates when that anchor moves under variable changes — the
    // mirror axis drags with the geometry it was anchored to.
    tc.a1Ref = snapToPointRef(runtime.lastSnap, p);
    tc.step = 'axis2';
    setPrompt('Spiegelachse: zweiter Punkt · Shift = Kopie (ohne: verschieben, Original weg)');
    updatePreview();
    render();
    return;
  }
  if (tc.step === 'axis2' && tc.a1) {
    const a = tc.a1, b = p;
    const d = norm(sub(b, a));
    if (len(d) < 1e-9) return;
    // Capture the ref for the second axis click too (same rationale as a1Ref).
    const a2Ref = snapToPointRef(runtime.lastSnap, b);
    if (shiftKey) {
      // Copy mirror → create a parametric MirrorFeature referencing the
      // current selection, leaving the sources untouched. The mirrored
      // geometry re-evaluates whenever the sources' parameters change, which
      // is the whole point of this refactor (previously Shift-mirror would
      // flatten the copies to abs-coords and break parametric links).
      createMirrorFeature([...state.selection], a, b, tc.a1Ref ?? null, a2Ref);
    } else {
      // Move mirror → keep the old flatten-and-transform behaviour. A move
      // mirror intentionally destroys the source, so there's nothing for a
      // parametric link to track against.
      const n = perp(d);
      transformSelection(pt => {
        const rel = sub(pt, a);
        return add(a, add(scale(d, dot(rel, d)), scale(n, -dot(rel, n))));
      }, { pureTranslation: false, copy: false });
    }
    // Selection kept — reset to "pick axis start" so the user can mirror
    // again (common: mirror across one axis, then across a second).
    runtime.toolCtx = { step: 'axis1' };
    setPrompt('Spiegelachse: erster Punkt · Shift = Kopie');
    render();
  }
}

/**
 * Create a MirrorFeature referencing every selected entity's source feature.
 * Mirrored entities stay parametrically linked: variable edits on the sources
 * propagate into the mirror's outputs on the next `evaluateTimeline()`.
 *
 * Entity types that can't be mirrored as Features (text/dim/hatch — see
 * `reflectEntity`) are silently skipped. If nothing survives, we fall back to
 * flattened copy-mirror so the user at least gets geometry on screen.
 */
function createMirrorFeature(
  entityIds: number[], a: Pt, b: Pt,
  aRef?: PointRef | null, bRef?: PointRef | null,
): void {
  const sourceFids: string[] = [];
  for (const id of entityIds) {
    const ent = state.entities.find(e => e.id === id);
    if (!ent) continue;
    // Skip types the mirror feature can't reflect yet (text/dim/hatch).
    if (ent.type === 'text' || ent.type === 'dim' || ent.type === 'hatch') continue;
    const feat = featureForEntity(id);
    if (!feat) continue;
    // Mirroring a mirror would compound — skip for now. (The user can flatten
    // first if they really want double mirrors.)
    if (feat.kind === 'mirror' || feat.kind === 'crossMirror') continue;
    sourceFids.push(feat.id);
  }
  if (!sourceFids.length) {
    // Fallback: flatten-copy mirror for the unsupported types.
    const d = norm(sub(b, a));
    const n = perp(d);
    transformSelection(pt => {
      const rel = sub(pt, a);
      return add(a, add(scale(d, dot(rel, d)), scale(n, -dot(rel, n))));
    }, { pureTranslation: false, copy: true });
    return;
  }
  pushUndo();
  const mirrorFid = newFeatureId();
  // Parametric axis when either endpoint was snapped to feature geometry.
  // The mirror re-evaluates on each timeline tick, so the axis (and hence
  // the mirrored output) tracks the anchored geometry when upstream
  // variables move. Free-point clicks stay abs.
  const axisP1: PointRef = aRef && aRef.kind !== 'abs'
    ? aRef
    : { kind: 'abs', x: numE(a.x), y: numE(a.y) };
  const axisP2: PointRef = bRef && bRef.kind !== 'abs'
    ? bRef
    : { kind: 'abs', x: numE(b.x), y: numE(b.y) };
  const mirror: Feature = {
    id: mirrorFid,
    kind: 'mirror',
    layer: state.activeLayer,
    sourceIds: sourceFids,
    axis: { kind: 'twoPoints', p1: axisP1, p2: axisP2 },
    keepOriginal: true,
  };
  state.features.push(mirror);
  evaluateTimeline();
  // Select the freshly mirrored entities so repeated mirrors (mirror across a
  // second axis) pick them up. The original sources stay selected too so the
  // user can mirror the whole cluster further.
  for (const ent of state.entities) {
    const mod = featureForEntity(ent.id);
    if (mod && mod.id === mirrorFid) state.selection.add(ent.id);
  }
  updateStats();
  updateSelStatus();
}

/**
 * Prompt text for the cross-mirror 'center' step, varies with the active mode
 * so the HUD message and the picker stay in sync.
 */
export function crossMirrorPrompt(mode: CrossMirrorMode): string {
  if (mode === 'quarter')  return 'Symmetrie-Mittelpunkt klicken (1/4)';
  if (mode === 'half_h')   return 'Symmetrie-Mittelpunkt klicken (1/2 horizontal, links ↔ rechts)';
  return 'Symmetrie-Mittelpunkt klicken (1/2 vertikal, oben ↕ unten)';
}

/**
 * Translate the sticky UI mode into the CrossMirrorFeature fields. The
 * Feature itself only knows (variant, angle) — the picker's three modes map
 * onto two orientations of the same half-variant plus the quarter variant.
 *
 *   quarter  → 3 copies, axes at 0°/90°
 *   half_h   → 1 copy, axis=(0,1) (vertical line through centre → left↔right)
 *   half_v   → 1 copy, axis=(1,0) (horizontal line through centre → top↕bottom)
 */
function crossMirrorSpec(mode: CrossMirrorMode): { variant: 'quarter' | 'half'; angleDeg: number } {
  if (mode === 'quarter') return { variant: 'quarter', angleDeg: 0 };
  // For the half-variant we reuse `angle` as the primary-axis rotation.
  // axis1 = (cos, sin), and we only use axis1 for reflection. Rotating 90°
  // turns axis1 into (0,1) — a vertical axis → reflection flips x (left↔right).
  if (mode === 'half_h') return { variant: 'half', angleDeg: 90 };
  return { variant: 'half', angleDeg: 0 };
}

/**
 * Cross-mirror tool — ArtiosCAD-style 1/4 or 1/2 symmetry. User picks a single
 * centre point; the mode selected in the HUD picker determines whether we
 * emit three copies (quarter) or one (half horizontal / half vertical).
 *
 * The user can later edit the angle Expr in the timeline to rotate the whole
 * symmetry frame — typical when the drawn quarter isn't axis-aligned.
 */
function handleCrossMirrorClick(p: Pt, worldPt: Pt, _shiftKey = false): void {
  const tc = runtime.toolCtx;
  if (!tc) return;
  if (tc.step === 'pick') {
    const hit = hitTest(worldPt);
    if (hit) state.selection.add(hit.id);
    updateSelStatus();
    render();
    return;
  }
  if (tc.step === 'center') {
    // Keep the parametric ref so the centre drags with the anchor it was
    // snapped to (intersection, endpoint, …) when variables change.
    const centerRef = snapToPointRef(runtime.lastSnap, p);
    const spec = crossMirrorSpec(runtime.crossMirrorMode);
    createCrossMirrorFeature([...state.selection], p, spec, centerRef);
    // Stay at 'center' so the user can drop another symmetry centre without
    // re-selecting the sources.
    runtime.toolCtx = { step: 'center' };
    setPrompt(crossMirrorPrompt(runtime.crossMirrorMode));
    render();
  }
}

function createCrossMirrorFeature(
  entityIds: number[], centerPt: Pt,
  spec: { variant: 'quarter' | 'half'; angleDeg: number },
  centerRef?: PointRef | null,
): void {
  const sourceFids: string[] = [];
  for (const id of entityIds) {
    const ent = state.entities.find(e => e.id === id);
    if (!ent) continue;
    // Skip types the reflect/rotate helpers can't handle (text/dim/hatch).
    if (ent.type === 'text' || ent.type === 'dim' || ent.type === 'hatch') continue;
    const feat = featureForEntity(id);
    if (!feat) continue;
    // Skip modifier outputs — mirroring a mirrored entity would compound.
    if (feat.kind === 'mirror' || feat.kind === 'crossMirror'
        || feat.kind === 'array' || feat.kind === 'rotate') continue;
    sourceFids.push(feat.id);
  }
  if (!sourceFids.length) {
    toast('Keine spiegelbaren Objekte in der Auswahl');
    return;
  }
  pushUndo();
  const fid = newFeatureId();
  const center: PointRef = centerRef && centerRef.kind !== 'abs'
    ? centerRef
    : { kind: 'abs', x: numE(centerPt.x), y: numE(centerPt.y) };
  const feat: Feature = {
    id: fid,
    kind: 'crossMirror',
    layer: state.activeLayer,
    sourceIds: sourceFids,
    center,
    angle: numE(spec.angleDeg),
    variant: spec.variant,
    keepOriginal: true,
  };
  state.features.push(feat);
  evaluateTimeline();
  // Select the freshly emitted copies so the user can chain further ops.
  for (const ent of state.entities) {
    const mod = featureForEntity(ent.id);
    if (mod && mod.id === fid) state.selection.add(ent.id);
  }
  updateStats();
  updateSelStatus();
}

// ---------------- Hatch / Fill ----------------
//
// Interaction: user clicks inside any closed shape on the canvas. We detect the
// smallest enclosing polygon and commit a HatchEntity that copies that
// polygon's points. The boundary is NOT linked to the source entity (the hatch
// does not follow the polygon if the polygon is later resized) — this is a
// pragmatic v1 choice that keeps HatchFeature simple.
//
// `solid` mode → flat fill with the active layer colour.
// `lines` mode → diagonal stripe pattern (active: `Schraffieren` tool).

/** Polygon tessellation resolution for curved shapes. 64 segments gives a
 *  barely-visible error for screen-sized circles while staying cheap. */
const HATCH_TESSELLATE_STEPS = 64;

/** Convert a closed entity into a polygon (array of Pt) suitable for
 *  point-in-polygon tests and for use as the hatch boundary. Returns null for
 *  non-closed entities (open polylines, lines, etc.). */
function entityToClosedPolygon(e: Entity): Pt[] | null {
  if (e.type === 'rect') {
    return [
      { x: e.x1, y: e.y1 },
      { x: e.x2, y: e.y1 },
      { x: e.x2, y: e.y2 },
      { x: e.x1, y: e.y2 },
    ];
  }
  if (e.type === 'circle') {
    const pts: Pt[] = [];
    for (let i = 0; i < HATCH_TESSELLATE_STEPS; i++) {
      const a = (i / HATCH_TESSELLATE_STEPS) * Math.PI * 2;
      pts.push({ x: e.cx + e.r * Math.cos(a), y: e.cy + e.r * Math.sin(a) });
    }
    return pts;
  }
  if (e.type === 'ellipse') {
    const pts: Pt[] = [];
    const cosR = Math.cos(e.rot), sinR = Math.sin(e.rot);
    for (let i = 0; i < HATCH_TESSELLATE_STEPS; i++) {
      const a = (i / HATCH_TESSELLATE_STEPS) * Math.PI * 2;
      const lx = e.rx * Math.cos(a), ly = e.ry * Math.sin(a);
      pts.push({ x: e.cx + lx * cosR - ly * sinR, y: e.cy + lx * sinR + ly * cosR });
    }
    return pts;
  }
  if (e.type === 'polyline' && e.closed && e.pts.length >= 3) {
    return e.pts.slice();
  }
  if (e.type === 'spline' && e.closed && e.pts.length >= 3) {
    // v1: treat spline control points as the boundary polygon. Accurate
    // de-Boor evaluation is overkill for pick-inside behaviour.
    return e.pts.slice();
  }
  return null;
}

/** Even-odd ray-cast point-in-polygon. Same algorithm as in hittest.ts;
 *  re-implemented locally to avoid a cross-module dependency. */
function ptInPoly(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    const cross = (yi > p.y) !== (yj > p.y)
      && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi + 1e-30) + xi;
    if (cross) inside = !inside;
  }
  return inside;
}

function polygonArea(poly: Pt[]): number {
  let s = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    s += (poly[j].x + poly[i].x) * (poly[j].y - poly[i].y);
  }
  return Math.abs(s) * 0.5;
}

/** Find the smallest closed entity whose polygon encloses p. Kept as a fallback
 *  for cases where the cycle-graph trace misses something (e.g. a single
 *  pre-existing closed polyline whose edges we didn't tessellate — but the
 *  cycle graph does include those now, so this is currently redundant). Still
 *  handy as a belt-and-suspenders layer. */
function findEnclosingDirectShape(p: Pt): { poly: Pt[]; layer: number; area: number } | null {
  let best: { poly: Pt[]; layer: number; area: number } | null = null;
  for (const e of state.entities) {
    const layer = state.layers[e.layer];
    if (!layer || !layer.visible) continue;
    const poly = entityToClosedPolygon(e);
    if (!poly || poly.length < 3) continue;
    if (!ptInPoly(p, poly)) continue;
    const area = polygonArea(poly);
    if (!best || area < best.area) best = { poly, layer: e.layer, area };
  }
  return best;
}

// ── Cycle-based face detection ───────────────────────────────────────────────
//
// Users frequently build "rectangles" from four separate Linie entities rather
// than a single rect primitive. For the hatch/fill tools to feel natural, we
// have to treat such arrangements as closed regions too. The approach:
//
//   1. Collect every line/polyline-segment/arc-chord from visible entities.
//   2. Merge coincident endpoints into a shared cluster graph (tolerance EPS).
//   3. Shoot a +X ray from the click point; find the nearest crossing segment.
//   4. Walk the planar face that lies on the left of that oriented segment by
//      repeatedly picking the "most clockwise" outgoing edge at each vertex
//      (standard planar-subdivision face-trace algorithm).
//
// Limitations: does NOT split segments at true intersections where segments
// cross without sharing an endpoint. A rectangle drawn with four lines that
// meet corner-to-corner works; an X of two crossing lines does not form a
// face by itself. Good enough for v1 — most CAD input uses endpoint snaps.

/** Endpoint-merging tolerance in world units (mm). Endpoint snapping produces
 *  identical coordinates, so `1e-6` is plenty; we bump it to `1e-3` so small
 *  float-round errors (from e.g. imported DXF) still join into a single cluster. */
const CYCLE_EPS = 1e-3;

type CycleSeg = { a: number; b: number; layer: number };

/** Tessellate an arc into N chord segments, sampling the sweep from a1 to a2
 *  the short way (matches how arcs are drawn). */
function tessellateArc(cx: number, cy: number, r: number, a1: number, a2: number, steps = 24): Pt[] {
  const TAU = Math.PI * 2;
  let sweep = a2 - a1;
  while (sweep <= -Math.PI) sweep += TAU;
  while (sweep >   Math.PI) sweep -= TAU;
  const pts: Pt[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = a1 + (sweep * i) / steps;
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return pts;
}

function collectCycleSegments(): { segs: CycleSeg[]; clusters: Pt[] } {
  const clusters: Pt[] = [];
  const indexOf = (pt: Pt): number => {
    for (let i = 0; i < clusters.length; i++) {
      if (Math.abs(clusters[i].x - pt.x) < CYCLE_EPS && Math.abs(clusters[i].y - pt.y) < CYCLE_EPS) return i;
    }
    clusters.push({ x: pt.x, y: pt.y });
    return clusters.length - 1;
  };
  const segs: CycleSeg[] = [];
  const push = (a: Pt, b: Pt, layer: number): void => {
    const ia = indexOf(a), ib = indexOf(b);
    if (ia === ib) return;
    segs.push({ a: ia, b: ib, layer });
  };
  for (const e of state.entities) {
    const L = state.layers[e.layer];
    if (!L || !L.visible) continue;
    if (e.type === 'line') {
      push({ x: e.x1, y: e.y1 }, { x: e.x2, y: e.y2 }, e.layer);
    } else if (e.type === 'polyline') {
      for (let i = 1; i < e.pts.length; i++) push(e.pts[i - 1], e.pts[i], e.layer);
      if (e.closed && e.pts.length >= 3) push(e.pts[e.pts.length - 1], e.pts[0], e.layer);
    } else if (e.type === 'rect') {
      const xL = Math.min(e.x1, e.x2), xR = Math.max(e.x1, e.x2);
      const yB = Math.min(e.y1, e.y2), yT = Math.max(e.y1, e.y2);
      push({ x: xL, y: yB }, { x: xR, y: yB }, e.layer);
      push({ x: xR, y: yB }, { x: xR, y: yT }, e.layer);
      push({ x: xR, y: yT }, { x: xL, y: yT }, e.layer);
      push({ x: xL, y: yT }, { x: xL, y: yB }, e.layer);
    } else if (e.type === 'arc') {
      const pts = tessellateArc(e.cx, e.cy, e.r, e.a1, e.a2);
      for (let i = 1; i < pts.length; i++) push(pts[i - 1], pts[i], e.layer);
    } else if (e.type === 'circle') {
      // Tessellate as closed polyline so a circle sitting inside a region can
      // participate in hole detection.
      const N = HATCH_TESSELLATE_STEPS;
      let prev = { x: e.cx + e.r, y: e.cy };
      for (let i = 1; i <= N; i++) {
        const a = (i / N) * Math.PI * 2;
        const cur = { x: e.cx + e.r * Math.cos(a), y: e.cy + e.r * Math.sin(a) };
        push(prev, cur, e.layer);
        prev = cur;
      }
    } else if (e.type === 'ellipse') {
      const N = HATCH_TESSELLATE_STEPS;
      const cosR = Math.cos(e.rot), sinR = Math.sin(e.rot);
      const at = (i: number): Pt => {
        const a = (i / N) * Math.PI * 2;
        const lx = e.rx * Math.cos(a), ly = e.ry * Math.sin(a);
        return { x: e.cx + lx * cosR - ly * sinR, y: e.cy + lx * sinR + ly * cosR };
      };
      let prev = at(0);
      for (let i = 1; i <= N; i++) { const cur = at(i); push(prev, cur, e.layer); prev = cur; }
    } else if (e.type === 'spline') {
      for (let i = 1; i < e.pts.length; i++) push(e.pts[i - 1], e.pts[i], e.layer);
      if (e.closed && e.pts.length >= 3) push(e.pts[e.pts.length - 1], e.pts[0], e.layer);
    }
  }
  return splitAtTJunctions({ segs, clusters });
}

/**
 * Split segments at T-junctions so the cycle tracer can traverse them.
 *
 * Why: tools like `line_offset` (connect mode) routinely drop a connector
 * whose endpoint lies on the *interior* of an existing segment, not at its
 * endpoints — classic T-junction. The planar-face tracer only navigates along
 * graph nodes (clusters), so an interior-touching cluster is invisible to it
 * and the enclosed sub-region can't be detected. Fill/hatch then silently
 * gives up with "Keine geschlossene Fläche".
 *
 * Fix: for every segment, scan all clusters that are NOT one of its endpoints
 * and check whether they sit on the segment's line within `CYCLE_EPS`. Those
 * that do become split points; the segment is replaced by the concatenation
 * of sub-segments between consecutive split points along its length.
 *
 * Cost: O(S·C) where S = segments, C = clusters. Both are bounded by typical
 * drawing sizes (hundreds), so this stays fast. A spatial index would be
 * needed past a few thousand segments; flag for later.
 */
function splitAtTJunctions(g: { segs: CycleSeg[]; clusters: Pt[] }): { segs: CycleSeg[]; clusters: Pt[] } {
  const { segs, clusters } = g;
  const EPS = CYCLE_EPS;
  const EPS2 = EPS * EPS;
  const out: CycleSeg[] = [];
  for (const s of segs) {
    const A = clusters[s.a], B = clusters[s.b];
    const dx = B.x - A.x, dy = B.y - A.y;
    const len2 = dx * dx + dy * dy;
    if (len2 < EPS2) { out.push(s); continue; }
    // Collect every cluster that sits on segment AB strictly between A and B.
    // `t` is the parametric projection along AB ∈ (0, 1); `d2` is the squared
    // perpendicular distance. A cluster counts as on-segment iff d2 < EPS².
    const hits: { t: number; idx: number }[] = [];
    for (let c = 0; c < clusters.length; c++) {
      if (c === s.a || c === s.b) continue;
      const P = clusters[c];
      const px = P.x - A.x, py = P.y - A.y;
      const t = (px * dx + py * dy) / len2;
      if (t <= EPS / Math.sqrt(len2) || t >= 1 - EPS / Math.sqrt(len2)) continue;
      // Perpendicular offset from the line through AB.
      const projX = A.x + t * dx, projY = A.y + t * dy;
      const ox = P.x - projX, oy = P.y - projY;
      if (ox * ox + oy * oy > EPS2) continue;
      hits.push({ t, idx: c });
    }
    if (hits.length === 0) { out.push(s); continue; }
    // Sort hits by position along the segment and emit sub-segments A→h1→…→B.
    hits.sort((x, y) => x.t - y.t);
    let prev = s.a;
    for (const h of hits) {
      if (h.idx === prev) continue;
      out.push({ a: prev, b: h.idx, layer: s.layer });
      prev = h.idx;
    }
    if (prev !== s.b) out.push({ a: prev, b: s.b, layer: s.layer });
  }
  // Collapse duplicate undirected edges. Two rectangles that share a border,
  // or a rect whose edge coincides with a line the user drew over it, both
  // push the same (a,b) pair — and T-junction splitting above can turn a
  // long line into sub-segments that now duplicate a neighbouring rect's
  // edge. Duplicates silently break the planar face tracer: each extra
  // directed edge gives the "turn-right" walk a redundant path that can
  // merge two adjacent interior faces into one, so hatch/fill bleeds across
  // the shared border. Key is order-independent so both orientations collapse.
  const seen = new Set<string>();
  const deduped: CycleSeg[] = [];
  for (const s of out) {
    const key = s.a < s.b ? `${s.a}:${s.b}` : `${s.b}:${s.a}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(s);
  }
  return { segs: deduped, clusters };
}

type Face = { poly: Pt[]; layer: number; area: number };

/** Trace every bounded face in the cycle graph. Each directed edge participates
 *  in exactly one face, so we iterate every (seg, reverse) combination and skip
 *  ones that were already covered by a previous trace. */
function traceAllFaces(): Face[] {
  const { segs, clusters } = collectCycleSegments();
  if (segs.length < 3) return [];

  type Out = { other: number; seg: number; reverse: boolean };
  const adj: Out[][] = clusters.map(() => []);
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    adj[s.a].push({ other: s.b, seg: i, reverse: false });
    adj[s.b].push({ other: s.a, seg: i, reverse: true });
  }

  const visited = new Set<string>();
  const faces: Face[] = [];
  const MAX_STEPS = Math.max(64, segs.length * 4);

  for (let startSeg = 0; startSeg < segs.length; startSeg++) {
    for (const startRev of [false, true]) {
      const startKey = `${startSeg}:${startRev ? 1 : 0}`;
      if (visited.has(startKey)) continue;

      const polyIdx: number[] = [];
      const layerVotes = new Map<number, number>();
      let curSeg = startSeg, curReverse = startRev;
      let ok = false;
      for (let step = 0; step < MAX_STEPS; step++) {
        const key = `${curSeg}:${curReverse ? 1 : 0}`;
        visited.add(key);
        const s = segs[curSeg];
        const fromCluster = curReverse ? s.b : s.a;
        const toCluster   = curReverse ? s.a : s.b;
        polyIdx.push(fromCluster);
        layerVotes.set(s.layer, (layerVotes.get(s.layer) ?? 0) + 1);

        const fromP = clusters[fromCluster], toP = clusters[toCluster];
        const backAng = Math.atan2(fromP.y - toP.y, fromP.x - toP.x);

        let bestNext: { seg: number; reverse: boolean } | null = null;
        let bestDelta = Infinity;
        for (const oe of adj[toCluster]) {
          if (oe.seg === curSeg) continue;
          const otherP = clusters[oe.other];
          const outAng = Math.atan2(otherP.y - toP.y, otherP.x - toP.x);
          let delta = backAng - outAng;
          while (delta <= 0)          delta += 2 * Math.PI;
          while (delta > 2 * Math.PI) delta -= 2 * Math.PI;
          if (delta < bestDelta) { bestDelta = delta; bestNext = { seg: oe.seg, reverse: oe.reverse }; }
        }
        if (!bestNext) break;
        if (bestNext.seg === startSeg && bestNext.reverse === startRev) { ok = true; break; }
        curSeg = bestNext.seg;
        curReverse = bestNext.reverse;
      }
      if (!ok || polyIdx.length < 3) continue;

      const poly = polyIdx.map(i => clusters[i]);
      const area = signedArea(poly);
      // Bounded interior face (CCW) has positive area under the convention
      // (left face of oriented edge in world coords, y-up). The unbounded outer
      // face traces the same graph in reverse orientation and has negative
      // area — discard it.
      if (area <= 1e-9) continue;
      let layer = state.activeLayer, bestVotes = 0;
      for (const [lyr, votes] of layerVotes) {
        if (votes > bestVotes) { bestVotes = votes; layer = lyr; }
      }
      faces.push({ poly, layer, area });
    }
  }
  return faces;
}

/**
 * Unified enclosing-region lookup.
 *
 * Returns `{ poly, holes, layer }` where:
 *   - `poly`  = outer boundary polygon of the region containing the click.
 *   - `holes` = inner boundaries (direct children by containment) that should
 *               be subtracted from the hatch so the pattern respects any
 *               smaller closed shapes sitting inside the outer region.
 *   - `layer` = dominant layer of the outer boundary's source edges.
 *
 * Strategy: trace every bounded face in the planar cycle graph, pick the
 * smallest face containing the click as the outer, then pick maximal-by-area
 * faces strictly inside the outer (but not containing the click) as holes.
 * Falls back to direct closed-shape detection if no cycle face is found
 * (degenerate graphs, single isolated polyline, etc.).
 */
function findEnclosingShape(p: Pt): { poly: Pt[]; holes: Pt[][]; layer: number } | null {
  const faces = traceAllFaces();

  // Outer = smallest face containing p.
  let outer: Face | null = null;
  for (const f of faces) {
    if (!ptInPoly(p, f.poly)) continue;
    if (!outer || f.area < outer.area) outer = f;
  }

  // Fallback: if the cycle graph didn't find anything (scene is only open
  // lines, or p is outside every bounded face), try direct closed shapes.
  if (!outer) {
    const direct = findEnclosingDirectShape(p);
    return direct ? { poly: direct.poly, holes: [], layer: direct.layer } : null;
  }

  // Hole candidates: faces fully inside `outer`, not containing p, not outer.
  //
  // Containment test uses a point STRICTLY inside the candidate face rather
  // than `poly[0]`. Two adjacent rects share a corner vertex (e.g., bottom
  // rect and top rect meeting at (52, 57.875)) — that shared vertex sits
  // exactly on the outer's boundary, and `ptInPoly` on a boundary point is
  // ambiguous: the raycasting algorithm can return `true` depending on which
  // edges the ray grazes. That false positive would mark the bottom rect as
  // a "hole" of the top rect; `drawHatch` then clips with even-odd across
  // two disjoint paths, which unions them — so hatching the top rect bled
  // into the bottom rect. Using the face centroid (strictly interior for
  // convex faces, which planar-graph rectangle traces always are) removes
  // the ambiguity.
  const rawCandidates: Face[] = [];
  for (const f of faces) {
    if (f === outer) continue;
    if (ptInPoly(p, f.poly)) continue;
    if (!ptInPoly(faceInteriorPoint(f.poly), outer.poly)) continue;
    rawCandidates.push(f);
  }
  // Keep only "direct children" by containment: a candidate H is a hole of
  // outer iff no other (larger) candidate K contains H. Sort descending by
  // area so larger candidates get accepted first, then reject any smaller
  // candidate already inside one that was accepted.
  rawCandidates.sort((a, b) => b.area - a.area);
  const holes: Pt[][] = [];
  const accepted: Face[] = [];
  for (const H of rawCandidates) {
    const hInterior = faceInteriorPoint(H.poly);
    const nested = accepted.some(K => ptInPoly(hInterior, K.poly));
    if (nested) continue;
    accepted.push(H);
    holes.push(H.poly);
  }
  return { poly: outer.poly, holes, layer: outer.layer };
}

/**
 * Pick a point guaranteed to lie strictly inside `poly` (never on its
 * boundary), suitable for point-in-polygon containment tests where boundary
 * ambiguity would cause false positives.
 *
 * Tries the area centroid first — strictly interior for any convex polygon,
 * which covers every rectangular / triangular face the planar-cycle tracer
 * produces in practice. For a pathological concave face where the centroid
 * falls outside, falls back to nudging an edge midpoint inward along the
 * edge's inward normal (CCW polygon → rotate edge direction 90° left).
 */
function faceInteriorPoint(poly: Pt[]): Pt {
  // Area centroid via the shoelace formula.
  let A = 0, cx = 0, cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const cross = p.x * q.y - q.x * p.y;
    A += cross;
    cx += (p.x + q.x) * cross;
    cy += (p.y + q.y) * cross;
  }
  A /= 2;
  if (Math.abs(A) > 1e-9) {
    const centroid = { x: cx / (6 * A), y: cy / (6 * A) };
    if (ptInPoly(centroid, poly)) return centroid;
  }
  // Concave-face fallback: nudge edge midpoints inward by ε and pick the
  // first that lands inside. ε is in world units (mm); 1e-4 is small enough
  // to stay inside sliver regions while being large enough to dodge
  // floating-point noise on the boundary.
  const eps = 1e-4;
  const ccw = A > 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const midx = (p.x + q.x) / 2, midy = (p.y + q.y) / 2;
    const dx = q.x - p.x, dy = q.y - p.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) continue;
    // Inward normal: for CCW polygon, 90° CCW rotation of edge direction
    // points into the interior; for CW, 90° CW.
    const nx = ccw ? -dy / len :  dy / len;
    const ny = ccw ?  dx / len : -dx / len;
    const candidate = { x: midx + nx * eps, y: midy + ny * eps };
    if (ptInPoly(candidate, poly)) return candidate;
  }
  // Last resort — a degenerate polygon. Return the first vertex; the caller
  // will get the old boundary behaviour but at least won't crash.
  return poly[0];
}

/** Default stripe spacing for a new hatch. World units (mm). Kept constant —
 *  the user can edit it later via the parameter panel on the feature. */
const DEFAULT_HATCH_SPACING = 5;
const DEFAULT_HATCH_ANGLE = Math.PI / 4; // 45°

/** Name of the auto-managed layer that new hatches and fills land on. Kept in
 *  one place so rename / lookup use the same string. */
const HATCH_LAYER_NAME = 'Schraffuren';

/**
 * Return the index of the "Schraffuren" layer, creating it on demand. Hatches
 * and fills share one dedicated layer so the user can toggle the visibility of
 * every hatch in the drawing with a single eye-icon click, and so the Ebenen
 * panel surfaces them as a distinct concept instead of mixing them into the
 * active construction layer.
 *
 * Rationale for one shared layer (vs. separate "Schraffuren" / "Füllungen"):
 *  - visually they serve the same annotation purpose (shading a region);
 *  - most users want to turn *all* area fills on/off at once;
 *  - kept minimal: the user can always move individual hatches onto their own
 *    layer via the "move selection here" button once created.
 */
function ensureHatchLayer(): number {
  const existing = state.layers.findIndex(L => L.name === HATCH_LAYER_NAME);
  if (existing >= 0) return existing;
  state.layers.push({ name: HATCH_LAYER_NAME, color: '#9aa3b5', visible: true });
  renderLayers();
  return state.layers.length - 1;
}

function handleHatchOrFillClick(worldPt: Pt, mode: 'solid' | 'lines'): void {
  const found = findEnclosingShape(worldPt);
  if (!found) {
    toast('Keine geschlossene Fläche unter dem Cursor');
    return;
  }
  // Route every hatch / fill onto the shared Schraffuren layer. `found.layer`
  // (the active layer at click time, or the layer inferred from the enclosing
  // geometry) is ignored by design — see ensureHatchLayer for the rationale.
  const hatchLayer = ensureHatchLayer();
  const holes = found.holes.length > 0 ? { holes: found.holes } : {};
  const init: EntityInit = mode === 'solid'
    ? { type: 'hatch', mode: 'solid', pts: found.poly, layer: hatchLayer, ...holes }
    : { type: 'hatch', mode: 'lines', pts: found.poly, layer: hatchLayer, ...holes,
        angle: DEFAULT_HATCH_ANGLE, spacing: DEFAULT_HATCH_SPACING };
  addEntity(init);
  // Stay in-tool so the user can click-fill multiple regions in a row.
  runtime.toolCtx = { step: 'pick' };
  setPrompt(mode === 'solid'
    ? 'Geschlossene Fläche anklicken (füllen)'
    : 'Geschlossene Fläche anklicken (schraffieren)');
  render();
}

// ---------------- Preview ----------------

export function updatePreview(): void {
  const tc = runtime.toolCtx;
  if (!tc) return;
  const snap = runtime.lastSnap;
  const p: Pt = snap ? { x: snap.x, y: snap.y } : state.mouseWorld;
  tc.preview = null;

  if (state.tool === 'line' && tc.step === 'p2' && tc.p1) {
    let endPt: Pt;
    if (tc.lockedDir) {
      // Preview mirrors commit: if the snap is on a feature edge, the line's
      // endpoint is the exact ray×edge intersection (what rayHit resolves to).
      // Otherwise fall back to ray-vs-snap-axis (horizontal/vertical through
      // the snap point) so the preview still magnetises to non-edge snaps.
      const edgeHit = (snap && snap.entityId != null && snap.edge)
        ? rayEdgeIntersect(tc.p1, tc.lockedDir, snap.entityId, snap.edge)
        : null;
      if (edgeHit) {
        endPt = edgeHit;
      } else {
        let length: number;
        if (snap) {
          length = lengthToSnapAxis(tc.p1, tc.lockedDir, { x: snap.x, y: snap.y });
        } else {
          const ap = sub(state.mouseWorld, tc.p1);
          length = dot(ap, tc.lockedDir);
        }
        endPt = add(tc.p1, scale(tc.lockedDir, length));
      }
    } else {
      endPt = maybeOrtho(tc.p1, p);
    }
    tc.preview = { type: 'line', x1: tc.p1.x, y1: tc.p1.y, x2: endPt.x, y2: endPt.y };
    const L = dist(tc.p1, endPt);
    const ang = Math.atan2(endPt.y - tc.p1.y, endPt.x - tc.p1.x) * 180 / Math.PI;
    const lock = tc.lockedDir ? ` (Lock ${tc.angleDeg}°)` : (runtime.orthoSnap && !runtime.lastSnap ? ' (Ortho)' : '');
    setTip(`L ${L.toFixed(2)} · ${ang.toFixed(1)}°${lock}`);
  } else if (state.tool === 'polyline' && tc.pts && tc.pts.length > 0) {
    const last = tc.pts[tc.pts.length - 1];
    let endPt: Pt;
    if (tc.lockedDir) {
      // Same as line tool: edge snap wins (ray × edge), else ray-vs-axis.
      const edgeHit = (snap && snap.entityId != null && snap.edge)
        ? rayEdgeIntersect(last, tc.lockedDir, snap.entityId, snap.edge)
        : null;
      if (edgeHit) {
        endPt = edgeHit;
      } else {
        let length: number;
        if (snap) {
          length = lengthToSnapAxis(last, tc.lockedDir, { x: snap.x, y: snap.y });
        } else {
          const ap = sub(state.mouseWorld, last);
          length = dot(ap, tc.lockedDir);
        }
        endPt = add(last, scale(tc.lockedDir, length));
      }
    } else {
      endPt = maybeOrtho(last, p);
    }
    // Previously-clicked segments have been committed as real line entities
    // already (see handlePolylineClick), so they draw as normal geometry. The
    // preview only needs to show the pending segment from the last clicked
    // vertex to the cursor — no ghost polyline overlaying solid lines.
    tc.preview = { type: 'line', x1: last.x, y1: last.y, x2: endPt.x, y2: endPt.y };
    const L   = dist(last, endPt);
    const ang = Math.atan2(endPt.y - last.y, endPt.x - last.x) * 180 / Math.PI;
    const lock = tc.lockedDir ? ` (Lock ${tc.angleDeg}°)` : (runtime.orthoSnap && !runtime.lastSnap ? ' (Ortho)' : '');
    setTip(`Polyline · Seg ${tc.pts.length} · L ${L.toFixed(2)} · ${ang.toFixed(1)}°${lock}`);
  } else if (state.tool === 'rect' && tc.step === 'dims' && tc.p1) {
    let y2 = p.y, x2 = p.x;
    if (tc.vertical != null)   y2 = tc.p1.y + (Math.sign(p.y - tc.p1.y) || 1) * tc.vertical;
    if (tc.horizontal != null) x2 = tc.p1.x + (Math.sign(p.x - tc.p1.x) || 1) * tc.horizontal;
    tc.preview = { type: 'rect', x1: tc.p1.x, y1: tc.p1.y, x2, y2 };
    const w = Math.abs(x2 - tc.p1.x), h = Math.abs(y2 - tc.p1.y);
    const locked: string[] = [];
    if (tc.vertical != null)   locked.push('V=' + tc.vertical);
    if (tc.horizontal != null) locked.push('H=' + tc.horizontal);
    setTip(`Rect · B ${w.toFixed(2)} · H ${h.toFixed(2)}` + (locked.length ? ' · ' + locked.join(' ') : ''));
  } else if (state.tool === 'circle' && tc.step === 'r' && tc.cx != null && tc.cy != null) {
    const r = dist(p, { x: tc.cx, y: tc.cy });
    tc.preview = { type: 'circle', cx: tc.cx, cy: tc.cy, r };
    setTip(`R ${r.toFixed(2)}`);
  } else if (state.tool === 'ref_circle' && tc.step === 'r' && tc.cx != null && tc.cy != null) {
    const r = dist(p, { x: tc.cx, y: tc.cy });
    tc.preview = { type: 'circle', cx: tc.cx, cy: tc.cy, r };
    setTip(`Hilfskreis · R ${r.toFixed(2)}`);
  } else if (state.tool === 'angle') {
    // Live preview: show the dim that would be created if the user clicks
    // here. Mirrors the picking logic in handleAngleClick — find the two
    // nearest non-parallel lines, intersect them, build the arc.
    const prev = buildAnglePreview(p);
    if (prev) {
      tc.preview = prev.shape;
      setTip(`∠ ${prev.deg.toFixed(1)}°`);
    } else {
      tc.preview = null;
      setTip('Zwischen zwei Linien klicken');
    }
  } else if (state.tool === 'radius') {
    const prev = buildRadiusPreview(p);
    if (prev) {
      tc.preview = prev.shape;
      const prefix = prev.mode === 'diameter' ? 'Ø' : 'R';
      setTip(`${prefix} ${prev.value.toFixed(2)}`);
    } else {
      tc.preview = null;
      setTip(runtime.radiusMode === 'diameter'
        ? 'Kreis/Bogen für Ø anklicken'
        : 'Kreis/Bogen für Radius anklicken');
    }
  } else if (state.tool === 'scale' && tc.basePt) {
    if (tc.step === 'refLen') {
      tc.preview = { type: 'line', x1: tc.basePt.x, y1: tc.basePt.y, x2: p.x, y2: p.y };
      setTip(`Ref-Länge: ${dist(tc.basePt, p).toFixed(2)}`);
    } else if (tc.step === 'factor' && tc.refLen != null) {
      const newLen = dist(tc.basePt, p);
      const k = tc.refLen > 1e-9 ? newLen / tc.refLen : 1;
      const base = tc.basePt;
      const previews: EntityShape[] = [];
      for (const id of state.selection) {
        const e = state.entities.find(x => x.id === id);
        if (!e) continue;
        for (const t of transformEntity(e, pt => ({
          x: base.x + (pt.x - base.x) * k,
          y: base.y + (pt.y - base.y) * k,
        }), { pureTranslation: false })) {
          previews.push(t as EntityShape);
        }
      }
      tc.preview = { type: 'group', entities: previews };
      setTip(`Faktor ${k.toFixed(3)}`);
    }
  } else if (state.tool === 'circle3' && tc.pts && tc.pts.length > 0) {
    if (tc.pts.length === 1) {
      // two-point diameter preview
      const a = tc.pts[0];
      const cx = (a.x + p.x) / 2, cy = (a.y + p.y) / 2;
      const r = dist(a, p) / 2;
      tc.preview = { type: 'circle', cx, cy, r };
      setTip(`Kreis (2/3) · R ${r.toFixed(2)}`);
    } else if (tc.pts.length === 2) {
      const circ = circleFrom3(tc.pts[0], tc.pts[1], p);
      if (circ) {
        tc.preview = { type: 'circle', cx: circ.cx, cy: circ.cy, r: circ.r };
        setTip(`Kreis · R ${circ.r.toFixed(2)}`);
      } else {
        setTip('Punkte sind kollinear');
      }
    }
  } else if (state.tool === 'arc3' && tc.pts && tc.pts.length > 0) {
    if (tc.pts.length === 1) {
      // Sehne-Preview zwischen Start und Cursor — zeigt klar, was der nächste
      // Klick als "Endpunkt" festlegt.
      tc.preview = { type: 'line', x1: tc.pts[0].x, y1: tc.pts[0].y, x2: p.x, y2: p.y };
      setTip('Bogen (2/3) — Endpunkt');
    } else if (tc.pts.length === 2) {
      const [a, b] = tc.pts;
      const dx = b.x - a.x, dy = b.y - a.y;
      const L = Math.hypot(dx, dy);
      if (L < 1e-9) {
        setTip('Endpunkte identisch');
      } else {
        const nx = -dy / L, ny = dx / L;
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        const h = (p.x - mx) * nx + (p.y - my) * ny;
        // Seite merken, damit cmdbar-Eingabe mit getipptem Betrag die richtige
        // Seite trifft.
        tc.bulgeSide = h >= 0 ? 1 : -1;
        const arc = arcFromChordBulgePoint(a, b, p);
        if (arc) {
          tc.preview = { type: 'arc', cx: arc.cx, cy: arc.cy, r: arc.r, a1: arc.a1, a2: arc.a2 };
          setTip(`Bogen · R ${arc.r.toFixed(2)} · Höhe ${Math.abs(h).toFixed(2)}`);
        } else {
          // Cursor fast auf der Sehne → noch kein Bogen, aber Sehne zeigen.
          tc.preview = { type: 'line', x1: a.x, y1: a.y, x2: b.x, y2: b.y };
          setTip('Bogen (3/3) — Seite wählen');
        }
      }
    }
  } else if (state.tool === 'ellipse' && tc.centerPt) {
    const c = tc.centerPt;
    if (tc.step === 'axis1') {
      if (tc.lockedDir) {
        // Winkel ist gesperrt (cmdbar hat nur den Winkel committet) — Maus auf
        // die Richtung projizieren und die Vorschau entlang der Achse zeichnen.
        const v = sub(p, c);
        const d = dot(v, tc.lockedDir);
        const rx = Math.abs(d);
        if (rx > 1e-6) {
          const signedDir = d >= 0 ? tc.lockedDir : { x: -tc.lockedDir.x, y: -tc.lockedDir.y };
          const rot = Math.atan2(signedDir.y, signedDir.x);
          tc.preview = { type: 'ellipse', cx: c.x, cy: c.y, rx, ry: rx * 0.5, rot };
          const lockAng = tc.angleDeg ?? (rot * 180 / Math.PI);
          setTip(`Halbachse 1: ${rx.toFixed(2)} · Winkel gesperrt ${lockAng.toFixed(1)}°`);
        } else {
          setTip(`Winkel gesperrt ${(tc.angleDeg ?? 0).toFixed(1)}° — Länge wählen`);
        }
      } else {
        const dx = p.x - c.x, dy = p.y - c.y;
        const rx = Math.hypot(dx, dy);
        if (rx > 1e-6) {
          const rot = Math.atan2(dy, dx);
          tc.preview = { type: 'ellipse', cx: c.x, cy: c.y, rx, ry: rx * 0.5, rot };
          setTip(`Halbachse 1: ${rx.toFixed(2)} · ${(rot * 180 / Math.PI).toFixed(1)}°`);
        }
      }
    } else if (tc.step === 'axis2' && tc.radius != null && tc.angleDeg != null) {
      const rot = tc.angleDeg;
      const nx = -Math.sin(rot), ny = Math.cos(rot);
      const ry = Math.abs((p.x - c.x) * nx + (p.y - c.y) * ny);
      if (ry > 1e-6) {
        tc.preview = { type: 'ellipse', cx: c.x, cy: c.y, rx: tc.radius, ry, rot };
        setTip(`Halbachsen: ${tc.radius.toFixed(2)} × ${ry.toFixed(2)}`);
      }
    }
  } else if (state.tool === 'spline' && tc.pts && tc.pts.length > 0) {
    const pts = [...tc.pts, p];
    tc.preview = { type: 'spline', pts };
    setTip(`Spline · ${pts.length} Punkte`);
  } else if (state.tool === 'stretch' && tc.step === 'pickbox') {
    // Drag-select feedback is owned by drawDragBox() (the shared rubber-band
    // renderer in render.ts), so no preview shape is needed here.
    setTip('Bereich aufziehen — dann Basispunkt setzen');
  } else if (state.tool === 'stretch' && tc.step === 'direction' && tc.click1 && tc.click2 && tc.basePt) {
    // Preview a ray from basePt to cursor so the user sees the direction they
    // will lock on click. No geometry ghost yet — direction is isolated.
    const snappedPt = maybeOrtho(tc.basePt, p);
    tc.preview = {
      type: 'line',
      x1: tc.basePt.x, y1: tc.basePt.y,
      x2: snappedPt.x, y2: snappedPt.y,
    };
    const ang = Math.atan2(snappedPt.y - tc.basePt.y, snappedPt.x - tc.basePt.x) * 180 / Math.PI;
    setTip(`∠ ${ang.toFixed(1)}°`);
  } else if (state.tool === 'stretch' && tc.step === 'distance' && tc.click1 && tc.click2 && tc.basePt) {
    // Project cursor onto the locked direction for the live preview — same
    // math the click-commit path uses.
    let target: Pt;
    if (tc.lockedDir) {
      const v = sub(p, tc.basePt);
      const d = dot(v, tc.lockedDir);
      target = add(tc.basePt, scale(tc.lockedDir, d));
    } else {
      target = maybeOrtho(tc.basePt, p);
    }
    const delta = sub(target, tc.basePt);
    const previews: EntityShape[] = [];
    for (const e of state.entities) {
      const s = stretchEntity(e, tc.click1, tc.click2, delta);
      if (s) previews.push(s as EntityShape);
    }
    tc.preview = { type: 'group', entities: previews };
    setTip(`Abstand ${len(delta).toFixed(2)}`);
  } else if (state.tool === 'stretch' && tc.step === 'target' && tc.click1 && tc.click2 && tc.basePt) {
    // Legacy path (not used by the new flow, but kept for compat).
    const target = maybeOrtho(tc.basePt, p);
    const delta = sub(target, tc.basePt);
    const previews: EntityShape[] = [];
    for (const e of state.entities) {
      const s = stretchEntity(e, tc.click1, tc.click2, delta);
      if (s) previews.push(s as EntityShape);
    }
    tc.preview = { type: 'group', entities: previews };
    setTip(`Δ ${delta.x.toFixed(2)}, ${delta.y.toFixed(2)}`);
  } else if (state.tool === 'divide_xline' && tc.step === 'pick' && tc.radius != null) {
    // Hover over a line/circle/arc/ellipse → preview the xlines that would
    // be emitted. Same geometry as the commit paths above, just into a
    // preview group instead of state.features.
    const hit = hitTest(p);
    const n = tc.radius;
    const previews: EntityShape[] = [];
    let count = 0;
    if (hit && Number.isInteger(n) && n >= 2) {
      if (hit.type === 'line') {
        const l = hit;
        const dx = l.x2 - l.x1, dy = l.y2 - l.y1;
        const L = Math.hypot(dx, dy);
        if (L > 1e-9) {
          const nx = -dy / L, ny = dx / L;
          for (let i = 1; i < n; i++) {
            const t = i / n;
            const px = l.x1 + dx * t;
            const py = l.y1 + dy * t;
            previews.push({ type: 'xline', x1: px, y1: py, dx: nx, dy: ny });
          }
          count = n - 1;
        }
      } else if (hit.type === 'circle' && hit.r > 1e-9) {
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2;
          previews.push({ type: 'xline', x1: hit.cx, y1: hit.cy, dx: Math.cos(a), dy: Math.sin(a) });
        }
        count = n;
      } else if (hit.type === 'arc' && hit.r > 1e-9) {
        let sweep = hit.a2 - hit.a1;
        while (sweep <= 0) sweep += Math.PI * 2;
        if (sweep > Math.PI * 2) sweep -= Math.PI * 2;
        for (let i = 1; i < n; i++) {
          const ang = hit.a1 + sweep * (i / n);
          previews.push({ type: 'xline', x1: hit.cx, y1: hit.cy, dx: Math.cos(ang), dy: Math.sin(ang) });
        }
        count = n - 1;
      } else if (hit.type === 'ellipse' && hit.rx > 1e-9 && hit.ry > 1e-9) {
        const cos = Math.cos(hit.rot), sin = Math.sin(hit.rot);
        for (let i = 0; i < n; i++) {
          const t = (i / n) * Math.PI * 2;
          const lx = Math.cos(t) * hit.rx, ly = Math.sin(t) * hit.ry;
          const ex = lx * cos - ly * sin, ey = lx * sin + ly * cos;
          const L = Math.hypot(ex, ey);
          if (L > 1e-9) previews.push({ type: 'xline', x1: hit.cx, y1: hit.cy, dx: ex / L, dy: ey / L });
        }
        count = previews.length;
      }
    }
    if (previews.length > 0) {
      tc.preview = { type: 'group', entities: previews };
      setTip(`N=${n} → ${count} Hilfslinien`);
    } else {
      tc.preview = null;
      setTip(`N=${n} · Linie/Kreis/Ellipse/Bogen wählen`);
    }
  } else if (state.tool === 'polygon' && tc.step === 'radius' && tc.cx != null && tc.cy != null) {
    const r = dist(p, { x: tc.cx, y: tc.cy });
    if (r > 1e-6) {
      const startAng = Math.atan2(p.y - tc.cy, p.x - tc.cx);
      tc.preview = {
        type: 'polyline',
        pts: polygonPoints(tc.cx, tc.cy, r, lastPolygonSides, startAng),
        closed: true,
      };
      setTip(`n=${lastPolygonSides} · R ${r.toFixed(2)}`);
    }
  } else if (state.tool === 'xline' && tc.step === 'ref') {
    if (snap && (snap.type === 'end' || snap.type === 'mid' || snap.type === 'int' || snap.type === 'center')) {
      setTip('Klick: Hilfslinie durch Snap-Punkt');
    } else {
      setTip('Referenzlinie/-achse/Kante wählen');
    }
  } else if (state.tool === 'xline' && tc.step === 'angle-pt' && tc.p1) {
    const v = sub(p, tc.p1);
    const dir = len(v) < 1e-9 ? { x: 1, y: 0 } : norm(v);
    tc.preview = { type: 'xline', x1: tc.p1.x, y1: tc.p1.y, dx: dir.x, dy: dir.y };
    const ang = Math.atan2(dir.y, dir.x) * 180 / Math.PI;
    setTip(`Hilfslinie durch Punkt · ${ang.toFixed(1)}°`);
  } else if (state.tool === 'xline' && tc.step === 'dist' && tc.base && tc.dir) {
    const off = perpOffset(tc.base, tc.dir, p);
    const n = perp(tc.dir);
    const base = add(tc.base, scale(n, off.dist));
    tc.preview = { type: 'xline', x1: base.x, y1: base.y, dx: tc.dir.x, dy: tc.dir.y };
    setTip(`Abstand ${Math.abs(off.dist).toFixed(2)}`);
  } else if (state.tool === 'offset' && tc.step === 'side' && tc.entities && tc.entities.length > 0) {
    // Delegate to the shared group-offset helper so preview and commit stay
    // in perfect lock-step — especially important for the chained-polygon
    // case where the preview's line endpoints must land on the same
    // intersections the commit produces.
    const shapes = computeGroupOffsetShapes(tc.entities, p, tc.distance);
    const nearest = nearestOffsetInfo(tc.entities, p);
    const d = tc.distance != null ? tc.distance : (nearest?.dist ?? 0);
    if (shapes && shapes.length > 0) {
      tc.preview = { type: 'group', entities: shapes.map(s => s.shape) };
    }
    setTip(`Versatz ${d.toFixed(2)} · ${tc.entities.length} Objekt(e)`);
  } else if ((state.tool === 'move' || state.tool === 'copy') && tc.step === 'target' && tc.basePt) {
    const target = maybeOrtho(tc.basePt, p);
    const delta = sub(target, tc.basePt);
    const previews: EntityShape[] = [];
    for (const id of state.selection) {
      const e = state.entities.find(x => x.id === id);
      if (!e) continue;
      for (const t of transformEntity(e, pt => add(pt, delta), { pureTranslation: true })) {
        previews.push(t as EntityShape);
      }
    }
    tc.preview = { type: 'group', entities: previews };
    setTip(`Δ ${delta.x.toFixed(2)}, ${delta.y.toFixed(2)} · Dist ${len(delta).toFixed(2)}`);
  } else if (state.tool === 'rotate' && tc.step === 'angle' && tc.centerPt) {
    const v = sub(p, tc.centerPt);
    const ang = Math.atan2(v.y, v.x);
    const cos = Math.cos(ang), sin = Math.sin(ang);
    const center = tc.centerPt;
    const fn: TransformFn = (pt) => {
      const dx = pt.x - center.x, dy = pt.y - center.y;
      return { x: center.x + dx * cos - dy * sin, y: center.y + dx * sin + dy * cos };
    };
    const previews: EntityShape[] = [];
    for (const id of state.selection) {
      const e = state.entities.find(x => x.id === id);
      if (!e) continue;
      for (const t of transformEntity(e, fn, { pureTranslation: false })) {
        previews.push(t as EntityShape);
      }
    }
    tc.preview = { type: 'group', entities: previews };
    setTip(`Winkel ${(ang * 180 / Math.PI).toFixed(1)}°`);
  } else if (state.tool === 'fillet' && tc.step === 'pick2'
             && tc.entity1 && tc.click1
             && tc.entity1.type === 'line') {
    // Live-preview using the sticky radius against the hovered partner line.
    // Use raw hitTest (no side effects) — rects only preview once they're
    // exploded on click, same as entity1.
    const hit = hitTest(p);
    const hover = hit && hit.type === 'line' ? hit : null;
    if (hover && hover.id !== tc.entity1.id) {
      const r = lastFilletRadius;
      // If there's already a fillet between these two lines, preview as if
      // we'd re-extended them to the original corner.
      let prevL1 = tc.entity1, prevL2 = hover;
      const existing = findExistingFilletBetween(tc.entity1, hover);
      if (existing) {
        const P = lineIntersectionInfinite(tc.entity1, hover);
        if (P) {
          prevL1 = extendLineEndTo(tc.entity1, existing.l1TrimEnd, P);
          prevL2 = extendLineEndTo(hover, existing.l2TrimEnd, P);
        }
      }
      const result = computeFillet(prevL1, tc.click1, prevL2, p, r);
      if (!('error' in result)) {
        tc.preview = {
          type: 'group',
          entities: [
            { type: 'line', x1: result.newL1.x1, y1: result.newL1.y1, x2: result.newL1.x2, y2: result.newL1.y2 },
            { type: 'line', x1: result.newL2.x1, y1: result.newL2.y1, x2: result.newL2.x2, y2: result.newL2.y2 },
            { type: 'arc', cx: result.arc.type === 'arc' ? result.arc.cx : 0,
              cy: result.arc.type === 'arc' ? result.arc.cy : 0,
              r: result.arc.type === 'arc' ? result.arc.r : 0,
              a1: result.arc.type === 'arc' ? result.arc.a1 : 0,
              a2: result.arc.type === 'arc' ? result.arc.a2 : 0 },
          ],
        };
        setTip(`Radius ${r.toFixed(2)}`);
      }
    }
  } else if (state.tool === 'chamfer' && tc.step === 'pick2'
             && tc.entity1 && tc.click1
             && tc.entity1.type === 'line') {
    // Live-preview using the sticky distance against the hovered partner
    // line — mirror of the fillet preview. Raw hitTest so rects are only
    // previewed once exploded (same as entity1).
    const hit = hitTest(p);
    const hover = hit && hit.type === 'line' ? hit : null;
    if (hover && hover.id !== tc.entity1.id) {
      const d = lastChamferDist;
      const result = computeChamfer(tc.entity1, tc.click1, hover, p, d);
      if (!('error' in result)) {
        tc.preview = {
          type: 'group',
          entities: [
            { type: 'line', x1: result.newL1.x1, y1: result.newL1.y1, x2: result.newL1.x2, y2: result.newL1.y2 },
            { type: 'line', x1: result.newL2.x1, y1: result.newL2.y1, x2: result.newL2.x2, y2: result.newL2.y2 },
            { type: 'line', x1: result.cut.x1,   y1: result.cut.y1,   x2: result.cut.x2,   y2: result.cut.y2   },
          ],
        };
        setTip(`Abstand ${d.toFixed(2)}`);
      }
    }
  } else if (state.tool === 'dim' && tc.click1 && tc.click2 && tc.step === 'place') {
    tc.preview = {
      type: 'dim',
      p1: { x: tc.click1.x, y: tc.click1.y },
      p2: { x: tc.click2.x, y: tc.click2.y },
      offset: { x: p.x, y: p.y },
      textHeight: lastTextHeight,
    };
    setTip(`Distanz ${dist(tc.click1, tc.click2).toFixed(2)}`);
  }
  // Chain / Auto mode — live preview. As the user collects reference
  // points, the preview shows all N-1 dims sharing the cursor's position
  // as the (shared) offset. This gives the "nach jedem Klick bereits eine
  // Bemaßung" feel — every click adds one more ghost dim, the offset floats
  // with the cursor until the user clicks on empty canvas to commit.
  else if (state.tool === 'dim' && (runtime.dimMode === 'chain' || runtime.dimMode === 'auto')
           && tc.step === 'collect' && tc.pts && tc.pts.length >= 2) {
    const dims: EntityShape[] = [];
    for (let i = 1; i < tc.pts.length; i++) {
      dims.push({
        type: 'dim',
        p1: { x: tc.pts[i - 1].x, y: tc.pts[i - 1].y },
        p2: { x: tc.pts[i].x,     y: tc.pts[i].y     },
        offset: { x: p.x, y: p.y },
        textHeight: lastTextHeight,
      });
    }
    tc.preview = { type: 'group', entities: dims };
    setTip(`${tc.pts.length - 1} Bemaßungen · Leere Stelle = Platzieren`);
  } else if (state.tool === 'line_offset' && tc.step === 'side'
             && tc.entity1 && tc.entity1.type === 'line') {
    // Live preview of the offset line (and connectors in 'connect' mode) as
    // the cursor moves. Mirrors applyLineOffsetAt's geometry exactly so the
    // preview lines up 1:1 with what the next click will commit.
    //
    // Angle semantics (new): α = tilt from perpendicular.
    //   α = 0°  → rectangle (connectors perpendicular, on the cursor side).
    //   α > 0° → symmetric trapezoid narrower on the offset side; both
    //            connectors tilt α° inward toward each other.
    //   α < 0° → flared outward, trapezoid wider on the offset side.
    //
    // Base perpendicular direction toward the cursor side is  lineAngle −
    // sign·90°  (see sideSignForOffset for the sign convention). Tilting α°
    // "inward" at endpoint 0 rotates the connector toward endpoint 1, which
    // means reducing its angular distance from the line direction; that's a
    // shift of +sign·α. At endpoint 1, the analogous shift is −sign·α from
    // the opposite perpendicular — keeps the trapezoid symmetric.
    const l = tc.entity1;
    const typedD = tc.distance;
    const rawD = (typedD != null && typedD > 0) ? typedD : perpDistLineToPt(l, p);
    // Past the apex of the two inward-tilting connectors, the offset line
    // flips to the other side — visually broken. Clamp the effective
    // distance to the apex (where both connector tips meet at a point).
    const d = clampLineOffsetDistance(l, rawD,
      runtime.lineOffsetUseAngle ? runtime.lineOffsetAngleDeg : 0);
    if (d > 1e-6) {
      const sign = sideSignForOffset(l, p);
      const lineAngleDeg = Math.atan2(l.y2 - l.y1, l.x2 - l.x1) * 180 / Math.PI;
      const tiltDeg = runtime.lineOffsetUseAngle ? runtime.lineOffsetAngleDeg : 0;
      const a0deg = lineAngleDeg - sign * (90 - tiltDeg);
      const a1deg = lineAngleDeg + 180 + sign * (90 - tiltDeg);
      const a0rad = a0deg * Math.PI / 180;
      const a1rad = a1deg * Math.PI / 180;
      const ax = l.x1 + Math.cos(a0rad) * d;
      const ay = l.y1 + Math.sin(a0rad) * d;
      const bx = l.x2 + Math.cos(a1rad) * d;
      const by = l.y2 + Math.sin(a1rad) * d;
      const shapes: EntityShape[] = [
        { type: 'line', x1: ax, y1: ay, x2: bx, y2: by },
      ];
      if (runtime.lineOffsetMode === 'connect') {
        shapes.push({ type: 'line', x1: l.x1, y1: l.y1, x2: ax, y2: ay });
        shapes.push({ type: 'line', x1: l.x2, y1: l.y2, x2: bx, y2: by });
      }
      tc.preview = { type: 'group', entities: shapes };
      const modeTag = runtime.lineOffsetMode === 'connect' ? ' · Verbinden' : '';
      const angleTag = (runtime.lineOffsetUseAngle && tiltDeg !== 0)
        ? ` · ${tiltDeg}°` : '';
      // If the clamp kicked in, hint to the user that they've reached the
      // apex — the cursor can drag farther but the geometry won't follow.
      const clamped = d < rawD - 1e-6 ? ' (max)' : '';
      setTip(`Versatz ${d.toFixed(2)}${clamped}${modeTag}${angleTag}`);
    } else {
      setTip('Seite mit der Maus bestimmen');
    }
  } else if (state.tool === 'hatch' || state.tool === 'fill') {
    // Hover-preview: highlight the polygon the click would target. Render as
    // a ghost hatch entity — same visual the commit will produce, so the user
    // sees exactly what they're about to create.
    const found = findEnclosingShape(p);
    if (found) {
      const mode: 'solid' | 'lines' = state.tool === 'fill' ? 'solid' : 'lines';
      const holesOpt = found.holes.length > 0 ? { holes: found.holes } : {};
      // If the shared Schraffuren layer already exists, preview on it so the
      // ghost uses the same colour as the committed result. Otherwise fall
      // back to the enclosing-geometry layer — creating the layer on *hover*
      // would feel intrusive (the user hasn't confirmed anything yet).
      const existingHatchLayer = state.layers.findIndex(L => L.name === HATCH_LAYER_NAME);
      const previewLayer = existingHatchLayer >= 0 ? existingHatchLayer : found.layer;
      tc.preview = mode === 'solid'
        ? { type: 'hatch', mode: 'solid', pts: found.poly, layer: previewLayer, ...holesOpt }
        : { type: 'hatch', mode: 'lines', pts: found.poly, layer: previewLayer, ...holesOpt,
            angle: DEFAULT_HATCH_ANGLE, spacing: DEFAULT_HATCH_SPACING };
      const holeTag = found.holes.length ? ` · ${found.holes.length} Aussparung${found.holes.length === 1 ? '' : 'en'}` : '';
      setTip((state.tool === 'hatch' ? 'Schraffieren' : 'Füllen') + `${holeTag} · klicken zum Bestätigen`);
    } else {
      setTip('Cursor in geschlossene Fläche bewegen');
    }
  } else if (state.tool === 'mirror' && tc.step === 'axis2' && tc.a1) {
    const a = tc.a1, b = p;
    const d = norm(sub(b, a));
    if (len(d) > 1e-9) {
      const n = perp(d);
      const fn: TransformFn = (pt) => {
        const rel = sub(pt, a);
        return add(a, add(scale(d, dot(rel, d)), scale(n, -dot(rel, n))));
      };
      const previews: EntityShape[] = [];
      for (const id of state.selection) {
        const e = state.entities.find(x => x.id === id);
        if (!e) continue;
        for (const t of transformEntity(e, fn, { pureTranslation: false })) {
          previews.push(t as EntityShape);
        }
      }
      previews.push({ type: 'line', x1: a.x, y1: a.y, x2: b.x, y2: b.y, layer: state.activeLayer });
      tc.preview = { type: 'group', entities: previews };
    }
  } else if (state.tool === 'cross_mirror' && tc.step === 'center') {
    // Live preview matches the currently selected picker mode (quarter / half
    // horizontal / half vertical), so what the user sees is exactly what will
    // be committed on click. Axes are drawn as guide lines for orientation.
    const c = p;
    const reflect = (ax: Pt): TransformFn => (pt) => {
      const rel = sub(pt, c);
      // reflect over line through c with direction ax: v' = 2*(v·ax)*ax - v
      const proj = dot(rel, ax);
      return {
        x: c.x + 2 * proj * ax.x - rel.x,
        y: c.y + 2 * proj * ax.y - rel.y,
      };
    };
    const rot180: TransformFn = (pt) => ({ x: 2 * c.x - pt.x, y: 2 * c.y - pt.y });
    const mode = runtime.crossMirrorMode;
    const previews: EntityShape[] = [];
    for (const id of state.selection) {
      const e = state.entities.find(x => x.id === id);
      if (!e) continue;
      if (mode === 'quarter') {
        for (const t of transformEntity(e, reflect({ x: 1, y: 0 }), { pureTranslation: false })) previews.push(t as EntityShape);
        for (const t of transformEntity(e, reflect({ x: 0, y: 1 }), { pureTranslation: false })) previews.push(t as EntityShape);
        for (const t of transformEntity(e, rot180, { pureTranslation: false })) previews.push(t as EntityShape);
      } else if (mode === 'half_h') {
        // axis (0,1) = vertical → reflection flips x (left↔right)
        for (const t of transformEntity(e, reflect({ x: 0, y: 1 }), { pureTranslation: false })) previews.push(t as EntityShape);
      } else {
        // axis (1,0) = horizontal → reflection flips y (top↕bottom)
        for (const t of transformEntity(e, reflect({ x: 1, y: 0 }), { pureTranslation: false })) previews.push(t as EntityShape);
      }
    }
    // Dashed axis hints — length scaled so they stay readable at any zoom.
    const len = 60 / (state.view.scale || 1);
    if (mode === 'quarter' || mode === 'half_v') {
      // Horizontal line through centre (the mirror axis for half_v).
      previews.push({ type: 'line', x1: c.x - len, y1: c.y, x2: c.x + len, y2: c.y, layer: state.activeLayer });
    }
    if (mode === 'quarter' || mode === 'half_h') {
      // Vertical line through centre (the mirror axis for half_h).
      previews.push({ type: 'line', x1: c.x, y1: c.y - len, x2: c.x, y2: c.y + len, layer: state.activeLayer });
    }
    tc.preview = { type: 'group', entities: previews };
  }
}

// ---------------- Fillet ----------------

/**
 * Rebuild a LineFeature trimmed at one end (as fillet/chamfer do) while
 * preserving the other end's original PointRef. Without this helper the
 * naïve `replaceFeatureFromInit` rebuilds the whole line with absolute
 * coordinates — obliterating any parametric bindings the line carried
 * (e.g. the polar refs that tie a rectangle's edges to width/height
 * variables). Only the cut end becomes an absolute point; the kept end
 * keeps its endpoint/center/polar/… ref, so changing the underlying
 * variable still moves the kept end and the line follows.
 *
 * `keptEnd` is the original end that survives the trim (0 or 1 on the
 * pre-trim LineFeature). `newCutPt` is the new (tangent) endpoint in
 * world coordinates.
 *
 * Returns true if the feature was updated; false if the id wasn't a
 * line feature (caller should fall back to the absolutising path).
 */
function replaceLineEndPreservingRef(
  featureId: string,
  keptEnd: 0 | 1,
  newCutPt: Pt,
  layer: number,
  /**
   * Optional parametric override for the NEW cut end. When the cut was
   * produced by an intersecting feature (trim / extend-to-target), the
   * caller can pass an `intersection`/`endpoint` ref here so the cut end
   * keeps tracking that other feature — otherwise we fall back to a flat
   * abs coordinate and the link is lost. Only used when `runtime
   * .parametricMode` is on; in free-draw mode we always emit abs so the
   * "no chains" contract holds.
   */
  cutRefOverride?: PointRef | null,
): boolean {
  const idx = state.features.findIndex(f => f.id === featureId);
  if (idx < 0) return false;
  const prev = state.features[idx];
  if (prev.kind !== 'line') return false;
  const keptRef = keptEnd === 0 ? prev.p1 : prev.p2;
  const useOverride = !!cutRefOverride && runtime.parametricMode
    && cutRefOverride.kind !== 'abs';
  const cutRef: PointRef = useOverride
    ? cutRefOverride as PointRef
    : { kind: 'abs', x: numE(newCutPt.x), y: numE(newCutPt.y) };
  const next: LineFeature = {
    id: prev.id,
    kind: 'line',
    layer,
    p1: keptEnd === 0 ? keptRef : cutRef,
    p2: keptEnd === 0 ? cutRef : keptRef,
  };
  state.features[idx] = next;
  return true;
}

/**
 * Given the pre-fillet/pre-chamfer line entity and the coordinate that
 * the trim preserved, figure out which feature-side (p1 or p2) was the
 * kept end. Compares positions in world space, so works regardless of
 * how the original feature stored its points (abs / polar / endpoint).
 */
function keptEndOfLine(old: LineEntity, keptPt: Pt): 0 | 1 {
  const d0 = Math.hypot(old.x1 - keptPt.x, old.y1 - keptPt.y);
  const d1 = Math.hypot(old.x2 - keptPt.x, old.y2 - keptPt.y);
  return d0 <= d1 ? 0 : 1;
}

let lastFilletRadius = 10;

export function setFilletRadius(r: number): void { lastFilletRadius = r; }
export function getFilletRadius(): number { return lastFilletRadius; }

// Sticky default for the Linie-teilen tool. Activation preloads this into
// toolCtx so the user can immediately click a line without re-entering N
// each time. commitDivideXLine persists the last committed value here.
let lastDivideCount = 2;

export function setDivideCount(n: number): void { lastDivideCount = n; }
export function getDivideCount(): number { return lastDivideCount; }

function lineIntersectionInfinite(a: { x1: number; y1: number; x2: number; y2: number }, b: { x1: number; y1: number; x2: number; y2: number }): Pt | null {
  const den = (a.x1 - a.x2) * (b.y1 - b.y2) - (a.y1 - a.y2) * (b.x1 - b.x2);
  if (Math.abs(den) < 1e-9) return null;
  const t = ((a.x1 - b.x1) * (b.y1 - b.y2) - (a.y1 - b.y1) * (b.x1 - b.x2)) / den;
  return { x: a.x1 + t * (a.x2 - a.x1), y: a.y1 + t * (a.y2 - a.y1) };
}

function computeFillet(l1: LineEntity, click1: Pt, l2: LineEntity, click2: Pt, r: number):
  | { newL1: LineEntity; newL2: LineEntity; arc: EntityInit; t1: Pt; t2: Pt }
  | { error: string }
{
  const P = lineIntersectionInfinite(l1, l2);
  if (!P) return { error: 'Linien sind parallel' };

  // Keep the endpoint on the same side of P as the click. Using dist-to-click
  // breaks when the click sits at the segment midpoint and one endpoint IS P
  // (common for rect edges meeting at the picked corner).
  const a1 = { x: l1.x1, y: l1.y1 }, b1 = { x: l1.x2, y: l1.y2 };
  const a2 = { x: l2.x1, y: l2.y1 }, b2 = { x: l2.x2, y: l2.y2 };
  const d1 = sub(click1, P), d2 = sub(click2, P);
  const kept1 = dot(sub(a1, P), d1) > dot(sub(b1, P), d1) ? a1 : b1;
  const kept2 = dot(sub(a2, P), d2) > dot(sub(b2, P), d2) ? a2 : b2;

  const u1 = norm(sub(kept1, P));
  const u2 = norm(sub(kept2, P));
  if (len(u1) < 1e-9 || len(u2) < 1e-9) return { error: 'Linie zu kurz' };

  const cosA = Math.max(-1, Math.min(1, dot(u1, u2)));
  const angle = Math.acos(cosA);
  if (angle < 1e-4 || angle > Math.PI - 1e-4) return { error: 'Linien sind kollinear oder parallel' };

  const half = angle / 2;
  const t = r / Math.tan(half);
  const cDist = r / Math.sin(half);
  // Constraint: t ≤ dist(P, keptN) → r ≤ tan(half) * dist(P, keptN).
  // Report the binding limit so the user knows what value would still fit.
  const maxR1 = Math.tan(half) * dist(P, kept1);
  const maxR2 = Math.tan(half) * dist(P, kept2);
  const rMax = Math.min(maxR1, maxR2);
  if (t > dist(P, kept1) - 1e-6) {
    return { error: `Radius zu groß für Linie 1 (max ${rMax.toFixed(2)})` };
  }
  if (t > dist(P, kept2) - 1e-6) {
    return { error: `Radius zu groß für Linie 2 (max ${rMax.toFixed(2)})` };
  }

  const T1 = add(P, scale(u1, t));
  const T2 = add(P, scale(u2, t));
  const bis = norm(add(u1, u2));
  const C = add(P, scale(bis, cDist));

  let aa1 = Math.atan2(T1.y - C.y, T1.x - C.x);
  let aa2 = Math.atan2(T2.y - C.y, T2.x - C.x);
  const twoPi = Math.PI * 2;
  const normA = (x: number) => ((x % twoPi) + twoPi) % twoPi;
  // Pick the short sweep (the fillet arc never exceeds π).
  if (normA(aa2 - aa1) > Math.PI) { const tmp = aa1; aa1 = aa2; aa2 = tmp; }

  const newL1: LineEntity = { ...l1, x1: kept1.x, y1: kept1.y, x2: T1.x, y2: T1.y };
  const newL2: LineEntity = { ...l2, x1: kept2.x, y1: kept2.y, x2: T2.x, y2: T2.y };
  const arc: EntityInit = { type: 'arc', cx: C.x, cy: C.y, r, a1: aa1, a2: aa2, layer: l1.layer };
  return { newL1, newL2, arc, t1: T1, t2: T2 };
}

/**
 * Determine which endpoint of `line` is the "cut" (corner-adjacent) end given
 * the click position and the lines' mutual intersection P.
 * Returns 1 (x1,y1 is cut) or 2 (x2,y2 is cut) — matching FilletFeature /
 * ChamferFeature convention.
 */
function pickLineCutEnd(line: LineEntity, clickPt: Pt, P: Pt): 1 | 2 {
  const a = { x: line.x1, y: line.y1 };
  const b = { x: line.x2, y: line.y2 };
  const d = sub(clickPt, P);
  // The kept endpoint is the one on the same side of P as the click.
  const keptIsA = dot(sub(a, P), d) > dot(sub(b, P), d);
  // If A (x1,y1) is kept → x2,y2 is cut → cut end = 2.
  return keptIsA ? 2 : 1;
}

/**
 * Find an existing FilletFeature that references both `fid1` and `fid2` as
 * its source lines.  Used to detect "re-fillet" so we can update the radius
 * in-place instead of stacking a second FilletFeature.
 */
function findExistingFilletFeature(
  fid1: string, fid2: string,
): Feature & { kind: 'fillet' } | null {
  for (const f of state.features) {
    if (f.kind !== 'fillet') continue;
    if ((f.line1Id === fid1 && f.line2Id === fid2) ||
        (f.line1Id === fid2 && f.line2Id === fid1)) {
      return f;
    }
  }
  return null;
}

/**
 * Find an existing ChamferFeature that references both `fid1` and `fid2`.
 */
function findExistingChamferFeature(
  fid1: string, fid2: string,
): Feature & { kind: 'chamfer' } | null {
  for (const f of state.features) {
    if (f.kind !== 'chamfer') continue;
    if ((f.line1Id === fid1 && f.line2Id === fid2) ||
        (f.line1Id === fid2 && f.line2Id === fid1)) {
      return f;
    }
  }
  return null;
}

/** Rect → 4 line EntityInits (caller is responsible for feature wiring). */
function explodeRect(r: RectEntity): EntityInit[] {
  const xl = Math.min(r.x1, r.x2), xr = Math.max(r.x1, r.x2);
  const yb = Math.min(r.y1, r.y2), yt = Math.max(r.y1, r.y2);
  const mk = (x1: number, y1: number, x2: number, y2: number): EntityInit => ({
    layer: r.layer, type: 'line', x1, y1, x2, y2,
  });
  return [
    mk(xl, yb, xr, yb),
    mk(xr, yb, xr, yt),
    mk(xr, yt, xl, yt),
    mk(xl, yt, xl, yb),
  ];
}

/** Resolve a click into a LineEntity — either a line hit directly, or a rect
 *  whose edge was clicked (the rect is exploded into 4 line features). */
function pickFilletLine(worldPt: Pt): LineEntity | null {
  const hit = hitTest(worldPt);
  if (!hit) { toast('Linie oder Rechteck wählen'); return null; }
  if (hit.type === 'line') return hit;
  if (hit.type === 'rect') {
    pushUndo();
    const rectFid = featureForEntity(hit.id)?.id;
    const lineInits = explodeRect(hit);
    if (rectFid) {
      // Route through deleteFeatures so dependents (dims on the rect's corners,
      // points snapped to its edges, mirrors using it as source) survive: the
      // rect becomes hidden if anyone references it, and its ctx entry keeps
      // their PointRefs resolvable. A plain orphan rect is removed outright.
      // Without this, filleting a rect edge silently breaks every parametric
      // link that pointed at the rect.
      deleteFeatures([rectFid]);
    }
    const newFids: string[] = [];
    for (const init of lineInits) {
      const f = featureFromEntityInit(init);
      state.features.push(f);
      newFids.push(f.id);
    }
    evaluateTimeline();
    let best: LineEntity | null = null;
    let bestD = Infinity;
    for (const fid of newFids) {
      const eid = entityIdForFeature(fid);
      if (eid === null) continue;
      const ent = state.entities.find(e => e.id === eid);
      if (!ent || ent.type !== 'line') continue;
      const d = distPtSeg(worldPt, { x: ent.x1, y: ent.y1 }, { x: ent.x2, y: ent.y2 });
      if (d < bestD) { bestD = d; best = ent; }
    }
    return best;
  }
  toast('Linie oder Rechteck wählen');
  return null;
}

/**
 * Detect whether l1 and l2 are already joined by an existing fillet arc —
 * i.e. some arc whose endpoints coincide with one endpoint of l1 and one
 * endpoint of l2. If so, return the arc plus which ends of l1/l2 are the
 * "trimmed" ends (those touching the arc). Used to let the user re-fillet
 * a corner with a new radius without stacking a second arc on top.
 */
function findExistingFilletBetween(l1: LineEntity, l2: LineEntity): {
  arcFeatureId: string;
  l1TrimEnd: 1 | 2;
  l2TrimEnd: 1 | 2;
} | null {
  const EPS = 1e-3;
  const endMatch = (pt: Pt, l: LineEntity): 1 | 2 | null => {
    if (Math.hypot(pt.x - l.x1, pt.y - l.y1) < EPS) return 1;
    if (Math.hypot(pt.x - l.x2, pt.y - l.y2) < EPS) return 2;
    return null;
  };
  for (const ent of state.entities) {
    if (ent.type !== 'arc') continue;
    const p1 = { x: ent.cx + ent.r * Math.cos(ent.a1), y: ent.cy + ent.r * Math.sin(ent.a1) };
    const p2 = { x: ent.cx + ent.r * Math.cos(ent.a2), y: ent.cy + ent.r * Math.sin(ent.a2) };
    let e1 = endMatch(p1, l1);
    let e2 = endMatch(p2, l2);
    if (!e1 || !e2) { e1 = endMatch(p2, l1); e2 = endMatch(p1, l2); }
    if (!e1 || !e2) continue;
    const f = featureForEntity(ent.id);
    if (!f) continue;
    return { arcFeatureId: f.id, l1TrimEnd: e1, l2TrimEnd: e2 };
  }
  return null;
}

/**
 * Return a copy of `l` whose `end` (1 or 2) is moved to point `p`. Used to
 * "undo" a previous fillet trim by snapping the trimmed endpoint back to the
 * original line-line intersection before re-computing with a new radius.
 */
function extendLineEndTo(l: LineEntity, end: 1 | 2, p: Pt): LineEntity {
  return end === 1
    ? { ...l, x1: p.x, y1: p.y }
    : { ...l, x2: p.x, y2: p.y };
}

function handleFilletClick(worldPt: Pt): void {
  const tc = runtime.toolCtx;
  if (!tc) return;
  if (tc.step === 'pick1') {
    const line = pickFilletLine(worldPt);
    if (!line) return;
    tc.entity1 = line;
    tc.click1 = worldPt;
    state.selection.clear();
    state.selection.add(line.id);
    updateSelStatus();
    tc.step = 'pick2';
    setPrompt(`Zweite Linie wählen (Radius=${lastFilletRadius})`);
    render();
    return;
  }
  if (tc.step === 'pick2') {
    const line = pickFilletLine(worldPt);
    if (!line) return;
    if (line.id === tc.entity1?.id) { toast('Andere Linie wählen'); return; }
    tc.entity2 = line;
    tc.click2 = worldPt;
    state.selection.add(line.id);
    updateSelStatus();
    // Sticky radius: apply immediately with the last-entered value. The user
    // can change it any time via the command bar — the next fillet uses the
    // new value. No "click-to-size" step here.
    applyFillet(lastFilletRadius);
    return;
  }
}

/** Invoked by the command line — `handleCommand` forwards a bare number here. */
export function applyFillet(radius: number): void {
  const tc = runtime.toolCtx;
  if (!tc || state.tool !== 'fillet') return;
  const l1 = tc.entity1, c1 = tc.click1, l2 = tc.entity2, c2 = tc.click2;
  if (!l1 || l1.type !== 'line' || !c1 || !l2 || l2.type !== 'line' || !c2) {
    toast('Erst zwei Linien wählen');
    return;
  }
  if (radius <= 0) { toast('Radius muss > 0 sein'); return; }

  const f1 = featureForEntity(l1.id);
  const f2 = featureForEntity(l2.id);
  const resetPick = () => {
    runtime.toolCtx = { step: 'pick1' };
    state.selection.clear();
    updateSelStatus();
    setPrompt('Erste Linie wählen');
    render();
  };

  // ── Case A: both sub-entities of the SAME FilletFeature → update radius ──
  if (f1 && f2 && f1.id === f2.id && f1.kind === 'fillet') {
    pushUndo();
    f1.radius = radius;
    lastFilletRadius = radius;
    evaluateTimeline({ changedFeatures: [f1.id] });
    updateStats();
    resetPick();
    return;
  }

  // ── Case B: plain line features → create non-destructive FilletFeature ───
  if (f1 && f1.kind === 'line' && f2 && f2.kind === 'line') {
    // Check for an existing FilletFeature between these two source lines and
    // delete it first so we don't stack a second one on top (re-fillet corner).
    const existingFillet = findExistingFilletFeature(f1.id, f2.id);
    if (existingFillet) {
      // Validate geometry with the full source lines before committing.
      const result = computeFillet(l1, c1, l2, c2, radius);
      if ('error' in result) { toast(result.error); resetPick(); return; }
      pushUndo();
      // Delete old FilletFeature — deleteFeatures cascade will unhide sources.
      deleteFeatures([existingFillet.id]);
    } else {
      const result = computeFillet(l1, c1, l2, c2, radius);
      if ('error' in result) { toast(result.error); resetPick(); return; }
      pushUndo();
    }

    const P = lineIntersectionInfinite(l1, l2);
    if (!P) { toast('Linien sind parallel'); return; }
    const cut1End = pickLineCutEnd(l1, c1, P);
    const cut2End = pickLineCutEnd(l2, c2, P);

    lastFilletRadius = radius;
    // Hide both source lines.
    const srcF1 = state.features.find(f => f.id === f1.id);
    const srcF2 = state.features.find(f => f.id === f2.id);
    if (srcF1) srcF1.hidden = true;
    if (srcF2) srcF2.hidden = true;
    // Push FilletFeature — evaluator produces trimmed l1, l2, and arc.
    state.features.push({
      id: newFeatureId(),
      kind: 'fillet',
      layer: l1.layer,
      line1Id: f1.id,
      line2Id: f2.id,
      cut1End,
      cut2End,
      radius,
    } as Feature);
    evaluateTimeline();
    updateStats();
    resetPick();
    return;
  }

  // ── Case C: unsupported configuration (sub-entity of a different modifier)
  toast('Verrundung nur zwischen zwei einfachen Linien oder Rechteck-Kanten möglich');
  resetPick();
}

// ---------------- Chamfer ----------------

let lastChamferDist = 10;

export function setChamferDist(d: number): void { lastChamferDist = d; }
export function getChamferDist(): number { return lastChamferDist; }

function computeChamfer(l1: LineEntity, click1: Pt, l2: LineEntity, click2: Pt, d: number):
  | { newL1: LineEntity; newL2: LineEntity; cut: LineEntity; t1: Pt; t2: Pt }
  | { error: string }
{
  const P = lineIntersectionInfinite(l1, l2);
  if (!P) return { error: 'Linien sind parallel' };
  const a1 = { x: l1.x1, y: l1.y1 }, b1 = { x: l1.x2, y: l1.y2 };
  const a2 = { x: l2.x1, y: l2.y1 }, b2 = { x: l2.x2, y: l2.y2 };
  const d1 = sub(click1, P), d2 = sub(click2, P);
  const kept1 = dot(sub(a1, P), d1) > dot(sub(b1, P), d1) ? a1 : b1;
  const kept2 = dot(sub(a2, P), d2) > dot(sub(b2, P), d2) ? a2 : b2;
  const u1 = norm(sub(kept1, P));
  const u2 = norm(sub(kept2, P));
  if (len(u1) < 1e-9 || len(u2) < 1e-9) return { error: 'Linie zu kurz' };
  const cosA = Math.max(-1, Math.min(1, dot(u1, u2)));
  const angle = Math.acos(cosA);
  if (angle < 1e-4 || angle > Math.PI - 1e-4) return { error: 'Linien sind kollinear oder parallel' };
  if (d > dist(P, kept1) - 1e-6) return { error: 'Abstand zu groß für Linie 1' };
  if (d > dist(P, kept2) - 1e-6) return { error: 'Abstand zu groß für Linie 2' };
  const T1 = add(P, scale(u1, d));
  const T2 = add(P, scale(u2, d));
  const newL1: LineEntity = { ...l1, x1: kept1.x, y1: kept1.y, x2: T1.x, y2: T1.y };
  const newL2: LineEntity = { ...l2, x1: kept2.x, y1: kept2.y, x2: T2.x, y2: T2.y };
  const cut: LineEntity = { id: 0, layer: l1.layer, type: 'line', x1: T1.x, y1: T1.y, x2: T2.x, y2: T2.y };
  return { newL1, newL2, cut, t1: T1, t2: T2 };
}

function handleChamferClick(worldPt: Pt): void {
  const tc = runtime.toolCtx;
  if (!tc) return;
  if (tc.step === 'pick1') {
    const line = pickFilletLine(worldPt);
    if (!line) return;
    tc.entity1 = line;
    tc.click1 = worldPt;
    state.selection.clear();
    state.selection.add(line.id);
    updateSelStatus();
    tc.step = 'pick2';
    setPrompt(`Zweite Linie wählen (Abstand=${lastChamferDist})`);
    render();
    return;
  }
  if (tc.step === 'pick2') {
    const line = pickFilletLine(worldPt);
    if (!line) return;
    if (line.id === tc.entity1?.id) { toast('Andere Linie wählen'); return; }
    tc.entity2 = line;
    tc.click2 = worldPt;
    state.selection.add(line.id);
    updateSelStatus();
    // Sticky distance: apply immediately using the value set in the top
    // panel (lastChamferDist). Matches the fillet tool's "no click-to-size"
    // semantics — the top panel is the single source of truth for the
    // chamfer amount, clicking a line never overrides it.
    applyChamfer(lastChamferDist);
    return;
  }
}

/** Invoked by the command line — `handleCommand` forwards a bare number here. */
export function applyChamfer(distance: number): void {
  const tc = runtime.toolCtx;
  if (!tc || state.tool !== 'chamfer') return;
  const l1 = tc.entity1, c1 = tc.click1, l2 = tc.entity2, c2 = tc.click2;
  if (!l1 || l1.type !== 'line' || !c1 || !l2 || l2.type !== 'line' || !c2) {
    toast('Erst zwei Linien wählen');
    return;
  }
  if (distance <= 0) { toast('Abstand muss > 0 sein'); return; }

  const f1 = featureForEntity(l1.id);
  const f2 = featureForEntity(l2.id);
  const resetPick = () => {
    runtime.toolCtx = { step: 'pick1' };
    state.selection.clear();
    updateSelStatus();
    setPrompt('Erste Linie wählen');
    render();
  };

  // ── Case A: both sub-entities of the SAME ChamferFeature → update distance
  if (f1 && f2 && f1.id === f2.id && f1.kind === 'chamfer') {
    pushUndo();
    f1.distance = distance;
    lastChamferDist = distance;
    evaluateTimeline({ changedFeatures: [f1.id] });
    updateStats();
    resetPick();
    return;
  }

  // ── Case B: plain line features → create non-destructive ChamferFeature ──
  if (f1 && f1.kind === 'line' && f2 && f2.kind === 'line') {
    const result = computeChamfer(l1, c1, l2, c2, distance);
    if ('error' in result) { toast(result.error); resetPick(); return; }

    const existingChamfer = findExistingChamferFeature(f1.id, f2.id);
    if (existingChamfer) {
      pushUndo();
      deleteFeatures([existingChamfer.id]);
    } else {
      pushUndo();
    }

    const P = lineIntersectionInfinite(l1, l2);
    if (!P) { toast('Linien sind parallel'); return; }
    const cut1End = pickLineCutEnd(l1, c1, P);
    const cut2End = pickLineCutEnd(l2, c2, P);

    lastChamferDist = distance;
    const srcF1 = state.features.find(f => f.id === f1.id);
    const srcF2 = state.features.find(f => f.id === f2.id);
    if (srcF1) srcF1.hidden = true;
    if (srcF2) srcF2.hidden = true;
    state.features.push({
      id: newFeatureId(),
      kind: 'chamfer',
      layer: l1.layer,
      line1Id: f1.id,
      line2Id: f2.id,
      cut1End,
      cut2End,
      distance,
    } as Feature);
    evaluateTimeline();
    updateStats();
    resetPick();
    return;
  }

  // ── Case C: unsupported
  toast('Fase nur zwischen zwei einfachen Linien oder Rechteck-Kanten möglich');
  resetPick();
}

// ---------------- Extend ----------------

function handleExtendClick(worldPt: Pt): void {
  const hit = hitTest(worldPt);
  if (!hit) { toast('Nichts getroffen'); return; }
  if (hit.type !== 'line') { toast('Nur Linien können verlängert werden'); return; }
  const a: Pt = { x: hit.x1, y: hit.y1 };
  const b: Pt = { x: hit.x2, y: hit.y2 };
  const dA = dist(worldPt, a), dB = dist(worldPt, b);
  const anchor = dA > dB ? a : b;
  const endpoint = dA > dB ? b : a;
  const dir = norm(sub(endpoint, anchor));
  if (len(dir) < 1e-9) return;
  const dists = extendCutterDistances(endpoint, dir, hit.id);
  const positive = dists.filter(c => c.d > 1e-6).sort((x, y) => x.d - y.d);
  if (!positive.length) { toast('Kein Ziel zum Verlängern gefunden'); return; }
  const hitTarget = positive[0];
  const d = hitTarget.d;
  const newEnd: Pt = { x: endpoint.x + dir.x * d, y: endpoint.y + dir.y * d };
  pushUndo();
  const fid = featureForEntity(hit.id)?.id;
  if (!fid) return;
  const newLine: LineEntity = dA > dB
    ? { ...hit, x2: newEnd.x, y2: newEnd.y }
    : { ...hit, x1: newEnd.x, y1: newEnd.y };
  // Preserve the anchor end's PointRef (anchor is the end that stays put;
  // `newEnd` is the extended end). The extended end becomes an
  // `intersection` ref tying our line to the target feature — so if the
  // target later moves (variable change), the extended end tracks it.
  const anchorEnd = keptEndOfLine(hit, anchor);
  const targetFid = featureForEntity(hitTarget.entityId)?.id ?? null;
  const cutterEntity = hitTarget.entityId != null
    ? state.entities.find(e => e.id === hitTarget.entityId) ?? null
    : null;
  // Parametric cut end: ray from anchor at current direction, hitting the
  // target feature's edge. `rayHit` (not `intersection`) because the latter
  // would self-reference this line's own feature — NaN on next eval.
  const prevFeat = state.features.find(f => f.id === fid);
  const keptRef = (prevFeat && prevFeat.kind === 'line')
    ? (anchorEnd === 0 ? prevFeat.p1 : prevFeat.p2)
    : null;
  const cutRefOverride: PointRef | null = (targetFid && cutterEntity && keptRef)
    ? buildRayHitCutOverride(keptRef, anchor, newEnd, cutterEntity, targetFid)
    : null;
  if (!replaceLineEndPreservingRef(fid, anchorEnd, newEnd, hit.layer, cutRefOverride)) {
    replaceFeatureFromInit(fid, entityInit(newLine));
  }
  evaluateTimeline();
  render();
}

// ---------------- Extend/Shorten to target line ----------------

/**
 * Two-click modifier: pick a source line near the end you want to move, then
 * pick a target line. The picked end is moved to the infinite-line intersection
 * with the target — extending the source if the target is past the endpoint,
 * or shortening it if the target crosses between the endpoints. Preserves the
 * opposite end's PointRef and sets the moved end to an `intersection` ref so
 * the source tracks the target when variables later shift either line.
 */
function handleExtendToClick(worldPt: Pt): void {
  const tc = runtime.toolCtx;
  if (!tc) return;
  if (tc.step === 'pick1') {
    const line = pickFilletLine(worldPt);
    if (!line) return;
    tc.entity1 = line;
    tc.click1 = worldPt;
    state.selection.clear();
    state.selection.add(line.id);
    updateSelStatus();
    tc.step = 'pick2';
    setPrompt('Ziel-Linie wählen');
    render();
    return;
  }
  if (tc.step === 'pick2') {
    const src = tc.entity1;
    const clk = tc.click1;
    if (!src || src.type !== 'line' || !clk) { toast('Erst Quelllinie wählen'); return; }
    // Target can be a regular line, an exploded-rect edge, or an infinite
    // xline (Hilfslinie). `pickFilletLine` handles the first two (it also
    // explodes a hit rect into line features), so we only need to take the
    // xline case directly off `hitTest`.
    const directHit = hitTest(worldPt);
    let tgt: Entity | null = null;
    if (directHit && directHit.type === 'xline') {
      tgt = directHit;
    } else {
      tgt = pickFilletLine(worldPt);
    }
    if (!tgt) return;
    if (tgt.id === src.id) { toast('Andere Linie wählen'); return; }
    if (tgt.type !== 'line' && tgt.type !== 'xline') {
      toast('Ziel muss eine Linie oder Hilfslinie sein'); return;
    }

    // `lineIntersectionInfinite` wants two endpoints; an xline is stored as
    // point + direction, so synthesize a second point along its direction.
    const tgtSeg = tgt.type === 'xline'
      ? { x1: tgt.x1, y1: tgt.y1, x2: tgt.x1 + tgt.dx, y2: tgt.y1 + tgt.dy }
      : { x1: tgt.x1, y1: tgt.y1, x2: tgt.x2, y2: tgt.y2 };
    const ip = lineIntersectionInfinite(src, tgtSeg);
    if (!ip) { toast('Linien sind parallel'); return; }

    const a: Pt = { x: src.x1, y: src.y1 };
    const b: Pt = { x: src.x2, y: src.y2 };
    // The end closer to the first click is the one that moves; the other stays.
    const dA = dist(clk, a), dB = dist(clk, b);
    const movingPt = dA < dB ? a : b;
    const anchorPt = dA < dB ? b : a;
    if (dist(movingPt, ip) < 1e-9) {
      toast('Endpunkt liegt bereits auf der Ziellinie');
      runtime.toolCtx = { step: 'pick1' };
      state.selection.clear();
      updateSelStatus();
      setPrompt('Linie am zu verlängernden/verkürzenden Ende anklicken');
      render();
      return;
    }
    if (dist(anchorPt, ip) < 1e-9) {
      toast('Zielschnittpunkt fällt mit dem Ankerende zusammen');
      return;
    }

    const fid = featureForEntity(src.id)?.id;
    if (!fid) return;
    const targetFid = featureForEntity(tgt.id)?.id ?? null;
    const anchorEnd = keptEndOfLine(src, anchorPt);
    // Parametric cut end via `rayHit` (see `handleExtendClick` for the
    // self-reference rationale — `intersection(self, cutter)` would evaluate
    // to NaN on the next timeline re-run and drop the line).
    const prevFeat = state.features.find(f => f.id === fid);
    const keptRef = (prevFeat && prevFeat.kind === 'line')
      ? (anchorEnd === 0 ? prevFeat.p1 : prevFeat.p2)
      : null;
    const cutRefOverride: PointRef | null = (targetFid && keptRef)
      ? buildRayHitCutOverride(keptRef, anchorPt, ip, tgt, targetFid)
      : null;

    pushUndo();
    if (!replaceLineEndPreservingRef(fid, anchorEnd, ip, src.layer, cutRefOverride)) {
      // Defensive fallback — should never hit because we verified src.type === 'line'.
      const newLine: LineEntity = anchorEnd === 0
        ? { ...src, x2: ip.x, y2: ip.y }
        : { ...src, x1: ip.x, y1: ip.y };
      replaceFeatureFromInit(fid, entityInit(newLine));
    }
    evaluateTimeline();
    updateStats();
    state.selection.clear();
    updateSelStatus();
    runtime.toolCtx = { step: 'pick1' };
    setPrompt('Linie am zu verlängernden/verkürzenden Ende anklicken');
    render();
    return;
  }
}

/** Distances along a ray from `origin` in unit-direction `dir` where the ray
 *  hits any other entity, paired with the hit entity's id so the caller can
 *  build a parametric intersection ref for the extended end. The ray is
 *  built as a very long segment so the existing segSegT/lineCircleT helpers
 *  (which clamp to [0,1]) work unchanged. */
function extendCutterDistances(origin: Pt, dir: Pt, selfId: number): { d: number; entityId: number }[] {
  const HUGE = 1e6;
  const a = origin;
  const b: Pt = { x: origin.x + dir.x * HUGE, y: origin.y + dir.y * HUGE };
  const out: { d: number; entityId: number }[] = [];
  for (const e of state.entities) {
    if (e.id === selfId) continue;
    const layer = state.layers[e.layer];
    if (!layer || !layer.visible) continue;
    if (e.type === 'line') {
      const t = segSegT(a, b, { x: e.x1, y: e.y1 }, { x: e.x2, y: e.y2 });
      if (t !== null) out.push({ d: t * HUGE, entityId: e.id });
    } else if (e.type === 'xline') {
      const t = segSegT(a, b, { x: e.x1, y: e.y1 }, { x: e.x1 + e.dx, y: e.y1 + e.dy }, true);
      if (t !== null) out.push({ d: t * HUGE, entityId: e.id });
    } else if (e.type === 'rect') {
      const xl = Math.min(e.x1, e.x2), xr = Math.max(e.x1, e.x2);
      const yb = Math.min(e.y1, e.y2), yt = Math.max(e.y1, e.y2);
      const edges: [Pt, Pt][] = [
        [{ x: xl, y: yb }, { x: xr, y: yb }],
        [{ x: xr, y: yb }, { x: xr, y: yt }],
        [{ x: xr, y: yt }, { x: xl, y: yt }],
        [{ x: xl, y: yt }, { x: xl, y: yb }],
      ];
      for (const [p1, p2] of edges) {
        const t = segSegT(a, b, p1, p2);
        if (t !== null) out.push({ d: t * HUGE, entityId: e.id });
      }
    } else if (e.type === 'circle') {
      for (const t of lineCircleT(a, b, { x: e.cx, y: e.cy }, e.r)) out.push({ d: t * HUGE, entityId: e.id });
    } else if (e.type === 'arc') {
      for (const t of lineCircleT(a, b, { x: e.cx, y: e.cy }, e.r)) {
        const px = a.x + (b.x - a.x) * t, py = a.y + (b.y - a.y) * t;
        const ang = Math.atan2(py - e.cy, px - e.cx);
        if (angleInSweep(ang, e.a1, e.a2)) out.push({ d: t * HUGE, entityId: e.id });
      }
    } else if (e.type === 'polyline') {
      for (let i = 0; i < e.pts.length - 1; i++) {
        const t = segSegT(a, b, e.pts[i], e.pts[i + 1]);
        if (t !== null) out.push({ d: t * HUGE, entityId: e.id });
      }
      if (e.closed && e.pts.length >= 2) {
        const t = segSegT(a, b, e.pts[e.pts.length - 1], e.pts[0]);
        if (t !== null) out.push({ d: t * HUGE, entityId: e.id });
      }
    }
  }
  return out;
}

// ---------------- Text ----------------
//
// Single unified placement flow: every text sits in a frame.
//   - Single click   → auto-sized default frame (~240 screen px wide)
//   - Click + drag   → explicit frame width from the drag rectangle
// Both paths open the same inline editor; the only difference is how
// `boxWidth` is chosen. The result is always a framed text that later
// participates in the corner-grip resize UI.

let lastTextHeight = 5;

const TEXT_PROMPT = 'Text: klicken oder Rahmen aufziehen';

/** Default frame width for a single-click placement, in world-mm. We target
 *  a visually consistent ~240 screen pixels wide so the frame is immediately
 *  meaningful at any zoom level without dominating the viewport. */
function defaultBoxWidth(): number {
  return 240 / state.view.scale;
}

/** Dispatched from `handleClick` when the user clicks in the text tool
 *  without dragging past the deadzone. */
async function handleTextClick(p: Pt): Promise<void> {
  await placeText(p, defaultBoxWidth());
}

/** Dispatched from main.ts's mouseup when the user dragged past the deadzone.
 *  The drag rectangle defines the frame width; we anchor top-left at the
 *  upper corner of the drag. */
export async function handleTextDrag(worldStart: Pt, worldEnd: Pt): Promise<void> {
  if (state.tool !== 'text') return;
  const minX = Math.min(worldStart.x, worldEnd.x);
  const maxY = Math.max(worldStart.y, worldEnd.y);
  const boxWidth = Math.abs(worldEnd.x - worldStart.x);
  // Sub-pixel drag: treat as a plain click with a default frame.
  if (boxWidth < 1e-6) { await placeText(worldStart, defaultBoxWidth()); return; }
  await placeText({ x: minX, y: maxY }, boxWidth);
}

/** Open the inline editor, then add the entity on commit. */
async function placeText(topLeft: Pt, boxWidth: number): Promise<void> {
  if (state.tool !== 'text') return;
  const tc = runtime.toolCtx;
  const result = await showInlineTextEditor({
    worldAnchor: topLeft,
    initialHeight: tc?.textHeight ?? lastTextHeight,
    boxWidth,
  });
  // The user may have switched tools while the editor was open; bail if so.
  if (state.tool !== 'text') return;
  if (!result) { resetTextTool(); return; }
  lastTextHeight = result.height;
  pushUndo();
  addEntity({
    type: 'text',
    x: topLeft.x, y: topLeft.y,
    text: result.text,
    height: result.height,
    boxWidth,
    layer: state.activeLayer,
  });
  resetTextTool();
}

function resetTextTool(): void {
  runtime.toolCtx = { step: 'pt', textHeight: lastTextHeight };
  setPrompt(TEXT_PROMPT);
  render();
}

// ---------------- Dimension ----------------

function dimLayer(): number {
  const idx = state.layers.findIndex(L => L.name.toLowerCase().includes('bemaß'));
  return idx >= 0 ? idx : state.activeLayer;
}

function commitDim(
  p1Ref: PointRef, p2Ref: PointRef, offsetPt: Pt,
): void {
  const absPt = (pt: Pt): PointRef => ({ kind: 'abs', x: numE(pt.x), y: numE(pt.y) });
  state.features.push({
    id: newFeatureId(),
    kind: 'dim',
    layer: dimLayer(),
    p1: p1Ref,
    p2: p2Ref,
    offset: absPt(offsetPt),
    textHeight: numE(lastTextHeight),
    ...(runtime.dimStyle ? { style: runtime.dimStyle } : {}),
  });
}

/**
 * Grip-drag handler for a linear dim's offset point. Called from main.ts'
 * applyGripDrag when the user is dragging a `dim-offset` grip.
 *
 * Unlike the generic `replaceFeatureFromInit` path (which rebuilds the whole
 * feature via `featureFromEntityInit`, flattening every PointRef to abs),
 * this mutates ONLY the offset PointRef on the DimFeature in place. p1/p2
 * remain untouched, so any link those refs have to a line's endpoints
 * (endpoint/mid/intersection) survives the drag — the dim continues to track
 * the measured geometry. Matches the user request:
 *     "die bemassung muss immer relativ zur verknüpften linie bleiben"
 *
 * The cursor is projected onto the perpendicular to p1→p2, yielding a signed
 * offset distance `sd`. We then choose the offset representation that
 * preserves the most downstream behaviour:
 *
 *   • If p1 is a linked PointRef (endpoint/mid/center/intersection — i.e. it
 *     tracks another feature), write the offset as `polar(from=p1,
 *     angle=perpAngle, distance=sd)`. When the source geometry translates,
 *     p1 moves and the offset moves with it — the dim stays glued to its
 *     line. Rotation of the source is still not followed (the angle is a
 *     literal at commit time, matching how line_offset handles this), but
 *     translation — the common case — works.
 *   • If p1 is already abs, a plain abs point is enough: there's nothing to
 *     link to downstream.
 */
export function applyDimOffsetGripDrag(entityId: number, newPt: Pt): void {
  const feat = featureForEntity(entityId);
  if (!feat || feat.kind !== 'dim') return;
  if (feat.dimKind && feat.dimKind !== 'linear') return;
  const ent = state.entities.find(x => x.id === entityId);
  if (!ent || ent.type !== 'dim') return;

  const dx = ent.p2.x - ent.p1.x, dy = ent.p2.y - ent.p1.y;
  const L = Math.hypot(dx, dy);
  if (L < 1e-9) return;
  const nx = -dy / L, ny = dx / L;
  const sd = (newPt.x - ent.p1.x) * nx + (newPt.y - ent.p1.y) * ny;

  const p1Linked = feat.p1.kind !== 'abs';
  if (p1Linked) {
    // Parametric-aware branch. The renderer only consumes the OFFSET's
    // perpendicular component relative to p1→p2 (`sd`), so any offset point
    // on the line through (p1+p2)/2 perpendicular to p1→p2 works. We
    // encode it as polar(from=p1, angle, distance) with distance and
    // angle chosen so that the projected sd equals the dragged value AND
    // — importantly — when p1 later translates, the offset translates by
    // the same vector (polar evaluates `from + dir(angle) * distance`).
    //
    // Vector from p1 to the new mid point is:
    //   v = 0.5 * (p2 - p1) + sd * (n)    with n = (nx, ny)
    // So distance = |v|, angle = atan2(v.y, v.x). This is a concrete
    // displacement off p1; translating p1 translates the offset by the
    // same amount — dim stays glued to its line under translation. (Line
    // rotation still isn't followed — polar's angle is literal — matching
    // line_offset's documented behaviour.)
    const vx = 0.5 * (ent.p2.x - ent.p1.x) + nx * sd;
    const vy = 0.5 * (ent.p2.y - ent.p1.y) + ny * sd;
    const distance = Math.hypot(vx, vy);
    const angleDeg = Math.atan2(vy, vx) * 180 / Math.PI;
    feat.offset = {
      kind: 'polar',
      from: feat.p1,
      angle: numE(angleDeg),
      distance: numE(distance),
    };
  } else {
    const mx = (ent.p1.x + ent.p2.x) / 2 + nx * sd;
    const my = (ent.p1.y + ent.p2.y) / 2 + ny * sd;
    feat.offset = { kind: 'abs', x: numE(mx), y: numE(my) };
  }
  evaluateTimeline();
}

/**
 * For chain/auto dim mode: given a click point, prefer the nearest endpoint of the
 * line / rect edge / polyline segment under the cursor. This lets the user
 * click anywhere along a line and get the line's nearer endpoint as the dim
 * anchor, matching "pick an object" semantics from real CAD.
 *
 * Falls back to null when nothing is under the cursor — the caller then uses
 * the snap system (endpoint/mid/etc) or the raw click coordinate.
 */
function pickNearestRefFromEdge(worldPt: Pt): { pt: Pt; ref: PointRef } | null {
  const absPt = (pt: Pt): PointRef => ({ kind: 'abs', x: numE(pt.x), y: numE(pt.y) });
  const hit = hitTest(worldPt);
  if (!hit) return null;
  const feat = featureForEntity(hit.id);
  const fid = feat?.id;

  if (hit.type === 'line') {
    const a = { x: hit.x1, y: hit.y1 };
    const b = { x: hit.x2, y: hit.y2 };
    const end: 0 | 1 = dist(worldPt, a) <= dist(worldPt, b) ? 0 : 1;
    const pt = end === 0 ? a : b;
    // Link dim anchor to the line's endpoint whenever possible so parameter
    // edits propagate. Modifier tools flatten these links to abs when they
    // rebuild the feature, so transformed lines won't drag the original dim.
    // Free-draw mode: emit an abs ref so the dim stays fixed even when the
    // line moves — matches the global "no implicit chains" guarantee.
    const ref: PointRef = (fid !== undefined && runtime.parametricMode)
      ? { kind: 'endpoint', feature: fid, end }
      : absPt(pt);
    return { pt, ref };
  }
  if (hit.type === 'rect') {
    const edge = nearestRectEdge(hit, worldPt);
    if (!edge) return null;
    const pt = dist(worldPt, edge.a) <= dist(worldPt, edge.b) ? edge.a : edge.b;
    return { pt, ref: absPt(pt) };
  }
  if (hit.type === 'polyline') {
    const seg = nearestPolySegment(hit, worldPt);
    if (!seg) return null;
    const pt = dist(worldPt, seg.a) <= dist(worldPt, seg.b) ? seg.a : seg.b;
    return { pt, ref: absPt(pt) };
  }
  return null;
}

/**
 * Segment–segment intersection. Returns the intersection point plus both
 * parametric coordinates (t on A→B, u on S1→S2). Null if the segments are
 * parallel or the intersection lies off either segment. Returning the
 * parameters lets callers tell whether the intersection is strictly inside
 * versus at an endpoint.
 */
function segSegIntersect(
  a1: Pt, a2: Pt, b1: Pt, b2: Pt,
): { pt: Pt; t: number; u: number } | null {
  const rx = a2.x - a1.x, ry = a2.y - a1.y;
  const sx = b2.x - b1.x, sy = b2.y - b1.y;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-9) return null; // parallel / collinear
  const t = ((b1.x - a1.x) * sy - (b1.y - a1.y) * sx) / den;
  const u = ((b1.x - a1.x) * ry - (b1.y - a1.y) * rx) / den;
  return { pt: { x: a1.x + t * rx, y: a1.y + t * ry }, t, u };
}

/**
 * Collect all entity segments (visible layers only) that the dim axis A→B
 * crosses. For each crossing, the returned point is the intersection of the
 * segment with the axis — so the measurement is taken perpendicular to the
 * axis, exactly like manual chain-dim clicks on each intermediate line.
 *
 * This is the "proper CAD auto-dim": click anywhere on the first line and
 * anywhere on the last line, and every line the axis crosses in between is
 * picked up. Clicks do not have to land on endpoints or snap points.
 *
 * Segment endpoints exactly at A or B (t ≈ 0 or t ≈ 1) are excluded — those
 * are the lines the user already clicked. Everything strictly inside (0,1)
 * is returned, sorted by distance along the axis.
 */
function findLinesBetween(a: Pt, b: Pt): { pt: Pt; ref: PointRef }[] {
  const absPt = (pt: Pt): PointRef => ({ kind: 'abs', x: numE(pt.x), y: numE(pt.y) });
  const axisLen = dist(a, b);
  if (axisLen < 1e-6) return [];

  type Candidate = { pt: Pt; ref: PointRef; t: number };
  const candidates: Candidate[] = [];

  const testSeg = (s1: Pt, s2: Pt) => {
    const r = segSegIntersect(a, b, s1, s2);
    if (!r) return;
    // Strict interior on the axis (t must be strictly between A and B) so
    // the clicked endpoints themselves don't get re-captured as "between".
    if (r.t <= 1e-6 || r.t >= 1 - 1e-6) return;
    // Inclusive on the segment, with a small tolerance for numeric wobble.
    if (r.u < -1e-6 || r.u > 1 + 1e-6) return;
    candidates.push({ pt: r.pt, ref: absPt(r.pt), t: r.t });
  };

  for (const ent of state.entities) {
    const layer = state.layers[ent.layer];
    if (!layer || !layer.visible) continue;

    if (ent.type === 'line') {
      testSeg({ x: ent.x1, y: ent.y1 }, { x: ent.x2, y: ent.y2 });
    } else if (ent.type === 'rect') {
      const xl = Math.min(ent.x1, ent.x2), xr = Math.max(ent.x1, ent.x2);
      const yb = Math.min(ent.y1, ent.y2), yt = Math.max(ent.y1, ent.y2);
      testSeg({ x: xl, y: yb }, { x: xr, y: yb });
      testSeg({ x: xr, y: yb }, { x: xr, y: yt });
      testSeg({ x: xr, y: yt }, { x: xl, y: yt });
      testSeg({ x: xl, y: yt }, { x: xl, y: yb });
    } else if (ent.type === 'polyline') {
      for (let i = 1; i < ent.pts.length; i++) {
        testSeg(ent.pts[i - 1], ent.pts[i]);
      }
      if (ent.closed && ent.pts.length > 2) {
        testSeg(ent.pts[ent.pts.length - 1], ent.pts[0]);
      }
    }
  }

  candidates.sort((x, y) => x.t - y.t);

  // Deduplicate coincident crossings (e.g. two segments meeting at a shared
  // endpoint that the axis passes exactly through).
  const unique: Candidate[] = [];
  for (const c of candidates) {
    const prev = unique[unique.length - 1];
    if (prev && dist(prev.pt, c.pt) < 1e-6) continue;
    unique.push(c);
  }
  return unique.map(({ pt, ref }) => ({ pt, ref }));
}

/**
 * True when the click is "on a point" for chain/auto dim purposes: either
 * the snap system has a strong hit (endpoint/mid/intersection/centre/tangent/
 * perp), or the cursor is directly over a hit-testable entity. Grid snap
 * doesn't count — it's a positioning aid, not a reference point.
 */
function dimClickIsOnPoint(worldPt: Pt): boolean {
  const s = runtime.lastSnap;
  if (s && s.type !== 'grid') return true;
  return hitTest(worldPt) !== null;
}

function handleDimClick(p: Pt): void {
  const tc = runtime.toolCtx;
  if (!tc) return;
  const mode = runtime.dimMode;
  const absPt = (pt: Pt): PointRef => ({ kind: 'abs', x: numE(pt.x), y: numE(pt.y) });

  // ── Chain / Auto — shared flow ──────────────────────────────────────
  // The modes share semantics: every click on a point/edge appends a
  // reference point to the chain. A click on empty canvas (not on a point)
  // commits all N-1 dims at the click's position as the shared offset.
  //
  // Auto additionally auto-inserts endpoints of any entities geometrically
  // between the previous click and the new click — so clicking just the
  // first and last element of a row dimensions every line in between. Chain
  // stays strictly manual — user clicks every reference explicitly.
  if (mode === 'chain' || mode === 'auto') {
    if (!tc.pts)    tc.pts    = [];
    if (!tc.ptRefs) tc.ptRefs = [];

    const onPoint = dimClickIsOnPoint(p);

    if (onPoint) {
      // Resolve the reference point. Priority:
      //   1. Active snap (user is explicitly targeting a specific feature point
      //      like MITTE / ZENTR / SCHN / LOT / TANG — anything the snap engine
      //      latched onto). These must win, otherwise a mid-snap at x=32 gets
      //      silently replaced by the far endpoint of the same line.
      //   2. Nearest endpoint of a hit-tested line/edge under the cursor, for
      //      the "click anywhere on a line, get its nearer end" convenience.
      //   3. Raw click point (shouldn't really happen given onPoint gate).
      let pt: Pt;
      let ref: PointRef;
      if (runtime.lastSnap) {
        pt = { x: runtime.lastSnap.x, y: runtime.lastSnap.y };
        ref = snapToPointRef(runtime.lastSnap, pt);
      } else {
        const edgePick = pickNearestRefFromEdge(p);
        if (edgePick) { pt = edgePick.pt; ref = edgePick.ref; }
        else          { pt = p;           ref = snapToPointRef(null, p); }
      }

      const last = tc.pts[tc.pts.length - 1];
      if (last && dist(last, pt) < 1e-6) { toast('Punkt bereits erfasst'); return; }

      // Auto mode: before appending the clicked point, pick up every line
      // the axis from the previous click to this click crosses — each
      // crossing becomes its own reference point, measured perpendicular
      // to the axis. This matches classic CAD auto-dim: the user clicks
      // only the first and last line; everything in between is detected
      // from the axis geometry, not from the click landing on a feature.
      if (mode === 'auto' && last) {
        for (const mid of findLinesBetween(last, pt)) {
          // Guard against dupes vs. already-collected points.
          const prevPt = tc.pts[tc.pts.length - 1];
          if (prevPt && dist(prevPt, mid.pt) < 1e-6) continue;
          tc.pts.push(mid.pt);
          tc.ptRefs.push(mid.ref);
        }
      }
      tc.pts.push(pt);
      tc.ptRefs.push(ref);
      tc.step = 'collect';
      const n = tc.pts.length;
      setPrompt(n >= 2
        ? `${n} Punkte · ${n - 1} Bemaßungen · Leere Stelle = Platzieren`
        : 'Nächster Punkt (klicke auf Leere zum Platzieren)');
      render();
      return;
    }

    // Click in empty space — commit all dims at this position.
    if (tc.pts.length < 2) {
      toast('Mindestens 2 Punkte für die Kette klicken');
      return;
    }
    pushUndo();
    for (let i = 1; i < tc.pts.length; i++) {
      const r1 = tc.ptRefs[i - 1] ?? absPt(tc.pts[i - 1]);
      const r2 = tc.ptRefs[i]     ?? absPt(tc.pts[i]);
      commitDim(r1, r2, p);
    }
    evaluateTimeline();
    updateStats();
    runtime.toolCtx = { step: 'collect', pts: [], ptRefs: [] };
    setPrompt(mode === 'auto'
      ? 'Erste Linie klicken (automatische Erkennung dazwischen)'
      : 'Erster Punkt der Kette');
    render();
    return;
  }

  // ── Single mode (default) ───────────────────────────────────────────
  if (tc.step === 'pick1') {
    tc.click1 = p;
    // Capture the snap as a parametric PointRef so the dim tracks the
    // underlying feature when variables change (same mechanism the line tool
    // uses for its p1/p2).
    tc.ptRefs = [snapToPointRef(runtime.lastSnap, p), null];
    tc.step = 'pick2';
    setPrompt('Zweiter Messpunkt');
    render();
    return;
  }
  if (tc.step === 'pick2' && tc.click1) {
    if (dist(tc.click1, p) < 1e-6) { toast('Punkte müssen unterschiedlich sein'); return; }
    tc.click2 = p;
    if (!tc.ptRefs) tc.ptRefs = [null, null];
    tc.ptRefs[1] = snapToPointRef(runtime.lastSnap, p);
    tc.step = 'place';
    setPrompt('Bemaßungsposition klicken');
    render();
    return;
  }
  if (tc.step === 'place' && tc.click1 && tc.click2) {
    const p1Ref = tc.ptRefs?.[0] ?? absPt(tc.click1);
    const p2Ref = tc.ptRefs?.[1] ?? absPt(tc.click2);
    pushUndo();
    commitDim(p1Ref, p2Ref, p);
    evaluateTimeline();
    updateStats();
    runtime.toolCtx = { step: 'pick1' };
    setPrompt('Erster Messpunkt');
    render();
  }
}

// ---------------- Trim ----------------

/** Intersect segment a→b with segment c→d. Returns t on a→b, or null. */
function segSegT(a: Pt, b: Pt, c: Pt, d: Pt, bInfinite = false): number | null {
  const rX = b.x - a.x, rY = b.y - a.y;
  const sX = d.x - c.x, sY = d.y - c.y;
  const rxs = rX * sY - rY * sX;
  if (Math.abs(rxs) < 1e-12) return null;
  const qpX = c.x - a.x, qpY = c.y - a.y;
  const t = (qpX * sY - qpY * sX) / rxs;
  const u = (qpX * rY - qpY * rX) / rxs;
  if (t < -1e-9 || t > 1 + 1e-9) return null;
  if (!bInfinite && (u < -1e-9 || u > 1 + 1e-9)) return null;
  return t;
}

function lineCircleT(a: Pt, b: Pt, c: Pt, r: number): number[] {
  const dX = b.x - a.x, dY = b.y - a.y;
  const fX = a.x - c.x, fY = a.y - c.y;
  const A = dX * dX + dY * dY;
  const B = 2 * (fX * dX + fY * dY);
  const C = fX * fX + fY * fY - r * r;
  let disc = B * B - 4 * A * C;
  if (disc < 0 || A < 1e-12) return [];
  disc = Math.sqrt(disc);
  const out: number[] = [];
  const t1 = (-B - disc) / (2 * A);
  const t2 = (-B + disc) / (2 * A);
  if (t1 >= -1e-9 && t1 <= 1 + 1e-9) out.push(t1);
  if (Math.abs(t2 - t1) > 1e-9 && t2 >= -1e-9 && t2 <= 1 + 1e-9) out.push(t2);
  return out;
}

/**
 * Every t along `target` where another visible entity crosses it, paired
 * with that entity's id. The id lets `handleTrimClick` look up the cutting
 * feature and build an `intersection` PointRef so the freshly-trimmed end
 * stays parametrically linked to whatever cut it — matches the "Bug 3"
 * user expectation (stutzen darf Verknüpfungen nicht verlieren).
 */
function trimCutterTs(target: LineEntity): { t: number; entityId: number }[] {
  const a: Pt = { x: target.x1, y: target.y1 };
  const b: Pt = { x: target.x2, y: target.y2 };
  const out: { t: number; entityId: number }[] = [];
  for (const e of state.entities) {
    if (e.id === target.id) continue;
    const layer = state.layers[e.layer];
    if (!layer || !layer.visible) continue;
    if (e.type === 'line') {
      const t = segSegT(a, b, { x: e.x1, y: e.y1 }, { x: e.x2, y: e.y2 });
      if (t !== null) out.push({ t, entityId: e.id });
    } else if (e.type === 'xline') {
      const t = segSegT(a, b, { x: e.x1, y: e.y1 }, { x: e.x1 + e.dx, y: e.y1 + e.dy }, true);
      if (t !== null) out.push({ t, entityId: e.id });
    } else if (e.type === 'rect') {
      const xl = Math.min(e.x1, e.x2), xr = Math.max(e.x1, e.x2);
      const yb = Math.min(e.y1, e.y2), yt = Math.max(e.y1, e.y2);
      const edges: [Pt, Pt][] = [
        [{ x: xl, y: yb }, { x: xr, y: yb }],
        [{ x: xr, y: yb }, { x: xr, y: yt }],
        [{ x: xr, y: yt }, { x: xl, y: yt }],
        [{ x: xl, y: yt }, { x: xl, y: yb }],
      ];
      for (const [p1, p2] of edges) {
        const t = segSegT(a, b, p1, p2);
        if (t !== null) out.push({ t, entityId: e.id });
      }
    } else if (e.type === 'circle') {
      for (const t of lineCircleT(a, b, { x: e.cx, y: e.cy }, e.r)) out.push({ t, entityId: e.id });
    } else if (e.type === 'arc') {
      for (const t of lineCircleT(a, b, { x: e.cx, y: e.cy }, e.r)) {
        const px = a.x + (b.x - a.x) * t, py = a.y + (b.y - a.y) * t;
        const ang = Math.atan2(py - e.cy, px - e.cx);
        if (angleInSweep(ang, e.a1, e.a2)) out.push({ t, entityId: e.id });
      }
    } else if (e.type === 'polyline') {
      for (let i = 0; i < e.pts.length - 1; i++) {
        const t = segSegT(a, b, e.pts[i], e.pts[i + 1]);
        if (t !== null) out.push({ t, entityId: e.id });
      }
      if (e.closed && e.pts.length >= 2) {
        const t = segSegT(a, b, e.pts[e.pts.length - 1], e.pts[0]);
        if (t !== null) out.push({ t, entityId: e.id });
      }
    }
  }
  return out;
}

/**
 * Re-trim one segment of an existing ClipFeature.
 * `hit` is the sub-entity line that was clicked (t values from
 * trimCutterTs are relative to hit's endpoints). We convert them back
 * to the original source-line t space and update the ClipFeature's
 * segments array non-destructively.
 */
function handleRetrimClip(
  hit: LineEntity,
  clip: { id: string; sourceId: string; segments: ClipSegment[] },
  segIdx: number,
  worldPt: Pt,
): void {
  const seg = clip.segments[segIdx];
  const a: Pt = { x: hit.x1, y: hit.y1 };
  const b: Pt = { x: hit.x2, y: hit.y2 };
  const abX = b.x - a.x, abY = b.y - a.y;
  const L2 = abX * abX + abY * abY;
  if (L2 < 1e-12) return;
  const tClickSub = ((worldPt.x - a.x) * abX + (worldPt.y - a.y) * abY) / L2;

  // Convert sub-entity t values to original-line t space.
  const tRange = seg.tEnd - seg.tStart;
  const tClickOrig = seg.tStart + tClickSub * tRange;

  const cuttersSub = trimCutterTs(hit).filter(c => c.t > 1e-6 && c.t < 1 - 1e-6);
  const cutters = cuttersSub.map(c => ({
    t: seg.tStart + c.t * tRange,
    entityId: c.entityId,
  }));

  let tLow = seg.tStart, tHigh = seg.tEnd;
  let hasLow = false, hasHigh = false;
  let cutterLow: { t: number; entityId: number } | null = null;
  let cutterHigh: { t: number; entityId: number } | null = null;
  for (const c of cutters) {
    if (c.t < tClickOrig) {
      if (!hasLow || c.t > tLow) { tLow = c.t; hasLow = true; cutterLow = c; }
    } else {
      if (!hasHigh || c.t < tHigh) { tHigh = c.t; hasHigh = true; cutterHigh = c; }
    }
  }

  // Build the replacement segments for this slot.
  const replacements: ClipSegment[] = [];
  if (hasLow) {
    const endCutterId = cutterLow ? (featureForEntity(cutterLow.entityId)?.id ?? null) : null;
    replacements.push({ tStart: seg.tStart, tEnd: tLow, startCutterId: seg.startCutterId, endCutterId });
  }
  if (hasHigh) {
    const startCutterId = cutterHigh ? (featureForEntity(cutterHigh.entityId)?.id ?? null) : null;
    replacements.push({ tStart: tHigh, tEnd: seg.tEnd, startCutterId, endCutterId: seg.endCutterId });
  }

  const clipFeat = state.features.find(f => f.id === clip.id);
  if (!clipFeat || clipFeat.kind !== 'clip') return;

  pushUndo();
  const newSegs = [
    ...clipFeat.segments.slice(0, segIdx),
    ...replacements,
    ...clipFeat.segments.slice(segIdx + 1),
  ];
  if (newSegs.length === 0) {
    // All segments gone — remove the ClipFeature (cascade will unhide source).
    deleteFeatures([clip.id]);
  } else {
    clipFeat.segments = newSegs;
    evaluateTimeline();
  }
  state.selection.delete(hit.id);
  updateStats();
  updateSelStatus();
  render();
}

function handleTrimClick(worldPt: Pt): void {
  const hit = hitTest(worldPt);
  if (!hit) { toast('Nichts getroffen'); return; }
  if (hit.type === 'circle') { handleTrimCircleClick(hit, worldPt); return; }
  if (hit.type === 'arc')    { handleTrimArcClick(hit, worldPt); return; }
  if (hit.type !== 'line') { toast('Nur Linien, Kreise und Bögen können gestutzt werden'); return; }

  // ── Re-trim an already-clipped segment ────────────────────────────────
  const clipInfo = resolveClipSubEntity(hit.id);
  if (clipInfo) {
    handleRetrimClip(hit, clipInfo.feat, clipInfo.segIdx, worldPt);
    return;
  }

  // ── Standard non-destructive trim for plain line features ─────────────
  const fid = featureForEntity(hit.id)?.id;
  if (!fid) return;
  const ownerFeat = featureForEntity(hit.id);
  // If this entity is a sub-entity of a Mirror/Array/Rotate, fall through
  // to the destructive path so we don't accidentally clip a copy that has
  // no parametric meaning on its own.
  if (ownerFeat && ownerFeat.kind !== 'line') {
    toast('Stutzen von Kopien noch nicht unterstützt');
    return;
  }

  const a: Pt = { x: hit.x1, y: hit.y1 };
  const b: Pt = { x: hit.x2, y: hit.y2 };
  const abX = b.x - a.x, abY = b.y - a.y;
  const L2 = abX * abX + abY * abY;
  if (L2 < 1e-12) return;
  const tClick = ((worldPt.x - a.x) * abX + (worldPt.y - a.y) * abY) / L2;

  const cutters = trimCutterTs(hit).filter(c => c.t > 1e-6 && c.t < 1 - 1e-6);
  let tLow = 0, tHigh = 1;
  let hasLow = false, hasHigh = false;
  let cutterLow: { t: number; entityId: number } | null = null;
  let cutterHigh: { t: number; entityId: number } | null = null;
  for (const c of cutters) {
    if (c.t < tClick) {
      if (!hasLow || c.t > tLow) { tLow = c.t; hasLow = true; cutterLow = c; }
    } else {
      if (!hasHigh || c.t < tHigh) { tHigh = c.t; hasHigh = true; cutterHigh = c; }
    }
  }

  if (!hasLow && !hasHigh) {
    // No intersections → works as a targeted delete.
    pushUndo();
    deleteFeatures([fid]);
    state.selection.delete(hit.id);
    evaluateTimeline();
    updateStats();
    updateSelStatus();
    toast('Linie entfernt');
    render();
    return;
  }

  // Build surviving segments for the ClipFeature.
  const segments: ClipSegment[] = [];
  if (hasLow) {
    const endCutterId = cutterLow ? (featureForEntity(cutterLow.entityId)?.id ?? null) : null;
    segments.push({ tStart: 0, tEnd: tLow, startCutterId: null, endCutterId });
  }
  if (hasHigh) {
    const startCutterId = cutterHigh ? (featureForEntity(cutterHigh.entityId)?.id ?? null) : null;
    segments.push({ tStart: tHigh, tEnd: 1, startCutterId, endCutterId: null });
  }

  if (!segments.length) {
    // Fully consumed between two flanking cutters.
    pushUndo();
    deleteFeatures([fid]);
    state.selection.delete(hit.id);
    evaluateTimeline();
    updateStats();
    updateSelStatus();
    toast('Linie entfernt');
    render();
    return;
  }

  pushUndo();
  // Hide the source feature so it stays in ctx (keeps PointRefs alive) but
  // is no longer rendered or hit-testable.
  const srcFeat = state.features.find(f => f.id === fid);
  if (srcFeat) srcFeat.hidden = true;
  // Emit the ClipFeature — evaluator will produce sub-entities for each segment.
  state.features.push({
    id: newFeatureId(),
    kind: 'clip',
    layer: hit.layer,
    sourceId: fid,
    segments,
  } as Feature);
  state.selection.delete(hit.id);
  evaluateTimeline();
  updateStats();
  updateSelStatus();
  render();
}

/**
 * Intersection points between two circles, expressed as angles (radians) on
 * the TARGET circle from its centre. Up to two results per pair. Tangent and
 * non-intersecting configurations return [].
 */
function circleCircleAngles(
  target: { cx: number; cy: number; r: number },
  cutter: { cx: number; cy: number; r: number },
): number[] {
  const dx = cutter.cx - target.cx, dy = cutter.cy - target.cy;
  const d = Math.hypot(dx, dy);
  // Coincident or totally separate / one-inside-the-other.
  if (d < 1e-9) return [];
  if (d > target.r + cutter.r + 1e-9) return [];
  if (d < Math.abs(target.r - cutter.r) - 1e-9) return [];
  const a = (d * d - cutter.r * cutter.r + target.r * target.r) / (2 * d);
  const h2 = target.r * target.r - a * a;
  const h = h2 > 0 ? Math.sqrt(h2) : 0;
  const ux = dx / d, uy = dy / d;
  const mx = target.cx + ux * a, my = target.cy + uy * a;
  // Two perpendicular offsets. Tangent (h≈0) collapses to a single point; we
  // still emit both so the caller can dedupe — cheap and simpler than the
  // alternative branching here.
  const p1x = mx + (-uy) * h, p1y = my + ux * h;
  const p2x = mx -  (-uy) * h, p2y = my -  ux * h;
  const ang = (px: number, py: number) => Math.atan2(py - target.cy, px - target.cx);
  const out: number[] = [ang(p1x, p1y)];
  if (h > 1e-9) out.push(ang(p2x, p2y));
  return out;
}

/**
 * Return every angle on the given circle (or full circle of an arc) where a
 * visible cutter entity crosses it, paired with that cutter's id. Angles are
 * in the native atan2 range (−π, π]. Used by the trim tool on circles/arcs.
 */
function trimCircleCutterAngles(
  target: { id: number; cx: number; cy: number; r: number },
): { angle: number; entityId: number }[] {
  const out: { angle: number; entityId: number }[] = [];
  const push = (ang: number, id: number) => out.push({ angle: ang, entityId: id });
  for (const e of state.entities) {
    if (e.id === target.id) continue;
    const layer = state.layers[e.layer];
    if (!layer || !layer.visible) continue;
    if (e.type === 'line' || e.type === 'xline') {
      const a: Pt = e.type === 'line' ? { x: e.x1, y: e.y1 } : { x: e.x1, y: e.y1 };
      const b: Pt = e.type === 'line'
        ? { x: e.x2, y: e.y2 }
        : { x: e.x1 + e.dx, y: e.y1 + e.dy };
      // Parametric t on the (infinite for xline, bounded for line) cutter.
      const dX = b.x - a.x, dY = b.y - a.y;
      const fX = a.x - target.cx, fY = a.y - target.cy;
      const A = dX * dX + dY * dY;
      const B = 2 * (fX * dX + fY * dY);
      const C = fX * fX + fY * fY - target.r * target.r;
      let disc = B * B - 4 * A * C;
      if (disc < 0 || A < 1e-12) continue;
      disc = Math.sqrt(disc);
      const ts = [(-B - disc) / (2 * A), (-B + disc) / (2 * A)];
      for (const t of ts) {
        if (e.type === 'line' && (t < -1e-9 || t > 1 + 1e-9)) continue;
        const px = a.x + dX * t, py = a.y + dY * t;
        push(Math.atan2(py - target.cy, px - target.cx), e.id);
      }
    } else if (e.type === 'circle') {
      for (const ang of circleCircleAngles(target, { cx: e.cx, cy: e.cy, r: e.r })) push(ang, e.id);
    } else if (e.type === 'arc') {
      // Cutter arc must hit the target circle in its own sweep — otherwise the
      // visible arc doesn't actually touch and would be a phantom intersection.
      for (const ang of circleCircleAngles(target, { cx: e.cx, cy: e.cy, r: e.r })) {
        const px = target.cx + Math.cos(ang) * target.r;
        const py = target.cy + Math.sin(ang) * target.r;
        const angOnCutter = Math.atan2(py - e.cy, px - e.cx);
        if (angleInSweep(angOnCutter, e.a1, e.a2)) push(ang, e.id);
      }
    } else if (e.type === 'rect') {
      const xl = Math.min(e.x1, e.x2), xr = Math.max(e.x1, e.x2);
      const yb = Math.min(e.y1, e.y2), yt = Math.max(e.y1, e.y2);
      const edges: [Pt, Pt][] = [
        [{ x: xl, y: yb }, { x: xr, y: yb }],
        [{ x: xr, y: yb }, { x: xr, y: yt }],
        [{ x: xr, y: yt }, { x: xl, y: yt }],
        [{ x: xl, y: yt }, { x: xl, y: yb }],
      ];
      for (const [p1, p2] of edges) {
        for (const t of lineCircleT(p1, p2, { x: target.cx, y: target.cy }, target.r)) {
          const px = p1.x + (p2.x - p1.x) * t, py = p1.y + (p2.y - p1.y) * t;
          push(Math.atan2(py - target.cy, px - target.cx), e.id);
        }
      }
    } else if (e.type === 'polyline') {
      for (let i = 0; i < e.pts.length - 1; i++) {
        const p1 = e.pts[i], p2 = e.pts[i + 1];
        for (const t of lineCircleT(p1, p2, { x: target.cx, y: target.cy }, target.r)) {
          const px = p1.x + (p2.x - p1.x) * t, py = p1.y + (p2.y - p1.y) * t;
          push(Math.atan2(py - target.cy, px - target.cx), e.id);
        }
      }
      if (e.closed && e.pts.length >= 2) {
        const p1 = e.pts[e.pts.length - 1], p2 = e.pts[0];
        for (const t of lineCircleT(p1, p2, { x: target.cx, y: target.cy }, target.r)) {
          const px = p1.x + (p2.x - p1.x) * t, py = p1.y + (p2.y - p1.y) * t;
          push(Math.atan2(py - target.cy, px - target.cx), e.id);
        }
      }
    }
  }
  return out;
}

/**
 * Trim a circle at the clicked arc segment. Finds the two intersection angles
 * that bracket the click (walking CW and CCW from it around the circle); the
 * segment between them — the one the user clicked — is removed and the
 * complement survives as an arc that sweeps CCW from the CCW-neighbour to the
 * CW-neighbour (the long way around).
 *
 * With no intersections the whole circle is deleted, mirroring the line-trim
 * fallback ("click what you want gone"). With exactly one intersection the
 * tool refuses: splitting a closed curve at a single point leaves the circle
 * shape intact, so there's nothing sensible to remove.
 *
 * The resulting arc inherits the source circle's parametric centre and radius
 * so `Radius` as a variable, `axisProject` centres, etc. still drive it.
 * Endpoint angles are baked as numeric exprs — the two cut points don't have
 * a parametric anchor we can name yet; keeping them parametric would require
 * an `arcOfCircle × intersection-with-cutter` ref kind we haven't built.
 */
function handleTrimCircleClick(hit: CircleEntity, worldPt: Pt): void {
  const fid = featureForEntity(hit.id)?.id;
  if (!fid) return;
  const cuts = trimCircleCutterAngles({ id: hit.id, cx: hit.cx, cy: hit.cy, r: hit.r });
  // Deduplicate near-equal angles (two entities meeting at the same point).
  const norm = (a: number) => ((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  const uniq: number[] = [];
  for (const c of cuts) {
    const a = norm(c.angle);
    if (!uniq.some(u => Math.abs(u - a) < 1e-6)) uniq.push(a);
  }
  uniq.sort((x, y) => x - y);
  if (uniq.length === 0) {
    pushUndo();
    deleteFeatures([fid]);
    state.selection.delete(hit.id);
    evaluateTimeline();
    updateStats();
    updateSelStatus();
    toast('Kreis entfernt');
    render();
    return;
  }
  if (uniq.length === 1) {
    toast('Ein Schnittpunkt reicht nicht — Kreis unverändert');
    return;
  }
  const clickAng = norm(Math.atan2(worldPt.y - hit.cy, worldPt.x - hit.cx));
  // Find the arc gap (CCW from uniq[i] to uniq[i+1], wrapping) that contains
  // the click. That gap is what we remove; the arc covering the rest of the
  // circle is what survives.
  let gapStart = uniq[uniq.length - 1], gapEnd = uniq[0]; // default: wrap gap
  for (let i = 0; i < uniq.length - 1; i++) {
    if (clickAng >= uniq[i] && clickAng <= uniq[i + 1]) {
      gapStart = uniq[i];
      gapEnd = uniq[i + 1];
      break;
    }
  }
  // Surviving arc: CCW from gapEnd → gapStart (the long way around, skipping
  // the click gap).
  pushUndo();
  const srcFeat = state.features.find(f => f.id === fid);
  const newArc: Feature = (srcFeat && srcFeat.kind === 'circle')
    ? { id: fid, kind: 'arc', layer: hit.layer, center: srcFeat.center, radius: srcFeat.radius,
        a1: numE(gapEnd), a2: numE(gapStart) }
    : featureFromEntityInit({
        type: 'arc', layer: hit.layer, cx: hit.cx, cy: hit.cy, r: hit.r,
        a1: gapEnd, a2: gapStart,
      }, fid);
  const idx = state.features.findIndex(f => f.id === fid);
  if (idx >= 0) state.features[idx] = newArc;
  evaluateTimeline();
  updateStats();
  updateSelStatus();
  render();
}

/**
 * Trim an existing arc at the clicked segment. Same bracketing logic as the
 * line trim (walk along the sweep, find the cutter just before and just after
 * the click, remove that span, keep what's left) — just parametrised by angle
 * through the arc's CCW-normalised sweep instead of linear t.
 *
 * May yield 0 (click gap reaches both endpoints), 1 (click gap touches one
 * endpoint), or 2 (click gap sits strictly inside the sweep) surviving arcs.
 * The source feature is reused for the first survivor to preserve its id and
 * its centre/radius parametric refs.
 */
function handleTrimArcClick(hit: ArcEntity, worldPt: Pt): void {
  const fid = featureForEntity(hit.id)?.id;
  if (!fid) return;
  // Normalised total sweep of the arc in [0, 2π).
  const twoPi = Math.PI * 2;
  let sweep = hit.a2 - hit.a1;
  while (sweep <= 0) sweep += twoPi;
  if (sweep > twoPi) sweep -= twoPi;
  if (sweep < 1e-9) { toast('Bogen zu klein'); return; }
  // Map an angle to t ∈ [0, 1] along the sweep (CCW from a1).
  const sweepT = (ang: number): number => {
    let d = ang - hit.a1;
    while (d < 0) d += twoPi;
    while (d > twoPi) d -= twoPi;
    return d / sweep;
  };
  // Gather cutters and keep only those inside the sweep. Points exactly at
  // the endpoints (t=0 or 1) are dropped — they're the arc's own endpoints,
  // not an interior cut.
  const rawCuts = trimCircleCutterAngles({ id: hit.id, cx: hit.cx, cy: hit.cy, r: hit.r });
  const cuts: { t: number; entityId: number }[] = [];
  for (const c of rawCuts) {
    if (!angleInSweep(c.angle, hit.a1, hit.a2)) continue;
    const t = sweepT(c.angle);
    if (t > 1e-6 && t < 1 - 1e-6) cuts.push({ t, entityId: c.entityId });
  }
  const tClick = sweepT(Math.atan2(worldPt.y - hit.cy, worldPt.x - hit.cx));
  let tLow = 0, tHigh = 1, hasLow = false, hasHigh = false;
  for (const c of cuts) {
    if (c.t < tClick) {
      if (c.t > tLow) { tLow = c.t; hasLow = true; }
    } else {
      if (c.t < tHigh) { tHigh = c.t; hasHigh = true; }
    }
  }
  if (!hasLow && !hasHigh) {
    pushUndo();
    deleteFeatures([fid]);
    state.selection.delete(hit.id);
    evaluateTimeline();
    updateStats();
    updateSelStatus();
    toast('Bogen entfernt');
    render();
    return;
  }
  pushUndo();
  const srcFeat = state.features.find(f => f.id === fid);
  const tToAngle = (t: number) => hit.a1 + sweep * t;
  const mkArc = (t0: number, t1: number, reuseId: string | null): Feature => {
    const a1 = tToAngle(t0), a2 = tToAngle(t1);
    if (reuseId && srcFeat && srcFeat.kind === 'arc') {
      return { id: reuseId, kind: 'arc', layer: hit.layer, center: srcFeat.center, radius: srcFeat.radius,
               a1: numE(a1), a2: numE(a2) };
    }
    return featureFromEntityInit({
      type: 'arc', layer: hit.layer, cx: hit.cx, cy: hit.cy, r: hit.r, a1, a2,
    }, reuseId ?? newFeatureId());
  };
  const pieces: { t0: number; t1: number }[] = [];
  if (hasLow)  pieces.push({ t0: 0,     t1: tLow  });
  if (hasHigh) pieces.push({ t0: tHigh, t1: 1     });
  if (!pieces.length) {
    // Entire arc consumed by flanking cutters — hide-if-referenced instead
    // of nuking the feature, so dependents (a dim, a tangent ref, a hatch
    // boundary) keep resolving through the preserved ctx slot.
    deleteFeatures([fid]);
    state.selection.delete(hit.id);
  } else {
    const idx = state.features.findIndex(f => f.id === fid);
    if (idx >= 0) state.features[idx] = mkArc(pieces[0].t0, pieces[0].t1, fid);
    for (let i = 1; i < pieces.length; i++) {
      state.features.push(mkArc(pieces[i].t0, pieces[i].t1, null));
    }
  }
  evaluateTimeline();
  updateStats();
  updateSelStatus();
  render();
}

// ---------------- Drag-select box ----------------

type Rect = { minX: number; minY: number; maxX: number; maxY: number };

function entityAABB(e: Entity): Rect | null {
  if (e.type === 'line')   return { minX: Math.min(e.x1, e.x2), minY: Math.min(e.y1, e.y2), maxX: Math.max(e.x1, e.x2), maxY: Math.max(e.y1, e.y2) };
  if (e.type === 'rect')   return { minX: Math.min(e.x1, e.x2), minY: Math.min(e.y1, e.y2), maxX: Math.max(e.x1, e.x2), maxY: Math.max(e.y1, e.y2) };
  if (e.type === 'circle') return { minX: e.cx - e.r, minY: e.cy - e.r, maxX: e.cx + e.r, maxY: e.cy + e.r };
  if (e.type === 'arc')    return { minX: e.cx - e.r, minY: e.cy - e.r, maxX: e.cx + e.r, maxY: e.cy + e.r };
  if (e.type === 'text') {
    const lt = layoutText(e);
    return { minX: lt.minX, minY: lt.minY, maxX: lt.maxX, maxY: lt.maxY };
  }
  if (e.type === 'dim') {
    const xs = [e.p1.x, e.p2.x, e.offset.x], ys = [e.p1.y, e.p2.y, e.offset.y];
    return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
  }
  if (e.type === 'polyline' || e.type === 'spline') {
    if (!e.pts.length) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of e.pts) {
      if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
    }
    return { minX, minY, maxX, maxY };
  }
  if (e.type === 'hatch') {
    // AABB is the outer boundary — holes always sit inside it, so they can't
    // extend the bounds. Without this case, drag-select silently skipped
    // every hatch/fill because the polyline branch didn't apply.
    if (!e.pts.length) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of e.pts) {
      if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
    }
    return { minX, minY, maxX, maxY };
  }
  if (e.type === 'ellipse') {
    // Tight AABB of a rotated ellipse: half-extents are
    //   hx = sqrt((rx·cos)² + (ry·sin)²),  hy = sqrt((rx·sin)² + (ry·cos)²).
    const c = Math.cos(e.rot), s = Math.sin(e.rot);
    const hx = Math.sqrt((e.rx * c) ** 2 + (e.ry * s) ** 2);
    const hy = Math.sqrt((e.rx * s) ** 2 + (e.ry * c) ** 2);
    return { minX: e.cx - hx, minY: e.cy - hy, maxX: e.cx + hx, maxY: e.cy + hy };
  }
  return null;
}

// Liang-Barsky segment-vs-rect intersection.
function segIntersectsRect(ax: number, ay: number, bx: number, by: number, r: Rect): boolean {
  let t0 = 0, t1 = 1;
  const dx = bx - ax, dy = by - ay;
  const p = [-dx, dx, -dy, dy];
  const q = [ax - r.minX, r.maxX - ax, ay - r.minY, r.maxY - ay];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) { if (q[i] < 0) return false; }
    else {
      const t = q[i] / p[i];
      if (p[i] < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
      else          { if (t < t0) return false; if (t < t1) t1 = t; }
    }
  }
  return true;
}

function entityIntersectsRect(e: Entity, r: Rect): boolean {
  if (e.type === 'xline') {
    const T = 1e6;
    return segIntersectsRect(e.x1 - e.dx * T, e.y1 - e.dy * T, e.x1 + e.dx * T, e.y1 + e.dy * T, r);
  }
  const bb = entityAABB(e);
  if (!bb) return false;
  if (bb.maxX < r.minX || bb.minX > r.maxX || bb.maxY < r.minY || bb.minY > r.maxY) return false;
  if (e.type === 'line') return segIntersectsRect(e.x1, e.y1, e.x2, e.y2, r);
  if (e.type === 'polyline') {
    for (let i = 0; i < e.pts.length - 1; i++) {
      if (segIntersectsRect(e.pts[i].x, e.pts[i].y, e.pts[i + 1].x, e.pts[i + 1].y, r)) return true;
    }
    if (e.closed && e.pts.length > 2) {
      const first = e.pts[0], last = e.pts[e.pts.length - 1];
      if (segIntersectsRect(last.x, last.y, first.x, first.y, r)) return true;
    }
    return false;
  }
  if (e.type === 'circle' || e.type === 'arc') {
    // bbox overlap already checked; treat as circle/circle-arc hit for selection.
    const ex = Math.max(r.minX, Math.min(e.cx, r.maxX));
    const ey = Math.max(r.minY, Math.min(e.cy, r.maxY));
    const dx = e.cx - ex, dy = e.cy - ey;
    return dx * dx + dy * dy <= e.r * e.r;
  }
  if (e.type === 'hatch') {
    // Boundary-segment test, same spirit as the closed-polyline branch:
    //   - outer ring is implicitly closed (last → first);
    //   - each hole ring is closed too.
    // Also accept "drag box fully inside the hatch region" — the rect centre
    // lying inside the outer ring and outside every hole counts as a crossing
    // hit, matching the user expectation that clicking inside a filled area
    // selects it.
    const segHit = (pts: Pt[]): boolean => {
      for (let i = 0; i < pts.length - 1; i++) {
        if (segIntersectsRect(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y, r)) return true;
      }
      if (pts.length > 2) {
        const first = pts[0], last = pts[pts.length - 1];
        if (segIntersectsRect(last.x, last.y, first.x, first.y, r)) return true;
      }
      return false;
    };
    if (segHit(e.pts)) return true;
    if (e.holes) for (const h of e.holes) if (segHit(h)) return true;
    // Inside-fill fallback: rect centre vs. outer ring minus holes.
    const cx = (r.minX + r.maxX) / 2, cy = (r.minY + r.maxY) / 2;
    const ptIn = (pts: Pt[]): boolean => {
      let inside = false;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const yi = pts[i].y, yj = pts[j].y;
        if ((yi > cy) !== (yj > cy)) {
          const xAt = (pts[j].x - pts[i].x) * (cy - yi) / (yj - yi) + pts[i].x;
          if (cx < xAt) inside = !inside;
        }
      }
      return inside;
    };
    if (!ptIn(e.pts)) return false;
    if (e.holes) for (const h of e.holes) if (ptIn(h)) return false;
    return true;
  }
  return true; // rect passes bbox overlap
}

function entityContainedInRect(e: Entity, r: Rect): boolean {
  if (e.type === 'xline') return false;
  const bb = entityAABB(e);
  if (!bb) return false;
  return bb.minX >= r.minX && bb.minY >= r.minY && bb.maxX <= r.maxX && bb.maxY <= r.maxY;
}

/**
 * Select entities by drag rectangle. Right-to-left drag (a.x > b.x) → crossing:
 * pick anything the box touches. Left-to-right → window: pick only fully enclosed.
 * Shift extends the existing selection.
 */
export function selectByBox(a: Pt, b: Pt, shift: boolean): void {
  const crossing = a.x > b.x;
  const r: Rect = {
    minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y),
    maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y),
  };
  if (!shift) state.selection.clear();
  for (const e of state.entities) {
    const layer = state.layers[e.layer];
    if (!layer || !layer.visible || layer.locked) continue;
    const hit = crossing ? entityIntersectsRect(e, r) : entityContainedInRect(e, r);
    if (hit) state.selection.add(e.id);
  }
  updateSelStatus();
}

// Re-exports so other modules don't need to know about hit-test helpers
export { hitTest, nearestPolySegment, nearestRectEdge };
