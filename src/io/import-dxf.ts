/**
 * DXF R12 ASCII parser.
 *
 * Reads a DXF as a flat sequence of group-code/value pairs (one per pair of
 * lines), then walks through ENTITIES emitting HektikCad entities. Layers are
 * mirrored from the LAYERS table (with ACI → hex) so the user keeps the
 * source-file's organisation; entities on layers we never saw declared get a
 * synthesised default-coloured layer named after the entity's `8` value.
 *
 * Scope (matches the export side):
 *   - LINE, LWPOLYLINE, POLYLINE+VERTEX (legacy), CIRCLE, ARC, ELLIPSE, POINT,
 *     SOLID (treated as filled polyline → polyline outline), TEXT, MTEXT.
 *   - SPLINE / 3DFACE / INSERT / HATCH / DIMENSION → counted in `skipped`.
 *
 * Coordinates are taken as-is (R12 stores Y-up, mm via $INSUNITS=4 — that's
 * what the export side writes); no Y flip.
 */

import type { ArcEntity, CircleEntity, EllipseEntity, EntityInit, ImportResult,
              Layer, LineEntity, PolylineEntity, Pt, TextEntity } from '../types';

/**
 * AutoCAD Color Index → approximate sRGB hex. The full ACI table has 256
 * entries; we only need the first 9 indexed colours for the default palette
 * the exporter writes. Anything past that gets a generic grey.
 */
const ACI_TO_HEX: Record<number, string> = {
  1: '#ff0000',  // red
  2: '#ffff00',  // yellow
  3: '#00ff00',  // green
  4: '#00ffff',  // cyan
  5: '#0000ff',  // blue
  6: '#ff00ff',  // magenta
  7: '#ffffff',  // white / black (we use white because dark canvas)
  8: '#808080',  // grey
  9: '#c0c0c0',  // light grey
};

type Pair = { code: number; value: string };

/** Walk a DXF text into a flat list of group-code/value pairs. */
function tokenise(text: string): Pair[] {
  // DXF: every record is two lines — the integer group code and the value.
  // Splitter is `\r?\n` so files saved on Windows still parse.
  const lines = text.split(/\r?\n/);
  const out: Pair[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i].trim(), 10);
    if (!Number.isFinite(code)) continue;
    out.push({ code, value: lines[i + 1] ?? '' });
  }
  return out;
}

export function importDxf(text: string, filename: string): ImportResult {
  const pairs = tokenise(text);

  // ── Pass 1: walk LAYERS table (if present) → layer name + colour ──
  const layers: Layer[] = [];
  const layerByName = new Map<string, number>();
  const upsertLayer = (name: string, color: string): number => {
    const existing = layerByName.get(name);
    if (existing != null) return existing;
    const idx = layers.length;
    layerByName.set(name, idx);
    layers.push({ name, color, visible: true });
    return idx;
  };

  // Scan for the LAYER table block: SECTION → TABLES → TABLE/LAYER. We just
  // sweep the whole pair list and pick out 0/LAYER blocks — declaring layers
  // outside the TABLES section is invalid DXF but tolerating it is harmless.
  for (let i = 0; i < pairs.length; i++) {
    if (pairs[i].code === 0 && pairs[i].value === 'LAYER') {
      let name = '';
      let aci = 7;
      // Walk until the next 0/* — group codes 2 = name, 62 = colour.
      for (let j = i + 1; j < pairs.length && pairs[j].code !== 0; j++) {
        if (pairs[j].code === 2) name = pairs[j].value;
        else if (pairs[j].code === 62) aci = parseInt(pairs[j].value, 10) || 7;
      }
      if (name) upsertLayer(name, ACI_TO_HEX[aci] ?? '#ffffff');
    }
  }

  // ── Pass 2: walk ENTITIES section ──
  const out: EntityInit[] = [];
  const skipped = { text: 0, hatch: 0, spline: 0, insert: 0, unknown: 0 };

  // Find the start + end of ENTITIES so we don't accidentally emit anything
  // from BLOCKS or HEADER.
  let inEntities = false;
  let i = 0;
  while (i < pairs.length) {
    const p = pairs[i];
    if (p.code === 0 && p.value === 'SECTION') {
      const next = pairs[i + 1];
      inEntities = !!next && next.code === 2 && next.value === 'ENTITIES';
      i += 2;
      continue;
    }
    if (p.code === 0 && p.value === 'ENDSEC') {
      inEntities = false;
      i += 1;
      continue;
    }
    if (!inEntities) {
      i += 1;
      continue;
    }
    if (p.code !== 0) {
      i += 1;
      continue;
    }
    // p.code === 0 — start of an entity. Collect group codes until the next 0.
    const type = p.value;
    const ent: Map<number, string[]> = new Map();
    let j = i + 1;
    while (j < pairs.length && pairs[j].code !== 0) {
      const arr = ent.get(pairs[j].code);
      if (arr) arr.push(pairs[j].value);
      else ent.set(pairs[j].code, [pairs[j].value]);
      j += 1;
    }
    // Special-case POLYLINE — the legacy "POLYLINE / VERTEX … VERTEX SEQEND"
    // form sits across multiple 0-blocks, so we have to consume them here
    // before falling through to the j-cursor advance.
    if (type === 'POLYLINE') {
      const result = consumeLegacyPolyline(pairs, j, ent, upsertLayer);
      if (result.entity) out.push(result.entity);
      i = result.next;
      continue;
    }
    handleEntity(type, ent, upsertLayer, out, skipped);
    i = j;
  }

  // Always make sure at least one layer exists (some files have no TABLES
  // section at all). Synthesises a "0" layer matching the DXF default.
  if (layers.length === 0) upsertLayer('0', '#ffffff');

  return { entities: out, layers, skipped, filename, format: 'dxf' };
}

