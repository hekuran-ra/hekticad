/**
 * DXF R12 ASCII writer.
 *
 * Group-code pairs, one per line. All coordinates in world mm, 1:1. No Y flip
 * (HektikCad stores Y-up, DXF is also Y-up).
 *
 * Scope:
 *   - Supported entities: line, polyline, rect, circle, arc, ellipse, spline,
 *     text. `dim` is decomposed into primitive lines + text. `xline` is
 *     skipped (infinite construction line — no DXF equivalent).
 *   - R12 has no SPLINE/ELLIPSE entity, so those get sampled to LWPOLYLINE.
 *   - `$INSUNITS = 4` (millimetres) — without it, LibreCAD assumes inches.
 *
 * Validation:
 *   - Open the output in LibreCAD or QCAD; a 1000mm line must measure 1000mm.
 */

import type { ArcEntity, CircleEntity, DimEntity, EllipseEntity, Entity, Layer,
              LineEntity, PolylineEntity, Pt, RectEntity, SplineEntity,
              TextEntity } from '../types';
import { isExportable } from './drawing-bounds';

/** DXF ACI colour index. 256 = ByLayer on entity; on layer definitions use 1..255. */
type Aci = number;

/**
 * Very small hex→ACI lookup covering the default HektikCad layer palette.
 * Anything unknown falls back to 7 (black/white, context-dependent).
 */
