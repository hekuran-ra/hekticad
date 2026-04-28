import type {
  DimEntity, EllipseEntity, Entity, HatchEntity, LineEntity, PolylineEntity, Pt,
  RectEntity, SplineEntity, TextEntity, XLineEntity,
} from './types';
import { runtime, state } from './state';
import { dot, len, norm, scale, sub } from './math';
import { layoutText } from './textlayout';

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
  if (e.dimKind === 'angular') return hitAngularDim(p, e, tol);
  if (e.dimKind === 'radius' || e.dimKind === 'diameter') return hitRadialDim(p, e, tol);

  // Compute the dim-line endpoints (a, b) using the SAME axis logic as the
  // renderer — the old code always used the "aligned" formula which was wrong
  // for horizontal/vertical dims when p1 and p2 have different Y (or X).
  const axis = e.linearAxis ?? 'aligned';
  let a: Pt, b: Pt, L: number, ux: number, uy: number;
  if (axis === 'horizontal') {
    a = { x: e.p1.x, y: e.offset.y };
    b = { x: e.p2.x, y: e.offset.y };
    L = Math.abs(e.p2.x - e.p1.x);
    if (L < 1e-9) return false;
    ux = e.p2.x > e.p1.x ? 1 : -1;
    uy = 0;
  } else if (axis === 'vertical') {
    a = { x: e.offset.x, y: e.p1.y };
    b = { x: e.offset.x, y: e.p2.y };
    L = Math.abs(e.p2.y - e.p1.y);
    if (L < 1e-9) return false;
    ux = 0;
    uy = e.p2.y > e.p1.y ? 1 : -1;
  } else {
    const dx = e.p2.x - e.p1.x, dy = e.p2.y - e.p1.y;
    L = Math.hypot(dx, dy);
    if (L < 1e-9) return false;
    const nx = -dy / L, ny = dx / L;
    const sd = (e.offset.x - e.p1.x) * nx + (e.offset.y - e.p1.y) * ny;
    a = { x: e.p1.x + nx * sd, y: e.p1.y + ny * sd };
    b = { x: e.p2.x + nx * sd, y: e.p2.y + ny * sd };
    ux = dx / L;
    uy = dy / L;
  }

  // 1) The dim line itself.
  if (distPtSeg(p, a, b) < tol) return true;
  // 2) The two extension lines (measurement point → dim line endpoint). Users
  //    routinely click near the extension when a dim is crowded against other
  //    geometry, so hitting these counts as selecting the dim.
  if (distPtSeg(p, e.p1, a) < tol) return true;
  if (distPtSeg(p, e.p2, b) < tol) return true;
  // 3) The label — a generous band centered on the label position along a→b.
  //    textAlign shifts the label: 'start' = 12 % from a, 'end' = 88 %, else mid.
  //    Size: along-axis ≈ max(6×textHeight, L/2) so even a single-digit label is
  //    easily clickable; perp-axis ≈ 2×textHeight covers the text cap height plus
  //    some breathing room.
  const t = e.textAlign === 'start' ? 0.12 : e.textAlign === 'end' ? 0.88 : 0.5;
  const mid = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  const nx2 = -uy, ny2 = ux; // normal (perpendicular to dim line)
  const along  = (p.x - mid.x) * ux  + (p.y - mid.y) * uy;
  const across = (p.x - mid.x) * nx2 + (p.y - mid.y) * ny2;
  const halfAlong  = Math.max(e.textHeight * 3, L * 0.25) + tol;
  const halfAcross = e.textHeight * 1.5 + tol;
  if (Math.abs(along) <= halfAlong && Math.abs(across) <= halfAcross) return true;
  return false;
}

/**
 * Angular dim hit test: click counts when it lands on the arc, near the label,
 * or on the extension lines from vertex along either ray up to the arc.
 */
