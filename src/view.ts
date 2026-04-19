import type { Entity, Pt } from './types';
import { state } from './state';
import { render } from './render';
import { dom } from './dom';
import { updateZoomStatus } from './ui';

function entityBounds(e: Entity): Pt[] {
  if (e.type === 'line')     return [{ x: e.x1, y: e.y1 }, { x: e.x2, y: e.y2 }];
  if (e.type === 'xline')    return [{ x: e.x1, y: e.y1 }];
  if (e.type === 'rect')     return [{ x: e.x1, y: e.y1 }, { x: e.x2, y: e.y2 }];
  if (e.type === 'circle')   return [{ x: e.cx - e.r, y: e.cy - e.r }, { x: e.cx + e.r, y: e.cy + e.r }];
  if (e.type === 'arc')      return [{ x: e.cx - e.r, y: e.cy - e.r }, { x: e.cx + e.r, y: e.cy + e.r }];
  if (e.type === 'ellipse') {
    const m = Math.max(e.rx, e.ry);
    return [{ x: e.cx - m, y: e.cy - m }, { x: e.cx + m, y: e.cy + m }];
  }
  if (e.type === 'spline')   return e.pts;
  if (e.type === 'polyline') return e.pts;
  if (e.type === 'text')     return [{ x: e.x, y: e.y }, { x: e.x + e.height * e.text.length * 0.6, y: e.y + e.height }];
  if (e.type === 'dim')      return [e.p1, e.p2, e.offset];
  return [];
}

export function drawingBounds():
  | { minX: number; maxX: number; minY: number; maxY: number }
  | null {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const e of state.entities) {
    for (const p of entityBounds(e)) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
  }
  return Number.isFinite(minX) ? { minX, maxX, minY, maxY } : null;
}

export function zoomFit(): void {
  const b = drawingBounds();
  const r = dom.cv.parentElement!.getBoundingClientRect();
  if (!b) {
    state.view.x = r.width / 2;
    state.view.y = r.height / 2;
    state.view.scale = 4;
    updateZoomStatus();
    render();
    return;
  }
  const pad = 40;
  const sx = (r.width - pad * 2) / Math.max(1, b.maxX - b.minX);
  const sy = (r.height - pad * 2) / Math.max(1, b.maxY - b.minY);
  state.view.scale = Math.min(sx, sy);
  state.view.x = pad - b.minX * state.view.scale;
  state.view.y = pad + b.maxY * state.view.scale;
  updateZoomStatus();
  render();
}