// ────────────────────────────────────────────────────────────────────────────
// Per-entity handlers. Each pulls the relevant group codes from the map,
// emits 0..N entities into `out`, or bumps a `skipped` counter.
// ────────────────────────────────────────────────────────────────────────────

function num(map: Map<number, string[]>, code: number, fallback = 0): number {
  const v = map.get(code)?.[0];
  if (v == null) return fallback;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}
function str(map: Map<number, string[]>, code: number, fallback = ''): string {
  return map.get(code)?.[0] ?? fallback;
}
function nums(map: Map<number, string[]>, code: number): number[] {
  return (map.get(code) ?? []).map(parseFloat).filter(Number.isFinite);
}

function handleEntity(
  type: string,
  ent: Map<number, string[]>,
  upsertLayer: (name: string, color: string) => number,
  out: EntityInit[],
  skipped: ImportResult['skipped'],
): void {
  const layerName = str(ent, 8, '0') || '0';
  const layerIdx = upsertLayer(layerName, '#ffffff');

  switch (type) {
    case 'LINE': {
      const e: Omit<LineEntity, 'id'> = {
        type: 'line',
        layer: layerIdx,
        x1: num(ent, 10), y1: num(ent, 20),
        x2: num(ent, 11), y2: num(ent, 21),
      };
      out.push(e);
      return;
    }
    case 'LWPOLYLINE': {
      // LWPOLYLINE encodes vertices as parallel 10/20 lists: `nums(10)[k]`
      // is x_k, `nums(20)[k]` is y_k. Closed flag = bit 1 of group 70.
      const xs = nums(ent, 10);
      const ys = nums(ent, 20);
      const flags = parseInt(str(ent, 70, '0'), 10) || 0;
      const pts: Pt[] = [];
      const n = Math.min(xs.length, ys.length);
      for (let k = 0; k < n; k++) pts.push({ x: xs[k], y: ys[k] });
      if (pts.length < 2) return;
      const e: Omit<PolylineEntity, 'id'> = {
        type: 'polyline',
        layer: layerIdx,
        pts,
        closed: (flags & 1) === 1,
      };
      out.push(e);
      return;
    }
    case 'CIRCLE': {
      const e: Omit<CircleEntity, 'id'> = {
        type: 'circle',
        layer: layerIdx,
        cx: num(ent, 10), cy: num(ent, 20), r: num(ent, 40),
      };
      out.push(e);
      return;
    }
    case 'ARC': {
      const e: Omit<ArcEntity, 'id'> = {
        type: 'arc',
        layer: layerIdx,
        cx: num(ent, 10), cy: num(ent, 20), r: num(ent, 40),
        a1: num(ent, 50) * Math.PI / 180,
        a2: num(ent, 51) * Math.PI / 180,
      };
      out.push(e);
      return;
    }
    case 'ELLIPSE': {
      // R12 doesn't have ELLIPSE but later DXFs do. Group 11/21 is the
      // major-axis vector relative to centre, 40 is the minor/major ratio,
      // 41/42 are start/end parameters (we ignore them — full ellipse only).
      const cx = num(ent, 10), cy = num(ent, 20);
      const mx = num(ent, 11), my = num(ent, 21);
      const ratio = num(ent, 40, 1);
      const rx = Math.hypot(mx, my);
      const ry = rx * ratio;
      const rot = Math.atan2(my, mx);
      const e: Omit<EllipseEntity, 'id'> = {
        type: 'ellipse',
        layer: layerIdx,
        cx, cy, rx, ry, rot,
      };
      out.push(e);
      return;
    }
    case 'POINT': {
      // Render as a tiny zero-length polyline so it isn't lost — most DXFs use
      // POINT for snap-only markers, the user usually wants it visible.
      const x = num(ent, 10), y = num(ent, 20);
      out.push({ type: 'polyline', layer: layerIdx, pts: [{ x, y }, { x, y }], closed: false });
      return;
    }
    case 'TEXT':
    case 'MTEXT': {
      const text = str(ent, 1).replace(/\\P/g, '\n');
      if (!text) return;
      const e: Omit<TextEntity, 'id'> = {
        type: 'text',
        layer: layerIdx,
        x: num(ent, 10), y: num(ent, 20),
        height: num(ent, 40, 2.5),
        text,
        rotation: num(ent, 50) * Math.PI / 180,
      };
      out.push(e);
      return;
    }
    case 'SOLID': {
      // SOLID is a filled triangle/quad. Treat as a closed polyline of its 3-4
      // corners so the geometry is preserved (we don't model fills).
      const xs = [num(ent, 10), num(ent, 11), num(ent, 12), num(ent, 13)];
      const ys = [num(ent, 20), num(ent, 21), num(ent, 22), num(ent, 23)];
      const pts: Pt[] = [];
      // R12 SOLID quirk: 4th vertex is duplicated for triangles. Filter dup.
      for (let k = 0; k < 4; k++) {
        const p = { x: xs[k], y: ys[k] };
        if (k > 0 && pts.length && p.x === pts[pts.length - 1].x && p.y === pts[pts.length - 1].y) continue;
        pts.push(p);
      }
      if (pts.length >= 3) {
        out.push({ type: 'polyline', layer: layerIdx, pts, closed: true });
      }
      return;
    }
    case 'SPLINE': {
      skipped.spline = (skipped.spline ?? 0) + 1;
      return;
    }
    case 'INSERT': {
      skipped.insert = (skipped.insert ?? 0) + 1;
      return;
    }
    case 'HATCH': {
      skipped.hatch = (skipped.hatch ?? 0) + 1;
      return;
    }
    case 'DIMENSION':
    case '3DFACE':
    case 'BLOCK':
    case 'ENDBLK':
    case 'ATTRIB':
    case 'ATTDEF':
    case 'VIEWPORT':
    case 'SEQEND':
      // Either explicitly out-of-scope or a structural marker (SEQEND).
      // Don't increment unknown for structural markers.
      if (type === 'DIMENSION' || type === '3DFACE') {
        skipped.unknown = (skipped.unknown ?? 0) + 1;
      }
      return;
    default:
      skipped.unknown = (skipped.unknown ?? 0) + 1;
      return;
  }
}