function hexToAci(hex: string): Aci {
  const h = hex.toLowerCase().replace(/^#/, '');
  // Quick palette hits first (the default layers).
  const table: Record<string, Aci> = {
    'ffffff': 7,   // white ("0")
    '4a5060': 8,   // grey ("Achsen" — but we skip that layer)
    'e06767': 1,   // red ("Kontur")
    '8891a0': 8,   // grey ("Hilfslinie")
    '67c1ff': 5,   // blue ("Bemaßung")
    '4cc2ff': 5,   // accent
    'f5a524': 2,   // amber
    '2dd4bf': 4,   // teal cyan
  };
  if (table[h]) return table[h];

  // Fallback: classify by dominant hue.
  const r = parseInt(h.slice(0, 2) || '0', 16);
  const g = parseInt(h.slice(2, 4) || '0', 16);
  const b = parseInt(h.slice(4, 6) || '0', 16);
  if (r > 200 && g < 120 && b < 120) return 1;  // red
  if (r > 200 && g > 200 && b < 120) return 2;  // yellow
  if (r < 120 && g > 200 && b < 120) return 3;  // green
  if (r < 120 && g > 200 && b > 200) return 4;  // cyan
  if (r < 120 && g < 120 && b > 200) return 5;  // blue
  if (r > 200 && g < 120 && b > 200) return 6;  // magenta
  return 7;
}

/** Sanitise layer names for DXF — no spaces, no special chars in strict readers. */
function sanitiseLayerName(name: string): string {
  // Replace anything outside [A-Za-z0-9_-] with underscore. Empty → "LAYER".
  const s = name.replace(/[^A-Za-z0-9_\-]/g, '_');
  return s.length > 0 ? s : 'LAYER';
}

/** Format a number for DXF — fixed 6 decimals, dot as decimal separator, no exponent. */
function num(n: number): string {
  if (!Number.isFinite(n)) return '0.000000';
  return n.toFixed(6);
}

/**
 * DXF writer — pushes group-code/value pairs onto `lines`. Each `pair()` call
 * produces two output lines (code on one, value on the next). The `writeXxx`
 * methods package the boilerplate for each supported entity type.
 */
class DxfWriter {
  private lines: string[] = [];
  /** Layers actually referenced by entities — only these get declared. */
  private usedLayers = new Map<string, { name: string; aci: Aci }>();

  // ── primitive pair emission ──
  private pair(code: number, value: string | number): void {
    this.lines.push(String(code));
    this.lines.push(String(value));
  }
  private startSection(name: string): void {
    this.pair(0, 'SECTION');
    this.pair(2, name);
  }
  private endSection(): void {
    this.pair(0, 'ENDSEC');
  }

  // ── header ──
  private writeHeader(): void {
    this.startSection('HEADER');
    // ACADVER = R12
    this.pair(9, '$ACADVER');
    this.pair(1, 'AC1009');
    // INSUNITS = 4 (mm)
    this.pair(9, '$INSUNITS');
    this.pair(70, 4);
    this.endSection();
  }

  // ── tables (LAYER) ──
  private writeTables(): void {
    this.startSection('TABLES');
    this.pair(0, 'TABLE');
    this.pair(2, 'LAYER');
    this.pair(70, this.usedLayers.size || 1);

    // Always emit "0" as a fallback layer so strict readers don't choke.
    if (!this.usedLayers.has('0')) {
      this.pair(0, 'LAYER');
      this.pair(2, '0');
      this.pair(70, 0);
      this.pair(62, 7);
      this.pair(6, 'CONTINUOUS');
    }
    for (const L of this.usedLayers.values()) {
      this.pair(0, 'LAYER');
      this.pair(2, L.name);
      this.pair(70, 0);
      this.pair(62, L.aci);
      this.pair(6, 'CONTINUOUS');
    }

    this.pair(0, 'ENDTAB');
    this.endSection();
  }

  /** Register a layer so it appears in the TABLES section. */
  private registerLayer(name: string, aci: Aci): string {
    const sanitised = sanitiseLayerName(name);
    if (!this.usedLayers.has(sanitised)) {
      this.usedLayers.set(sanitised, { name: sanitised, aci });
    }
    return sanitised;
  }

  // ── entity emitters ──
  private entityHeader(type: string, layer: string): void {
    this.pair(0, type);
    this.pair(8, layer);
    this.pair(62, 256);  // ByLayer
  }

  writeLine(x1: number, y1: number, x2: number, y2: number, layer: string): void {
    this.entityHeader('LINE', layer);
    this.pair(10, num(x1)); this.pair(20, num(y1)); this.pair(30, '0.0');
    this.pair(11, num(x2)); this.pair(21, num(y2)); this.pair(31, '0.0');
  }

  writeLwPolyline(pts: Pt[], closed: boolean, layer: string): void {
    if (pts.length < 2) return;
    this.entityHeader('LWPOLYLINE', layer);
    this.pair(90, pts.length);
    this.pair(70, closed ? 1 : 0);
    for (const p of pts) {
      this.pair(10, num(p.x));
      this.pair(20, num(p.y));
    }
  }

  writeCircle(cx: number, cy: number, r: number, layer: string): void {
    this.entityHeader('CIRCLE', layer);
    this.pair(10, num(cx)); this.pair(20, num(cy)); this.pair(30, '0.0');
    this.pair(40, num(r));
  }

  writeArc(cx: number, cy: number, r: number, a1Deg: number, a2Deg: number, layer: string): void {
    this.entityHeader('ARC', layer);
    this.pair(10, num(cx)); this.pair(20, num(cy)); this.pair(30, '0.0');
    this.pair(40, num(r));
    this.pair(50, num(a1Deg));
    this.pair(51, num(a2Deg));
  }

  writeText(x: number, y: number, height: number, text: string, rotationDeg: number, layer: string): void {
    // R12 TEXT: group 10/20 = insertion point, 40 = height, 1 = value, 50 = rotation.
    // Sanitise the text: DXF R12 doesn't like newlines inside TEXT (use MTEXT for that,
    // but R12 predates MTEXT); split into multiple TEXT lines stacked vertically.
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const lineText = lines[i].replace(/[\x00-\x1f]/g, ' ');
      // Stack additional lines ABOVE the anchor (world Y-up, baseline anchor).
      const ly = y + (lines.length - 1 - i) * height * 1.2;
      this.entityHeader('TEXT', layer);
      this.pair(10, num(x)); this.pair(20, num(ly)); this.pair(30, '0.0');
      this.pair(40, num(height));
      this.pair(1,  lineText);
      if (rotationDeg !== 0) this.pair(50, num(rotationDeg));
    }
  }

  /** Register the layer used by an entity and return its sanitised name. */
  layerFor(e: Entity, layers: Layer[]): string {
    const L = layers[e.layer] ?? { name: '0', color: '#ffffff' } as Layer;
    return this.registerLayer(L.name, hexToAci(L.color));
  }

  // ── assembly ──
  build(entitiesSection: () => void): string {
    // Entities get written first (which populates usedLayers), but the final
    // DXF order is HEADER → TABLES → ENTITIES. We buffer the entities section
    // into a temporary writer, run it, then stitch the sections.
    const entityLines: string[] = [];
    const originalLines = this.lines;
    this.lines = entityLines;

    this.startSection('ENTITIES');
    entitiesSection();
    this.endSection();

    this.lines = originalLines;
    this.writeHeader();
    this.writeTables();
    // Dump the buffered entities section.
    for (const l of entityLines) this.lines.push(l);
    this.pair(0, 'EOF');

    return this.lines.join('\n') + '\n';
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Entity → DXF geometry
// ────────────────────────────────────────────────────────────────────────────

/**
 * Sample an ellipse into `segments` equally-spaced points around its perimeter.
 * Rotation is applied after the unit-ellipse expansion. Used because DXF R12
 * lacks a native ELLIPSE entity.
 */
function sampleEllipse(e: EllipseEntity, segments: number = 72): Pt[] {
  const pts: Pt[] = [];
  const cosR = Math.cos(e.rot), sinR = Math.sin(e.rot);
  for (let i = 0; i <= segments; i++) {
    const t = (i / segments) * Math.PI * 2;
    const ux = Math.cos(t) * e.rx;
    const uy = Math.sin(t) * e.ry;
    pts.push({
      x: e.cx + ux * cosR - uy * sinR,
      y: e.cy + ux * sinR + uy * cosR,
    });
  }
  return pts;
}

/**
 * Catmull-Rom spline sampling, matching the renderer's cubic-Bezier chain.
 * 12 samples per segment is enough for export fidelity without blowing up
 * file size. Closed splines get wrap-around neighbours.
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

/** Dimension decomposed into 3 lines + 1 text. Matches the SVG renderer's geometry. */
function emitDim(w: DxfWriter, e: DimEntity, layer: string): void {
  if (e.dimKind === 'angular' && e.vertex && e.ray1 && e.ray2) {
    // Angular → DXF ARC + degree label. CAD receivers get a proper primitive
    // (not a sampled polyline) so downstream tools can still re-measure.
    const V = e.vertex;
    const R = Math.hypot(e.offset.x - V.x, e.offset.y - V.y);
    if (R < 1e-9) return;
    const TAU = Math.PI * 2;
    const norm2pi = (x: number) => ((x % TAU) + TAU) % TAU;
    const a1 = Math.atan2(e.ray1.y - V.y, e.ray1.x - V.x);
    const a2 = Math.atan2(e.ray2.y - V.y, e.ray2.x - V.x);
    const aO = Math.atan2(e.offset.y - V.y, e.offset.x - V.x);
    const sweep12 = norm2pi(a2 - a1);
    const sweep1O = norm2pi(aO - a1);
    const [aS, aE] = (sweep1O <= sweep12 + 1e-9) ? [a1, a2] : [a2, a1];
    const sweep = norm2pi(aE - aS) || TAU;
    const toDeg = (rad: number) => (rad * 180 / Math.PI);
    w.writeArc(V.x, V.y, R, toDeg(aS), toDeg(aE), layer);
    const aM = aS + sweep / 2;
    const mx = V.x + R * Math.cos(aM), my = V.y + R * Math.sin(aM);
    w.writeText(mx, my + 0.5, e.textHeight, `${(sweep * 180 / Math.PI).toFixed(1)}°`, 0, layer);
    return;
  }
  if ((e.dimKind === 'radius' || e.dimKind === 'diameter') && e.vertex && e.ray1) {
    // Radius / diameter → LINE leader + TEXT with R/Ø prefix. Keeping the DXF
    // simple (not emitting a full DIMENSION entity) is consistent with the
    // linear-dim path: CAD receivers see a stable drawing without having to
    // parse our specific dim variant.
    const C = e.vertex;
    const r = Math.hypot(e.ray1.x - C.x, e.ray1.y - C.y);
    if (r < 1e-9) return;
    let ux = e.offset.x - C.x, uy = e.offset.y - C.y;
    let ul = Math.hypot(ux, uy);
    if (ul < 1e-9) { ux = e.ray1.x - C.x; uy = e.ray1.y - C.y; ul = r; }
    ux /= ul; uy /= ul;
    const nearX = C.x + ux * r, nearY = C.y + uy * r;
    const farX  = C.x - ux * r, farY  = C.y - uy * r;
    const isDia = e.dimKind === 'diameter';
    if (isDia) w.writeLine(farX, farY, e.offset.x, e.offset.y, layer);
    else       w.writeLine(nearX, nearY, e.offset.x, e.offset.y, layer);
    const label = isDia ? `%%C${(2 * r).toFixed(2)}` : `R${r.toFixed(2)}`;
    // Rotate text along the leader direction (DXF CCW degrees from +X).
    const leaderStartX = isDia ? farX : nearX;
    const leaderStartY = isDia ? farY : nearY;
    let deg = Math.atan2(e.offset.y - leaderStartY, e.offset.x - leaderStartX) * 180 / Math.PI;
    if (deg > 90)  deg -= 180;
    if (deg < -90) deg += 180;
    w.writeText(e.offset.x, e.offset.y + 0.5, e.textHeight, label, deg, layer);
    return;
  }
  const dx = e.p2.x - e.p1.x, dy = e.p2.y - e.p1.y;
  const L = Math.hypot(dx, dy);
  if (L < 1e-9) return;
  const nx = -dy / L, ny = dx / L;
  const sd = (e.offset.x - e.p1.x) * nx + (e.offset.y - e.p1.y) * ny;
  const ax = e.p1.x + nx * sd, ay = e.p1.y + ny * sd;
  const bx = e.p2.x + nx * sd, by = e.p2.y + ny * sd;
  // Dim line + two extension lines
  w.writeLine(ax, ay, bx, by, layer);
  w.writeLine(e.p1.x, e.p1.y, ax, ay, layer);
  w.writeLine(e.p2.x, e.p2.y, bx, by, layer);
  // Text at midpoint, rotated along the dim line (DXF rotation is degrees CCW from +X)
  const mx = (ax + bx) / 2, my = (ay + by) / 2;
  let deg = Math.atan2(by - ay, bx - ax) * 180 / Math.PI;
  if (deg > 90)  deg -= 180;
  if (deg < -90) deg += 180;
  w.writeText(mx, my + 0.5, e.textHeight, L.toFixed(2), deg, layer);
}

// ────────────────────────────────────────────────────────────────────────────
// Public entry point
// ────────────────────────────────────────────────────────────────────────────

/**
 * Convert the drawing to a DXF R12 ASCII `Blob`.
 *
 * @param entities  Full entity list — filtered internally via `isExportable`
 *                  (drops xline + entities on hidden/locked-axes layers).
 * @param layers    Layer table, used for layer-name and ACI colour.
 */
export function exportDxf(entities: Entity[], layers: Layer[]): Blob {
  const w = new DxfWriter();

  const text = w.build(() => {
    for (const e of entities) {
      if (!isExportable(e, layers)) continue;
      const layer = w.layerFor(e, layers);

      switch (e.type) {
        case 'line': {
          const L = e as LineEntity;
          w.writeLine(L.x1, L.y1, L.x2, L.y2, layer);
          break;
        }
        case 'polyline': {
          const P = e as PolylineEntity;
          w.writeLwPolyline(P.pts, !!P.closed, layer);
          break;
        }
        case 'rect': {
          const R = e as RectEntity;
          const xl = Math.min(R.x1, R.x2), xr = Math.max(R.x1, R.x2);
          const yb = Math.min(R.y1, R.y2), yt = Math.max(R.y1, R.y2);
          w.writeLwPolyline(
            [{ x: xl, y: yb }, { x: xr, y: yb }, { x: xr, y: yt }, { x: xl, y: yt }],
            true,
            layer,
          );
          break;
        }
        case 'circle': {
          const C = e as CircleEntity;
          w.writeCircle(C.cx, C.cy, C.r, layer);
          break;
        }
        case 'arc': {
          const A = e as ArcEntity;
          // HektikCad stores arc angles in radians; DXF wants degrees.
          const toDeg = (rad: number) => (rad * 180 / Math.PI);
          w.writeArc(A.cx, A.cy, A.r, toDeg(A.a1), toDeg(A.a2), layer);
          break;
        }
        case 'ellipse': {
          const E = e as EllipseEntity;
          w.writeLwPolyline(sampleEllipse(E), true, layer);
          break;
        }
        case 'spline': {
          const S = e as SplineEntity;
          w.writeLwPolyline(sampleSpline(S), !!S.closed, layer);
          break;
        }
        case 'text': {
          const T = e as TextEntity;
          const rotDeg = T.rotation ? (T.rotation * 180 / Math.PI) : 0;
          w.writeText(T.x, T.y, T.height, T.text, rotDeg, layer);
          break;
        }
        case 'dim': {
          emitDim(w, e as DimEntity, layer);
          break;
        }
        case 'xline':
          // Already filtered by isExportable, but guard anyway.
          break;
      }
    }
  });

  return new Blob([text], { type: 'application/dxf' });
}
