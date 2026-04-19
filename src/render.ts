import type {
  ArcEntity, CircleEntity, DimEntity, DimStyle, EllipseEntity, Entity, EntityShape,
  PolylineEntity, Preview, RectEntity, SnapPoint, SplineEntity, TextEntity, XLineEntity,
} from './types';
import { state, runtime } from './state';
import { css, screenToWorld, worldToScreen } from './math';
import { dom, ctx } from './dom';

const { cv } = dom;

export function resize(): void {
  const r = cv.parentElement!.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  cv.width  = Math.floor(r.width * dpr);
  cv.height = Math.floor(r.height * dpr);
  cv.style.width  = r.width + 'px';
  cv.style.height = r.height + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (state.view.x === 0 && state.view.y === 0) {
    state.view.x = r.width / 2;
    state.view.y = r.height / 2;
  }
  render();
}

let rafPending = false;

/**
 * Coalesce multiple render requests into a single frame. Use this from hot
 * paths like `mousemove` — calling it 60+ times/sec only renders once/frame.
 */
export function requestRender(): void {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    render();
  });
}

export function render(): void {
  const w = cv.clientWidth, h = cv.clientHeight;
  ctx.fillStyle = css('--bg');
  ctx.fillRect(0, 0, w, h);
  drawGrid(w, h);
  for (const e of state.entities) drawEntity(e, false);
  if (runtime.toolCtx?.preview) drawPreview(runtime.toolCtx.preview);
  for (const id of state.selection) {
    const e = state.entities.find(x => x.id === id);
    if (e) drawEntity(e, true);
  }
  drawCrosshair(w, h);
  if (runtime.lastSnap) drawSnapMarker(runtime.lastSnap);
  if (runtime.dragSelect?.active) drawDragBox();
}

const GUIDE_TOOLS  = new Set(['xline', 'dim', 'ref_circle', 'angle']);
const MODIFY_TOOLS = new Set(['move', 'copy', 'rotate', 'mirror', 'stretch',
                               'fillet', 'chamfer', 'extend', 'trim', 'offset', 'scale']);
/**
 * Crosshair (X/Y cursor guide lines) is ONLY drawn for drawing/guide tools that
 * actually need point-placement feedback. Select/modify tools keep the canvas
 * clean — the marching lines are visual noise when you're just picking an
 * entity. Tool ids here must stay in sync with ToolId in types.ts.
 */
const CROSSHAIR_TOOLS = new Set([
  'line', 'polyline', 'polygon', 'rect', 'circle', 'circle3', 'arc3',
  'ellipse', 'spline', 'point',
  // guide/measurement tools that need precision cursor:
  'xline', 'dim', 'ref_circle', 'angle', 'axis',
  // text placement:
  'text',
]);

function crosshairColor(): string {
  const t = state.tool;
  if (GUIDE_TOOLS.has(t))  return css('--guides');
  if (MODIFY_TOOLS.has(t)) return css('--modify');
  return css('--draw');
}

function drawCrosshair(w: number, h: number): void {
  if (!CROSSHAIR_TOOLS.has(state.tool)) return;
  if (!state.mouseScreen.x && !state.mouseScreen.y) return; // not yet hovered

  // Snap-lock position: if a snap point is active, the crosshair follows it.
  const sp: { x: number; y: number } = runtime.lastSnap
    ? worldToScreen(runtime.lastSnap)
    : state.mouseScreen;

  const color = crosshairColor();

  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  // Very subtle — the lines should whisper, not shout. AutoCAD/Artios feel:
  // present but nearly transparent until the cursor stops on a snap point.
  ctx.globalAlpha = runtime.lastSnap ? 0.22 : 0.14;

  // Full-width horizontal line
  ctx.beginPath();
  ctx.moveTo(0,    sp.y + 0.5);
  ctx.lineTo(w,    sp.y + 0.5);
  ctx.stroke();

  // Full-height vertical line
  ctx.beginPath();
  ctx.moveTo(sp.x + 0.5, 0);
  ctx.lineTo(sp.x + 0.5, h);
  ctx.stroke();

  // Coordinate label — only when actually placing a point. Keeps the view
  // uncluttered; the bottom-left readout already shows live X/Y.
  const world = runtime.lastSnap ?? state.mouseWorld;
  const label = `${world.x.toFixed(2)},  ${world.y.toFixed(2)}`;
  ctx.globalAlpha = 0.6;
  ctx.font = '10px "Space Mono", monospace';
  ctx.fillStyle = color;
  const PAD = 10;
  const measuredW = ctx.measureText(label).width;
  const lx = sp.x + PAD + measuredW < w ? sp.x + PAD : sp.x - PAD - measuredW;
  const ly = sp.y - PAD > 14 ? sp.y - PAD : sp.y + PAD + 10;
  ctx.fillText(label, lx, ly);

  ctx.restore();
}

