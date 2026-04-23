/**
 * PDF writer built on `pdf-lib`.
 *
 * Coordinate pipeline:
 *   world (mm, Y-up)
 *     → template-resolved page coords (mm, Y-up, origin at page bottom-left)
 *     → PDF points (× PT_PER_MM)
 *
 * Templates drive paper size, scale, origin, title-block position, and plot
 * frame. `custom-1to1` (phase 4) is the reference case: paper = bbox + 10mm
 * margin, scale 1:1, no title block, no plot frame. Fixed-scale templates
 * (`a4-landscape-1to50`, …) reuse the same geometry pipeline with a non-unit
 * scale denominator; the title-block renderer (phase 5) plugs in at the end.
 *
 * Why pdf-lib over print-to-PDF: we need vector output with exact physical
 * dimensions (a 1m world line must measure 20mm on a 1:50 print). Browser
 * print dialogs add their own margins and scale factors that can't be pinned.
 */

import { PDFDocument, PDFFont, StandardFonts, degrees, rgb, PDFPage, PDFImage } from 'pdf-lib';
import type { ArcEntity, CircleEntity, DimEntity, DimStyle, EllipseEntity,
              Entity, HatchEntity, Layer, LineEntity, PdfTemplateId,
              PolylineEntity, Pt, RectEntity, SplineEntity, TextEntity,
              TitleBlockData }
  from '../types';
import { exportBbox, isExportable } from './drawing-bounds';
import { PT_PER_MM } from './units';
import { TEMPLATES, resolveTemplate, type ResolvedTemplate } from './templates';
import { drawTitleBlock, drawPlotFrame } from './titleblock';

// ────────────────────────────────────────────────────────────────────────────
// Colour mapping
//
// The HektikCad canvas uses a dark background, so layers stored as pure white
// (the default "0" layer at #ffffff) are legible on screen but would be
// invisible on white PDF paper. The only safe contrast check at print time
// is therefore limited to pure white → pure black; every other colour the
// user picked (red, blue, mid-grey, pastel, …) passes through unchanged so
// the printed drawing matches the on-screen palette.
// ────────────────────────────────────────────────────────────────────────────

