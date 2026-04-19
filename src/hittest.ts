import type {
  DimEntity, EllipseEntity, Entity, LineEntity, PolylineEntity, Pt, RectEntity,
  SplineEntity, TextEntity, XLineEntity,
} from './types';
import { state } from './state';
import { dot, len, norm, scale, sub } from './math';

export function distPtSeg(p: Pt, a: Pt, b: Pt): number {
  const ab = sub(b, a);
  const ap = sub(p, a);
  const L2 = dot(ab, ab);
  if (L2 < 1e-12) return len(ap);
  let t = dot(ap, ab) / L2;
  t = Math.max(0, Math.min(1, t));
  return len(sub(ap, scale(ab, t)));
}

export function distPtXLine(p: Pt, e: XLineEntity): number {
  const ap = { x: p.x - e.x1, y: p.y - e.y1 };
  return Math.abs(ap.x * e.dy - ap.y * e.dx);
}

function hitRect(p: Pt, e: RectEntity, tol: number): boolean {
  const xl = Math.min(e.x1, e.x2), xr = Math.max(e.x1, e.x2);
  const yb = Math.min(e.y1, e.y2), yt = Math.max(e.y1, e.y2);
  const edges: [Pt, Pt][] = [
    [{ x: xl, y: yb }, { x: xr, y: yb }],
    [{ x: xr, y: yb }, { x: xr, y: yt }],
    [{ x: xr, y: yt }, { x: xl, y: yt }],
    [{ x: xl, y: yt }, { x: xl, y: yb }],
  ];
  return edges.some(ed => distPtSeg(p, ed[0], ed[1]) < tol);
}

function hitLine(p: Pt, e: LineEntity, tol: number): boolean {
  return distPtSeg(p, { x: e.x1, y: e.y1 }, { x: e.x2, y: e.y2 }) < tol;
}

function hitCircle(p: Pt, e: { cx: number; cy: number; r: number }, tol: number): boolean {
  return Math.abs(Math.hypot(p.x - e.cx, p.y - e.cy) - e.r) < tol;
}

/** True if `a` is within the CCW sweep a1 → a2 (mod 2π). */
export function angleInSweep(a: number, a1: number, a2: number): boolean {
  const twoPi = Math.PI * 2;
  const norm = (x: number) => ((x % twoPi) + twoPi) % twoPi;
  const sweep = norm(a2 - a1);
  const delta = norm(a - a1);
  return delta <= sweep + 1e-9;
}

function hitArc(p: Pt, e: { cx: number; cy: number; r: number; a1: number; a2: number }, tol: number): boolean {
  const d = Math.hypot(p.x - e.cx, p.y - e.cy);
  if (Math.abs(d - e.r) >= tol) return false;
  const a = Math.atan2(p.y - e.cy, p.x - e.cx);
  return angleInSweep(a, e.a1, e.a2);
}

function hitDim(p: Pt, e: DimEntity, tol: number): boolean {
  const dx = e.p2.x - e.p1.x, dy = e.p2.y - e.p1.y;
  const L = Math.hypot(dx, dy);
  if (L < 1e-9) return false;
  const nx = -dy / L, ny = dx / L;
  const sd = (e.offset.x - e.p1.x) * nx + (e.offset.y - e.p1.y) * ny;
  const a = { x: e.p1.x + nx * sd, y: e.p1.y + ny * sd };
  const b = { x: e.p2.x + nx * sd, y: e.p2.y + ny * sd };
  return distPtSeg(p, a, b) < tol;
}

function hitText(p: Pt, e: TextEntity, tol: number): boolean {
  // Unrotated bbox approximation. Rotated text uses axis-aligned approx of the
  // rotated box — good enough for picking, since text is usually axis-aligned.
  const w = Math.max(e.height * 0.3, e.height * e.text.length * 0.6);
  const h = e.height;
  const rot = e.rotation ?? 0;
  const c = Math.cos(-rot), s = Math.sin(-rot);
  const dx = p.x - e.x, dy = p.y - e.y;
  const lx = dx * c - dy * s;
  const ly = dx * s + dy * c;
  return lx >= -tol && lx <= w + tol && ly >= -tol && ly <= h + tol;
}

/**
 * Parameter angle on the rotated ellipse at world point `p`. Used to sample the
 * ellipse as a densely-tessellated polyline for hit-testing.
 */
export function ellipseSamples(e: EllipseEntity | { cx: number; cy: number; rx: number; ry: number; rot: number }, n = 64): Pt[] {
  const cos = Math.cos(e.rot), sin = Math.sin(e.rot);
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * Math.PI * 2;
    const ct = Math.cos(t), st = Math.sin(t);
    out.push({
      x: e.cx + e.rx * ct * cos - e.ry * st * sin,
      y: e.cy + e.rx * ct * sin + e.ry * st * cos,
    });
  }
  return out;
}

function hitEllipse(p: Pt, e: EllipseEntity, tol: number): boolean {
  const samples = ellipseSamples(e, 72);
  for (let i = 1; i < samples.length; i++) {
    if (distPtSeg(p, samples[i - 1], samples[i]) < tol) return true;
  }
  return false;
}

/**
 * Convert an interpolating spline through `pts` into densely sampled points,
 * using Catmull-Rom tangents. Samples `stepsPerSeg` points per segment.
 */