function drawDragBox(): void {
  const ds = runtime.dragSelect;
  if (!ds) return;
  const a = worldToScreen(ds.worldStart);
  const b = state.mouseScreen;
  const crossing = ds.worldStart.x > screenToWorld(b).x;
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  const w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
  ctx.save();
  ctx.strokeStyle = css('--preview');
  ctx.fillStyle = css('--preview') + '20';
  ctx.lineWidth = 1;
  ctx.setLineDash(crossing ? [4, 3] : []);
  ctx.fillRect(x, y, w, h);
  ctx.strokeRect(x + 0.5, y + 0.5, w, h);
  ctx.restore();
}

function drawGrid(w: number, h: number): void {
  // Grid display is INDEPENDENT of grid-snap. `showGrid` controls whether the
  // grid is painted; `snapSettings.grid` only controls whether the cursor
  // snaps to intersections. Either can be on/off without affecting the other.
  if (!runtime.snapSettings.showGrid) return;
  const g = runtime.snapSettings.gridSize;
  const s = state.view.scale;
  if (g * s < 6) return;
  const tl = screenToWorld({ x: 0, y: 0 });
  const br = screenToWorld({ x: w, y: h });
  ctx.strokeStyle = css('--grid');
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = Math.floor(tl.x / g) * g; x <= Math.ceil(br.x / g) * g; x += g) {
    const sp = worldToScreen({ x, y: 0 });
    ctx.moveTo(sp.x + 0.5, 0);
    ctx.lineTo(sp.x + 0.5, h);
  }
  for (let y = Math.floor(br.y / g) * g; y <= Math.ceil(tl.y / g) * g; y += g) {
    const sp = worldToScreen({ x: 0, y });
    ctx.moveTo(0, sp.y + 0.5);
    ctx.lineTo(w, sp.y + 0.5);
  }
  ctx.stroke();
}


function drawEntity(e: Entity, selected: boolean): void {
  const L = state.layers[e.layer];
  if (!L || !L.visible) return;
  const hovered = !selected && e.id === runtime.hoveredId;
  const color = selected ? css('--sel') : L.color;
  if (e.type === 'text') {
    ctx.fillStyle = color;
    drawShape(e);
    return;
  }
  if (e.type === 'dim') {
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = selected ? 1.8 : hovered ? 1.6 : 1.1;
    ctx.setLineDash([]);
    drawDim(e);
    if (hovered) {
      ctx.strokeStyle = ctx.fillStyle = 'rgba(255,255,255,0.18)';
      drawDim(e);
    }
    return;
  }
  const dash = L.style === 'dash' ? [6, 4] : [];
  ctx.strokeStyle = color;
  ctx.lineWidth = selected ? 2 : hovered ? 2 : 1.3;
  ctx.setLineDash(dash);
  drawShape(e);
  if (hovered) {
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    drawShape(e);
  }
  ctx.setLineDash([]);
}

function drawShape(e: Entity | EntityShape): void {
  if (e.type === 'line')     drawLineSeg(e.x1, e.y1, e.x2, e.y2);
  else if (e.type === 'xline')    drawXLine(e);
  else if (e.type === 'rect')     drawRect(e);
  else if (e.type === 'circle')   drawCircle(e);
  else if (e.type === 'arc')      drawArc(e);
  else if (e.type === 'ellipse')  drawEllipse(e);
  else if (e.type === 'spline')   drawSpline(e);
  else if (e.type === 'polyline') drawPolyline(e);
  else if (e.type === 'text')     drawText(e);
  else if (e.type === 'dim')      drawDim(e);
}