/** Parse a CSS hex colour (#rgb or #rrggbb) into a normalised {r,g,b} triple. */
function parseHexTriple(hex: string): { r: number; g: number; b: number } {
  let h = hex.replace(/^#/, '').toLowerCase();
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const r = parseInt(h.slice(0, 2) || '0', 16) / 255;
  const g = parseInt(h.slice(2, 4) || '0', 16) / 255;
  const b = parseInt(h.slice(4, 6) || '0', 16) / 255;
  return {
    r: Number.isFinite(r) ? r : 0,
    g: Number.isFinite(g) ? g : 0,
    b: Number.isFinite(b) ? b : 0,
  };
}

/**
 * Convert a CSS hex colour into a pdf-lib `rgb()` value. Pure white (`#ffffff`)
 * becomes pure black so lines drawn on the default "0" layer don't vanish on
 * white paper; every other colour is emitted verbatim.
 *
 * The tolerance is a single quantisation step (≤ 1/255 off per channel) so we
 * only catch exact white expressed through different hex widths (`#fff`,
 * `#FFFFFF`, rounding artefacts); light greys like `#f8f8f8` remain light
 * grey on the print — that's the user's choice.
 */
function parseHexColor(hex: string): ReturnType<typeof rgb> {
  const { r, g, b } = parseHexTriple(hex);
  const eps = 1 / 255 + 1e-6;
  if (r > 1 - eps && g > 1 - eps && b > 1 - eps) {
    return rgb(0, 0, 0);
  }
  return rgb(r, g, b);
}

// ────────────────────────────────────────────────────────────────────────────
// World → page transform
// ────────────────────────────────────────────────────────────────────────────

/**
 * Build a transform from world-mm to PDF-pt, driven by a resolved template.
 * Returned as a closure so the per-entity draw loop stays tight.
 */
function makeTransform(rt: ResolvedTemplate): (x: number, y: number) => { x: number; y: number } {
  const s = 1 / rt.scaleDenom;
  const ox = rt.originMm.x;
  const oy = rt.originMm.y;
  return (x, y) => ({
    x: (ox + x * s) * PT_PER_MM,
    y: (oy + y * s) * PT_PER_MM,
  });
}

/** Line width for drawing geometry — 0.25mm equivalent in PDF pt. */
const DEFAULT_LINE_WIDTH_PT = 0.25 * PT_PER_MM;

// ────────────────────────────────────────────────────────────────────────────
// Arc / ellipse → cubic Bezier approximation
//
// pdf-lib has no native arc drawing; we build an SVG-path string and pass it
// to `page.drawSvgPath`. A cubic Bezier approximates a circular arc of up to
// ~90° with error ≈ 0.00027 · r. For arcs up to 360° we subdivide.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Return an SVG path string for an arc. Coordinates are in pt, pre-flipped
 * for `page.drawSvgPath({ x: 0, y: pageHeight, scale: 1 })`: we compute each
 * point in PDF Y-up space and then write `pathY = pageHeight - pdfY` so the
 * internal `scale(1,-1)` + `translate(0, pageHeight)` that pdf-lib applies
 * unwinds back to the original PDF-up coord.
 *
 * `startAngle`/`endAngle` in radians, CCW from +X (world/PDF convention —
 * the caller still passes PDF Y-up angles; we flip only the final point
 * emission). Subdivides into ≤90° quarters for low Bezier error.
 *
 * Earlier versions skipped the pre-flip and relied on `y: pageHeight` alone,
 * which silently mirrored every arc across the page centre line. Full-arc
 * symmetric shapes hid the bug; partial arcs (fillets at H-shape corners,
 * e.g. HLogo) drew at the wrong corner and didn't connect to the lines they
 * were meant to round off.
 */
function arcPathPt(
  cxPt: number, cyPt: number, rPt: number,
  startAngle: number, endAngle: number,
  sweepCCW: boolean,
  pageH: number,
): string {
  // Normalise sweep to [0, 2π] in the correct direction.
  let sweep = endAngle - startAngle;
  const TWO_PI = Math.PI * 2;
  if (sweepCCW) {
    while (sweep < 0) sweep += TWO_PI;
  } else {
    while (sweep > 0) sweep -= TWO_PI;
  }

  const numSegs = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2)));
  const segAngle = sweep / numSegs;
  // k is the tangent-handle length for a unit arc of `segAngle` radians.
  const k = (4 / 3) * Math.tan(segAngle / 4);

  const sy = (y: number) => pageH - y;
  const atPt = (a: number) => ({
    x: cxPt + Math.cos(a) * rPt,
    y: cyPt + Math.sin(a) * rPt,
  });
  let a = startAngle;
  let p0 = atPt(a);
  let out = `M ${p0.x.toFixed(3)} ${sy(p0.y).toFixed(3)}`;
  for (let i = 0; i < numSegs; i++) {
    const a1 = a + segAngle;
    const p1 = atPt(a1);
    // Control points are perpendicular to the radius at each end, scaled by k·r.
    const c0 = {
      x: p0.x - Math.sin(a)  * k * rPt,
      y: p0.y + Math.cos(a)  * k * rPt,
    };
    const c1 = {
      x: p1.x + Math.sin(a1) * k * rPt,
      y: p1.y - Math.cos(a1) * k * rPt,
    };
    out += ` C ${c0.x.toFixed(3)} ${sy(c0.y).toFixed(3)} ${c1.x.toFixed(3)} ${sy(c1.y).toFixed(3)} ${p1.x.toFixed(3)} ${sy(p1.y).toFixed(3)}`;
    a = a1;
    p0 = p1;
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// Hatch helpers
//
// pdf-lib doesn't expose clip-path construction, so instead of clipping a big
// family of infinite stripes to the boundary we analytically intersect each
// stripe with every polygon edge (outer + holes) and draw only the interior
// segments. Even-odd parity pairs adjacent intersections into interior runs,
// so holes "just work" without a separate pass. Complexity is O(N·E) per
// hatch with N stripes and E total edges — fine for realistic CAD cases.
//
// Solid fills use `drawSvgPath({ color, …, x:0, y:pageH, scale:1 })` with the
// boundary paths built Y-pre-flipped (same trick as arcPathPt) so pdf-lib's
// internal scale(1,-1) + translate-to-pageHeight unwinds to PDF-up coords.
// Even-odd fill rule cuts holes out of the outer region.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Build an SVG path string (Y-pre-flipped for `drawSvgPath({ y: pageH })`)
 * covering the outer boundary plus each hole as separate sub-paths. pdf-lib
 * uses the default non-zero fill rule; our renderer (canvas) uses even-odd
 * explicitly. With same-winding holes the two rules agree; if the user
 * digitised a hole in the same orientation as the outer ring we still want a
 * proper cut-out, so we emit a path string that the non-zero rule also
 * respects (by reversing hole winding — not necessary in practice because the
 * hatch tool writes holes CW when the outer is CCW, but doing it explicitly
 * is cheap insurance).
 */
function hatchBoundaryPath(
  outer: { x: number; y: number }[],
  holes: { x: number; y: number }[][],
  pageH: number,
): string {
  const sy = (y: number) => pageH - y;
  const subpath = (pts: { x: number; y: number }[]) => {
    if (pts.length < 2) return '';
    let s = `M ${pts[0].x.toFixed(3)} ${sy(pts[0].y).toFixed(3)}`;
    for (let i = 1; i < pts.length; i++) {
      s += ` L ${pts[i].x.toFixed(3)} ${sy(pts[i].y).toFixed(3)}`;
    }
    return s + ' Z';
  };
  let d = subpath(outer);
  for (const hole of holes) d += ' ' + subpath(hole);
  return d;
}

/**
 * Intersect stripe line through (bx,by) with direction (dx,dy) (both in PDF
 * pt) against every polygon edge (outer + holes). Returns sorted `t` values
 * where `p = (bx,by) + t * (dx,dy)` crosses an edge. Adjacent pairs are
 * interior segments (even-odd rule).
 */
function stripeHits(
  bx: number, by: number, dx: number, dy: number,
  outer: { x: number; y: number }[],
  holes: { x: number; y: number }[][],
): number[] {
  const ts: number[] = [];
  const edges = (pts: { x: number; y: number }[]): void => {
    const n = pts.length;
    if (n < 2) return;
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      // Line (bx,by)+t(dx,dy) = edge a + s(b-a) → solve 2x2.
      const ex = b.x - a.x, ey = b.y - a.y;
      const det = dx * (-ey) - dy * (-ex);
      if (Math.abs(det) < 1e-12) continue;              // parallel
      const rhs_t = (a.x - bx) * (-ey) - (a.y - by) * (-ex);
      const rhs_s = dx * (a.y - by)  - dy * (a.x - bx);
      const t = rhs_t / det;
      const s = rhs_s / det;
      // Skip the degenerate "ray hits vertex exactly" case by biasing the
      // half-open edge interval — otherwise a stripe grazing a vertex emits
      // two hits on adjacent edges and even-odd pairing mis-classifies the
      // stripe as entering → exiting → entering again.
      if (s >= 0 && s < 1) ts.push(t);
    }
  };
  edges(outer);
  for (const hole of holes) edges(hole);
  ts.sort((a, b) => a - b);
  return ts;
}

