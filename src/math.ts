import type { Pt } from './types';
import { state } from './state';

export const dist = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y);
export const dot = (a: Pt, b: Pt): number => a.x * b.x + a.y * b.y;
export const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y });
export const add = (a: Pt, b: Pt): Pt => ({ x: a.x + b.x, y: a.y + b.y });
export const scale = (v: Pt, s: number): Pt => ({ x: v.x * s, y: v.y * s });
export const len = (v: Pt): number => Math.hypot(v.x, v.y);
export const perp = (v: Pt): Pt => ({ x: -v.y, y: v.x });

export function norm(v: Pt): Pt {
  const L = len(v);
  return L < 1e-9 ? { x: 0, y: 0 } : { x: v.x / L, y: v.y / L };
}

export function worldToScreen(p: Pt): Pt {
  const v = state.view;
  return { x: p.x * v.scale + v.x, y: -p.y * v.scale + v.y };
}

export function screenToWorld(p: Pt): Pt {
  const v = state.view;
  return { x: (p.x - v.x) / v.scale, y: -(p.y - v.y) / v.scale };
}

export function css(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/**
 * Given a cursor direction from `base`, returns a unit direction that equals
 * the closest cardinal axis rotated by `angleDeg` toward the cursor side.
 * Used by the line/polyline angle-lock ("tippe 45 → Linie um 45° zur nächsten Achse").
 */
export function directionAtAngle(basePt: Pt, cursor: Pt, angleDeg: number): Pt {
  const v = sub(cursor, basePt);
  if (len(v) < 1e-9) {
    const rad = (angleDeg * Math.PI) / 180;
    return { x: Math.cos(rad), y: Math.sin(rad) };
  }
  const cards: Pt[] = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];
  const n = norm(v);
  let baseDir = cards[0];
  let bestDot = -Infinity;
  for (const c of cards) {
    const d = dot(n, c);
    if (d > bestDot) { bestDot = d; baseDir = c; }
  }
  let perpDir: Pt;
  if (Math.abs(baseDir.x) > 0.5) perpDir = { x: 0, y: v.y >= 0 ? 1 : -1 };
  else perpDir = { x: v.x >= 0 ? 1 : -1, y: 0 };
  const rad = (angleDeg * Math.PI) / 180;
  return {
    x: baseDir.x * Math.cos(rad) + perpDir.x * Math.sin(rad),
    y: baseDir.y * Math.cos(rad) + perpDir.y * Math.sin(rad),
  };
}

/**
 * Snap the direction from `ref` to `pt` to the nearest multiple of `stepDeg`
 * (default 15°), preserving distance. Returns `pt` if it coincides with `ref`.
 */
export function orthoSnap(ref: Pt, pt: Pt, stepDeg = 15): Pt {
  const dx = pt.x - ref.x, dy = pt.y - ref.y;
  const L = Math.hypot(dx, dy);
  if (L < 1e-9) return pt;
  const step = (stepDeg * Math.PI) / 180;
  const ang = Math.round(Math.atan2(dy, dx) / step) * step;
  return { x: ref.x + Math.cos(ang) * L, y: ref.y + Math.sin(ang) * L };
}

export function perpOffset(base: Pt, dir: Pt, point: Pt): { dist: number; sign: 1 | -1 } {
  const ap = sub(point, base);
  const cross = dir.x * ap.y - dir.y * ap.x;
  return { dist: cross, sign: cross >= 0 ? 1 : -1 };
}
