import type {
  ArcEntity, CircleEntity, DimEntity, DimStyle, EllipseEntity, Entity, EntityShape,
  HatchEntity, PolylineEntity, Preview, Pt, RectEntity, SnapPoint, SplineEntity,
  TextEntity, XLineEntity,
} from './types';
import { patternForLineStyle, resolveLineStyle } from './types';
import { state, runtime } from './state';
import { css, screenToWorld, worldToScreen } from './math';
import { dom, ctx } from './dom';
import { getDraftInfo } from './draftinfo';
import { layoutText } from './textlayout';
import { framedTextGrips, GRIP_HALF_PX } from './textgrips';
// Geometry grips (line endpoints / vertices / corners / …) used to render
// unconditionally and flatten parametric PointRefs on drag. They're now gated
// behind `runtime.parametricMode === false` — the free-draw mode explicitly
// opts out of parametric linking, so direct grip edits are safe there.
import { entityGrips } from './grips';
import { featureForEntity, linkedEntityIds } from './features';

const { cv } = dom;

/**
 * Reference pixels-per-mm at 100% zoom. The zoom-readout in the status bar is
 * computed as `state.view.scale * 25 %`, so 100% corresponds to scale = 4.
 * Dash patterns are authored in world-mm; multiplying them by this constant
 * (instead of the live `state.view.scale`) gives a zoom-invariant visual
 * density — dashes look identical at 100%, 500% and 1500% zoom.
 */
const DASH_REF_SCALE = 4;

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
  drawOriginAxes(w, h);
  // Two O(N) passes: unselected first, then selected on top. This replaces an
  // older O(N·M) variant that called `state.entities.find()` for every selected
  // id, which quadratically blew up with multi-selection on big drawings.
  const sel = state.selection;
  for (const e of state.entities) {
    if (!sel.has(e.id)) drawEntity(e, false);
  }
  if (runtime.toolCtx?.preview) drawPreview(runtime.toolCtx.preview);
  if (sel.size) {
    // Parametric-link highlight: any entity whose underlying feature depends
    // on (or is depended on by) the selection gets a dashed teal overlay, so
    // the user can see the whole cluster that will move together before they
    // drag/rotate/parameter-edit. Drawn before the selection outline so the
    // brighter --sel stroke on top stays dominant on the selected entity.
    const linked = linkedEntityIds(sel);
    if (linked.size) {
      for (const e of state.entities) {
        if (linked.has(e.id)) drawLinkedOverlay(e);
      }
    }
    for (const e of state.entities) {
      if (sel.has(e.id)) drawEntity(e, true);
    }
    // Framed-text corner grips — drawn last so they sit on top of the text
    // itself and can't be visually swallowed by long selected strings.
    for (const e of state.entities) {
      if (sel.has(e.id) && e.type === 'text' && e.boxWidth !== undefined) {
        drawFrameGrips(e);
      }
    }
    // Geometry grips (line endpoints, rect corners, polyline vertices, …) —
    // only in free-draw mode with exactly one selected entity, matching the
    // findGripHit gating in the mouse pipeline. In parametric mode these
    // would flatten PointRefs on drag, so we hide them entirely.
    if (!runtime.parametricMode
        && state.tool === 'select'
        && sel.size === 1) {
      const id = [...sel][0];
      const ent = state.entities.find(x => x.id === id);
      if (ent) drawGeometryGrips(ent);
    }
  }
  drawCrosshair(w, h);
  // Dashed alignment guides for the active polar/DYN snap. Drawn BEFORE the
  // snap marker so the bright glyph always sits on top.
  if (runtime.lastSnap && (runtime.lastSnap.type === 'polar' || runtime.lastSnap.type === 'track')) {
    drawActiveGuide(runtime.lastSnap);
  }
  if (runtime.lastSnap) drawSnapMarker(runtime.lastSnap);
  if (runtime.dragSelect?.active) drawDragBox();
  if (runtime.dragText?.active) drawTextFrameBox();
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

  // Label next to the crosshair. During drafting, show the tool-specific
  // readout (B/H for rect, R for circle, ∠+L for line/polyline, etc.) so the
  // label always mirrors the cmdbar input fields. Idle / no tool-specific
  // info — fall back to delta from the active tool anchor (last click), or
  // world X/Y when no anchor exists. The delta fallback keeps the spatial
  // information close to "what the user intends to do next" rather than
  // forcing them to subtract two world coordinates in their head.
  const world = runtime.lastSnap ?? state.mouseWorld;
  const info = getDraftInfo();
  let label: string;
  if (info) {
    label = info;
  } else {
    const tc = runtime.toolCtx;
    const anchor = tc?.p1 ?? tc?.click1 ?? tc?.basePt ?? null;
    if (anchor) {
      const dx = world.x - anchor.x;
      const dy = world.y - anchor.y;
      label = `Δ ${dx.toFixed(2)},  ${dy.toFixed(2)}`;
    } else {
      label = `${world.x.toFixed(2)},  ${world.y.toFixed(2)}`;
    }
  }
  ctx.globalAlpha = 0.6;
  ctx.font = '10px "Space Mono", monospace';
  ctx.fillStyle = color;
  const PAD = 10;
  const measuredW = ctx.measureText(label).width;
  const lx = sp.x + PAD + measuredW < w ? sp.x + PAD : sp.x - PAD - measuredW;
  // When a snap is active the snap-type tag (END, MITTE, ACHS, …) sits at
  // (+12, -10) from the crosshair. Pushing the draft-info label BELOW the
  // crosshair keeps both readable instead of rendering them on top of each
  // other. Idle, keep the classic upper-right placement.
  const ly = runtime.lastSnap
    ? sp.y + PAD + 10
    : sp.y - PAD > 14 ? sp.y - PAD : sp.y + PAD + 10;
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

