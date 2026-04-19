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

export function collectSnapPoints(cursor: Pt, fromPt: Pt | null = null): SnapPoint | null {
  const pts: SnapPoint[] = [];
  const snapSettings = runtime.snapSettings;
  const tol = 14 / state.view.scale;

  const visibleLines: (LineEntity | XLineEntity)[] = [];

  for (const e of state.entities) {
    const layer = state.layers[e.layer];
    if (!layer || !layer.visible) continue;

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
        if (dist(foot, cursor) < tol) pts.push({ type: 'perp', x: foot.x, y: foot.y });
      }
    } else if (e.type === 'xline') {
      if (snapSettings.end) {
        // Snap to xline base point so lines can be drawn from it relationally.
        if (dist({ x: e.x1, y: e.y1 }, cursor) < tol) {
          pts.push({ type: 'end', x: e.x1, y: e.y1, entityId: e.id });
        }
      }
      if (snapSettings.perp && fromPt) {
        const foot = footOnLine({ x: e.x1, y: e.y1 }, { x: e.dx, y: e.dy }, fromPt);
        if (dist(foot, cursor) < tol) pts.push({ type: 'perp', x: foot.x, y: foot.y });
      }
      // Infinite line — can't bbox-reject, but only contributes to intersections.
      visibleLines.push(e);
    } else if (e.type === 'rect') {
      const xl = Math.min(e.x1, e.x2), xr = Math.max(e.x1, e.x2);
      const yb = Math.min(e.y1, e.y2), yt = Math.max(e.y1, e.y2);
      if (!bboxNear({ minX: xl, minY: yb, maxX: xr, maxY: yt }, cursor, tol)) continue;
      if (snapSettings.end) {
        pts.push({ type: 'end', x: xl, y: yb, entityId: e.id });
        pts.push({ type: 'end', x: xr, y: yb, entityId: e.id });
        pts.push({ type: 'end', x: xr, y: yt, entityId: e.id });
        pts.push({ type: 'end', x: xl, y: yt, entityId: e.id });
      }
      if (snapSettings.mid) {
        pts.push({ type: 'mid', x: (xl + xr) / 2, y: yb, entityId: e.id });
        pts.push({ type: 'mid', x: xr,            y: (yb + yt) / 2, entityId: e.id });
        pts.push({ type: 'mid', x: (xl + xr) / 2, y: yt, entityId: e.id });
        pts.push({ type: 'mid', x: xl,            y: (yb + yt) / 2, entityId: e.id });
      }
      if (snapSettings.center) {
        pts.push({ type: 'center', x: (xl + xr) / 2, y: (yb + yt) / 2, entityId: e.id });
      }
      if (snapSettings.perp && fromPt) {
        const edges: [Pt, Pt][] = [
          [{ x: xl, y: yb }, { x: xr, y: yb }],
          [{ x: xr, y: yb }, { x: xr, y: yt }],
          [{ x: xr, y: yt }, { x: xl, y: yt }],
          [{ x: xl, y: yt }, { x: xl, y: yb }],
        ];
        for (const [a, b] of edges) {
          const foot = footOnLine(a, { x: b.x - a.x, y: b.y - a.y }, fromPt);
          const t = ((foot.x - a.x) * (b.x - a.x) + (foot.y - a.y) * (b.y - a.y))
                  / ((b.x - a.x) ** 2 + (b.y - a.y) ** 2 || 1);
          if (t >= -0.01 && t <= 1.01 && dist(foot, cursor) < tol) {
            pts.push({ type: 'perp', x: foot.x, y: foot.y });
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
        pts.push({ type: 'end', x: e.p1.x, y: e.p1.y });
        pts.push({ type: 'end', x: e.p2.x, y: e.p2.y });
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

  const axisX: XLineEntity = { id: -1, layer: 0, type: 'xline', x1: 0, y1: 0, dx: 1, dy: 0 };
  const axisY: XLineEntity = { id: -1, layer: 0, type: 'xline', x1: 0, y1: 0, dx: 0, dy: 1 };

  // Origin is always valuable when axis snap is on, independent of `int`.
  if (snapSettings.axis) pts.push({ type: 'int', x: 0, y: 0 });

  if (snapSettings.int) {
    for (let i = 0; i < visibleLines.length; i++) {
      for (let j = i + 1; j < visibleLines.length; j++) {
        const ip = intersectLines(visibleLines[i], visibleLines[j]);
        if (ip) pts.push({
          type: 'int', x: ip.x, y: ip.y,
          entityId: visibleLines[i].id, entityId2: visibleLines[j].id,
        });
      }
    }
    if (snapSettings.axis) {
      for (const L of visibleLines) {
        for (const A of [axisX, axisY]) {
          const ip = intersectLines(L, A);
          if (ip) pts.push({ type: 'int', x: ip.x, y: ip.y });
        }
      }

      for (const e of state.entities) {
        if (e.type !== 'rect') continue;
        const layer = state.layers[e.layer];
        if (!layer || !layer.visible) continue;
        const xl = Math.min(e.x1, e.x2), xr = Math.max(e.x1, e.x2);
        const yb = Math.min(e.y1, e.y2), yt = Math.max(e.y1, e.y2);
        const edges = [
          { type: 'line' as const, x1: xl, y1: yb, x2: xr, y2: yb },
          { type: 'line' as const, x1: xr, y1: yb, x2: xr, y2: yt },
          { type: 'line' as const, x1: xr, y1: yt, x2: xl, y2: yt },
          { type: 'line' as const, x1: xl, y1: yt, x2: xl, y2: yb },
        ];
        for (const ed of edges) {
          for (const A of [axisX, axisY]) {
            const ip = intersectLines(ed, A);
            if (ip) pts.push({ type: 'int', x: ip.x, y: ip.y });
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

  const prio: Record<SnapPoint['type'], number> = {
    end: 8, mid: 7, int: 6, center: 5, tangent: 4, perp: 3, axis: 2, grid: 1,
  };
  // Within the tolerance radius, higher priority always wins.
  // Among equal-priority candidates, the closest one wins.
  let best: SnapPoint | null = null;
  let bestD = Infinity;
  for (const p of pts) {
    const d = dist(p, cursor);
    if (d >= tol) continue;
    if (!best) { best = p; bestD = d; continue; }
    if (prio[p.type] > prio[best.type]) { best = p; bestD = d; }
    else if (prio[p.type] === prio[best.type] && d < bestD) { best = p; bestD = d; }
  }
  return best;
}