/**
 * Legacy POLYLINE / VERTEX … SEQEND form. The opening POLYLINE record holds
 * the closed flag (group 70 bit 1); each subsequent VERTEX record holds one
 * `(x, y)` pair (group 10/20). SEQEND closes the run.
 *
 * Returns the assembled entity (or `null`) plus the index of the next pair to
 * resume scanning at — the caller advances `i` to that.
 */
function consumeLegacyPolyline(
  pairs: Pair[],
  startJ: number,
  poly: Map<number, string[]>,
  upsertLayer: (name: string, color: string) => number,
): { entity: EntityInit | null; next: number } {
  const layerName = (poly.get(8)?.[0]) ?? '0';
  const layerIdx = upsertLayer(layerName, '#ffffff');
  const flags = parseInt(poly.get(70)?.[0] ?? '0', 10) || 0;
  const closed = (flags & 1) === 1;

  const pts: Pt[] = [];
  let k = startJ;
  while (k < pairs.length) {
    const p = pairs[k];
    if (p.code !== 0) { k += 1; continue; }
    if (p.value === 'VERTEX') {
      let x = 0, y = 0;
      let m = k + 1;
      while (m < pairs.length && pairs[m].code !== 0) {
        if (pairs[m].code === 10) x = parseFloat(pairs[m].value) || 0;
        else if (pairs[m].code === 20) y = parseFloat(pairs[m].value) || 0;
        m += 1;
      }
      pts.push({ x, y });
      k = m;
      continue;
    }
    if (p.value === 'SEQEND') {
      // Done — return resume index past the SEQEND's pair group.
      let m = k + 1;
      while (m < pairs.length && pairs[m].code !== 0) m += 1;
      if (pts.length < 2) return { entity: null, next: m };
      const e: Omit<PolylineEntity, 'id'> = { type: 'polyline', layer: layerIdx, pts, closed };
      return { entity: e, next: m };
    }
    // Unexpected entity type before SEQEND — bail out, let the outer loop pick
    // it up. We've already consumed the polyline header so emit what we've got.
    if (pts.length >= 2) {
      const e: Omit<PolylineEntity, 'id'> = { type: 'polyline', layer: layerIdx, pts, closed };
      return { entity: e, next: k };
    }
    return { entity: null, next: k };
  }
  return { entity: null, next: k };
}
