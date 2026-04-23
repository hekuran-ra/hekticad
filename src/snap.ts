import type { LineEntity, Pt, SnapPoint, XLineEntity } from './types';
import { state, runtime } from './state';
import { dist } from './math';
import { angleInSweep } from './hittest';

/**
 * Compute line/xline intersection. For finite lines, clamps t/u to [0,1].
 * Returns null for parallel lines.
 */
export function intersectLines(
  a: LineEntity | XLineEntity | { type: 'line'; x1: number; y1: number; x2: number; y2: number },
  b: LineEntity | XLineEntity | { type: 'line'; x1: number; y1: number; x2: number; y2: number },
): Pt | null {
  const p1 = { x: a.x1, y: a.y1 };
  const p2 = a.type === 'xline'
    ? { x: a.x1 + a.dx, y: a.y1 + a.dy }
    : { x: a.x2, y: a.y2 };
  const p3 = { x: b.x1, y: b.y1 };
  const p4 = b.type === 'xline'
    ? { x: b.x1 + b.dx, y: b.y1 + b.dy }
    : { x: b.x2, y: b.y2 };
  const den = (p1.x - p2.x) * (p3.y - p4.y) - (p1.y - p2.y) * (p3.x - p4.x);
  if (Math.abs(den) < 1e-9) return null;
  const t = ((p1.x - p3.x) * (p3.y - p4.y) - (p1.y - p3.y) * (p3.x - p4.x)) / den;
  if (a.type === 'line' && (t < -1e-6 || t > 1 + 1e-6)) return null;
  const u = -((p1.x - p2.x) * (p1.y - p3.y) - (p1.y - p2.y) * (p1.x - p3.x)) / den;
  if (b.type === 'line' && (u < -1e-6 || u > 1 + 1e-6)) return null;
  return { x: p1.x + t * (p2.x - p1.x), y: p1.y + t * (p2.y - p1.y) };
}

/**
 * Find the best snap point near `cursor`, given current snap settings.
 * Uses a priority tiebreaker so end/mid beat grid/axis when close.
 */
/** Cursor-proximity filter: quick reject entities whose bbox is far from cursor. */
function bboxNear(bb: { minX: number; minY: number; maxX: number; maxY: number }, cursor: Pt, tol: number): boolean {
  return cursor.x >= bb.minX - tol && cursor.x <= bb.maxX + tol
      && cursor.y >= bb.minY - tol && cursor.y <= bb.maxY + tol;
}

/**
 * Project `p` onto the infinite line through `a` in direction `d` (unit-ish).
 * Returns the foot of perpendicular. `d` need not be normalized.
 */
function footOnLine(a: Pt, d: Pt, p: Pt): Pt {
  const L2 = d.x * d.x + d.y * d.y;
  if (L2 < 1e-18) return a;
  const t = ((p.x - a.x) * d.x + (p.y - a.y) * d.y) / L2;
  return { x: a.x + t * d.x, y: a.y + t * d.y };
}

/**
 * Collect every "point of interest" across the drawing — endpoints,
 * midpoints, centers. Each of these becomes a potential anchor for the
 * dynamic-guide system: the user gets a dashed H/V (and polar) alignment
 * ray through any of these whenever the cursor aligns with them.
 *
 * Unlike the main snap loop we DON'T prune by cursor distance here — a
 * dynamic guide is useful precisely when the user is far from the anchor
 * itself (otherwise a direct end/mid snap already fires). Visibility is
 * respected so hidden-layer anchors don't emit ghost guides.
 *
 * Kept simple and purely geometric: no dwell timer, no "acquired" list,
 * no state. Re-scanned every mousemove. For typical drawings this is a
 * few hundred points — O(N) cheap.
 */
