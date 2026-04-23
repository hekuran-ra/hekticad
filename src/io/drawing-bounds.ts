/**
 * Drawing-bbox helpers for the I/O subsystem.
 *
 * The renderer's `drawingBounds()` in view.ts also includes construction
 * lines (xline) and entities on invisible layers — fine for zoom-to-fit, bad
 * for export, where we need the exact printable bounds.
 */

import type { Entity, Layer, Pt } from '../types';
import { layoutText } from '../textlayout';
import type { Bbox } from './units';

/**
 * Does this entity count toward the export bbox AND does it get exported?
 * Rules:
 *   - xline (infinite construction line): never export
 *   - entity on invisible layer: skip
 *   - entity on locked 'Achsen' layer: skip (construction axes)
 *   - entity on a `style: 'guide'` layer (Hilfslinie): skip — these are
 *     construction aids (Hilfskreis, reference xlines, scratch geometry)
 *     that the user expects to see on-canvas but not on the printed sheet.
 *     Matches the xline rule: xlines live on guide layers by convention, and
 *     a Hilfskreis is the circular counterpart, so treat them the same.
 */
export function isExportable(e: Entity, layers: Layer[]): boolean {
  if (e.type === 'xline') return false;
  const L = layers[e.layer];
  if (!L) return false;
  if (!L.visible) return false;
  // Origin axes live on layer 0 ("Achsen") which is locked by default — they
  // are construction helpers, not drawn content.
  if (L.name === 'Achsen' && L.locked) return false;
  // Any construction-style layer (Hilfslinie by convention) is non-printable.
  // `style` is `LineStyle | undefined`; a guide-preset is the string 'guide',
  // a custom dash pattern is an object so we only match the string form.
  if (L.style === 'guide') return false;
  return true;
}

/** World-space corner points of an entity, used to compute the bbox. */
function entityCorners(e: Entity): Pt[] {
  if (e.type === 'line')     return [{ x: e.x1, y: e.y1 }, { x: e.x2, y: e.y2 }];
  if (e.type === 'rect')     return [{ x: e.x1, y: e.y1 }, { x: e.x2, y: e.y2 }];
  if (e.type === 'circle')   return [{ x: e.cx - e.r, y: e.cy - e.r }, { x: e.cx + e.r, y: e.cy + e.r }];
  if (e.type === 'arc') {
    // Conservative: use the full bounding circle rather than computing the
    // sweep arc's true extents. Keeps the exporter simple.
    return [{ x: e.cx - e.r, y: e.cy - e.r }, { x: e.cx + e.r, y: e.cy + e.r }];
  }
  if (e.type === 'ellipse') {
    const m = Math.max(e.rx, e.ry);
    return [{ x: e.cx - m, y: e.cy - m }, { x: e.cx + m, y: e.cy + m }];
  }
  if (e.type === 'spline')   return e.pts;
  if (e.type === 'polyline') return e.pts;
  if (e.type === 'text') {
    const lt = layoutText(e);
    return [{ x: lt.minX, y: lt.minY }, { x: lt.maxX, y: lt.maxY }];
  }
  if (e.type === 'dim') {
    const pts: Pt[] = [e.p1, e.p2, e.offset];
    if (e.vertex) pts.push(e.vertex);
    if (e.ray1)   pts.push(e.ray1);
    if (e.ray2)   pts.push(e.ray2);
    return pts;
  }
  if (e.type === 'hatch') return e.pts;
  return [];
}

/**
 * Compute the world-mm bbox of everything that will actually be exported.
 * Returns null if the drawing is empty (nothing exportable).
 */
export function exportBbox(entities: Entity[], layers: Layer[]): Bbox | null {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const e of entities) {
    if (!isExportable(e, layers)) continue;
    for (const p of entityCorners(e)) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
  }
  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