export function splineSamples(pts: Pt[], closed = false, stepsPerSeg = 16): Pt[] {
  const n = pts.length;
  if (n < 2) return pts.slice();
  const get = (i: number) => {
    if (closed) return pts[((i % n) + n) % n];
    return pts[Math.max(0, Math.min(n - 1, i))];
  };
  const segCount = closed ? n : n - 1;
  const out: Pt[] = [pts[0]];
  for (let i = 0; i < segCount; i++) {
    const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
    const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
    const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
    for (let s = 1; s <= stepsPerSeg; s++) {
      const t = s / stepsPerSeg;
      const u = 1 - t;
      const b0 = u * u * u, b1 = 3 * u * u * t, b2 = 3 * u * t * t, b3 = t * t * t;
      out.push({
        x: b0 * p1.x + b1 * c1.x + b2 * c2.x + b3 * p2.x,
        y: b0 * p1.y + b1 * c1.y + b2 * c2.y + b3 * p2.y,
      });
    }
  }
  return out;
}

function hitSpline(p: Pt, e: SplineEntity, tol: number): boolean {
  const samples = splineSamples(e.pts, !!e.closed, 12);
  for (let i = 1; i < samples.length; i++) {
    if (distPtSeg(p, samples[i - 1], samples[i]) < tol) return true;
  }
  return false;
}

function hitPolyline(p: Pt, e: PolylineEntity, tol: number): boolean {
  for (let k = 1; k < e.pts.length; k++) {
    if (distPtSeg(p, e.pts[k - 1], e.pts[k]) < tol) return true;
  }
  if (e.closed && e.pts.length >= 2
      && distPtSeg(p, e.pts[e.pts.length - 1], e.pts[0]) < tol) return true;
  return false;
}

export function hitTest(worldPt: Pt, tol?: number, includeLocked = false): Entity | null {
  const t = tol ?? 6 / state.view.scale;
  for (let i = state.entities.length - 1; i >= 0; i--) {
    const e = state.entities[i];
    const layer = state.layers[e.layer];
    if (!layer || !layer.visible) continue;
    if (!includeLocked && layer.locked) continue;
    if (e.type === 'line'     && hitLine(worldPt, e, t))     return e;
    if (e.type === 'xline'    && distPtXLine(worldPt, e) < t) return e;
    if (e.type === 'rect'     && hitRect(worldPt, e, t))     return e;
    if (e.type === 'circle'   && hitCircle(worldPt, e, t))   return e;
    if (e.type === 'arc'      && hitArc(worldPt, e, t))      return e;
    if (e.type === 'ellipse'  && hitEllipse(worldPt, e, t))  return e;
    if (e.type === 'spline'   && hitSpline(worldPt, e, t))   return e;
    if (e.type === 'polyline' && hitPolyline(worldPt, e, t)) return e;
    if (e.type === 'text'     && hitText(worldPt, e, t))     return e;
    if (e.type === 'dim'      && hitDim(worldPt, e, t))      return e;
  }
  return null;
}

export function nearestRectEdge(rect: RectEntity, pt: Pt): { a: Pt; b: Pt } | null {
  const xl = Math.min(rect.x1, rect.x2), xr = Math.max(rect.x1, rect.x2);
  const yb = Math.min(rect.y1, rect.y2), yt = Math.max(rect.y1, rect.y2);
  const edges = [
    { a: { x: xl, y: yb }, b: { x: xr, y: yb } },
    { a: { x: xr, y: yb }, b: { x: xr, y: yt } },
    { a: { x: xr, y: yt }, b: { x: xl, y: yt } },
    { a: { x: xl, y: yt }, b: { x: xl, y: yb } },
  ];
  let best: { a: Pt; b: Pt } | null = null;
  let bestD = Infinity;
  for (const e of edges) {
    const d = distPtSeg(pt, e.a, e.b);
    if (d < bestD) { bestD = d; best = e; }
  }
  return best;
}

export function nearestPolySegment(poly: PolylineEntity, pt: Pt): { a: Pt; b: Pt } | null {
  let best: { a: Pt; b: Pt } | null = null;
  let bestD = Infinity;
  for (let i = 1; i < poly.pts.length; i++) {
    const d = distPtSeg(pt, poly.pts[i - 1], poly.pts[i]);
    if (d < bestD) { bestD = d; best = { a: poly.pts[i - 1], b: poly.pts[i] }; }
  }
  if (poly.closed && poly.pts.length >= 2) {
    const d = distPtSeg(pt, poly.pts[poly.pts.length - 1], poly.pts[0]);
    if (d < bestD) { bestD = d; best = { a: poly.pts[poly.pts.length - 1], b: poly.pts[0] }; }
  }
  return best;
}

/**
 * Returns a reference geometry under the cursor (entity or virtual axis) along
 * with a direction vector and a base point on it. Used by the parallel-guide
 * tool to build an offset xline.
 */
export function pickReference(worldPt: Pt):
  | { entity: Entity | { _axis: 'x' | 'y' }; dir: Pt; base: Pt }
  | null {
  // Include locked layers so the origin axis xlines can be used as references.
  const hit = hitTest(worldPt, undefined, true);
  if (hit) {
    if (hit.type === 'line') {
      const dir = norm({ x: hit.x2 - hit.x1, y: hit.y2 - hit.y1 });
      return { entity: hit, dir, base: { x: hit.x1, y: hit.y1 } };
    }
    if (hit.type === 'xline') {
      return { entity: hit, dir: { x: hit.dx, y: hit.dy }, base: { x: hit.x1, y: hit.y1 } };
    }
    if (hit.type === 'rect') {
      const edge = nearestRectEdge(hit, worldPt);
      if (edge) return { entity: hit, dir: norm(sub(edge.b, edge.a)), base: edge.a };
    }
    if (hit.type === 'polyline') {
      const seg = nearestPolySegment(hit, worldPt);
      if (seg) return { entity: hit, dir: norm(sub(seg.b, seg.a)), base: seg.a };
    }
  }
  return null;
}