function collectDynAnchors(): Pt[] {
  const pts: Pt[] = [];
  // Origin is always an interesting alignment target when axis snap is on —
  // even if the two axis xlines are below visibility threshold.
  if (runtime.snapSettings.axis) pts.push({ x: 0, y: 0 });
  for (const e of state.entities) {
    const layer = state.layers[e.layer];
    if (!layer || !layer.visible) continue;
    if (e.type === 'line') {
      pts.push({ x: e.x1, y: e.y1 }, { x: e.x2, y: e.y2 });
      pts.push({ x: (e.x1 + e.x2) / 2, y: (e.y1 + e.y2) / 2 });
    } else if (e.type === 'rect') {
      const xl = Math.min(e.x1, e.x2), xr = Math.max(e.x1, e.x2);
      const yb = Math.min(e.y1, e.y2), yt = Math.max(e.y1, e.y2);
      pts.push({ x: xl, y: yb }, { x: xr, y: yb }, { x: xr, y: yt }, { x: xl, y: yt });
      pts.push({ x: (xl + xr) / 2, y: (yb + yt) / 2 });
    } else if (e.type === 'circle') {
      pts.push({ x: e.cx, y: e.cy });
      pts.push({ x: e.cx + e.r, y: e.cy }, { x: e.cx - e.r, y: e.cy });
      pts.push({ x: e.cx, y: e.cy + e.r }, { x: e.cx, y: e.cy - e.r });
    } else if (e.type === 'arc') {
      pts.push({ x: e.cx, y: e.cy });
      pts.push({ x: e.cx + Math.cos(e.a1) * e.r, y: e.cy + Math.sin(e.a1) * e.r });
      pts.push({ x: e.cx + Math.cos(e.a2) * e.r, y: e.cy + Math.sin(e.a2) * e.r });
    } else if (e.type === 'ellipse') {
      pts.push({ x: e.cx, y: e.cy });
    } else if (e.type === 'polyline') {
      for (const v of e.pts) pts.push({ x: v.x, y: v.y });
    } else if (e.type === 'spline') {
      for (const v of e.pts) pts.push({ x: v.x, y: v.y });
    } else if (e.type === 'dim') {
      if (e.p1) pts.push({ x: e.p1.x, y: e.p1.y });
      if (e.p2) pts.push({ x: e.p2.x, y: e.p2.y });
      if (e.vertex) pts.push({ x: e.vertex.x, y: e.vertex.y });
    } else if (e.type === 'xline') {
      pts.push({ x: e.x1, y: e.y1 });
    } else if (e.type === 'text') {
      pts.push({ x: e.x, y: e.y });
    }
  }
  return pts;
}

/** Tangent points on circle (C, r) from external point P. Empty if P is inside. */
function tangentPoints(C: Pt, r: number, P: Pt): Pt[] {
  const dx = P.x - C.x, dy = P.y - C.y;
  const d2 = dx * dx + dy * dy;
  if (d2 <= r * r + 1e-9) return [];
  const d = Math.sqrt(d2);
  const theta = Math.atan2(dy, dx);
  const alpha = Math.acos(r / d);
  return [
    { x: C.x + r * Math.cos(theta + alpha), y: C.y + r * Math.sin(theta + alpha) },
    { x: C.x + r * Math.cos(theta - alpha), y: C.y + r * Math.sin(theta - alpha) },
  ];
}

