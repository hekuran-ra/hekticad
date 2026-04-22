/**
 * EPS PostScript Level 2 writer.
 *
 * Strategy:
 *   - Header sets `2.834645 2.834645 scale` so that everything below it is
 *     written in millimetres — a "1000 M" in the body means 1000mm.
 *   - BoundingBox is computed in world-mm and converted to pt for the
 *     `%%BoundingBox` / `%%HiResBoundingBox` comments (PostScript default
 *     unit, required by Illustrator and Ghostscript).
 *   - Y-axis: PostScript is Y-up, HektikCad world is Y-up → no flip.
 *
 * Out-of-scope (phase 1 simplifications):
 *   - xline (infinite construction) — skipped, like DXF export.
 *   - text, dim — skipped; emitting glyph paths would require font embedding.
 *     A toast surfaces the skip count (wiring in the UI phase).
 *   - Colour: phase 1 is all black. Layer colours could be emitted later.
 */

import type { ArcEntity, CircleEntity, EllipseEntity, Entity, Layer,
              LineEntity, PolylineEntity, Pt, RectEntity, SplineEntity }
  from '../types';
import { exportBbox, isExportable } from './drawing-bounds';
import { PT_PER_MM } from './units';

/** Format a number for PostScript body — 4 decimals is plenty for mm precision. */
function num(n: number): string {
  if (!Number.isFinite(n)) return '0';
  return n.toFixed(4);
}

/**
 * EPS writer. Keeps the body lines and computes a bbox as entities are added
 * (though for the final bbox we use the world `exportBbox` helper, because
 * that correctly handles arcs/ellipses without sampling).
 */
class EpsWriter {
  private body: string[] = [];

  moveTo(x: number, y: number): void {
    this.body.push(`${num(x)} ${num(y)} M`);
  }
  lineTo(x: number, y: number): void {
    this.body.push(`${num(x)} ${num(y)} L`);
  }
  closePath(): void { this.body.push('Z'); }
  stroke():    void { this.body.push('S'); }
  newPath():   void { this.body.push('newpath'); }

  /** Straight line as a single path. */
  writeLine(x1: number, y1: number, x2: number, y2: number): void {
    this.newPath();
    this.moveTo(x1, y1);
    this.lineTo(x2, y2);
    this.stroke();
  }