/**
 * Dashed frame drawn while the user drags the text tool: previews the box that
 * will determine the text height. Includes a baseline marker at the bottom
 * edge so the user knows where the text baseline will sit.
 */
function drawTextFrameBox(): void {
  const dt = runtime.dragText;
  if (!dt) return;
  const a = worldToScreen(dt.worldStart);
  const b = state.mouseScreen;
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  const w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
  ctx.save();
  ctx.strokeStyle = css('--preview');
  ctx.fillStyle = css('--preview') + '14';
  ctx.lineWidth = 1;
  ctx.setLineDash([5, 3]);
  ctx.fillRect(x, y, w, h);
  ctx.strokeRect(x + 0.5, y + 0.5, w, h);
  // Baseline tick (solid) on the bottom edge — visual hint that text sits here.
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(x, y + h + 0.5);
  ctx.lineTo(x + w, y + h + 0.5);
  ctx.stroke();
  ctx.restore();
}

/**
 * Four corner grips drawn on a selected Rahmentext. Filled squares with a
 * high-contrast outline so they read clearly on any layer colour. Screen-
 * space size (GRIP_HALF_PX) so they stay a consistent click target at any
 * zoom level.
 */
function drawFrameGrips(e: TextEntity): void {
  const grips = framedTextGrips(e);
  if (!grips.length) return;
  ctx.save();
  ctx.fillStyle = css('--sel');
  ctx.strokeStyle = css('--bg');
  ctx.lineWidth = 1;
  const s = GRIP_HALF_PX;
  for (const g of grips) {
    const sp = worldToScreen({ x: g.x, y: g.y });
    const x = Math.round(sp.x - s) + 0.5;
    const y = Math.round(sp.y - s) + 0.5;
    ctx.fillRect(x, y, s * 2, s * 2);
    ctx.strokeRect(x, y, s * 2, s * 2);
  }
  ctx.restore();
}

/**
 * Geometry grips for the single-selected entity (free-draw mode only).
 * Endpoint/vertex/corner/quadrant grips render as filled squares; the
 * "move" grip (line midpoint, rect centre, circle centre, arc centre) is
 * drawn hollow so users can tell at a glance which grip translates the
 * whole entity vs. stretches a side. Sub-entities of modifiers (mirror /
 * array / crossMirror / rotate output) are skipped because they're not
 * directly editable — mutating them would desync the source.
 */