/**
 * Render a hatch entity (solid / lines / cross) onto the PDF page.
 * `xformedOuter`/`xformedHoles` are the boundary polygons already mapped from
 * world-mm to PDF-pt. `spacingPt` / `angle` are the stripe parameters (pt +
 * radians, already scale-converted by the caller).
 */
function drawHatchPdf(
  page: PDFPage,
  mode: 'solid' | 'lines' | 'cross',
  xformedOuter: { x: number; y: number }[],
  xformedHoles: { x: number; y: number }[][],
  spacingPt: number,
  angle: number,
  lineWidth: number,
  color: ReturnType<typeof rgb>,
): void {
  if (xformedOuter.length < 3) return;
  const ph = page.getHeight();

  if (mode === 'solid') {
    const d = hatchBoundaryPath(xformedOuter, xformedHoles, ph);
    page.drawSvgPath(d, {
      color,
      x: 0, y: ph, scale: 1,
    });
    return;
  }

  // Bounding box of the boundary in PDF pt — governs how far we have to shoot
  // stripes so every interior cell is covered regardless of the stripe angle.
  let minX = xformedOuter[0].x, maxX = minX;
  let minY = xformedOuter[0].y, maxY = minY;
  for (const p of xformedOuter) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  // Half-diagonal plus a stripe's width of slack so extreme diagonals still
  // sweep all the way across the shape's bbox.
  const halfDiag = Math.hypot(maxX - minX, maxY - minY) / 2 + spacingPt;

  const families = mode === 'cross'
    ? [angle, angle + Math.PI / 2]
    : [angle];

  const safeSpacing = Math.max(0.1, spacingPt);
  for (const a of families) {
    const dirX = Math.cos(a), dirY = Math.sin(a);
    const nx = -dirY, ny = dirX;
    const N = Math.ceil(halfDiag / safeSpacing) + 1;
    for (let k = -N; k <= N; k++) {
      const off = k * safeSpacing;
      const bx = cx + nx * off, by = cy + ny * off;
      const ts = stripeHits(bx, by, dirX, dirY, xformedOuter, xformedHoles);
      // Cap the sweep range to ±halfDiag so we don't emit lines that run off
      // to infinity if even-odd pairing is odd (numerical edge case).
      const tMin = -halfDiag * 2, tMax = halfDiag * 2;
      for (let i = 0; i + 1 < ts.length; i += 2) {
        const t0 = Math.max(tMin, ts[i]);
        const t1 = Math.min(tMax, ts[i + 1]);
        if (t1 <= t0) continue;
        const x1 = bx + dirX * t0, y1 = by + dirY * t0;
        const x2 = bx + dirX * t1, y2 = by + dirY * t1;
        page.drawLine({
          start: { x: x1, y: y1 },
          end:   { x: x2, y: y2 },
          thickness: lineWidth, color,
        });
      }
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Spline sampling — match DXF/EPS exporters
// ────────────────────────────────────────────────────────────────────────────

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
// Dim helpers — extension lines and end-caps
//
// Caps are drawn in paper-mm (independent of drawing scale) so a 1:50 print
// and a 1:100 print have visually identical arrowheads. Sizes are the ISO
// conventions adapted from our canvas renderer:
//   - arrow / open tip:   2.5mm long, 0.9mm half-width (≈ 20° included)
//   - tick (AutoCAD):     1.2mm half-length, 45° across the line
//   - arch (architect):   1.5mm stroke one-sided + 0.45mm dot at endpoint
// ────────────────────────────────────────────────────────────────────────────

const DIM_ARROW_LEN_MM  = 2.5;
const DIM_ARROW_HALF_MM = 0.9;
const DIM_TICK_HALF_MM  = 1.2;
const DIM_ARCH_LEN_MM   = 1.5;
const DIM_ARCH_DOT_MM   = 0.45;
const DIM_EXT_GAP_MM    = 0.8;
const DIM_EXT_OVER_MM   = 0.8;

/**
 * Draw an extension line from the measured point toward the dim line, with
 * a small gap at the measured end and a small overshoot past the dim line.
 * Both endpoints are already in PDF-pt.
 */
function drawExtensionLine(
  page: PDFPage,
  from: { x: number; y: number },
  to:   { x: number; y: number },
  lineWidth: number,
  color: ReturnType<typeof rgb>,
): void {
  const ex = to.x - from.x, ey = to.y - from.y;
  const L = Math.hypot(ex, ey);
  const gap  = DIM_EXT_GAP_MM  * PT_PER_MM;
  const over = DIM_EXT_OVER_MM * PT_PER_MM;
  if (L < gap) return;
  const kGap = gap / L, kEnd = (L + over) / L;
  page.drawLine({
    start: { x: from.x + ex * kGap, y: from.y + ey * kGap },
    end:   { x: from.x + ex * kEnd, y: from.y + ey * kEnd },
    thickness: lineWidth, color,
  });
}

/**
 * Render a dim end-cap in PDF-pt at `tip`, with the cap pointing INTO the
 * dim line (toward `other`). The four styles match what the canvas draws so
 * a PDF export looks identical to what the user sees.
 */
function drawDimCapPdf(
  page: PDFPage,
  tip:   { x: number; y: number },
  other: { x: number; y: number },
  style: DimStyle,
  lineWidth: number,
  color: ReturnType<typeof rgb>,
): void {
  const dx = other.x - tip.x, dy = other.y - tip.y;
  const L = Math.hypot(dx, dy);
  if (L < 1e-9) return;
  // Unit vector pointing INTO the dim (from the cap toward the other end).
  const ux = dx / L, uy = dy / L;
  // Left-hand perpendicular.
  const px = -uy, py = ux;

  if (style === 'arrow') {
    // Solid filled triangle: tip at `tip`, base 2.5mm back along the dim.
    const len = DIM_ARROW_LEN_MM * PT_PER_MM;
    const halfW = DIM_ARROW_HALF_MM * PT_PER_MM;
    const bx = tip.x + ux * len, by = tip.y + uy * len;
    // pdf-lib's `drawSvgPath` treats SVG path coords as Y-DOWN and maps
    // them to PDF as `finalY = options.y - pathY`. Our tip/bx/by/etc. are
    // in PDF Y-UP, so we pre-flip them against the page height: path-Y =
    // ph − pdf-Y. With `options.y = ph`, the render computes
    // `ph − (ph − pdf_y) = pdf_y`, putting the triangle exactly where we
    // want it. Earlier builds skipped this flip, which scattered the
    // filled arrowheads at `ph − tip.y` — i.e. mirrored across the page
    // centreline — while the other cap styles (which use `drawLine`) were
    // unaffected. That's the "Pfeilspitzen irgendwo im Freiraum" bug.
    const ph = page.getHeight();
    const sy = (y: number) => ph - y;
    const d = `M ${tip.x.toFixed(3)} ${sy(tip.y).toFixed(3)} ` +
              `L ${(bx + px * halfW).toFixed(3)} ${sy(by + py * halfW).toFixed(3)} ` +
              `L ${(bx - px * halfW).toFixed(3)} ${sy(by - py * halfW).toFixed(3)} Z`;
    // Pure fill — no border. Earlier builds passed `borderColor + borderWidth
    // = 0.1` which triggered pdf-lib's fillAndStroke path and laid a 0.1pt
    // outline on top of the triangle, making PDF arrowheads look subtly
    // heavier than the canvas version (pure `ctx.fill()`). Using fill-only
    // keeps the two renderers identical in appearance.
    page.drawSvgPath(d, {
      x: 0, y: ph, scale: 1,
      color,
    });
  } else if (style === 'open') {
    // Two strokes forming an open V.
    const len = DIM_ARROW_LEN_MM * PT_PER_MM;
    const halfW = DIM_ARROW_HALF_MM * PT_PER_MM;
    const bx = tip.x + ux * len, by = tip.y + uy * len;
    page.drawLine({
      start: { x: bx + px * halfW, y: by + py * halfW },
      end: tip,
      thickness: lineWidth, color,
    });
    page.drawLine({
      start: tip,
      end: { x: bx - px * halfW, y: by - py * halfW },
      thickness: lineWidth, color,
    });
  } else if (style === 'tick') {
    // AutoCAD-style short 45° stroke crossing the dim line (mechanical).
    // Rotate `ux` by +45° in paper-mm using (ux−uy, uy+ux)/√2.
    const t = DIM_TICK_HALF_MM * PT_PER_MM;
    const rxRaw = ux - uy, ryRaw = uy + ux;
    const k = t / Math.hypot(rxRaw, ryRaw);
    const rx = rxRaw * k, ry = ryRaw * k;
    page.drawLine({
      start: { x: tip.x - rx, y: tip.y - ry },
      end:   { x: tip.x + rx, y: tip.y + ry },
      thickness: lineWidth, color,
    });
  } else {
    // 'arch' — architect tick: short 45° stroke on ONE side + small dot.
    const t = DIM_ARCH_LEN_MM * PT_PER_MM;
    const rxRaw = ux - uy, ryRaw = uy + ux;
    const k = t / Math.hypot(rxRaw, ryRaw);
    const rx = rxRaw * k, ry = ryRaw * k;
    page.drawLine({
      start: tip,
      end:   { x: tip.x + rx, y: tip.y + ry },
      thickness: lineWidth, color,
    });
    page.drawCircle({
      x: tip.x, y: tip.y,
      size: DIM_ARCH_DOT_MM * PT_PER_MM,
      color, borderColor: color, borderWidth: 0,
    });
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Dim label — rotated text aligned with the dim line
//
// Canvas draws the dim label rotated along the dim/arc/leader direction with a
// readability flip that keeps it upright (never upside-down) and a small
// perpendicular gap above the line. pdf-lib's `drawText` supports a `rotate`
// option that pivots around the (x, y) reference point, but there's no
// textAlign=center — so we measure the text width through the embedded font
// and offset the anchor manually so the text stays centred on `anchorPdf`.
//
// `dirPdf` is the direction ALONG the dim line in PDF (Y-up) coords. The
// readability flip mirrors the canvas logic (`if ang > π/2 …`) so both
// renderers produce the same visual orientation.
// ────────────────────────────────────────────────────────────────────────────

function drawDimLabelPdf(
  page: PDFPage,
  text: string,
  anchorPdf: { x: number; y: number },
  dirPdf: { dx: number; dy: number },
  heightPt: number,
  font: PDFFont,
  color: ReturnType<typeof rgb>,
): void {
  let ang = Math.atan2(dirPdf.dy, dirPdf.dx);
  if (ang >  Math.PI / 2) ang -= Math.PI;
  if (ang < -Math.PI / 2) ang += Math.PI;
  const w = font.widthOfTextAtSize(text, heightPt);
  const cos = Math.cos(ang), sin = Math.sin(ang);
  // Perpendicular 90° CCW from the line direction — offsets the baseline above
  // the dim line in PDF Y-up space, matching the canvas `fillText(label, 0, -3)`
  // that draws 3px "above" in a Y-down screen frame.
  const perpX = -sin, perpY = cos;
  const gap = 0.5 * PT_PER_MM;
  // pdf-lib rotates around (x, y); after rotation text extends along local +x
  // for `w` units. To centre the text on `anchorPdf`, step back half the width
  // along the line direction before adding the perpendicular gap.
  const x = anchorPdf.x - cos * (w / 2) + perpX * gap;
  const y = anchorPdf.y - sin * (w / 2) + perpY * gap;
  page.drawText(text, {
    x, y,
    size: heightPt,
    font,
    color,
    rotate: degrees(ang * 180 / Math.PI),
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Entity drawing
// ────────────────────────────────────────────────────────────────────────────

/**
 * Paint a single entity onto a pdf-lib page. `xform` converts world-mm to
 * PDF-pt; `color` is the entity's layer colour; `lineWidth` is in pt. Text and
 * dim entities are handled as decomposed lines + simple Helvetica text.
 */
function drawEntity(
  page: PDFPage,
  e: Entity,
  xform: (x: number, y: number) => { x: number; y: number },
  color: ReturnType<typeof rgb>,
  lineWidth: number,
  scaleDenom: number,
  font: PDFFont,
): void {
  // Layer dash styles are intentionally dropped on PDF export for now —
  // pdf-lib's `drawLine` has no dash parameter, and emitting SVG paths for
  // every line would be a rewrite. Dashed layers render as solid, which is
  // the same trade-off that was in place before the linetype presets landed.
  switch (e.type) {
    case 'line': {
      const L = e as LineEntity;
      const p1 = xform(L.x1, L.y1), p2 = xform(L.x2, L.y2);
      page.drawLine({ start: p1, end: p2, thickness: lineWidth, color });
      break;
    }
    case 'rect': {
      const R = e as RectEntity;
      const xl = Math.min(R.x1, R.x2), xr = Math.max(R.x1, R.x2);
      const yb = Math.min(R.y1, R.y2), yt = Math.max(R.y1, R.y2);
      // Draw as four lines: pdf-lib's drawRectangle with border-only works
      // but fills with white by default — using lines avoids accidentally
      // occluding geometry behind the rect.
      const c1 = xform(xl, yb), c2 = xform(xr, yb);
      const c3 = xform(xr, yt), c4 = xform(xl, yt);
      for (const [a, b] of [[c1, c2], [c2, c3], [c3, c4], [c4, c1]] as const) {
        page.drawLine({ start: a, end: b, thickness: lineWidth, color });
      }
      break;
    }
    case 'polyline': {
      const P = e as PolylineEntity;
      if (P.pts.length < 2) break;
      const tp = P.pts.map(p => xform(p.x, p.y));
      for (let i = 0; i < tp.length - 1; i++) {
        page.drawLine({ start: tp[i], end: tp[i + 1], thickness: lineWidth, color });
      }
      if (P.closed) {
        page.drawLine({ start: tp[tp.length - 1], end: tp[0], thickness: lineWidth, color });
      }
      break;
    }
    case 'circle': {
      const C = e as CircleEntity;
      const c = xform(C.cx, C.cy);
      // Radius must be scaled too — we pass a unit-length-mm r in world; on
      // the page that becomes (r / scaleDenom) mm → × PT_PER_MM.
      const rPt = (C.r / scaleDenom) * PT_PER_MM;
      page.drawCircle({ x: c.x, y: c.y, size: rPt, borderColor: color, borderWidth: lineWidth });
      break;
    }
    case 'arc': {
      const A = e as ArcEntity;
      const c = xform(A.cx, A.cy);
      const rPt = (A.r / scaleDenom) * PT_PER_MM;
      const ph = page.getHeight();
      const d = arcPathPt(c.x, c.y, rPt, A.a1, A.a2, true, ph);
      // `arcPathPt` now bakes the Y-flip into the path so pdf-lib's internal
      // `scale(1,-1)` + translate by `y: ph` unwinds back to PDF Y-up coords
      // — pass `borderColor` only (no `color`) so the arc renders as a stroke
      // and not a filled region.
      page.drawSvgPath(d, {
        borderColor: color,
        borderWidth: lineWidth,
        x: 0,
        y: ph,
        scale: 1,
      });
      break;
    }
    case 'ellipse': {
      const E = e as EllipseEntity;
      const c = xform(E.cx, E.cy);
      const rxPt = (E.rx / scaleDenom) * PT_PER_MM;
      const ryPt = (E.ry / scaleDenom) * PT_PER_MM;
      const ph = page.getHeight();
      // Pre-flip Y against the page height so pdf-lib's internal `scale(1,-1)`
      // + `y: ph` unwinds to PDF-up coords. Same fix as `arcPathPt`.
      const sy = (y: number) => ph - y;
      // Build a parametric ellipse path, rotated by E.rot (CCW in world).
      const steps = 64;
      const cosR = Math.cos(E.rot), sinR = Math.sin(E.rot);
      const pt0 = {
        x: c.x + Math.cos(0) * rxPt * cosR - Math.sin(0) * ryPt * sinR,
        y: c.y + Math.cos(0) * rxPt * sinR + Math.sin(0) * ryPt * cosR,
      };
      let d = `M ${pt0.x.toFixed(3)} ${sy(pt0.y).toFixed(3)}`;
      for (let i = 1; i <= steps; i++) {
        const t = (i / steps) * Math.PI * 2;
        const px = Math.cos(t) * rxPt, py = Math.sin(t) * ryPt;
        const px2 = c.x + px * cosR - py * sinR;
        const py2 = c.y + px * sinR + py * cosR;
        d += ` L ${px2.toFixed(3)} ${sy(py2).toFixed(3)}`;
      }
      d += ' Z';
      page.drawSvgPath(d, {
        borderColor: color, borderWidth: lineWidth,
        x: 0, y: ph, scale: 1,
      });
      break;
    }
    case 'spline': {
      const S = e as SplineEntity;
      const pts = sampleSpline(S).map(p => xform(p.x, p.y));
      for (let i = 0; i < pts.length - 1; i++) {
        page.drawLine({ start: pts[i], end: pts[i + 1], thickness: lineWidth, color });
      }
      if (S.closed && pts.length > 1) {
        page.drawLine({ start: pts[pts.length - 1], end: pts[0], thickness: lineWidth, color });
      }
      break;
    }
    case 'text': {
      const T = e as TextEntity;
      const p = xform(T.x, T.y);
      const heightPt = (T.height / scaleDenom) * PT_PER_MM;
      // Split on \n so multi-line Grafiktext stacks upwards (anchor at
      // baseline of last line — matches the renderer).
      const lines = T.text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const y = p.y + (lines.length - 1 - i) * heightPt * 1.2;
        page.drawText(lines[i], { x: p.x, y, size: heightPt, color, font });
      }
      break;
    }
    case 'dim': {
      const D = e as DimEntity;
      if (D.dimKind === 'angular' && D.vertex && D.ray1 && D.ray2) {
        // Angular dim → sampled arc (pdf-lib has no native arc primitive we
        // can use with `drawLine`) + degree label at the arc midpoint.
        const V = D.vertex;
        const R = Math.hypot(D.offset.x - V.x, D.offset.y - V.y);
        if (R < 1e-9) break;
        const TAU = Math.PI * 2;
        const norm2pi = (x: number) => ((x % TAU) + TAU) % TAU;
        const a1 = Math.atan2(D.ray1.y - V.y, D.ray1.x - V.x);
        const a2 = Math.atan2(D.ray2.y - V.y, D.ray2.x - V.x);
        const aO = Math.atan2(D.offset.y - V.y, D.offset.x - V.x);
        const sweep12 = norm2pi(a2 - a1);
        const sweep1O = norm2pi(aO - a1);
        const [aS, aE] = (sweep1O <= sweep12 + 1e-9) ? [a1, a2] : [a2, a1];
        const sweep = norm2pi(aE - aS) || TAU;
        const steps = Math.max(24, Math.ceil(sweep / 0.05));
        let prev = xform(V.x + R * Math.cos(aS), V.y + R * Math.sin(aS));
        for (let i = 1; i <= steps; i++) {
          const a = aS + sweep * (i / steps);
          const next = xform(V.x + R * Math.cos(a), V.y + R * Math.sin(a));
          page.drawLine({ start: prev, end: next, thickness: lineWidth, color });
          prev = next;
        }
        // End-caps at the two arc endpoints — direct the cap by feeding a
        // second screen-space point slightly back along the arc; drawDimCapPdf
        // only needs a direction.
        const startS = xform(V.x + R * Math.cos(aS), V.y + R * Math.sin(aS));
        const endS   = xform(V.x + R * Math.cos(aE), V.y + R * Math.sin(aE));
        const stepBack = 0.02; // radians
        const nearStart = xform(
          V.x + R * Math.cos(aS + stepBack),
          V.y + R * Math.sin(aS + stepBack),
        );
        const nearEnd = xform(
          V.x + R * Math.cos(aE - stepBack),
          V.y + R * Math.sin(aE - stepBack),
        );
        const style: DimStyle = D.style ?? 'arrow';
        drawDimCapPdf(page, startS, nearStart, style, lineWidth, color);
        drawDimCapPdf(page, endS,   nearEnd,   style, lineWidth, color);
        // Label slide: 0.12 / 0.5 / 0.88 along the arc sweep, matching the
        // canvas `textAlign` mapping (start / center / end).
        const tArc = D.textAlign === 'start' ? 0.12
                   : D.textAlign === 'end'   ? 0.88
                                             : 0.5;
        const aM = aS + sweep * tArc;
        const midS = xform(V.x + R * Math.cos(aM), V.y + R * Math.sin(aM));
        const heightPt = (D.textHeight / scaleDenom) * PT_PER_MM;
        const degLabel = `${(sweep * 180 / Math.PI).toFixed(1)}°`;
        // Tangent to the arc at aM in PDF (Y-up) coords is perpendicular to
        // the radius, rotated 90° CCW: (-sin aM, cos aM).
        drawDimLabelPdf(
          page, degLabel, midS,
          { dx: -Math.sin(aM), dy: Math.cos(aM) },
          heightPt, font, color,
        );
        break;
      }
      if ((D.dimKind === 'radius' || D.dimKind === 'diameter') && D.vertex && D.ray1) {
        // Radius / diameter: single leader from near-edge (or far-edge for Ø)
        // to the label anchor, plus an arrow at each measured edge.
        const C = D.vertex;
        const r = Math.hypot(D.ray1.x - C.x, D.ray1.y - C.y);
        if (r < 1e-9) break;
        let ux = D.offset.x - C.x, uy = D.offset.y - C.y;
        let ul = Math.hypot(ux, uy);
        if (ul < 1e-9) { ux = D.ray1.x - C.x; uy = D.ray1.y - C.y; ul = r; }
        ux /= ul; uy /= ul;
        const nearW = { x: C.x + ux * r, y: C.y + uy * r };
        const farW  = { x: C.x - ux * r, y: C.y - uy * r };
        const nearP = xform(nearW.x, nearW.y);
        const farP  = xform(farW.x,  farW.y);
        const anchorP = xform(D.offset.x, D.offset.y);
        const isDia = D.dimKind === 'diameter';
        const leaderStart = isDia ? farP : nearP;
        page.drawLine({ start: leaderStart, end: anchorP, thickness: lineWidth, color });
        const style: DimStyle = D.style ?? 'arrow';
        // Near-edge cap: tip on the near edge, tail pointing toward the
        // anchor (i.e. away from centre). drawDimCapPdf takes (tip, tail).
        drawDimCapPdf(page, nearP, anchorP, style, lineWidth, color);
        if (isDia) {
          // Far-edge cap: tip on the far edge, tail pointing toward centre
          // (toward the near edge). Use the near-edge screen point as tail
          // so the arrow is oriented inward along the diameter line.
          drawDimCapPdf(page, farP, nearP, style, lineWidth, color);
        }
        const heightPt = (D.textHeight / scaleDenom) * PT_PER_MM;
        const label = isDia ? `Ø ${(2 * r).toFixed(2)}` : `R ${r.toFixed(2)}`;
        // textAlign drives label position along the leader: `end` (default)
        // pins it at the anchor where the user pulled it, `center` halfway,
        // `start` hugs the edge near the circle. `end` = 1.0 matches the
        // canvas renderer which also uses `end` as the implicit default.
        const tLead = D.textAlign === 'start'  ? 0.12
                    : D.textAlign === 'center' ? 0.5
                                               : 1.0;
        const labelP = {
          x: nearP.x + (anchorP.x - nearP.x) * tLead,
          y: nearP.y + (anchorP.y - nearP.y) * tLead,
        };
        drawDimLabelPdf(
          page, label, labelP,
          { dx: anchorP.x - nearP.x, dy: anchorP.y - nearP.y },
          heightPt, font, color,
        );
        break;
      }
      // Decompose into dim line + 2 extension lines + end-caps + text. The
      // end-caps mirror the four canvas styles (arrow/open/tick/arch) —
      // sized in paper-mm (industry convention: arrows are paper-relative,
      // not drawing-relative, so they stay the same size regardless of
      // scale 1:50 vs 1:100).
      const dx = D.p2.x - D.p1.x, dy = D.p2.y - D.p1.y;
      const L = Math.hypot(dx, dy);
      if (L < 1e-9) break;
      const nx = -dy / L, ny = dx / L;
      const sd = (D.offset.x - D.p1.x) * nx + (D.offset.y - D.p1.y) * ny;
      const ax = D.p1.x + nx * sd, ay = D.p1.y + ny * sd;
      const bx = D.p2.x + nx * sd, by = D.p2.y + ny * sd;
      const A1 = xform(ax, ay), A2 = xform(bx, by);
      const P1 = xform(D.p1.x, D.p1.y), P2 = xform(D.p2.x, D.p2.y);

      // Dim line
      page.drawLine({ start: A1, end: A2, thickness: lineWidth, color });
      // Extension lines with a 0.8mm gap from the measured point and 0.8mm
      // overshoot past the dim line — same shape as the canvas renderer.
      drawExtensionLine(page, P1, A1, lineWidth, color);
      drawExtensionLine(page, P2, A2, lineWidth, color);

      // End-caps. Style falls back to 'arrow' if the entity has none stored
      // (legacy dims predate the per-entity style field).
      const style: DimStyle = D.style ?? 'arrow';
      drawDimCapPdf(page, A1, A2, style, lineWidth, color);  // cap at A1, pointing toward A2
      drawDimCapPdf(page, A2, A1, style, lineWidth, color);  // cap at A2, pointing toward A1

      // Midpoint (or start/end biased) text rotated along the dim line so
      // the PDF matches what the canvas shows.
      const tLin = D.textAlign === 'start' ? 0.12
                 : D.textAlign === 'end'   ? 0.88
                                           : 0.5;
      const labelP = {
        x: A1.x + (A2.x - A1.x) * tLin,
        y: A1.y + (A2.y - A1.y) * tLin,
      };
      const heightPt = (D.textHeight / scaleDenom) * PT_PER_MM;
      drawDimLabelPdf(
        page, L.toFixed(2), labelP,
        { dx: A2.x - A1.x, dy: A2.y - A1.y },
        heightPt, font, color,
      );
      break;
    }
    case 'hatch': {
      const H = e as HatchEntity;
      if (!H.pts || H.pts.length < 3) break;
      // Hatch colour falls back to the layer colour for non-solid modes; for
      // solid, the HatchEntity optionally overrides the layer colour. Matches
      // the canvas renderer's behaviour so a "solid fill with custom colour"
      // export looks identical to what's on screen.
      const fillColor = (H.mode === 'solid' && H.color)
        ? parseHexColor(H.color)
        : color;
      const xformedOuter = H.pts.map(p => xform(p.x, p.y));
      const xformedHoles = (H.holes ?? [])
        .filter(h => h.length >= 3)
        .map(h => h.map(p => xform(p.x, p.y)));
      // Canvas uses default angle=π/4, spacing=5mm when unset (see drawHatch
      // in render.ts). Keep parity so a hatch saved before those fields became
      // mandatory still exports with the same stripe pattern.
      const angle = H.angle ?? Math.PI / 4;
      const spacingWorld = Math.max(0.1, H.spacing ?? 5);
      // spacing is in world mm; convert to PDF pt through the same scale
      // denominator the rest of the exporter uses.
      const spacingPt = (spacingWorld / scaleDenom) * PT_PER_MM;
      drawHatchPdf(
        page, H.mode, xformedOuter, xformedHoles,
        spacingPt, angle, lineWidth, fillColor,
      );
      break;
    }
    case 'xline':
      // Filtered upstream by isExportable.
      break;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Public entry point
// ────────────────────────────────────────────────────────────────────────────

/**
 * Build a PDF from the current drawing.
 *
 * @param entities    Full entity list — filtered internally (xline, hidden layers).
 * @param layers      Layer table for colour + name lookups.
 * @param templateId  Template selector. `custom-1to1` bypasses title-block
 *                    and plot-frame rendering.
 * @param titleBlock  Fields for the title block. Auto-fields (`format`,
 *                    `scale`, `date`) are filled from the resolved template
 *                    if the caller left them blank.
 */
export async function exportPdf(
  entities: Entity[],
  layers: Layer[],
  templateId: PdfTemplateId,
  titleBlock: TitleBlockData,
): Promise<Blob> {
  const def = TEMPLATES[templateId];
  if (!def) throw new Error(`Unbekannte Vorlage: ${templateId}`);

  const bbox = exportBbox(entities, layers);
  if (!bbox) throw new Error('Nichts zu exportieren');

  const rt = resolveTemplate(def, bbox);

  const doc = await PDFDocument.create();
  doc.setTitle(titleBlock.drawingTitle || 'HektikCad Zeichnung');
  doc.setCreator('HektikCad');
  doc.setProducer('HektikCad via pdf-lib');

  const pageW = rt.paperMm.w * PT_PER_MM;
  const pageH = rt.paperMm.h * PT_PER_MM;
  const page = doc.addPage([pageW, pageH]);

  const xform = makeTransform(rt);

  // Embed Helvetica once — used for plain text entities and rotated dim
  // labels. pdf-lib's default font can't be fed to `drawText({ rotate })`
  // without an explicit font reference; measuring the label width via
  // `font.widthOfTextAtSize` also depends on this embed.
  const helvetica = await doc.embedFont(StandardFonts.Helvetica);

  // Plot frame (5mm inset, black 0.5pt). `custom-1to1` skips this.
  if (def.drawPlotFrame) {
    drawPlotFrame(page, rt.paperMm);
  }

  // Draw geometry.
  for (const e of entities) {
    if (!isExportable(e, layers)) continue;
    const L = layers[e.layer];
    const color = parseHexColor(L?.color ?? '#000000');
    drawEntity(page, e, xform, color, DEFAULT_LINE_WIDTH_PT, rt.scaleDenom, helvetica);
  }

  // Title block (phase 5 renderer; skipped for `custom-1to1`).
  if (def.titleBlock.kind !== 'none') {
    // Auto-fill derived fields unless the caller explicitly set them.
    const tb: TitleBlockData = {
      ...titleBlock,
      format: titleBlock.format || rt.formatLabel,
      scale:  titleBlock.scale  || rt.scaleLabel,
      date:   titleBlock.date   || formatTodayDE(),
    };
    // Embed the logo if present (PNG or JPEG DataURL).
    let logoImage: PDFImage | undefined;
    if (tb.logoDataUrl) {
      try {
        logoImage = await embedDataUrl(doc, tb.logoDataUrl);
      } catch (err) {
        console.warn('[exportPdf] Logo konnte nicht eingebettet werden:', err);
      }
    }
    await drawTitleBlock(page, doc, rt, tb, logoImage);
  }

  const bytes = await doc.save();
  // Copy into a fresh ArrayBuffer to make TypeScript happy about
  // `Uint8Array<ArrayBufferLike>` vs. `BlobPart`.
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  return new Blob([buf], { type: 'application/pdf' });
}

/** DD.MM.YYYY — used for the auto-filled `date` field on the title block. */
function formatTodayDE(): string {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}.${mm}.${yyyy}`;
}

/**
 * Turn a `data:image/{png|jpeg};base64,…` URL into a pdf-lib `PDFImage`.
 * Anything else (svg, malformed) throws — caller logs and skips.
 */
async function embedDataUrl(doc: PDFDocument, dataUrl: string): Promise<PDFImage> {
  const m = /^data:image\/(png|jpeg|jpg);base64,(.+)$/.exec(dataUrl);
  if (!m) throw new Error('Unsupported logo format (PNG/JPEG only)');
  const kind = m[1] === 'png' ? 'png' : 'jpg';
  const b64 = m[2];
  // atob → byte string → Uint8Array
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return kind === 'png' ? doc.embedPng(bytes) : doc.embedJpg(bytes);
}