function hitAngularDim(p: Pt, e: DimEntity, tol: number): boolean {
  const V = e.vertex, r1 = e.ray1, r2 = e.ray2;
  if (!V || !r1 || !r2) return false;
  const dOx = e.offset.x - V.x, dOy = e.offset.y - V.y;
  const R = Math.hypot(dOx, dOy);
  if (R < 1e-9) return false;
  const d1x = r1.x - V.x, d1y = r1.y - V.y;
  const d2x = r2.x - V.x, d2y = r2.y - V.y;
  if (Math.hypot(d1x, d1y) < 1e-9 || Math.hypot(d2x, d2y) < 1e-9) return false;

  const TAU = Math.PI * 2;
  const norm2pi = (x: number) => ((x % TAU) + TAU) % TAU;
  const a1 = Math.atan2(d1y, d1x);
  const a2 = Math.atan2(d2y, d2x);
  const aO = Math.atan2(dOy, dOx);
  const sweep12 = norm2pi(a2 - a1);
  const sweep1O = norm2pi(aO - a1);
  const [aS, aE] = (sweep1O <= sweep12 + 1e-9) ? [a1, a2] : [a2, a1];
  const sweep = norm2pi(aE - aS) || TAU;

  const dx = p.x - V.x, dy = p.y - V.y;
  const rP = Math.hypot(dx, dy);

  // Arc body.
  if (Math.abs(rP - R) <= tol) {
    const aP = Math.atan2(dy, dx);
    const dP = norm2pi(aP - aS);
    if (dP <= sweep + 1e-9) return true;
  }
  // Label band around arc midpoint.
  const aM = aS + sweep / 2;
  const mx = V.x + R * Math.cos(aM), my = V.y + R * Math.sin(aM);
  if (Math.hypot(p.x - mx, p.y - my) <= e.textHeight * 2 + tol) return true;
  return false;
}

/**
 * Radial dim hit test: click counts on the leader line (near-edge → anchor for
 * radius, or far-edge → anchor for diameter), on the caps, or near the label
 * at the anchor.
 */
function hitRadialDim(p: Pt, e: DimEntity, tol: number): boolean {
  const C = e.vertex, E = e.ray1;
  if (!C || !E) return false;
  const r = Math.hypot(E.x - C.x, E.y - C.y);
  if (r < 1e-9) return false;
  let ux = e.offset.x - C.x, uy = e.offset.y - C.y;
  let ul = Math.hypot(ux, uy);
  if (ul < 1e-9) { ux = E.x - C.x; uy = E.y - C.y; ul = r; }
  ux /= ul; uy /= ul;
  const near: Pt = { x: C.x + ux * r, y: C.y + uy * r };
  const far:  Pt = { x: C.x - ux * r, y: C.y - uy * r };
  // Leader hit.
  if (e.dimKind === 'diameter') {
    if (distPtSeg(p, far, e.offset) < tol) return true;
  } else {
    if (distPtSeg(p, near, e.offset) < tol) return true;
  }
  // Label band around the anchor.
  const dx = p.x - e.offset.x, dy = p.y - e.offset.y;
  if (Math.hypot(dx, dy) <= e.textHeight * 2 + tol) return true;
  return false;
}