function drawDim(e: DimEntity | Extract<EntityShape, { type: 'dim' }>): void {
  const dx = e.p2.x - e.p1.x, dy = e.p2.y - e.p1.y;
  const L = Math.hypot(dx, dy);
  if (L < 1e-9) return;
  const nx = -dy / L, ny = dx / L;
  const sd = (e.offset.x - e.p1.x) * nx + (e.offset.y - e.p1.y) * ny;
  const a = { x: e.p1.x + nx * sd, y: e.p1.y + ny * sd };
  const b = { x: e.p2.x + nx * sd, y: e.p2.y + ny * sd };

  const aS = worldToScreen(a), bS = worldToScreen(b);
  const p1S = worldToScreen(e.p1), p2S = worldToScreen(e.p2);

  const dimLen = Math.hypot(bS.x - aS.x, bS.y - aS.y);
  if (dimLen < 1e-6) return;
  // Unit vector ALONG the dim line (a→b) in screen space. Each end-cap is drawn
  // with ux pointing into the dim, so at endpoint `a` we flip ux to get
  // "into the line" instead of "out of the line".
  const ux = (bS.x - aS.x) / dimLen, uy = (bS.y - aS.y) / dimLen;

  // Dim line + extension lines (same for all styles).
  ctx.beginPath();
  ctx.moveTo(aS.x, aS.y); ctx.lineTo(bS.x, bS.y);
  const extGap = 4, extOver = 4;
  const drawExt = (from: { x: number; y: number }, to: { x: number; y: number }) => {
    const ex = to.x - from.x, ey = to.y - from.y;
    const L0 = Math.hypot(ex, ey);
    if (L0 < extGap) return;
    const kGap = extGap / L0, kEnd = (L0 + extOver) / L0;
    ctx.moveTo(from.x + ex * kGap, from.y + ey * kGap);
    ctx.lineTo(from.x + ex * kEnd, from.y + ey * kEnd);
  };
  drawExt(p1S, aS);
  drawExt(p2S, bS);
  ctx.stroke();

  // End-caps. `style` defaults to the global runtime preset if the entity
  // itself has none (new entities track the global; existing ones can store
  // their own for per-dim overrides).
  const style: DimStyle = e.style ?? runtime.dimStyle ?? 'arrow';
  drawDimCap(aS.x, aS.y,  ux,  uy, style);
  drawDimCap(bS.x, bS.y, -ux, -uy, style);

  // Label.
  const mid = { x: (aS.x + bS.x) / 2, y: (aS.y + bS.y) / 2 };
  const label = L.toFixed(2);
  const pxH = Math.max(10, e.textHeight * state.view.scale);
  ctx.save();
  ctx.font = `${pxH.toFixed(1)}px "Inter", system-ui, sans-serif`;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'center';
  let ang = Math.atan2(bS.y - aS.y, bS.x - aS.x);
  if (ang > Math.PI / 2)  ang -= Math.PI;
  if (ang < -Math.PI / 2) ang += Math.PI;
  ctx.translate(mid.x, mid.y);
  ctx.rotate(ang);
  ctx.fillText(label, 0, -3);
  ctx.restore();
}

/**
 * Draw a single dim end-cap at screen point (x,y).
 * (ux, uy) is the unit vector pointing ALONG the dim line INTO the line
 * (so at endpoint `a` it points toward `b`, at endpoint `b` it points toward `a`).
 */