export function collectSnapPoints(
  cursor: Pt,
  fromPt: Pt | null = null,
  excludeId: number | null = null,
): SnapPoint | null {
  const pts: SnapPoint[] = [];
  const snapSettings = runtime.snapSettings;
  const tol = 14 / state.view.scale;

  const visibleLines: (LineEntity | XLineEntity)[] = [];

  for (const e of state.entities) {
    const layer = state.layers[e.layer];
    if (!layer || !layer.visible) continue;
    // Skip the entity currently being edited by a grip drag — otherwise the
    // endpoint we just moved to the cursor becomes its own snap candidate
    // and "locks" the grip to its own previous position.
    if (excludeId != null && e.id === excludeId) continue;

    if (e.type === 'line') {
      const bb = { minX: Math.min(e.x1, e.x2), minY: Math.min(e.y1, e.y2), maxX: Math.max(e.x1, e.x2), maxY: Math.max(e.y1, e.y2) };
      if (bboxNear(bb, cursor, tol)) {
        if (snapSettings.end) {
          pts.push({ type: 'end', x: e.x1, y: e.y1, entityId: e.id });
          pts.push({ type: 'end', x: e.x2, y: e.y2, entityId: e.id });
        }
        if (snapSettings.mid) {
          pts.push({ type: 'mid', x: (e.x1 + e.x2) / 2, y: (e.y1 + e.y2) / 2, entityId: e.id });
        }
        visibleLines.push(e);
      }
      // Perp: the foot may lie outside the line's bbox. Gate by distance-to-cursor instead.
      if (snapSettings.perp && fromPt) {
        const foot = footOnLine({ x: e.x1, y: e.y1 }, { x: e.x2 - e.x1, y: e.y2 - e.y1 }, fromPt);
        if (dist(foot, cursor) < tol) pts.push({ type: 'perp', x: foot.x, y: foot.y, entityId: e.id, edge: { kind: 'lineSeg' } });
      }
    } else if (e.type === 'xline') {
      if (snapSettings.end) {
        // Snap to xline base point so lines can be drawn from it relationally.
        if (dist({ x: e.x1, y: e.y1 }, cursor) < tol) {
          pts.push({ type: 'end', x: e.x1, y: e.y1, entityId: e.id });
        }
      }
      // Achs-Fang (ACHS): wenn der Cursor nahe der Xline liegt, einen
      // Fangpunkt auf der Linie (Lot vom Cursor) liefern. Damit funktioniert
      // ACHS nicht nur auf den Welt-Achsen sondern auf jeder Hilfslinie /
      // Bezugsachse, die der Benutzer zeichnet.
      if (snapSettings.axis) {
        const aTol = 12 / state.view.scale;
        const foot = footOnLine({ x: e.x1, y: e.y1 }, { x: e.dx, y: e.dy }, cursor);
        if (dist(foot, cursor) < aTol) {
          // Edge annotation lets the line tool build a rayHit PointRef when
          // the user locks an angle and snaps onto an xline's axis (including
          // parallelXLine / axisParallelXLine outputs). Without this the
          // endpoint stores a fixed polar distance and ignores later param
          // changes of the reference axis.
          pts.push({ type: 'axis', x: foot.x, y: foot.y, entityId: e.id, edge: { kind: 'lineSeg' } });
        }
      }
      if (snapSettings.perp && fromPt) {
        const foot = footOnLine({ x: e.x1, y: e.y1 }, { x: e.dx, y: e.dy }, fromPt);
        if (dist(foot, cursor) < tol) pts.push({ type: 'perp', x: foot.x, y: foot.y, entityId: e.id, edge: { kind: 'lineSeg' } });
      }
      // Infinite line — filter by perpendicular distance to cursor so only
      // xlines actually near the cursor contribute to the O(N²) intersection
      // loop below. Without this, 50 Hilfslinien produce 50² = 2500
      // intersection tests *per mousemove*, which is the main reason the
      // app feels sluggish as the drawing grows.
      const foot = footOnLine({ x: e.x1, y: e.y1 }, { x: e.dx, y: e.dy }, cursor);
      if (dist(foot, cursor) < tol * 4) visibleLines.push(e);
    } else if (e.type === 'rect') {
      const xl = Math.min(e.x1, e.x2), xr = Math.max(e.x1, e.x2);
      const yb = Math.min(e.y1, e.y2), yt = Math.max(e.y1, e.y2);
      if (!bboxNear({ minX: xl, minY: yb, maxX: xr, maxY: yt }, cursor, tol)) continue;
      // Per-edge metadata used by the rayHit PointRef builder: lets the line
      // tool record "line endpoint = ray × this specific rect edge".
      type RectSide = 'top' | 'right' | 'bottom' | 'left';
      const edgeRef = (side: RectSide) =>
        ({ kind: 'rectEdge', side } as const);
      if (snapSettings.end) {
        // Corners belong to two edges; we don't know at snap-time which one
        // the user wants to track (depends on ray direction at commit). The
        // line tool re-resolves the best edge in `handleLineClick` via
        // `rayEdgeIntersect` — we just tag one default here so the edge field
        // is always populated (avoids a branch where snap.edge is falsy).
        pts.push({ type: 'end', x: xl, y: yb, entityId: e.id, edge: edgeRef('bottom') });
        pts.push({ type: 'end', x: xr, y: yb, entityId: e.id, edge: edgeRef('bottom') });
        pts.push({ type: 'end', x: xr, y: yt, entityId: e.id, edge: edgeRef('top') });
        pts.push({ type: 'end', x: xl, y: yt, entityId: e.id, edge: edgeRef('top') });
      }
      if (snapSettings.mid) {
        pts.push({ type: 'mid', x: (xl + xr) / 2, y: yb, entityId: e.id, edge: edgeRef('bottom') });
        pts.push({ type: 'mid', x: xr,            y: (yb + yt) / 2, entityId: e.id, edge: edgeRef('right') });
        pts.push({ type: 'mid', x: (xl + xr) / 2, y: yt, entityId: e.id, edge: edgeRef('top') });
        pts.push({ type: 'mid', x: xl,            y: (yb + yt) / 2, entityId: e.id, edge: edgeRef('left') });
      }
      if (snapSettings.center) {
        pts.push({ type: 'center', x: (xl + xr) / 2, y: (yb + yt) / 2, entityId: e.id });
      }
      if (snapSettings.perp && fromPt) {
        const edges: [Pt, Pt, RectSide][] = [
          [{ x: xl, y: yb }, { x: xr, y: yb }, 'bottom'],
          [{ x: xr, y: yb }, { x: xr, y: yt }, 'right'],
          [{ x: xr, y: yt }, { x: xl, y: yt }, 'top'],
          [{ x: xl, y: yt }, { x: xl, y: yb }, 'left'],
        ];
        for (const [a, b, side] of edges) {
          const foot = footOnLine(a, { x: b.x - a.x, y: b.y - a.y }, fromPt);
          const t = ((foot.x - a.x) * (b.x - a.x) + (foot.y - a.y) * (b.y - a.y))
                  / ((b.x - a.x) ** 2 + (b.y - a.y) ** 2 || 1);
          if (t >= -0.01 && t <= 1.01 && dist(foot, cursor) < tol) {
            pts.push({ type: 'perp', x: foot.x, y: foot.y, entityId: e.id, edge: edgeRef(side) });
          }
        }
      }
    } else if (e.type === 'circle') {
      if (!bboxNear({ minX: e.cx - e.r, minY: e.cy - e.r, maxX: e.cx + e.r, maxY: e.cy + e.r }, cursor, tol)) continue;
      if (snapSettings.center) pts.push({ type: 'center', x: e.cx, y: e.cy, entityId: e.id });
      if (snapSettings.end) {
        pts.push({ type: 'end', x: e.cx + e.r, y: e.cy, entityId: e.id });
        pts.push({ type: 'end', x: e.cx - e.r, y: e.cy, entityId: e.id });
        pts.push({ type: 'end', x: e.cx,       y: e.cy + e.r, entityId: e.id });
        pts.push({ type: 'end', x: e.cx,       y: e.cy - e.r, entityId: e.id });
      }
      if (snapSettings.tangent && fromPt) {
        for (const tp of tangentPoints({ x: e.cx, y: e.cy }, e.r, fromPt)) {
          pts.push({ type: 'tangent', x: tp.x, y: tp.y });
        }
      }
    } else if (e.type === 'arc') {
      if (!bboxNear({ minX: e.cx - e.r, minY: e.cy - e.r, maxX: e.cx + e.r, maxY: e.cy + e.r }, cursor, tol)) continue;
      if (snapSettings.center) pts.push({ type: 'center', x: e.cx, y: e.cy, entityId: e.id });
      if (snapSettings.end) {
        pts.push({ type: 'end', x: e.cx + Math.cos(e.a1) * e.r, y: e.cy + Math.sin(e.a1) * e.r, entityId: e.id });
        pts.push({ type: 'end', x: e.cx + Math.cos(e.a2) * e.r, y: e.cy + Math.sin(e.a2) * e.r, entityId: e.id });
      }
      if (snapSettings.mid) {
        const am = (e.a1 + e.a2) / 2;
        pts.push({ type: 'mid', x: e.cx + Math.cos(am) * e.r, y: e.cy + Math.sin(am) * e.r, entityId: e.id });
      }
      if (snapSettings.tangent && fromPt) {
        for (const tp of tangentPoints({ x: e.cx, y: e.cy }, e.r, fromPt)) {
          const ang = Math.atan2(tp.y - e.cy, tp.x - e.cx);
          if (angleInSweep(ang, e.a1, e.a2)) {
            pts.push({ type: 'tangent', x: tp.x, y: tp.y });
          }
        }
      }
    } else if (e.type === 'dim') {
      if (snapSettings.end) {
        if (e.dimKind === 'angular' && e.vertex) {
          // Angular dim: snap to the shared vertex and the stored ray anchors.
          pts.push({ type: 'end', x: e.vertex.x, y: e.vertex.y });
          if (e.ray1) pts.push({ type: 'end', x: e.ray1.x, y: e.ray1.y });
          if (e.ray2) pts.push({ type: 'end', x: e.ray2.x, y: e.ray2.y });
        } else {
          // Linear / radius / diameter: p1 and p2 are the two measured points
          // (for radius: p1 = centre, p2 = near-edge).
          pts.push({ type: 'end', x: e.p1.x, y: e.p1.y });
          pts.push({ type: 'end', x: e.p2.x, y: e.p2.y });
        }
      }
      // Radius/diameter: the stored `vertex` is the circle's centre — offer
      // it as a center-snap so users can quickly re-reference the same
      // centre when drawing related geometry.
      if (snapSettings.center && (e.dimKind === 'radius' || e.dimKind === 'diameter') && e.vertex) {
        pts.push({ type: 'center', x: e.vertex.x, y: e.vertex.y });
      }
    } else if (e.type === 'text') {
      if (snapSettings.end) {
        if (bboxNear({ minX: e.x - tol, minY: e.y - tol, maxX: e.x + tol, maxY: e.y + tol }, cursor, tol)) {
          pts.push({ type: 'end', x: e.x, y: e.y });
        }
      }
    } else if (e.type === 'ellipse') {
      const maxR = Math.max(e.rx, e.ry);
      if (!bboxNear({ minX: e.cx - maxR, minY: e.cy - maxR, maxX: e.cx + maxR, maxY: e.cy + maxR }, cursor, tol)) continue;
      if (snapSettings.center) pts.push({ type: 'center', x: e.cx, y: e.cy, entityId: e.id });
      if (snapSettings.end) {
        // Four axis endpoints, rotated
        const cos = Math.cos(e.rot), sin = Math.sin(e.rot);
        pts.push({ type: 'end', x: e.cx + e.rx * cos, y: e.cy + e.rx * sin, entityId: e.id });
        pts.push({ type: 'end', x: e.cx - e.rx * cos, y: e.cy - e.rx * sin, entityId: e.id });
        pts.push({ type: 'end', x: e.cx - e.ry * sin, y: e.cy + e.ry * cos, entityId: e.id });
        pts.push({ type: 'end', x: e.cx + e.ry * sin, y: e.cy - e.ry * cos, entityId: e.id });
      }
    } else if (e.type === 'spline') {
      if (!e.pts.length) continue;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const v of e.pts) {
        if (v.x < minX) minX = v.x; if (v.y < minY) minY = v.y;
        if (v.x > maxX) maxX = v.x; if (v.y > maxY) maxY = v.y;
      }
      if (!bboxNear({ minX, minY, maxX, maxY }, cursor, tol)) continue;
      if (snapSettings.end) for (const v of e.pts) pts.push({ type: 'end', x: v.x, y: v.y, entityId: e.id });
    } else if (e.type === 'polyline') {
      if (!e.pts.length) continue;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of e.pts) {
        if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
      }
      if (!bboxNear({ minX, minY, maxX, maxY }, cursor, tol)) continue;
      if (snapSettings.end) for (const v of e.pts) pts.push({ type: 'end', x: v.x, y: v.y, entityId: e.id });
      if (snapSettings.mid) {
        for (let i = 1; i < e.pts.length; i++) {
          pts.push({
            type: 'mid', entityId: e.id,
            x: (e.pts[i - 1].x + e.pts[i].x) / 2,
            y: (e.pts[i - 1].y + e.pts[i].y) / 2,
          });
        }
        if (e.closed && e.pts.length >= 2) {
          const a = e.pts[e.pts.length - 1], b = e.pts[0];
          pts.push({ type: 'mid', entityId: e.id, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
        }
      }
    }
  }

  // Sentinel entity IDs that tag a snap point as involving the X or Y origin
  // axis. The axes aren't real entities; these negative numbers never collide
  // with real entity ids (which are positive) and let `snapToPointRef`
  // translate an axis-intersection snap back into a parametric PointRef
  // (`intersection` with feature1/2 = AXIS_X_ID / AXIS_Y_ID). Without this
  // transport the axis side of the intersection silently decays to abs and
  // the drawn geometry detaches from the axis on variable change.
  const AXIS_X_ENT = -1001;
  const AXIS_Y_ENT = -1002;
  const axisX: XLineEntity = { id: AXIS_X_ENT, layer: 0, type: 'xline', x1: 0, y1: 0, dx: 1, dy: 0 };
  const axisY: XLineEntity = { id: AXIS_Y_ENT, layer: 0, type: 'xline', x1: 0, y1: 0, dx: 0, dy: 1 };

  // Origin is always valuable when axis snap is on, independent of `int`.
  // Tag it as the X×Y intersection so a snap here links both axes.
  if (snapSettings.axis) {
    pts.push({ type: 'int', x: 0, y: 0, entityId: AXIS_X_ENT, entityId2: AXIS_Y_ENT });
  }

  if (snapSettings.int) {
    // Only intersections near the cursor can ever win (the final pass rejects
    // anything outside `tol`). Computing them is cheap, but *pushing* them
    // inflates the candidate list and the final scan. Tighter cutoff here
    // also skips arithmetic for pairs whose crossing is far away.
    const intTol = tol * 2;
    for (let i = 0; i < visibleLines.length; i++) {
      for (let j = i + 1; j < visibleLines.length; j++) {
        const ip = intersectLines(visibleLines[i], visibleLines[j]);
        if (!ip) continue;
        if (Math.abs(ip.x - cursor.x) > intTol || Math.abs(ip.y - cursor.y) > intTol) continue;
        pts.push({
          type: 'int', x: ip.x, y: ip.y,
          entityId: visibleLines[i].id, entityId2: visibleLines[j].id,
        });
      }
    }
    if (snapSettings.axis) {
      for (const L of visibleLines) {
        for (const A of [axisX, axisY]) {
          const ip = intersectLines(L, A);
          if (!ip) continue;
          if (Math.abs(ip.x - cursor.x) > intTol || Math.abs(ip.y - cursor.y) > intTol) continue;
          // Transport both entity ids — L is the real feature, A is the axis
          // sentinel. `snapToPointRef` uses these to produce a parametric
          // `intersection` PointRef whose one side is the axis constant.
          pts.push({ type: 'int', x: ip.x, y: ip.y, entityId: L.id, entityId2: A.id });
        }
      }

      for (const e of state.entities) {
        if (e.type !== 'rect') continue;
        const layer = state.layers[e.layer];
        if (!layer || !layer.visible) continue;
        const xl = Math.min(e.x1, e.x2), xr = Math.max(e.x1, e.x2);
        const yb = Math.min(e.y1, e.y2), yt = Math.max(e.y1, e.y2);
        // Rect edges far from cursor can't produce a near-cursor axis
        // intersection — quick AABB reject saves four line-tests per rect.
        if (!bboxNear({ minX: xl, minY: yb, maxX: xr, maxY: yt }, cursor, intTol)) continue;
        const edges = [
          { type: 'line' as const, x1: xl, y1: yb, x2: xr, y2: yb },
          { type: 'line' as const, x1: xr, y1: yb, x2: xr, y2: yt },
          { type: 'line' as const, x1: xr, y1: yt, x2: xl, y2: yt },
          { type: 'line' as const, x1: xl, y1: yt, x2: xl, y2: yb },
        ];
        for (const ed of edges) {
          for (const A of [axisX, axisY]) {
            const ip = intersectLines(ed, A);
            if (!ip) continue;
            if (Math.abs(ip.x - cursor.x) > intTol || Math.abs(ip.y - cursor.y) > intTol) continue;
            // Rect edges can't be addressed as a single PointRef in current
            // type, so we transport only the axis sentinel; the rect-side
            // ref stays abs (two of the four rect corners already decay to
            // abs in snapToPointRef, same reasoning).
            pts.push({ type: 'int', x: ip.x, y: ip.y, entityId: e.id, entityId2: A.id });
          }
        }
      }
    }
  }

  if (snapSettings.axis) {
    const aTol = 12 / state.view.scale;
    const nearX = Math.abs(cursor.y) < aTol;
    const nearY = Math.abs(cursor.x) < aTol;
    // Near both axes → user intent is clearly the origin. Skip axis points so
    // the origin `int` snap wins the proximity contest.
    if (!(nearX && nearY)) {
      if (nearX) pts.push({ type: 'axis', x: cursor.x, y: 0 });
      if (nearY) pts.push({ type: 'axis', x: 0,        y: cursor.y });
    }
  }

  if (snapSettings.grid && snapSettings.gridSize > 0) {
    const g = snapSettings.gridSize;
    pts.push({ type: 'grid', x: Math.round(cursor.x / g) * g, y: Math.round(cursor.y / g) * g });
  }

  // ─── Dynamic guides: polar + DYN (auto-aligned anchors) ─────────────────
  //
  // Each "guide" is a ray (origin + unit direction). Two sources:
  //   • Polar rays — from fromPt at every polarAngleDeg multiple.
  //   • DYN rays  — horizontal + vertical rays through any end/mid/center
  //                 anchor in the drawing that the cursor is aligned with
  //                 (y ≈ anchor.y or x ≈ anchor.x within guideTol).
  //
  // For every single guide we push a `track`/`polar` snap at the foot-of-
  // perpendicular on the ray (so cursor locks to the guide). For every PAIR
  // of guides we push the intersection so alignments cross cleanly:
  //   - polar × DYN       → "45° from anchor A, horizontally aligned with B"
  //   - DYN(H,A) × DYN(V,B) → "line up X with A and Y with B" (between 2 pts)
  //
  // Tolerance: cursor must be within `guideTol` perpendicular distance of the
  // ray to contribute. Generous enough to feel magnetic, tight enough that
  // unrelated anchors don't clutter the picture.
  const guideTol = 10 / state.view.scale;
  type Guide = { origin: Pt; angle: number; kind: 'polar' | 'track' };
  const guides: Guide[] = [];

  if (snapSettings.polar && fromPt && snapSettings.polarAngleDeg > 0) {
    const step = (snapSettings.polarAngleDeg * Math.PI) / 180;
    const dx = cursor.x - fromPt.x;
    const dy = cursor.y - fromPt.y;
    const r = Math.hypot(dx, dy);
    if (r > 1e-6) {
      const cursorAng = Math.atan2(dy, dx);
      // Nearest multiple of `step`, wrapped to (-π, π].
      const k = Math.round(cursorAng / step);
      const ang = k * step;
      // Angular deviation in radians → perpendicular distance at radius r.
      const perpDist = Math.abs(Math.sin(cursorAng - ang)) * r;
      if (perpDist < guideTol) {
        guides.push({ origin: fromPt, angle: ang, kind: 'polar' });
      }
    }
  }

  if (snapSettings.tracking) {
    // Auto-scan: every anchor point in the drawing can potentially emit a
    // guide. We prune to anchors whose H or V ray currently runs near the
    // cursor — so a 1000-anchor drawing still only produces a handful of
    // active guides at any given moment.
    //
    // Extra guard: skip anchors that are essentially AT the cursor (there's
    // a regular end/mid/center snap for those; a self-guide would just
    // duplicate the marker and render a zero-length ray).
    const anchors = collectDynAnchors();
    // Dedupe aligned-anchor coords to avoid drawing the same guide twice
    // when two entities share an endpoint.
    const seenH = new Set<number>();
    const seenV = new Set<number>();
    for (const a of anchors) {
      const near = Math.abs(a.x - cursor.x) < tol && Math.abs(a.y - cursor.y) < tol;
      if (near) continue;
      if (Math.abs(cursor.y - a.y) < guideTol) {
        const key = Math.round(a.y * 1000);
        if (!seenH.has(key)) {
          guides.push({ origin: { x: a.x, y: a.y }, angle: 0, kind: 'track' });
          seenH.add(key);
        }
      }
      if (Math.abs(cursor.x - a.x) < guideTol) {
        const key = Math.round(a.x * 1000);
        if (!seenV.has(key)) {
          guides.push({ origin: { x: a.x, y: a.y }, angle: Math.PI / 2, kind: 'track' });
          seenV.add(key);
        }
      }
    }
  }

  // Project cursor onto each guide and emit a snap candidate at the foot.
  for (const g of guides) {
    const d = { x: Math.cos(g.angle), y: Math.sin(g.angle) };
    const foot = footOnLine(g.origin, d, cursor);
    pts.push({
      type: g.kind,
      x: foot.x, y: foot.y,
      origin: g.origin, angleRad: g.angle,
    });
  }

  // Intersections of every pair of distinct guides (polar × DYN, DYN × DYN).
  // Only useful when the intersection is near the cursor — otherwise the
  // foot-projections above already provide the right snap.
  if (guides.length >= 2) {
    for (let i = 0; i < guides.length; i++) {
      for (let j = i + 1; j < guides.length; j++) {
        const a = guides[i], b = guides[j];
        // Skip parallel pairs: two horizontal track guides, or same-angle polar.
        const sa = Math.sin(a.angle - b.angle);
        if (Math.abs(sa) < 1e-6) continue;
        const a1 = a.origin;
        const a2 = { x: a.origin.x + Math.cos(a.angle), y: a.origin.y + Math.sin(a.angle) };
        const b1 = b.origin;
        const b2 = { x: b.origin.x + Math.cos(b.angle), y: b.origin.y + Math.sin(b.angle) };
        const den = (a1.x - a2.x) * (b1.y - b2.y) - (a1.y - a2.y) * (b1.x - b2.x);
        if (Math.abs(den) < 1e-9) continue;
        const t = ((a1.x - b1.x) * (b1.y - b2.y) - (a1.y - b1.y) * (b1.x - b2.x)) / den;
        const ix = a1.x + t * (a2.x - a1.x);
        const iy = a1.y + t * (a2.y - a1.y);
        // Generous gate: intersections are high-value, so we let them in as
        // long as they're within a few guideTol of the cursor. The final
        // loop still applies `tol` for picking a winner.
        if (Math.abs(ix - cursor.x) > guideTol * 4 || Math.abs(iy - cursor.y) > guideTol * 4) continue;
        // Mixed polar+DYN intersections promote to `polar` so the label
        // reads POLAR (higher priority than SPUR/DYN).
        const kind: 'polar' | 'track' = (a.kind === 'polar' || b.kind === 'polar') ? 'polar' : 'track';
        pts.push({
          type: kind,
          x: ix, y: iy,
          origin: a.origin, angleRad: a.angle,
          origin2: b.origin, angleRad2: b.angle,
        });
      }
    }
  }

  // Priority matters for tiebreaking within the tolerance radius. Guides rank
  // above grid but below regular object snaps — polar slightly higher than
  // track, matching AutoCAD where polar is the more "active" of the two.
  const prio: Record<SnapPoint['type'], number> = {
    end: 8, mid: 7, int: 6, center: 5, tangent: 4, perp: 3,
    axis: 2, polar: 2.5, track: 1.5, grid: 1,
  };
  // Guide-on-guide intersections (two origins present) are more valuable than
  // either single foot-projection that feeds them: "locked to 90° AND aligned
  // with that midpoint" is a stronger statement than either half alone. Bump
  // their effective priority so polar×DYN, DYN×DYN etc. beat the individual
  // foot points. Still below every real object snap (end/mid/int/…).
  const effectivePrio = (p: SnapPoint): number => {
    let pr = prio[p.type];
    if ((p.type === 'polar' || p.type === 'track') && p.origin2) pr += 3;
    return pr;
  };
  // Per-type tolerance — object snaps use the base aperture. Grid is exempt
  // (it's always the "fallback resolution" of the cursor when no higher-
  // priority snap wins — limiting it by tol would leave dead zones in the
  // middle of every grid cell). When grid snap is on, we widen the object-
  // snap aperture to one grid step so a nearby intersection/axis isn't
  // hidden behind the coarser grid sampling — this addresses the complaint
  // that raster-fang "swallows" intersection snaps.
  const objTol = snapSettings.grid && snapSettings.gridSize > 0
    ? Math.max(tol, snapSettings.gridSize)
    : tol;
  // Within the per-type tolerance, higher priority always wins. Among equal-
  // priority candidates, the closest one wins.
  let best: SnapPoint | null = null;
  let bestD = Infinity;
  let bestPrio = -Infinity;
  for (const p of pts) {
    const d = dist(p, cursor);
    if (p.type !== 'grid' && d >= objTol) continue;
    const pr = effectivePrio(p);
    if (!best) { best = p; bestD = d; bestPrio = pr; continue; }
    if (pr > bestPrio) { best = p; bestD = d; bestPrio = pr; }
    else if (pr === bestPrio && d < bestD) { best = p; bestD = d; }
  }
  return best;
}