function drawGeometryGrips(e: Entity): void {
  // xline / dim / hatch have either no grips or very specialised ones that
  // don't fit the generic drag-a-corner model — skip rendering for those.
  if (e.type === 'xline' || e.type === 'hatch') return;
  // Modifier sub-entities (mirror/array/…): feature kind doesn't match entity
  // type. Dragging a grip on a computed copy would rebuild the source feature
  // as a free `line`, orphaning the modifier. Skip.
  const feat = featureForEntity(e.id);
  if (!feat || feat.kind !== e.type) return;
  const L = state.layers[e.layer];
  if (!L || !L.visible || L.locked) return;

  const grips = entityGrips(e);
  if (!grips.length) return;
  ctx.save();
  ctx.fillStyle = css('--sel');
  ctx.strokeStyle = css('--bg');
  ctx.lineWidth = 1;
  const s = GRIP_HALF_PX;
  for (const g of grips) {
    const sp = worldToScreen({ x: g.x, y: g.y });
    const x = Math.round(sp.x - s) + 0.5;
    const y = Math.round(sp.y - s) + 0.5;
    if (g.kind === 'move' || g.kind === 'arc-mid') {
      // Hollow square — visually distinct from edit-grips, signals "drag me
      // to translate the whole entity". Fill with bg so the stroke reads
      // even on top of the entity's own body.
      ctx.fillStyle = css('--bg');
      ctx.fillRect(x, y, s * 2, s * 2);
      ctx.fillStyle = css('--sel');
      ctx.strokeStyle = css('--sel');
      ctx.strokeRect(x, y, s * 2, s * 2);
      ctx.strokeStyle = css('--bg');
    } else {
      ctx.fillRect(x, y, s * 2, s * 2);
      ctx.strokeRect(x, y, s * 2, s * 2);
    }
  }
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


/**
 * WCAG relative luminance for a #rrggbb hex. Returns -1 if the string isn't a
 * plain 6-digit hex — callers should fall back in that case. Used by the
 * snap-marker halo to pick a dark or light glow against the theme background.
 */
function relLum(hex: string): number {
  const h = hex.trim().replace('#', '');
  if (h.length !== 6) return -1;
  const toLin = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  if (Number.isNaN(r + g + b)) return -1;
  return 0.2126 * toLin(r) + 0.7152 * toLin(g) + 0.0722 * toLin(b);
}

/**
 * In-app rendering uses layer colours verbatim — the user picks the colour,
 * the app shows exactly that colour. Earlier builds ran a background-contrast
 * check here that silently remapped low-contrast layers to the theme
 * foreground. That hid the user's choice and was confusing when the same
 * layer rendered differently depending on theme preset. Print legibility
 * (white-on-white paper) is still handled downstream in the PDF exporter.
 */

/**
 * Teal dashed overlay drawn on top of an entity's normal stroke to signal a
 * parametric link to the current selection. Skips dim/text/hatch because a
 * dashed outline on those would misread as a styling change; lines/curves
 * get a clean accent that reads as "this follows the selection".
 */
function drawLinkedOverlay(e: Entity): void {
  const L = state.layers[e.layer];
  if (!L || !L.visible) return;
  if (e.type === 'text' || e.type === 'dim' || e.type === 'hatch') return;
  ctx.save();
  ctx.strokeStyle = css('--guides');
  ctx.lineWidth = 1.8;
  ctx.setLineDash([5, 4]);
  ctx.globalAlpha = 0.85;
  drawShape(e);
  ctx.restore();
  ctx.setLineDash([]);
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
  if (e.type === 'hatch') {
    // Solid fills use the entity's own colour if set, otherwise the layer
    // colour. Stripe patterns always stroke with the layer colour.
    const solidColor = e.color ?? color;
    const selBoost = selected ? 1.6 : hovered ? 1.2 : 1.0;
    ctx.strokeStyle = selected ? css('--sel') : L.color;
    ctx.fillStyle = selected ? css('--sel') : solidColor;
    ctx.lineWidth = (e.mode === 'solid' ? 0 : 0.9) * selBoost;
    ctx.setLineDash([]);
    drawHatch(e, selected);
    if (hovered && e.mode !== 'solid') {
      ctx.strokeStyle = 'rgba(255,255,255,0.2)';
      drawHatch(e, selected);
    }
    return;
  }
  // Dash patterns are authored in world mm but rendered at a fixed
  // screen-pixel scale so the visual rhythm stays identical regardless of
  // zoom — zooming in on a dashed line used to blow the dashes up into
  // chunky blocks, zooming out shrank them into near-solid. The geometry
  // itself still scales with zoom; only the dash cadence is pinned.
  const patternMm = patternForLineStyle(resolveLineStyle(L.style));
  const dash = patternMm.length
    ? patternMm.map(v => Math.max(0.5, v * DASH_REF_SCALE))
    : [];
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
  else if (e.type === 'hatch')    drawHatch(e, false);
}

function drawDim(e: DimEntity | Extract<EntityShape, { type: 'dim' }>): void {
  if (e.dimKind === 'angular') { drawAngularDim(e); return; }
  if (e.dimKind === 'radius' || e.dimKind === 'diameter') { drawRadialDim(e); return; }
  // Linear dim: three sub-modes selected via `linearAxis`.
  //   - aligned (default): dim line parallel to p1→p2, label = √(dx²+dy²)
  //   - horizontal: dim line horizontal at offset.y, label = |dx|
  //   - vertical:   dim line vertical at offset.x,  label = |dy|
  // The two axis-locked variants project p1/p2 onto the chosen axis and
  // route extension lines perpendicular to that axis. Cleanly degenerates
  // when the user picked an offset that's collinear with p1→p2.
  const axis = e.linearAxis ?? 'aligned';
  let a: Pt;
  let b: Pt;
  let L: number;
  if (axis === 'horizontal') {
    a = { x: e.p1.x, y: e.offset.y };
    b = { x: e.p2.x, y: e.offset.y };
    L = Math.abs(e.p2.x - e.p1.x);
    if (L < 1e-9) return;
  } else if (axis === 'vertical') {
    a = { x: e.offset.x, y: e.p1.y };
    b = { x: e.offset.x, y: e.p2.y };
    L = Math.abs(e.p2.y - e.p1.y);
    if (L < 1e-9) return;
  } else {
    const dx = e.p2.x - e.p1.x, dy = e.p2.y - e.p1.y;
    L = Math.hypot(dx, dy);
    if (L < 1e-9) return;
    const nx = -dy / L, ny = dx / L;
    const sd = (e.offset.x - e.p1.x) * nx + (e.offset.y - e.p1.y) * ny;
    a = { x: e.p1.x + nx * sd, y: e.p1.y + ny * sd };
    b = { x: e.p2.x + nx * sd, y: e.p2.y + ny * sd };
  }

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

  // Label — parameter `t` slides along a→b in screen space. 0.12/0.88 keep the
  // text clear of the end-caps even for short dims while still visibly hugging
  // the chosen side. `center` (default) is the classic midpoint placement.
  const t = e.textAlign === 'start' ? 0.12 : e.textAlign === 'end' ? 0.88 : 0.5;
  const pos = { x: aS.x + (bS.x - aS.x) * t, y: aS.y + (bS.y - aS.y) * t };
  const label = L.toFixed(2);
  const pxH = Math.max(10, e.textHeight * state.view.scale);
  ctx.save();
  ctx.font = `${pxH.toFixed(1)}px "Inter", system-ui, sans-serif`;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'center';
  let ang = Math.atan2(bS.y - aS.y, bS.x - aS.x);
  if (ang > Math.PI / 2)  ang -= Math.PI;
  if (ang < -Math.PI / 2) ang += Math.PI;
  ctx.translate(pos.x, pos.y);
  ctx.rotate(ang);
  ctx.fillText(label, 0, -3);
  ctx.restore();
}

/**
 * Angular dim: arc between two rays from a shared vertex, end-caps at the
 * arc endpoints, degree label at the arc midpoint. The `offset` field stores
 * the user-picked arc anchor — its distance from `vertex` is the arc radius,
 * and it lies in the sector being measured (disambiguates which of the four
 * sectors around two crossing lines is the one with the dim).
 */
function drawAngularDim(e: DimEntity | Extract<EntityShape, { type: 'dim' }>): void {
  const V = e.vertex, r1 = e.ray1, r2 = e.ray2;
  if (!V || !r1 || !r2) return;
  const d1x = r1.x - V.x, d1y = r1.y - V.y;
  const d2x = r2.x - V.x, d2y = r2.y - V.y;
  if (Math.hypot(d1x, d1y) < 1e-9 || Math.hypot(d2x, d2y) < 1e-9) return;
  const dOx = e.offset.x - V.x, dOy = e.offset.y - V.y;
  const R = Math.hypot(dOx, dOy);
  if (R < 1e-9) return;

  const TAU = Math.PI * 2;
  const norm2pi = (x: number) => ((x % TAU) + TAU) % TAU;
  const a1 = Math.atan2(d1y, d1x);
  const a2 = Math.atan2(d2y, d2x);
  const aO = Math.atan2(dOy, dOx);

  // Pick the CCW sweep that contains the offset anchor — that's the sector
  // the user is measuring. The other three sectors around a pair of crossing
  // lines are ignored.
  const sweep12 = norm2pi(a2 - a1);
  const sweep1O = norm2pi(aO - a1);
  const [aS, aE] = (sweep1O <= sweep12 + 1e-9) ? [a1, a2] : [a2, a1];
  const sweep = norm2pi(aE - aS) || TAU;

  // Sample the arc — robust to the world/screen coordinate flip without
  // fighting ctx.arc's angle convention.
  const steps = Math.max(24, Math.ceil(sweep / 0.05));
  ctx.beginPath();
  for (let i = 0; i <= steps; i++) {
    const a = aS + sweep * (i / steps);
    const sp = worldToScreen({ x: V.x + R * Math.cos(a), y: V.y + R * Math.sin(a) });
    if (i === 0) ctx.moveTo(sp.x, sp.y); else ctx.lineTo(sp.x, sp.y);
  }
  ctx.stroke();

  // End-caps sit at the arc endpoints, tangent to the arc, pointing INTO the
  // arc. Screen-space tangent at world angle a (going CCW in world = CW in
  // screen, because screen y flips) is (-sin(a), -cos(a)).
  const startS = worldToScreen({ x: V.x + R * Math.cos(aS), y: V.y + R * Math.sin(aS) });
  const endS   = worldToScreen({ x: V.x + R * Math.cos(aE), y: V.y + R * Math.sin(aE) });
  const style: DimStyle = e.style ?? runtime.dimStyle ?? 'arrow';
  drawDimCap(startS.x, startS.y, -Math.sin(aS), -Math.cos(aS), style);
  drawDimCap(endS.x,   endS.y,    Math.sin(aE),  Math.cos(aE), style);

  // Degree label: parameterise along the arc sweep so start/center/end drags
  // the label toward the first ray / midpoint / second ray respectively.
  const tArc = e.textAlign === 'start' ? 0.12 : e.textAlign === 'end' ? 0.88 : 0.5;
  const aM = aS + sweep * tArc;
  const midS = worldToScreen({ x: V.x + R * Math.cos(aM), y: V.y + R * Math.sin(aM) });
  const degLabel = `${(sweep * 180 / Math.PI).toFixed(1)}°`;
  const pxH = Math.max(10, e.textHeight * state.view.scale);
  ctx.save();
  ctx.font = `${pxH.toFixed(1)}px "Inter", system-ui, sans-serif`;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'center';
  // Tangent angle in screen space; flip if upside-down so text stays readable.
  let textAng = Math.atan2(-Math.cos(aM), -Math.sin(aM));
  if (textAng >  Math.PI / 2) textAng -= Math.PI;
  if (textAng < -Math.PI / 2) textAng += Math.PI;
  ctx.translate(midS.x, midS.y);
  ctx.rotate(textAng);
  ctx.fillText(degLabel, 0, -3);
  ctx.restore();
}

/**
 * Radius / diameter dim.
 *
 * Data model (see tools.ts):
 *   vertex  = centre of the measured circle/arc
 *   ray1    = near-edge point (on the ray from centre through the label anchor)
 *   offset  = label anchor, where the user clicked to place the leader
 *   radius  = dist(vertex, ray1)
 *
 * Geometry:
 *   • Radius:    leader from near-edge → label anchor, arrow at the edge
 *                pointing inward (toward the circle). Label prefix "R".
 *   • Diameter:  leader from far-edge → near-edge → label anchor with arrows
 *                at BOTH edges pointing inward (toward the circle). Label
 *                prefix "Ø" and value = 2 × r.
 *
 * Label sits next to the anchor, rotated along the leader direction.
 */
function drawRadialDim(e: DimEntity | Extract<EntityShape, { type: 'dim' }>): void {
  const C = e.vertex, E = e.ray1;
  if (!C || !E) return;
  const r = Math.hypot(E.x - C.x, E.y - C.y);
  if (r < 1e-9) return;

  // Direction from centre through label anchor (normalised). If the anchor
  // sits exactly on the centre (degenerate), fall back to the stored ray1.
  let ux = e.offset.x - C.x, uy = e.offset.y - C.y;
  let ul = Math.hypot(ux, uy);
  if (ul < 1e-9) { ux = E.x - C.x; uy = E.y - C.y; ul = r; }
  ux /= ul; uy /= ul;

  const near: Pt = { x: C.x + ux * r, y: C.y + uy * r };
  const far:  Pt = { x: C.x - ux * r, y: C.y - uy * r };
  const anchor = e.offset;

  const nearS = worldToScreen(near);
  const farS  = worldToScreen(far);
  const anchorS = worldToScreen(anchor);

  // Leader: near-edge → anchor (radius) or far-edge → anchor (diameter).
  ctx.beginPath();
  if (e.dimKind === 'diameter') {
    ctx.moveTo(farS.x, farS.y);
    ctx.lineTo(anchorS.x, anchorS.y);
  } else {
    ctx.moveTo(nearS.x, nearS.y);
    ctx.lineTo(anchorS.x, anchorS.y);
  }
  ctx.stroke();

  // End-cap direction. (ux, uy) is a world-space direction; flip the y
  // component for screen-space because screen y grows downward.
  const sUx =  ux, sUy = -uy;                  // outward along leader in screen space
  const style: DimStyle = e.style ?? runtime.dimStyle ?? 'arrow';
  // Cap at the near edge, pointing INWARD (away from centre, toward the
  // leader's tail). drawDimCap draws the cap from (x,y) along (ux,uy). The
  // cap convention is "tip at (x,y), tail at (x + L*ux, y + L*uy)" — so to
  // place the arrow TIP on the edge pointing AT the circle, we pass the
  // outward screen direction (from centre toward anchor = away from centre).
  drawDimCap(nearS.x, nearS.y, sUx, sUy, style);
  if (e.dimKind === 'diameter') {
    // Second cap on the opposite edge, tip on the far edge, pointing toward
    // the centre (i.e. back along the leader). That's the inverse direction.
    drawDimCap(farS.x, farS.y, -sUx, -sUy, style);
  }

  // Label near the anchor, rotated along the leader direction and offset
  // slightly outward so the text doesn't overlap the cap.
  const label = e.dimKind === 'diameter'
    ? `Ø ${(2 * r).toFixed(2)}`
    : `R ${r.toFixed(2)}`;
  const pxH = Math.max(10, e.textHeight * state.view.scale);
  ctx.save();
  ctx.font = `${pxH.toFixed(1)}px "Inter", system-ui, sans-serif`;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'center';
  // Text angle: follow the leader direction (near → anchor in screen space).
  const lx = anchorS.x - nearS.x, ly = anchorS.y - nearS.y;
  let ang = Math.atan2(ly, lx);
  if (ang >  Math.PI / 2) ang -= Math.PI;
  if (ang < -Math.PI / 2) ang += Math.PI;
  // Slide the label along the leader: `end` (default) pins it at the anchor
  // where the user pulled it, `center` drops it halfway along the leader,
  // `start` hugs the edge near the circle. Using `end` as the implicit
  // default preserves the behaviour of older dims that have no textAlign.
  const tLead = e.textAlign === 'start' ? 0.12 : e.textAlign === 'center' ? 0.5 : 1.0;
  const labelS = {
    x: nearS.x + (anchorS.x - nearS.x) * tLead,
    y: nearS.y + (anchorS.y - nearS.y) * tLead,
  };
  ctx.translate(labelS.x, labelS.y);
  ctx.rotate(ang);
  ctx.fillText(label, 0, -3);
  ctx.restore();
}

/**
 * Draw a single dim end-cap at screen point (x,y).
 * (ux, uy) is the unit vector pointing ALONG the dim line INTO the line
 * (so at endpoint `a` it points toward `b`, at endpoint `b` it points toward `a`).
 */
/**
 * Canvas-side mirror of `src/io/export-pdf.ts` `drawDimCapPdf`. Canvas uses
 * CSS pixels and PDF uses paper-mm, so exact identical values are impossible
 * — but the proportions (length-to-half-width ratio for arrows, tick length,
 * arch dot size) are kept in lockstep here so a dim on-canvas and the same
 * dim in the exported PDF look like the same cap, just at different DPIs.
 *
 *   PDF constants (paper-mm): LEN=2.5, HALF=0.9, TICK=1.2, ARCH=1.5, DOT=0.45
 *   Canvas constants (CSS px, ≈ 96dpi → 3.78 px/mm):
 *     LEN ≈ 9.5 px, HALF ≈ 3.4 px, TICK ≈ 4.5 px, ARCH ≈ 5.7 px, DOT ≈ 1.7 px
 *
 * The earlier canvas values (L=10, H=3.5) drifted from the PDF's ratio (L/H
 * 2.86 vs PDF 2.78) — close but not identical, and the user noticed in
 * side-by-side screenshots. Using matching ratios + pure fill (no stroke
 * border — the PDF side is also fill-only now) makes them visually match.
 */
function drawDimCap(x: number, y: number, ux: number, uy: number, style: DimStyle): void {
  // Perpendicular to the line (left-hand normal).
  const px = -uy, py = ux;
  if (style === 'arrow') {
    // Solid filled triangle: tip at (x,y), base L0 back along dim. Ratio
    // L0/H = 2.78 matches the PDF export's 2.5mm × 0.9mm arrow.
    const L0 = 9.5, H = 3.4;
    const bx = x + ux * L0, by = y + uy * L0;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(bx + px * H, by + py * H);
    ctx.lineTo(bx - px * H, by - py * H);
    ctx.closePath();
    ctx.fill();
  } else if (style === 'open') {
    // Two strokes forming an open V — same proportions as the filled arrow.
    const L0 = 9.5, H = 3.4;
    const bx = x + ux * L0, by = y + uy * L0;
    ctx.beginPath();
    ctx.moveTo(bx + px * H, by + py * H);
    ctx.lineTo(x, y);
    ctx.lineTo(bx - px * H, by - py * H);
    ctx.stroke();
  } else if (style === 'tick') {
    // AutoCAD-style short 45° stroke crossing the dim line (mechanical).
    // 4.5 px ≈ 1.2mm at 96dpi → matches PDF's DIM_TICK_HALF_MM.
    const t = 4.5;
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
    // 5.7 px / 1.7 px ≈ PDF's 1.5mm stroke + 0.45mm dot at 96dpi.
    const t = 5.7;
    const txv = (ux - uy), tyv = (uy + ux);
    const k = t / Math.hypot(txv, tyv);
    const dx0 = txv * k, dy0 = tyv * k;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + dx0, y + dy0);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, 1.7, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawText(e: TextEntity | Extract<EntityShape, { type: 'text' }>): void {
  const pxH = e.height * state.view.scale;
  if (pxH < 3) return;
  const layout = layoutText(e);
  const rot = e.rotation ?? 0;

  ctx.save();
  ctx.font = `${pxH.toFixed(1)}px "Inter", system-ui, sans-serif`;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';

  if (rot) {
    // Rotate around the anchor point so multi-line blocks pivot sensibly.
    const origin = worldToScreen({ x: e.x, y: e.y });
    ctx.translate(origin.x, origin.y);
    ctx.rotate(-rot);
    // In the rotated frame the anchor is at (0, 0); each line offsets from
    // there in world-units scaled to screen. dy for canvas = negative of world
    // dy (screen Y grows down, world Y grows up).
    for (let i = 0; i < layout.lines.length; i++) {
      const dyWorld = layout.baselineY[i] - e.y;
      ctx.fillText(layout.lines[i], 0, -dyWorld * state.view.scale);
    }
  } else {
    for (let i = 0; i < layout.lines.length; i++) {
      const pt = worldToScreen({ x: e.x, y: layout.baselineY[i] });
      ctx.fillText(layout.lines[i], pt.x, pt.y);
    }
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

// Axis tints — X = warm red, Y = cool green. Standard CAD convention
// (X=red, Y=green, Z=blue). Rendered verbatim; no theme-driven remap.
const AXIS_X_COLOR = '#d94a4a';
const AXIS_Y_COLOR = '#3aa84f';

/**
 * Paint the two origin axes as viewport-wide infinite lines through (0,0).
 * Axes are independent of the layer system: they're toggled from the snap
 * toolbar (`runtime.snapSettings.showAxes`) and always drawn with the same
 * fine-dashed, colour-coded, labelled style — X red, Y green, "X"/"Y" pill
 * at the positive-direction tip just inside the viewport.
 *
 * Draws over the grid but under all geometry so user entities stay on top.
 */
function drawOriginAxes(w: number, h: number): void {
  if (!runtime.snapSettings.showAxes) return;
  drawOneAxis(w, h, 'x');
  drawOneAxis(w, h, 'y');
}

function drawOneAxis(w: number, h: number, kind: 'x' | 'y'): void {
  const stroke = kind === 'x' ? AXIS_X_COLOR : AXIS_Y_COLOR;
  const dx = kind === 'x' ? 1 : 0;
  const dy = kind === 'x' ? 0 : 1;

  const tl = screenToWorld({ x: -32, y: -32 });
  const br = screenToWorld({ x: w + 32, y: h + 32 });
  const minX = Math.min(tl.x, br.x), maxX = Math.max(tl.x, br.x);
  const minY = Math.min(tl.y, br.y), maxY = Math.max(tl.y, br.y);

  // Liang-Barsky param clip around an infinite line through world origin.
  let t0 = -Infinity, t1 = Infinity;
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0;
    const t = q / p;
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
    else       { if (t < t0) return false; if (t < t1) t1 = t; }
    return true;
  };
  if (!clip(-dx, 0 - minX)) return;
  if (!clip( dx, maxX - 0)) return;
  if (!clip(-dy, 0 - minY)) return;
  if (!clip( dy, maxY - 0)) return;
  if (!Number.isFinite(t0) || !Number.isFinite(t1) || t0 >= t1) return;

  ctx.save();
  ctx.strokeStyle = stroke;
  ctx.fillStyle = stroke;
  ctx.lineWidth = 1;
  // Fine dash in world mm, rendered at the 100%-zoom reference scale so the
  // axis cadence is identical at every zoom level. Clamp per-segment to a
  // half-pixel minimum so the pattern doesn't vanish on sub-pixel densities.
  const patternMm = [1.2, 1];
  ctx.setLineDash(patternMm.map(v => Math.max(0.5, v * DASH_REF_SCALE)));
  drawLineSeg(dx * t0, dy * t0, dx * t1, dy * t1);
  ctx.setLineDash([]);

  // Label at the positive-direction tip. `t1` is the far positive end of the
  // clipped segment because dx/dy ≥ 0 for both axes. Inset by 10 px so it
  // doesn't rest on the viewport edge.
  const tipWorld = { x: dx * t1, y: dy * t1 };
  const tip = worldToScreen(tipWorld);
  const INSET = 10;
  let tx = tip.x, ty = tip.y;
  if (kind === 'x') { tx -= INSET; ty -= INSET; }   // inside top-right of x tip
  else              { tx += INSET; ty += INSET; }   // inside bottom-right of y tip
  ctx.font = '600 12px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  // Small pill behind the label so it stays legible over background grid.
  const label = kind === 'x' ? 'X' : 'Y';
  const metrics = ctx.measureText(label);
  const padX = 4;
  const boxW = metrics.width + padX * 2;
  const boxH = 14;
  const boxX = tx - padX;
  const boxY = ty - boxH / 2;
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = css('--bg');
  ctx.fillRect(boxX, boxY, boxW, boxH);
  ctx.globalAlpha = 1;
  ctx.fillStyle = stroke;
  ctx.fillText(label, tx, ty);
  ctx.restore();
}

function drawXLine(e: XLineEntity | Extract<EntityShape, { type: 'xline' }>): void {
  // Infinite line — clip to the visible viewport (plus a small margin) before
  // drawing. Naively using a huge T made the on-screen segment span millions
  // of pixels at high zoom, which the rasterizer handled very poorly. Clipping
  // here turns every xline into a short viewport-sized segment regardless of
  // zoom level.
  const w = cv.clientWidth, h = cv.clientHeight;
  const tl = screenToWorld({ x: -32, y: -32 });
  const br = screenToWorld({ x: w + 32, y: h + 32 });
  const minX = Math.min(tl.x, br.x), maxX = Math.max(tl.x, br.x);
  const minY = Math.min(tl.y, br.y), maxY = Math.max(tl.y, br.y);

  // Liang–Barsky parametric clip of the infinite line {p = base + t·d} against
  // the viewport rect. t0/t1 bracket the visible portion.
  let t0 = -Infinity, t1 = Infinity;
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0;
    const t = q / p;
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
    else       { if (t < t0) return false; if (t < t1) t1 = t; }
    return true;
  };
  if (!clip(-e.dx, e.x1 - minX)) return;
  if (!clip( e.dx, maxX - e.x1)) return;
  if (!clip(-e.dy, e.y1 - minY)) return;
  if (!clip( e.dy, maxY - e.y1)) return;
  if (!Number.isFinite(t0) || !Number.isFinite(t1) || t0 >= t1) return;

  drawLineSeg(
    e.x1 + e.dx * t0, e.y1 + e.dy * t0,
    e.x1 + e.dx * t1, e.y1 + e.dy * t1,
  );
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

/**
 * Draw a hatch / fill region. For `solid`, fills the boundary polygon with
 * the current fillStyle. For `lines` / `cross`, clips to the boundary and
 * draws a family of parallel lines at `angle` rad, spaced `spacing` world-
 * units apart. Cross-hatch adds a second family at angle + 90°.
 *
 * Boundary polygon drawn with a thin visible outline so the user can always
 * see where the hatch ends — otherwise stripe patterns on a complex shape
 * look disconnected.
 */
function drawHatch(
  e: HatchEntity | Extract<EntityShape, { type: 'hatch' }>,
  selected: boolean,
): void {
  if (!e.pts || e.pts.length < 3) return;
  const sPts = e.pts.map(worldToScreen);
  const sHoles: { x: number; y: number }[][] = (e.holes ?? [])
    .filter(h => h.length >= 3)
    .map(h => h.map(worldToScreen));

  // Combined boundary path (outer + holes). Evaluate with the even-odd rule so
  // the holes cut out of the filled/clipped region.
  const buildBoundary = (): void => {
    ctx.beginPath();
    ctx.moveTo(sPts[0].x, sPts[0].y);
    for (let i = 1; i < sPts.length; i++) ctx.lineTo(sPts[i].x, sPts[i].y);
    ctx.closePath();
    for (const hole of sHoles) {
      ctx.moveTo(hole[0].x, hole[0].y);
      for (let i = 1; i < hole.length; i++) ctx.lineTo(hole[i].x, hole[i].y);
      ctx.closePath();
    }
  };

  if (e.mode === 'solid') {
    buildBoundary();
    ctx.fill('evenodd');
    // Very faint outline when not selected so the fill edge stays crisp on
    // top of other geometry; a stronger outline when selected.
    if (selected) {
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    return;
  }

  // Stripe family (lines / cross).
  const angle = e.angle ?? Math.PI / 4;
  const spacingWorld = Math.max(0.1, e.spacing ?? 5);
  const spacingPx = spacingWorld * state.view.scale;

  // Boundary bbox in screen space — we shoot stripes across the whole bbox
  // then clip to the boundary, which is both correct and simpler than a
  // proper line-polygon intersection pass.
  let minX = sPts[0].x, minY = sPts[0].y, maxX = sPts[0].x, maxY = sPts[0].y;
  for (const p of sPts) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const halfDiag = Math.hypot(maxX - minX, maxY - minY) / 2 + spacingPx;

  ctx.save();
  buildBoundary();
  ctx.clip('evenodd');

  // Draw both families (angle, and for 'cross' also angle + 90°).
  const families = e.mode === 'cross'
    ? [angle, angle + Math.PI / 2]
    : [angle];

  for (const a of families) {
    // Stripes are drawn perpendicular to direction `(cos a, sin a)`, spaced
    // along the normal `n = (-sin a, cos a)`. Iterate signed-offsets centred
    // on the bbox centre so the pattern is symmetric and doesn't shift when
    // the shape moves.
    const dirX = Math.cos(a), dirY = -Math.sin(a); // screen y is flipped
    const nx = -dirY, ny = dirX;
    // Number of stripes needed to span the bbox diagonal.
    const N = Math.ceil(halfDiag / spacingPx) + 1;
    ctx.beginPath();
    for (let k = -N; k <= N; k++) {
      const off = k * spacingPx;
      const bx = cx + nx * off, by = cy + ny * off;
      const x1 = bx - dirX * halfDiag, y1 = by - dirY * halfDiag;
      const x2 = bx + dirX * halfDiag, y2 = by + dirY * halfDiag;
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
    }
    ctx.stroke();
  }
  ctx.restore();

  // Outline the boundary so the hatch reads as "this area" — faint for
  // normal, bright when selected.
  ctx.save();
  ctx.setLineDash(selected ? [] : [3, 3]);
  ctx.lineWidth = selected ? 1.4 : 0.7;
  ctx.globalAlpha = selected ? 1 : 0.55;
  buildBoundary();
  ctx.stroke();
  ctx.restore();
}

function drawPreview(p: Preview): void {
  ctx.save();
  const col = css('--preview');
  ctx.strokeStyle = col;
  // Also set fillStyle: dim previews (angular, radius, diameter) and text
  // previews paint their labels with fillText, which inherits whatever
  // fillStyle the last-drawn entity left behind. Without this, the label
  // would come out in the wrong colour — on light themes (Blaupause) the
  // inherited light fill makes the preview number invisible.
  ctx.fillStyle = col;
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
  polar: 'POLAR', track: 'DYN',
};

function drawSnapMarker(s: SnapPoint): void {
  const sp = worldToScreen(s);
  ctx.save();
  const snap = css('--snap');
  // Halo passt sich dem Theme an: dunkler Hintergrund → dunkler Halo (macht
  // den hellen Marker sichtbar), heller Hintergrund → heller Halo (sonst
  // erzeugt ein hart-schwarzer Umriss in Hell-Themes das störende
  // „Strichgerüst" um die Beschriftung, das der Nutzer gemeldet hat). Wir
  // testen Luminanz von --bg; der Halo selbst wird aus --bg mit hoher Alpha
  // gebaut, damit er unabhängig vom konkreten Theme-Farbton harmoniert.
  const bg = css('--bg');
  const isDark = relLum(bg) < 0.5;
  const markerHalo = isDark ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.75)';
  const labelHalo  = isDark ? 'rgba(0,0,0,0.85)' : 'rgba(255,255,255,0.9)';
  ctx.strokeStyle = markerHalo;
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  drawSnapShape(sp, s.type);
  ctx.stroke();
  ctx.strokeStyle = snap;
  ctx.lineWidth = 2;
  drawSnapShape(sp, s.type);
  ctx.stroke();

  // Typ-Beschriftung — Space Mono 10px, 12px oben-rechts vom Marker. Halo
  // (stroke) unter Füllung für Lesbarkeit auf jedem Hintergrund.
  const label = SNAP_LABELS[s.type];
  if (label) {
    const lx = sp.x + 12;
    const ly = sp.y - 10;
    ctx.font = '10px "Space Mono", monospace';
    ctx.textBaseline = 'alphabetic';
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    ctx.strokeStyle = labelHalo;
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
  } else if (type === 'polar' || type === 'track') {
    // Small square rotated 45° (diamond) — lightweight, reads as "alignment
    // point" without competing visually with the dashed guide line through it.
    const r = type === 'polar' ? 6 : 5;
    ctx.moveTo(sp.x - r, sp.y);
    ctx.lineTo(sp.x,     sp.y - r);
    ctx.lineTo(sp.x + r, sp.y);
    ctx.lineTo(sp.x,     sp.y + r);
    ctx.closePath();
  }
}

/**
 * Dashed guide line for an active polar/track snap. The ray passes through
 * `origin` in direction `angleRad`; we draw it from a short bit behind the
 * origin to well past the cursor so it reads as "infinite" on screen.
 *
 * For 2-guide intersections (polar × track or track × track) both rays are
 * drawn so the user sees the geometric construction.
 */
function drawActiveGuide(s: SnapPoint): void {
  if (!s.origin || s.angleRad === undefined) return;
  ctx.save();
  ctx.strokeStyle = css('--guides');
  ctx.globalAlpha = 0.9;
  ctx.setLineDash([6, 4]);
  ctx.lineWidth = 1;
  drawGuideRay(s.origin, s.angleRad);
  if (s.origin2 && s.angleRad2 !== undefined) {
    drawGuideRay(s.origin2, s.angleRad2);
  }
  ctx.restore();
}

/** Single infinite-style guide ray in screen-space dashed line. */
function drawGuideRay(origin: Pt, angleRad: number): void {
  const w = cv.clientWidth, h = cv.clientHeight;
  // Project the world ray onto the canvas diagonal so it spans the whole
  // viewport regardless of zoom/pan. Parametric in world units; the large
  // extent is trimmed visually by the viewport.
  const diag = Math.hypot(w, h) / state.view.scale;
  const dx = Math.cos(angleRad), dy = Math.sin(angleRad);
  const a = worldToScreen({ x: origin.x - dx * diag, y: origin.y - dy * diag });
  const b = worldToScreen({ x: origin.x + dx * diag, y: origin.y + dy * diag });
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
}