function drawDimCap(x: number, y: number, ux: number, uy: number, style: DimStyle): void {
  // Perpendicular to the line (left-hand normal).
  const px = -uy, py = ux;
  if (style === 'arrow') {
    // Solid filled triangle: tip at (x,y), base 8px back along dim.
    const L0 = 10, H = 3.5;
    const bx = x + ux * L0, by = y + uy * L0;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(bx + px * H, by + py * H);
    ctx.lineTo(bx - px * H, by - py * H);
    ctx.closePath();
    ctx.fill();
  } else if (style === 'open') {
    // Two strokes forming an open V.
    const L0 = 10, H = 3.5;
    const bx = x + ux * L0, by = y + uy * L0;
    ctx.beginPath();
    ctx.moveTo(bx + px * H, by + py * H);
    ctx.lineTo(x, y);
    ctx.lineTo(bx - px * H, by - py * H);
    ctx.stroke();
  } else if (style === 'tick') {
    // AutoCAD-style short 45° stroke crossing the dim line (mechanical).
    const t = 5;
    // 45° rotation of ux by combining ux with the perpendicular component.
    const txv = (ux - uy), tyv = (uy + ux);   // unit not required; cap by t
    const k = t / Math.hypot(txv, tyv);
    const dx0 = txv * k, dy0 = tyv * k;
    ctx.beginPath();
    ctx.moveTo(x - dx0, y - dy0);
    ctx.lineTo(x + dx0, y + dy0);
    ctx.stroke();
  } else {
    // 'arch' — architect tick: short 45° stroke on ONE side of the line only,
    // with a small dot at the endpoint (visually distinct from mech tick).
    const t = 6;
    const txv = (ux - uy), tyv = (uy + ux);
    const k = t / Math.hypot(txv, tyv);
    const dx0 = txv * k, dy0 = tyv * k;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + dx0, y + dy0);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, 1.6, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawText(e: TextEntity | Extract<EntityShape, { type: 'text' }>): void {
  const pxH = e.height * state.view.scale;
  if (pxH < 3) return;
  const p = worldToScreen({ x: e.x, y: e.y });
  ctx.save();
  ctx.font = `${pxH.toFixed(1)}px "Inter", system-ui, sans-serif`;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  const rot = e.rotation ?? 0;
  if (rot) {
    ctx.translate(p.x, p.y);
    ctx.rotate(-rot);
    ctx.fillText(e.text, 0, 0);
  } else {
    ctx.fillText(e.text, p.x, p.y);
  }
  ctx.restore();
}

function drawLineSeg(x1: number, y1: number, x2: number, y2: number): void {
  const a = worldToScreen({ x: x1, y: y1 });
  const b = worldToScreen({ x: x2, y: y2 });
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
}

function drawXLine(e: XLineEntity | Extract<EntityShape, { type: 'xline' }>): void {
  const T = 100000;
  drawLineSeg(e.x1 - e.dx * T, e.y1 - e.dy * T, e.x1 + e.dx * T, e.y1 + e.dy * T);
}

function drawRect(e: RectEntity | Extract<EntityShape, { type: 'rect' }>): void {
  const a = worldToScreen({ x: e.x1, y: e.y1 });
  const b = worldToScreen({ x: e.x2, y: e.y2 });
  ctx.beginPath();
  ctx.rect(a.x, a.y, b.x - a.x, b.y - a.y);
  ctx.stroke();
}

function drawCircle(e: CircleEntity | Extract<EntityShape, { type: 'circle' }>): void {
  const c = worldToScreen({ x: e.cx, y: e.cy });
  ctx.beginPath();
  ctx.arc(c.x, c.y, e.r * state.view.scale, 0, Math.PI * 2);
  ctx.stroke();
}

function drawArc(e: ArcEntity | Extract<EntityShape, { type: 'arc' }>): void {
  // World y grows up, screen y grows down, so CCW in world = CW on screen.
  // Negate angles and ask canvas for the CW direction to match.
  const c = worldToScreen({ x: e.cx, y: e.cy });
  ctx.beginPath();
  ctx.arc(c.x, c.y, e.r * state.view.scale, -e.a1, -e.a2, true);
  ctx.stroke();
}

function drawEllipse(e: EllipseEntity | Extract<EntityShape, { type: 'ellipse' }>): void {
  const c = worldToScreen({ x: e.cx, y: e.cy });
  const s = state.view.scale;
  // World CCW rotation → screen CW. Canvas ellipse rotation is in screen space,
  // where positive = CW. Our world rot is CCW, so negate for drawing.
  ctx.beginPath();
  ctx.ellipse(c.x, c.y, e.rx * s, e.ry * s, -e.rot, 0, Math.PI * 2);
  ctx.stroke();
}

/**
 * Convert an interpolating polyline of knots into cubic-Bezier segments using
 * Catmull-Rom tangents (tension 0.5 = standard CR). Returns control points
 * ready for bezierCurveTo calls, one quad per segment between knots[i] and knots[i+1].
 */
function catmullRomBeziers(pts: { x: number; y: number }[], closed: boolean):
  { c1: { x: number; y: number }; c2: { x: number; y: number }; p: { x: number; y: number } }[] {
  const out: { c1: { x: number; y: number }; c2: { x: number; y: number }; p: { x: number; y: number } }[] = [];
  const n = pts.length;
  if (n < 2) return out;
  const get = (i: number) => {
    if (closed) return pts[((i % n) + n) % n];
    return pts[Math.max(0, Math.min(n - 1, i))];
  };
  const segCount = closed ? n : n - 1;
  for (let i = 0; i < segCount; i++) {
    const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
    const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
    const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
    out.push({ c1, c2, p: p2 });
  }
  return out;
}

function drawSpline(e: SplineEntity | Extract<EntityShape, { type: 'spline' }>): void {
  if (!e.pts || e.pts.length < 2) return;
  const sPts = e.pts.map(worldToScreen);
  const first = sPts[0];
  ctx.beginPath();
  ctx.moveTo(first.x, first.y);
  const segs = catmullRomBeziers(sPts, !!e.closed);
  for (const s of segs) ctx.bezierCurveTo(s.c1.x, s.c1.y, s.c2.x, s.c2.y, s.p.x, s.p.y);
  ctx.stroke();
}

function drawPolyline(e: PolylineEntity | Extract<EntityShape, { type: 'polyline' }>): void {
  if (!e.pts || e.pts.length < 2) return;
  ctx.beginPath();
  const first = worldToScreen(e.pts[0]);
  ctx.moveTo(first.x, first.y);
  for (let i = 1; i < e.pts.length; i++) {
    const p = worldToScreen(e.pts[i]);
    ctx.lineTo(p.x, p.y);
  }
  if (e.closed) ctx.closePath();
  ctx.stroke();
}

function drawPreview(p: Preview): void {
  ctx.save();
  ctx.strokeStyle = css('--preview');
  ctx.lineWidth = 1.2;
  ctx.setLineDash([4, 4]);
  if (p.type === 'group') {
    for (const ent of p.entities) drawShape(ent);
  } else {
    drawShape(p);
  }
  ctx.restore();
}

/** German abbreviations shown next to each snap marker type. */
const SNAP_LABELS: Record<SnapPoint['type'], string> = {
  end: 'END', mid: 'MITTE', int: 'SCHN', center: 'ZENTR',
  axis: 'ACHS', grid: 'RASTER', tangent: 'TANG', perp: 'LOT',
};

function drawSnapMarker(s: SnapPoint): void {
  const sp = worldToScreen(s);
  ctx.save();
  const snap = css('--snap');
  // Dark halo + bright marker — works across light/dark entities behind it.
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  drawSnapShape(sp, s.type);
  ctx.stroke();
  ctx.strokeStyle = snap;
  ctx.lineWidth = 2;
  drawSnapShape(sp, s.type);
  ctx.stroke();

  // Type label — uppercase Space Mono, 10px, 12px offset to the upper-right
  // of the marker. Paint-order stroke (dark halo under bright fill) keeps it
  // legible over any canvas background.
  const label = SNAP_LABELS[s.type];
  if (label) {
    const lx = sp.x + 12;
    const ly = sp.y - 10;
    ctx.font = '10px "Space Mono", monospace';
    ctx.textBaseline = 'alphabetic';
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.lineWidth = 3;
    ctx.strokeText(label, lx, ly);
    ctx.fillStyle = snap;
    ctx.fillText(label, lx, ly);
  }

  ctx.restore();
}

function drawSnapShape(sp: { x: number; y: number }, type: SnapPoint['type']): void {
  ctx.beginPath();
  if (type === 'end') {
    ctx.rect(sp.x - 6, sp.y - 6, 12, 12);
  } else if (type === 'mid') {
    ctx.moveTo(sp.x - 7, sp.y + 6);
    ctx.lineTo(sp.x,     sp.y - 7);
    ctx.lineTo(sp.x + 7, sp.y + 6);
    ctx.closePath();
  } else if (type === 'int') {
    ctx.moveTo(sp.x - 7, sp.y - 7);
    ctx.lineTo(sp.x + 7, sp.y + 7);
    ctx.moveTo(sp.x + 7, sp.y - 7);
    ctx.lineTo(sp.x - 7, sp.y + 7);
  } else if (type === 'center') {
    ctx.arc(sp.x, sp.y, 7, 0, Math.PI * 2);
  } else if (type === 'axis') {
    ctx.moveTo(sp.x - 9, sp.y);
    ctx.lineTo(sp.x + 9, sp.y);
    ctx.moveTo(sp.x,     sp.y - 9);
    ctx.lineTo(sp.x,     sp.y + 9);
  } else if (type === 'grid') {
    ctx.rect(sp.x - 4, sp.y - 4, 8, 8);
  } else if (type === 'tangent') {
    // Circle with horizontal tangent line through it.
    ctx.arc(sp.x, sp.y, 6, 0, Math.PI * 2);
    ctx.moveTo(sp.x - 9, sp.y - 6);
    ctx.lineTo(sp.x + 9, sp.y - 6);
  } else if (type === 'perp') {
    // Right-angle mark ⊥.
    ctx.moveTo(sp.x - 7, sp.y + 7);
    ctx.lineTo(sp.x + 7, sp.y + 7);
    ctx.moveTo(sp.x,     sp.y + 7);
    ctx.lineTo(sp.x,     sp.y - 7);
    ctx.moveTo(sp.x - 4, sp.y + 3);
    ctx.lineTo(sp.x - 4, sp.y + 7);
    ctx.lineTo(sp.x,     sp.y + 7);
  }
}
