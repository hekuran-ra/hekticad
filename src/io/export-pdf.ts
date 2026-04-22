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

import { PDFDocument, rgb, PDFPage, PDFImage } from 'pdf-lib';
import type { ArcEntity, CircleEntity, DimEntity, DimStyle, EllipseEntity,
              Entity, Layer, LineEntity, PdfTemplateId, PolylineEntity,
              Pt, RectEntity, SplineEntity, TextEntity, TitleBlockData }
  from '../types';
import { exportBbox, isExportable } from './drawing-bounds';
import { PT_PER_MM } from './units';
import { TEMPLATES, resolveTemplate, type ResolvedTemplate } from './templates';
import { drawTitleBlock, drawPlotFrame } from './titleblock';

// ────────────────────────────────────────────────────────────────────────────
// Colour mapping
//
// The HektikCad canvas uses a dark background, so layers in white or near-white
// (e.g. the default "0" layer at #ffffff) are perfectly legible on screen. The
// PDF paper, however, is white — emitting those colours verbatim would make the
// geometry invisible on the print.
//
// Strategy: compute a perceived luminance, and if a colour would have too
// little contrast against white paper, remap it to pure black. This preserves
// all "normal" engineering colours (red, blue, amber, teal …) exactly, and
// only rescues the white-on-white corner case. Same idea as AutoCAD's
// "Display as black" print handling for layer colour 7.
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
 * Rec. 601 perceived luminance (0 = black, 1 = white). Good-enough model for
 * deciding "is this colour bright?" — we're not colour-matching here, just
 * checking print legibility.
 */
