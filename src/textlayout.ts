/**
 * Shared layout for text entities. Rendering, hit-testing and bbox all consume
 * the same output so they stay consistent — hit a line and pick it up cleanly,
 * bbox matches what the renderer draws, zoom-to-fit accounts for multi-line
 * blocks, etc.
 *
 * Two modes, keyed on the presence of `boxWidth` on the entity:
 *
 *   Grafiktext  (boxWidth undefined)
 *     - No word wrap; only explicit `\n` breaks the text.
 *     - Anchor `(x, y)` is the baseline of the LAST (bottom) line.
 *       Additional lines stack upward in world-space (+Y).
 *     - This preserves the original single-line convention for unchanged
 *       entities.
 *
 *   Rahmentext  (boxWidth set)
 *     - Word-wrapped to `boxWidth` world-units.
 *     - Anchor `(x, y)` is the TOP-LEFT of the frame. Lines flow downward
 *       from the top edge.
 *
 * Character width is approximated as `0.55 × height` (typical sans-serif ratio
 * — close enough for wrapping and picking without requiring a canvas context
 * at layout time).
 */

import type { TextEntity } from './types';

const CHAR_W_RATIO = 0.55;
const LINE_SPACING = 1.2;

export type TextLayout = {
  /** Wrapped / split lines in reading order (top to bottom). */
  lines: string[];
  /** Baseline world Y per line, same indexing as `lines`. */
  baselineY: number[];
  /** World-distance between consecutive baselines. */
  lineHeight: number;
  /** Axis-aligned world bounds with rotation = 0 (callers rotate externally). */
  minX: number; minY: number; maxX: number; maxY: number;
  /** Effective block width — includes frame width for Rahmentext. */
  width: number;
};

type TextGeom = Pick<TextEntity, 'x' | 'y' | 'text' | 'height' | 'boxWidth'>;

/** Word-wrap `text` to `boxWidth` in world-units. Returns original `\n`-split
 *  lines when `boxWidth` is undefined. Never returns an empty array. */
export function wrapText(text: string, height: number, boxWidth?: number): string[] {
  const hardLines = text.split('\n');
  if (boxWidth === undefined || boxWidth <= 0) {
    return hardLines.length ? hardLines : [''];
  }
  const charW = height * CHAR_W_RATIO;
  const maxChars = Math.max(1, Math.floor(boxWidth / charW));
  const out: string[] = [];
  for (const line of hardLines) {
    if (line === '') { out.push(''); continue; }
    const words = line.split(' ');
    let cur = '';
    for (const w of words) {
      // Word on its own that exceeds the frame: hard-break it character by
      // character so it still lands inside the frame.
      if (w.length > maxChars) {
        if (cur) { out.push(cur); cur = ''; }
        let rest = w;
        while (rest.length > maxChars) {
          out.push(rest.slice(0, maxChars));
          rest = rest.slice(maxChars);
        }
        cur = rest;
        continue;
      }
      const test = cur ? cur + ' ' + w : w;
      if (cur && test.length > maxChars) { out.push(cur); cur = w; }
      else cur = test;
    }
    if (cur) out.push(cur);
  }
  return out.length ? out : [''];
}

/** Approx width of a single text line in world-units. */
export function lineWidth(text: string, height: number): number {
  return text.length * height * CHAR_W_RATIO;
}

export function layoutText(e: TextGeom): TextLayout {
  const lines = wrapText(e.text, e.height, e.boxWidth);
  const lineHeight = e.height * LINE_SPACING;
  const n = lines.length;
  const baselineY: number[] = new Array(n);
  let minY: number, maxY: number;

  if (e.boxWidth !== undefined) {
    // Rahmentext: anchor at TOP-LEFT in world coords. First baseline sits one
    // text-height below the top edge; successive lines drop by lineHeight.
    for (let i = 0; i < n; i++) baselineY[i] = e.y - e.height - i * lineHeight;
    maxY = e.y;
    minY = e.y - e.height - (n - 1) * lineHeight;
  } else {
    // Grafiktext: anchor at BOTTOM-LEFT baseline. Earlier lines sit above.
    for (let i = 0; i < n; i++) baselineY[i] = e.y + (n - 1 - i) * lineHeight;
    minY = e.y;
    maxY = e.y + e.height + (n - 1) * lineHeight;
  }

  let maxW = 0;
  for (const l of lines) {
    const w = lineWidth(l, e.height);
    if (w > maxW) maxW = w;
  }
  const width = e.boxWidth !== undefined ? Math.max(e.boxWidth, maxW) : Math.max(maxW, e.height * 0.3);
  return {
    lines, baselineY, lineHeight,
    minX: e.x, maxX: e.x + width,
    minY, maxY,
    width,
  };
}