  /** Polyline (open or closed). */
  writePolyline(pts: Pt[], closed: boolean): void {
    if (pts.length < 2) return;
    this.newPath();
    this.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) this.lineTo(pts[i].x, pts[i].y);
    if (closed) this.closePath();
    this.stroke();
  }

  /** Full circle via PostScript's `arc` operator. */
  writeCircle(cx: number, cy: number, r: number): void {
    this.newPath();
    this.body.push(`${num(cx)} ${num(cy)} ${num(r)} 0 360 arc`);
    this.stroke();
  }

  /**
   * Arc via `arc` (CCW). HektikCad uses radians CCW; PostScript wants degrees CCW.
   * `arc` draws from current-point straight to the arc start then along the arc,
   * which would emit an unwanted connector. Starting with `newpath` + `arc`
   * uses the implicit arc start as the current point → no connector.
   */
  writeArc(cx: number, cy: number, r: number, a1Rad: number, a2Rad: number): void {
    const a1 = (a1Rad * 180 / Math.PI);
    const a2 = (a2Rad * 180 / Math.PI);
    this.newPath();
    this.body.push(`${num(cx)} ${num(cy)} ${num(r)} ${num(a1)} ${num(a2)} arc`);
    this.stroke();
  }

  /**
   * Ellipse: emit via scale/rotate transforms on the CTM, then `0 0 1 0 360 arc`.
   * Wrapped in `gsave`/`grestore` so the global scale (mm) stays intact.
   */
  writeEllipse(cx: number, cy: number, rx: number, ry: number, rotRad: number): void {
    const rotDeg = rotRad * 180 / Math.PI;
    this.body.push('gsave');
    this.body.push(`${num(cx)} ${num(cy)} translate`);
    if (rotDeg !== 0) this.body.push(`${num(rotDeg)} rotate`);
    this.body.push(`${num(rx)} ${num(ry)} scale`);
    this.newPath();
    // Note: once scaled, a circle of radius 1 traces the ellipse. But stroke
    // width would also be scaled — since our 'S' uses the global line width
    // from the prolog, we accept this as the standard PostScript idiom.
    this.body.push('0 0 1 0 360 arc');
    this.stroke();
    this.body.push('grestore');
  }

  toString(bboxMm: { x: number; y: number; width: number; height: number } | null, title: string): string {
    // BoundingBox in points. Add a 1mm safety margin so the bbox isn't flush
    // against stroked geometry (PostScript's stroke width extends outward).
    const padMm = 1;
    const b = bboxMm ?? { x: 0, y: 0, width: 1, height: 1 };
    const x1 = (b.x - padMm) * PT_PER_MM;
    const y1 = (b.y - padMm) * PT_PER_MM;
    const x2 = (b.x + b.width  + padMm) * PT_PER_MM;
    const y2 = (b.y + b.height + padMm) * PT_PER_MM;

    const today = new Date().toISOString().slice(0, 10);
    return [
      '%!PS-Adobe-3.0 EPSF-3.0',
      `%%BoundingBox: ${Math.floor(x1)} ${Math.floor(y1)} ${Math.ceil(x2)} ${Math.ceil(y2)}`,
      `%%HiResBoundingBox: ${x1.toFixed(4)} ${y1.toFixed(4)} ${x2.toFixed(4)} ${y2.toFixed(4)}`,
      '%%Creator: HektikCad',
      `%%Title: ${title}`,
      `%%CreationDate: ${today}`,
      '%%EndComments',
      '%%BeginProlog',
      '/M { moveto } bind def',
      '/L { lineto } bind def',
      '/Z { closepath } bind def',
      '/S { stroke } bind def',
      '/RGB { setrgbcolor } bind def',
      '%%EndProlog',
      '',
      // Switch user unit to millimetres (1mm = PT_PER_MM pt).
      `${PT_PER_MM.toFixed(6)} ${PT_PER_MM.toFixed(6)} scale`,
      // Compensate the line width for the scale change: 0.25mm looks right
      // regardless of the host scale. stroke width is a single value → just
      // set it directly in mm (since we're in mm-space now).
      '0.25 setlinewidth',
      '1 setlinejoin',
      '1 setlinecap',
      '0 0 0 RGB',
      ...this.body,
      '',
      '%%EOF',
    ].join('\n');
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Spline + ellipse sampling duplicated from export-dxf.ts? — no: ellipse goes
// via CTM transforms, spline still needs sampling because PostScript's native
// `curveto` is cubic-Bezier and our spline is Catmull-Rom. Convert on the fly.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Sample a Catmull-Rom spline to line segments. Matches the renderer's
 * cubic-Bezier conversion; 12 samples/segment is visually smooth.
 */
function sampleSpline(e: SplineEntity, samplesPerSeg: number = 12): Pt[] {
  const n = e.pts.length;
  if (n < 2) return [...e.pts];
  const closed = !!e.closed;
  const get = (i: number): Pt =>
    closed ? e.pts[((i % n) + n) % n] : e.pts[Math.max(0, Math.min(n - 1, i))];

  const segCount = closed ? n : n - 1;
  const out: Pt[] = [];
  if (!closed) out.push({ ...e.pts[0] });

  for (let i = 0; i < segCount; i++) {
    const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
    const c1x = p1.x + (p2.x - p0.x) / 6, c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6, c2y = p2.y - (p3.y - p1.y) / 6;
    for (let s = 1; s <= samplesPerSeg; s++) {
      const t = s / samplesPerSeg;
      const it = 1 - t;
      const b = it * it * it;
      const b1 = 3 * it * it * t;
      const b2 = 3 * it * t * t;
      const b3 = t * t * t;
      out.push({
        x: b * p1.x + b1 * c1x + b2 * c2x + b3 * p2.x,
        y: b * p1.y + b1 * c1y + b2 * c2y + b3 * p2.y,
      });
    }
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// Public entry point
// ────────────────────────────────────────────────────────────────────────────

export function exportEps(entities: Entity[], layers: Layer[]): Blob {
  const w = new EpsWriter();

  for (const e of entities) {
    if (!isExportable(e, layers)) continue;

    switch (e.type) {
      case 'line': {
        const L = e as LineEntity;
        w.writeLine(L.x1, L.y1, L.x2, L.y2);
        break;
      }
      case 'polyline': {
        const P = e as PolylineEntity;
        w.writePolyline(P.pts, !!P.closed);
        break;
      }
      case 'rect': {
        const R = e as RectEntity;
        const xl = Math.min(R.x1, R.x2), xr = Math.max(R.x1, R.x2);
        const yb = Math.min(R.y1, R.y2), yt = Math.max(R.y1, R.y2);
        w.writePolyline(
          [{ x: xl, y: yb }, { x: xr, y: yb }, { x: xr, y: yt }, { x: xl, y: yt }],
          true,
        );
        break;
      }
      case 'circle': {
        const C = e as CircleEntity;
        w.writeCircle(C.cx, C.cy, C.r);
        break;
      }
      case 'arc': {
        const A = e as ArcEntity;
        w.writeArc(A.cx, A.cy, A.r, A.a1, A.a2);
        break;
      }
      case 'ellipse': {
        const E = e as EllipseEntity;
        w.writeEllipse(E.cx, E.cy, E.rx, E.ry, E.rot);
        break;
      }
      case 'spline': {
        const S = e as SplineEntity;
        w.writePolyline(sampleSpline(S), !!S.closed);
        break;
      }
      case 'text':
      case 'dim':
        // Skipped in phase 1 — see file header. Count surfaced via Toast later.
        break;
      case 'xline':
        // Filtered by isExportable, guard anyway.
        break;
    }
  }

  const bbox = exportBbox(entities, layers);
  const text = w.toString(bbox, 'zeichnung.eps');
  return new Blob([text], { type: 'application/postscript' });
}