function hitText(p: Pt, e: TextEntity, tol: number): boolean {
  // Inverse-rotate the hit point into the text's local frame, then do an
  // axis-aligned box check against the laid-out block. Multi-line Grafiktext
  // and wrapped Rahmentext both fall out of the shared layout helper.
  const rot = e.rotation ?? 0;
  const c = Math.cos(-rot), s = Math.sin(-rot);
  const dx = p.x - e.x, dy = p.y - e.y;
  const lx = e.x + (dx * c - dy * s);
  const ly = e.y + (dx * s + dy * c);
  const layout = layoutText(e);
  return lx >= layout.minX - tol && lx <= layout.maxX + tol
      && ly >= layout.minY - tol && ly <= layout.maxY + tol;
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

/**
 * Hatch hit-test. A click anywhere inside the boundary polygon hits —
 * hatches are 2D regions, not 1D outlines, so "close to an edge" is too
 * narrow a target. Uses even-odd ray casting on the boundary.
 */
function hitHatch(p: Pt, e: HatchEntity, _tol: number): boolean {
  const inPoly = (pts: Pt[]): boolean => {
    if (pts.length < 3) return false;
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
  };
  if (!inPoly(e.pts)) return false;
  // Inside the outer boundary — but if the point falls in any hole, it's
  // outside the actual hatched region.
  if (e.holes) {
    for (const h of e.holes) {
      if (inPoly(h)) return false;
    }
  }
  return true;
}

/**
 * Bbox pre-reject: cursor-box must overlap entity-box. Cheap compared to the
 * sampling-based hit tests for ellipse/spline/polyline — a single compare per
 * bound on entities the cursor isn't even near. Skipped for xlines (infinite)
 * and lines (already O(1) check).
 */
function bboxReject(worldPt: Pt, e: Entity, t: number): boolean {
  let minX: number, minY: number, maxX: number, maxY: number;
  switch (e.type) {
    case 'rect':
      minX = Math.min(e.x1, e.x2); maxX = Math.max(e.x1, e.x2);
      minY = Math.min(e.y1, e.y2); maxY = Math.max(e.y1, e.y2);
      break;
    case 'circle': case 'arc':
      minX = e.cx - e.r; maxX = e.cx + e.r;
      minY = e.cy - e.r; maxY = e.cy + e.r;
      break;
    case 'ellipse': {
      const c = Math.cos(e.rot), s = Math.sin(e.rot);
      const hx = Math.sqrt((e.rx * c) ** 2 + (e.ry * s) ** 2);
      const hy = Math.sqrt((e.rx * s) ** 2 + (e.ry * c) ** 2);
      minX = e.cx - hx; maxX = e.cx + hx;
      minY = e.cy - hy; maxY = e.cy + hy;
      break;
    }
    case 'polyline': case 'spline': case 'hatch': {
      if (!e.pts.length) return true;
      minX = Infinity; minY = Infinity; maxX = -Infinity; maxY = -Infinity;
      for (const p of e.pts) {
        if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
      }
      break;
    }
    case 'dim': {
      minX = Math.min(e.p1.x, e.p2.x, e.offset.x);
      maxX = Math.max(e.p1.x, e.p2.x, e.offset.x);
      minY = Math.min(e.p1.y, e.p2.y, e.offset.y);
      maxY = Math.max(e.p1.y, e.p2.y, e.offset.y);
      // Inflate by the label hit-zone so the cheap reject doesn't kill
      // valid clicks on the number when it sticks out past the dim line.
      // hitDim's label band is `max(3·textHeight, L·0.25)` along × `1.5·textHeight`
      // across — pad here by the larger of the two so all clicks reach hitDim.
      const labelPad = Math.max(e.textHeight * 3, 4);
      minX -= labelPad; maxX += labelPad;
      minY -= labelPad; maxY += labelPad;
      // Diameter dims also extend to the far edge (centre − (anchor−centre)/r).
      // Be safe: include the whole radius-sized circle around the centre.
      if (e.dimKind === 'diameter' && e.vertex && e.ray1) {
        const r = Math.hypot(e.ray1.x - e.vertex.x, e.ray1.y - e.vertex.y);
        minX = Math.min(minX, e.vertex.x - r);
        maxX = Math.max(maxX, e.vertex.x + r);
        minY = Math.min(minY, e.vertex.y - r);
        maxY = Math.max(maxY, e.vertex.y + r);
      }
      break;
    }
    default:
      return false;
  }
  return worldPt.x < minX - t || worldPt.x > maxX + t
      || worldPt.y < minY - t || worldPt.y > maxY + t;
}

export function hitTest(worldPt: Pt, tol?: number, includeLocked = false): Entity | null {
  const t = tol ?? 6 / state.view.scale;
  for (let i = state.entities.length - 1; i >= 0; i--) {
    const e = state.entities[i];
    const layer = state.layers[e.layer];
    if (!layer || !layer.visible) continue;
    if (!includeLocked && layer.locked) continue;
    // Cheap bbox reject for bounded types before hitting the expensive samplers.
    if (bboxReject(worldPt, e, t)) continue;
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
    if (e.type === 'hatch'    && hitHatch(worldPt, e, t))    return e;
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

  // Fallback: virtual origin axes. The axes are no longer stored as entities
  // (they're rendered directly by the viewport), so `hitTest` can't find them.
  // Tools that want "eine Linie, Achse, …" must still be able to pick them as
  // a reference — check distance to the X and Y axes in screen pixels and
  // synthesize a virtual reference. Only offered when the axes are actually
  // visible — picking an invisible reference would be confusing.
  if (runtime.snapSettings.showAxes) {
    // 8 px tolerance, independent of zoom.
    const tolWorld = 8 / state.view.scale;
    const dX = Math.abs(worldPt.y);  // distance to X-axis (y = 0)
    const dY = Math.abs(worldPt.x);  // distance to Y-axis (x = 0)
    if (dX < tolWorld && dX <= dY) {
      return { entity: { _axis: 'x' }, dir: { x: 1, y: 0 }, base: { x: 0, y: 0 } };
    }
    if (dY < tolWorld) {
      return { entity: { _axis: 'y' }, dir: { x: 0, y: 1 }, base: { x: 0, y: 0 } };
    }
  }
  return null;
}