function luminance(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * Above this luminance, remap to black. 0.92 catches pure white (#ffffff, Y=1),
 * the near-whites (#f8f8f8, Y≈0.97), and the very-light greys that would
 * otherwise print as ghosted lines. Mid-greys (#cccccc, Y≈0.8) still pass
 * through unchanged — the user explicitly picked those.
 */
const PAPER_WHITE_LUM_THRESHOLD = 0.92;

/**
 * Convert a CSS hex colour into a pdf-lib `rgb()` value, rescuing colours
 * that would be invisible on white paper. See the header comment for the
 * rationale and threshold choice.
 */
function parseHexColor(hex: string): ReturnType<typeof rgb> {
  const { r, g, b } = parseHexTriple(hex);
  if (luminance(r, g, b) >= PAPER_WHITE_LUM_THRESHOLD) {
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
 * Return an SVG path string for an arc, in pt, Y-up (pdf-lib convention).
 * `startAngle`/`endAngle` in radians, CCW from +X. Subdivides into ≤90°
 * quarters for low Bezier error.
 */
function arcPathPt(
  cxPt: number, cyPt: number, rPt: number,
  startAngle: number, endAngle: number,
  sweepCCW: boolean = true,
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

  const atPt = (a: number) => ({
    x: cxPt + Math.cos(a) * rPt,
    y: cyPt + Math.sin(a) * rPt,
  });
  let a = startAngle;
  let p0 = atPt(a);
  let out = `M ${p0.x.toFixed(3)} ${p0.y.toFixed(3)}`;
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
    out += ` C ${c0.x.toFixed(3)} ${c0.y.toFixed(3)} ${c1.x.toFixed(3)} ${c1.y.toFixed(3)} ${p1.x.toFixed(3)} ${p1.y.toFixed(3)}`;
    a = a1;
    p0 = p1;
  }
  return out;
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
    const d = `M ${tip.x.toFixed(3)} ${tip.y.toFixed(3)} ` +
              `L ${(bx + px * halfW).toFixed(3)} ${(by + py * halfW).toFixed(3)} ` +
              `L ${(bx - px * halfW).toFixed(3)} ${(by - py * halfW).toFixed(3)} Z`;
    // `drawSvgPath` treats input as SVG coords (Y-down); we pass an explicit
    // `y: pageHeight` + `scale: 1` so the coords we built in PDF Y-up pass
    // through unchanged. Same trick as the arc/ellipse paths above.
    page.drawSvgPath(d, {
      x: 0, y: page.getHeight(), scale: 1,
      color, borderColor: color, borderWidth: 0.1,
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
      const d = arcPathPt(c.x, c.y, rPt, A.a1, A.a2, true);
      // pdf-lib's drawSvgPath expects Y-down by default (SVG convention), but
      // we've already built the path in pt with PDF's Y-up coords. Pass an
      // explicit y offset of 0 and `scale: 1` with `y:` anchored to page
      // height to compensate.
      page.drawSvgPath(d, {
        color,
        borderColor: color,
        borderWidth: lineWidth,
        x: 0,
        y: page.getHeight(),
        scale: 1,
      });
      break;
    }
    case 'ellipse': {
      const E = e as EllipseEntity;
      const c = xform(E.cx, E.cy);
      const rxPt = (E.rx / scaleDenom) * PT_PER_MM;
      const ryPt = (E.ry / scaleDenom) * PT_PER_MM;
      // Build a parametric ellipse path, rotated by E.rot (CCW in world).
      const steps = 64;
      const cosR = Math.cos(E.rot), sinR = Math.sin(E.rot);
      const pt0 = {
        x: c.x + Math.cos(0) * rxPt * cosR - Math.sin(0) * ryPt * sinR,
        y: c.y + Math.cos(0) * rxPt * sinR + Math.sin(0) * ryPt * cosR,
      };
      let d = `M ${pt0.x.toFixed(3)} ${pt0.y.toFixed(3)}`;
      for (let i = 1; i <= steps; i++) {
        const t = (i / steps) * Math.PI * 2;
        const px = Math.cos(t) * rxPt, py = Math.sin(t) * ryPt;
        const px2 = c.x + px * cosR - py * sinR;
        const py2 = c.y + px * sinR + py * cosR;
        d += ` L ${px2.toFixed(3)} ${py2.toFixed(3)}`;
      }
      d += ' Z';
      page.drawSvgPath(d, {
        borderColor: color, borderWidth: lineWidth,
        x: 0, y: page.getHeight(), scale: 1,
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
        page.drawText(lines[i], { x: p.x, y, size: heightPt, color });
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
        const aM = aS + sweep / 2;
        const midS = xform(V.x + R * Math.cos(aM), V.y + R * Math.sin(aM));
        const heightPt = (D.textHeight / scaleDenom) * PT_PER_MM;
        const degLabel = `${(sweep * 180 / Math.PI).toFixed(1)}°`;
        page.drawText(degLabel, {
          x: midS.x - heightPt * 1.2,
          y: midS.y + 0.5 * PT_PER_MM,
          size: heightPt, color,
        });
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
        page.drawText(label, {
          x: anchorP.x - heightPt * 1.2,
          y: anchorP.y + 0.5 * PT_PER_MM,
          size: heightPt, color,
        });
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

      // Midpoint text — kept axis-aligned for phase 1 (rotation would need
      // pdf-lib's `rotate` option; acceptable trade-off for a first pass).
      const mx = (A1.x + A2.x) / 2, my = (A1.y + A2.y) / 2;
      const heightPt = (D.textHeight / scaleDenom) * PT_PER_MM;
      page.drawText(L.toFixed(2), { x: mx - heightPt * 1.2, y: my + 0.5 * PT_PER_MM, size: heightPt, color });
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

  // Plot frame (5mm inset, black 0.5pt). `custom-1to1` skips this.
  if (def.drawPlotFrame) {
    drawPlotFrame(page, rt.paperMm);
  }

  // Draw geometry.
  for (const e of entities) {
    if (!isExportable(e, layers)) continue;
    const L = layers[e.layer];
    const color = parseHexColor(L?.color ?? '#000000');
    drawEntity(page, e, xform, color, DEFAULT_LINE_WIDTH_PT, rt.scaleDenom);
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
