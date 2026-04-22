/**
 * Corner grips for Rahmentext (framed text) entities.
 *
 * When a Rahmentext is selected, four small squares are drawn at the corners
 * of its frame. The user can drag any corner to:
 *   - horizontally adjust the frame width (and, for left-side grips, the
 *     anchor x) — the text re-wraps on the fly.
 *   - vertically translate the entire frame (since the bottom edge is
 *     content-driven, a vertical drag effectively shifts the anchor y).
 *
 * Grips are screen-space hit-tested (fixed pixel size regardless of zoom).
 */

import type { TextEntity } from './types';
import { layoutText } from './textlayout';
import { worldToScreen } from './math';

/** Half-size of a grip square in CSS pixels. Click tolerance uses the same. */
export const GRIP_HALF_PX = 5;

/** Corner indices. 0=TL, 1=TR, 2=BR, 3=BL (clockwise from top-left). */
export type GripIdx = 0 | 1 | 2 | 3;

export type FrameGrip = {
  /** World-space position of the grip. */
  x: number;
  y: number;
  idx: GripIdx;
};

/** Compute the 4 frame corners for a Rahmentext entity. Returns an empty
 *  array for Grafiktext (`boxWidth === undefined`). */
export function framedTextGrips(e: TextEntity): FrameGrip[] {
  if (e.boxWidth === undefined) return [];
  const L = layoutText(e);
  return [
    { x: L.minX, y: L.maxY, idx: 0 }, // TL
    { x: L.maxX, y: L.maxY, idx: 1 }, // TR
    { x: L.maxX, y: L.minY, idx: 2 }, // BR
    { x: L.minX, y: L.minY, idx: 3 }, // BL
  ];
}

/** Screen-space hit-test: returns the grip under the screen point, if any.
 *  `screenPt` is in canvas-local CSS px. */
export function hitFrameGrip(
  screenPt: { x: number; y: number },
  e: TextEntity,
): FrameGrip | null {
  for (const g of framedTextGrips(e)) {
    const s = worldToScreen({ x: g.x, y: g.y });
    if (Math.abs(s.x - screenPt.x) <= GRIP_HALF_PX &&
        Math.abs(s.y - screenPt.y) <= GRIP_HALF_PX) {
      return g;
    }
  }
  return null;
}

/** Which horizontal edge this grip controls. */
export function gripAffectsLeft(idx: GripIdx): boolean {
  return idx === 0 || idx === 3;
}
export function gripAffectsTop(idx: GripIdx): boolean {
  return idx === 0 || idx === 1;
}
