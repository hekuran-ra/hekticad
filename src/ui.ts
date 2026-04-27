import type { DimStyle, DimTextAlign, Entity, Expr, Feature, LineStylePreset, PointRef } from './types';
import { LINESTYLE_LABELS, LINESTYLE_ORDER, LINESTYLE_PATTERNS, resolveLineStyle } from './types';
import { state, runtime } from './state';
import { render, requestRender } from './render';
import { dom } from './dom';
import {
  deleteParameter, evalExpr, isParameterReferenced, parseExprInput, updateParameter,
} from './params';
import {
  AXIS_X_ID, AXIS_Y_ID,
  deleteFeatures, evaluateTimeline, featureDetail, featureForEntity, featureLabel,
  moveEntityToLayer, unhideFeature,
} from './features';
import { pushUndo } from './undo';
import { showConfirm, showPrompt } from './modal';
import { bindSetPrompt, rebuildCmdBar } from './cmdbar';
import { getDraftInfo } from './draftinfo';
import {
  applyChamfer, commitDivideXLine, getChamferDist, getDivideCount, getFilletRadius,
  setChamferDist, setFilletRadius, syncToolAvailability,
} from './tools';

let toastTimer: number | null = null;

export function toast(message: string): void {
  dom.toastEl.textContent = message;
  dom.toastEl.classList.add('show');
  if (toastTimer !== null) clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => dom.toastEl.classList.remove('show'), 1500);
}

export function setPrompt(text: string): void {
  dom.stTip.textContent = text;
  rebuildCmdBar(text);
}

bindSetPrompt(setPrompt);

export function updateStats(): void {
  const n = state.entities.length;
  // Object count lives in the bottom status bar next to Auswahl — matches the
  // visual style of the other stat chips (`Werkzeug: <b>…</b>`).
  dom.stats.innerHTML = `Objekt${n === 1 ? '' : 'e'}: <b>${n}</b>`;
  renderParameters();
  renderTimeline();
  renderProperties();
  // Parametric edits keep the same selection but change the underlying
  // geometry — refresh the measurement readout so it stays in sync.
  updateMeasStatus();
}

const ENTITY_TYPE_LABELS: Record<string, [string, string]> = {
  line:     ['Linie',       'Linien'],
  xline:    ['Hilfslinie',  'Hilfslinien'],
  rect:     ['Rechteck',    'Rechtecke'],
  circle:   ['Kreis',       'Kreise'],
  arc:      ['Bogen',       'Bögen'],
  ellipse:  ['Ellipse',     'Ellipsen'],
  spline:   ['Spline',      'Splines'],
  polyline: ['Polylinie',   'Polylinien'],
  text:     ['Text',        'Texte'],
  dim:      ['Bemaßung',    'Bemaßungen'],
};

export function updateSelStatus(): void {
  const n = state.selection.size;
  if (n === 0) {
    dom.stSel.innerHTML = `Auswahl: <b>0</b>`;
  } else {
    // Count selected entities per type for a quick mental breakdown.
    const counts: Record<string, number> = {};
    for (const id of state.selection) {
      const ent = state.entities.find(e => e.id === id);
      if (!ent) continue;
      counts[ent.type] = (counts[ent.type] ?? 0) + 1;
    }
    const parts = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([t, c]) => {
        const [sing, plur] = ENTITY_TYPE_LABELS[t] ?? [t, t];
        return `${c} ${c === 1 ? sing : plur}`;
      });
    dom.stSel.innerHTML = `Auswahl: <b>${n}</b> <span class="st-dim">(${parts.join(' · ')})</span>`;
  }
  syncDimPicker();
  updateMeasStatus();
  // Layer rows show a "move selection here" button whose visibility depends
  // on the current selection, so re-render whenever selection changes.
  renderLayers();
  // Selection-gated tools (move, offset, mirror, …) greyed-out when nothing
  // is selected — re-sync the rail whenever the selection count changes.
  syncToolAvailability();
  // Selection drives what the properties panel shows.
  renderProperties();
}

// ----------------- Measurement readout -----------------
//
// When exactly one entity is selected, show its key measurements in the
// bottom-left coord-readout strip next to X/Y/Zoom. For multiple selections or
// empty selection the block is hidden. Kept next to the coord readout because
// that's where users already glance for positional/numeric feedback.

function fmtNum(n: number): string {
  // Trim trailing zeros but keep up to 2 decimals; avoids "100.00" clutter.
  return (Math.round(n * 100) / 100).toString();
}

/** Normalise to [-180, 180] so ∠ reads as a signed deviation from horizontal. */
function fmtAngleDeg(rad: number): string {
  let d = rad * 180 / Math.PI;
  while (d > 180)  d -= 360;
  while (d < -180) d += 360;
  return fmtNum(d);
}

function polylineLength(pts: { x: number; y: number }[], closed: boolean): number {
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  }
  if (closed && pts.length >= 2) {
    const a = pts[pts.length - 1], b = pts[0];
    total += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return total;
}

function measureEntity(e: Entity): string | null {
  switch (e.type) {
    case 'line': {
      const dx = e.x2 - e.x1, dy = e.y2 - e.y1;
      const L = Math.hypot(dx, dy);
      return `<em>L</em> <b>${fmtNum(L)}</b>  <em>∠</em> <b>${fmtAngleDeg(Math.atan2(dy, dx))}°</b>`;
    }
    case 'rect': {
      const w = Math.abs(e.x2 - e.x1), h = Math.abs(e.y2 - e.y1);
      return `<em>B</em> <b>${fmtNum(w)}</b>  <em>H</em> <b>${fmtNum(h)}</b>`;
    }
    case 'circle':
      return `<em>R</em> <b>${fmtNum(e.r)}</b>  <em>⌀</em> <b>${fmtNum(2 * e.r)}</b>`;
    case 'arc': {
      let sweep = (e.a2 - e.a1) * 180 / Math.PI;
      while (sweep < 0)   sweep += 360;
      while (sweep > 360) sweep -= 360;
      const arcLen = e.r * sweep * Math.PI / 180;
      return `<em>R</em> <b>${fmtNum(e.r)}</b>  <em>∠</em> <b>${fmtNum(sweep)}°</b>  <em>L</em> <b>${fmtNum(arcLen)}</b>`;
    }
    case 'ellipse':
      return `<em>rx</em> <b>${fmtNum(e.rx)}</b>  <em>ry</em> <b>${fmtNum(e.ry)}</b>`;
    case 'polyline': {
      const L = polylineLength(e.pts, !!e.closed);
      return `<em>L</em> <b>${fmtNum(L)}</b>  <em>n</em> <b>${e.pts.length}</b>`;
    }
    case 'spline':
      return `<em>n</em> <b>${e.pts.length}</b>`;
    case 'dim': {
      const L = Math.hypot(e.p2.x - e.p1.x, e.p2.y - e.p1.y);
      return `<em>Δ</em> <b>${fmtNum(L)}</b>`;
    }
    default:
      return null;
  }
}

export function updateMeasStatus(): void {
  const el = dom.stMeas;
  if (state.selection.size !== 1) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }
  const [id] = state.selection;
  const ent = state.entities.find(e => e.id === id);
  if (!ent) { el.hidden = true; el.innerHTML = ''; return; }
  const label = measureEntity(ent);
  if (!label) { el.hidden = true; el.innerHTML = ''; return; }
  el.innerHTML = label;
  el.hidden = false;
}

// ----------------- Dimension mode picker -----------------
//
// Floats below the snap-overlay. Visible only while the dim tool is active.
// Lets the user switch between three interaction flows for creating dims:
//   - single (Einfach):   pick p1 → pick p2 → place offset line  (current default)
//   - chain  (Gekettet):  after the first dim, each subsequent click extends
//                         the chain using the previous p2 as p1 with the same
//                         offset line
//   - auto   (Automatisch): click a single edge (line / rect edge / polyline
//                           segment) → create a dim with a default perpendicular
//                           offset; no separate place step
//
// The end-cap style (arrow / open / tick / arch) moved out of this picker and
// into Format → Bemaßungsstil — it's a document-wide setting, not a per-dim-
// invocation choice, so it doesn't belong on a tool HUD.

import { saveCrossMirrorMode, saveDimMode, saveLineOffsetAngleDeg, saveLineOffsetMode, saveLineOffsetUseAngle, saveRadiusMode } from './state';
import type { CrossMirrorMode, DimMode, LineOffsetMode, RadiusMode } from './types';

const DIM_MODES: readonly DimMode[] = ['single', 'chain', 'auto'];
const RADIUS_MODES: readonly RadiusMode[] = ['radius', 'diameter'];
const LINE_OFFSET_MODES: readonly LineOffsetMode[] = ['line', 'connect'];
const CROSS_MIRROR_MODES: readonly CrossMirrorMode[] = ['quarter', 'half_h', 'half_v'];
const dimPicker = document.getElementById('dim-picker') as HTMLElement | null;
const radiusPicker = document.getElementById('radius-picker') as HTMLElement | null;
const lineOffsetPicker = document.getElementById('line-offset-picker') as HTMLElement | null;
const crossMirrorPicker = document.getElementById('cross-mirror-picker') as HTMLElement | null;
const lineOffsetAngleBtn = document.getElementById('line-offset-angle') as HTMLButtonElement | null;
const lineOffsetAngleValue = document.getElementById('line-offset-angle-value') as HTMLInputElement | null;
const dividePicker = document.getElementById('divide-picker') as HTMLElement | null;
const divideCount = document.getElementById('divide-count') as HTMLInputElement | null;
const filletPicker = document.getElementById('fillet-picker') as HTMLElement | null;
const filletRadius = document.getElementById('fillet-radius') as HTMLInputElement | null;
const chamferPicker = document.getElementById('chamfer-picker') as HTMLElement | null;
const chamferDistance = document.getElementById('chamfer-distance') as HTMLInputElement | null;

export function syncDimPicker(): void {
  if (dimPicker) {
    const show = state.tool === 'dim';
    dimPicker.toggleAttribute('hidden', !show);
    if (show) {
      dimPicker.querySelectorAll<HTMLButtonElement>('.dim-mode-btn').forEach(btn => {
        btn.classList.toggle('on', btn.dataset.mode === runtime.dimMode);
      });
    }
  }
  if (radiusPicker) {
    const show = state.tool === 'radius';
    radiusPicker.toggleAttribute('hidden', !show);
    if (show) {
      radiusPicker.querySelectorAll<HTMLButtonElement>('.radius-mode-btn').forEach(btn => {
        btn.classList.toggle('on', btn.dataset.mode === runtime.radiusMode);
      });
    }
  }
  if (crossMirrorPicker) {
    const show = state.tool === 'cross_mirror';
    crossMirrorPicker.toggleAttribute('hidden', !show);
    if (show) {
      crossMirrorPicker.querySelectorAll<HTMLButtonElement>('.cross-mirror-mode-btn').forEach(btn => {
        btn.classList.toggle('on', btn.dataset.mode === runtime.crossMirrorMode);
      });
    }
  }
  if (lineOffsetPicker) {
    const show = state.tool === 'line_offset';
    lineOffsetPicker.toggleAttribute('hidden', !show);
    if (show) {
      lineOffsetPicker.querySelectorAll<HTMLButtonElement>('.line-offset-mode-btn').forEach(btn => {
        btn.classList.toggle('on', btn.dataset.mode === runtime.lineOffsetMode);
      });
      // Winkel toggle is independent — not part of the mode radio group.
      // The angle input next to it is visible iff the toggle is on, so the
      // picker stays compact when Winkel is off (typical 90° offset case).
      if (lineOffsetAngleBtn) {
        lineOffsetAngleBtn.classList.toggle('on', runtime.lineOffsetUseAngle);
      }
      if (lineOffsetAngleValue) {
        lineOffsetAngleValue.toggleAttribute('hidden', !runtime.lineOffsetUseAngle);
        // Only re-sync the value if the input isn't currently focused — avoids
        // clobbering a half-typed number when other UI updates fire.
        if (document.activeElement !== lineOffsetAngleValue) {
          lineOffsetAngleValue.value = String(runtime.lineOffsetAngleDeg);
        }
      }
    }
  }
  if (dividePicker) {
    const show = state.tool === 'divide_xline';
    dividePicker.toggleAttribute('hidden', !show);
    if (show && divideCount) {
      // Mirror the toolCtx's stashed count (tc.radius) into the input — or
      // fall back to the sticky last value if the ctx slot is empty. We skip
      // while the input is focused so typing isn't clobbered by re-syncs
      // (undo, selection changes, etc).
      const tc = runtime.toolCtx;
      if (document.activeElement !== divideCount) {
        const fromCtx = tc?.radius;
        const n = (fromCtx != null && Number.isInteger(fromCtx) && fromCtx >= 2)
          ? fromCtx
          : getDivideCount();
        divideCount.value = String(n);
      }
    }
  }
  if (filletPicker) {
    const show = state.tool === 'fillet';
    filletPicker.toggleAttribute('hidden', !show);
    if (show && filletRadius && document.activeElement !== filletRadius) {
      filletRadius.value = String(getFilletRadius());
    }
  }
  if (chamferPicker) {
    const show = state.tool === 'chamfer';
    chamferPicker.toggleAttribute('hidden', !show);
    if (show && chamferDistance && document.activeElement !== chamferDistance) {
      chamferDistance.value = String(getChamferDist());
    }
  }
  syncDimPropsHud();
}

// ── Dim properties HUD (text size + alignment) ──────────────────────────────
// Visible whenever the selection contains at least one dim. Reflects the
// *first* selected dim's values in the inputs — patching applies to every
// selected dim via `applyDimTextHeight` / `applyDimTextAlign`.

const dimPropsHud  = document.getElementById('dim-props')      as HTMLElement | null;
const dimPropsSize = document.getElementById('dim-props-size') as HTMLInputElement | null;

function firstSelectedDim(): Entity | null {
  for (const id of state.selection) {
    const ent = state.entities.find(e => e.id === id);
    if (ent && ent.type === 'dim') return ent;
  }
  return null;
}

export function syncDimPropsHud(): void {
  if (!dimPropsHud) return;
  const first = firstSelectedDim();
  if (!first || first.type !== 'dim') {
    dimPropsHud.toggleAttribute('hidden', true);
    return;
  }
  dimPropsHud.toggleAttribute('hidden', false);
  if (dimPropsSize && document.activeElement !== dimPropsSize) {
    dimPropsSize.value = String(first.textHeight);
  }
  // Default `undefined` reads as `center` for linear/angular dims; keep the UI
  // consistent by showing center-highlight when no explicit field is set,
  // regardless of dim kind (radial's implicit "end" is a renderer convention,
  // not a user choice, so we don't misrepresent it in the HUD).
  const activeAlign: DimTextAlign = first.textAlign ?? 'center';
  dimPropsHud.querySelectorAll<HTMLButtonElement>('.dim-props-align-btn').forEach(btn => {
    btn.classList.toggle('on', btn.dataset.align === activeAlign);
  });
}

if (dimPropsSize) {
  // `change` fires on blur / Enter — committing one undo step per edit
  // instead of one per keystroke. `input` would feel live but would also
  // spam the undo stack with 5 entries for "32.5 → 3.25".
  dimPropsSize.addEventListener('change', () => {
    const v = parseFloat(dimPropsSize.value);
    if (!Number.isFinite(v) || v <= 0) { syncDimPropsHud(); return; }
    applyDimTextHeight(v);
  });
  // Enter commits and blurs so the user can keep drawing without stealing focus.
  dimPropsSize.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') dimPropsSize.blur();
  });
}

if (dimPropsHud) {
  dimPropsHud.addEventListener('click', (ev) => {
    const target = ev.target;
    if (!(target instanceof Element)) return;
    const btn = target.closest<HTMLButtonElement>('.dim-props-align-btn');
    if (!btn) return;
    const align = btn.dataset.align as DimTextAlign | undefined;
    if (!align || (align !== 'start' && align !== 'center' && align !== 'end')) return;
    applyDimTextAlign(align);
    syncDimPropsHud();
  });
}

if (dimPicker) {
  dimPicker.addEventListener('click', (ev) => {
    const target = ev.target;
    if (!(target instanceof Element)) return;
    const btn = target.closest<HTMLButtonElement>('.dim-mode-btn');
    if (!btn) return;
    const mode = btn.dataset.mode as DimMode | undefined;
    if (!mode || !DIM_MODES.includes(mode)) return;
    runtime.dimMode = mode;
    saveDimMode(mode);
    // Mid-tool mode switch: reset any in-flight pick state and re-issue the
    // initial prompt so the user gets consistent feedback. Leaving stale
    // click1/click2 around would be confusing — a fresh start matches what a
    // CAD user expects from flipping a mode toggle.
    if (state.tool === 'dim') {
      runtime.toolCtx = (mode === 'chain' || mode === 'auto')
        ? { step: 'collect', pts: [], ptRefs: [] }
        : { step: 'pick1' };
      setPrompt(
        mode === 'auto'  ? 'Erste Linie klicken (automatische Erkennung dazwischen)' :
        mode === 'chain' ? 'Erster Punkt der Kette' :
                           'Erster Messpunkt'
      );
    }
    syncDimPicker();
    requestRender();
  });
}

if (radiusPicker) {
  radiusPicker.addEventListener('click', (ev) => {
    const target = ev.target;
    if (!(target instanceof Element)) return;
    const btn = target.closest<HTMLButtonElement>('.radius-mode-btn');
    if (!btn) return;
    const mode = btn.dataset.mode as RadiusMode | undefined;
    if (!mode || !RADIUS_MODES.includes(mode)) return;
    runtime.radiusMode = mode;
    saveRadiusMode(mode);
    // Same reset-on-switch policy as the dim picker: if the user is mid-click,
    // reset to the "pick a circle" phase so the newly selected mode takes
    // effect on the very next click.
    if (state.tool === 'radius') {
      runtime.toolCtx = { step: 'pickCircle' };
      setPrompt(mode === 'diameter'
        ? 'Durchmesser: Kreis/Bogen anklicken'
        : 'Radius: Kreis/Bogen anklicken');
    }
    syncDimPicker();
    requestRender();
  });
}

if (crossMirrorPicker) {
  crossMirrorPicker.addEventListener('click', (ev) => {
    const target = ev.target;
    if (!(target instanceof Element)) return;
    const btn = target.closest<HTMLButtonElement>('.cross-mirror-mode-btn');
    if (!btn) return;
    const mode = btn.dataset.mode as CrossMirrorMode | undefined;
    if (!mode || !CROSS_MIRROR_MODES.includes(mode)) return;
    runtime.crossMirrorMode = mode;
    saveCrossMirrorMode(mode);
    // Picker switch: the tool itself stays at its 'center' step (the user
    // hasn't committed yet), only the mode sticky-state changes. Re-emit the
    // prompt so the HUD reflects the newly selected mode.
    if (state.tool === 'cross_mirror') {
      const promptTxt = mode === 'quarter'
        ? 'Symmetrie-Mittelpunkt klicken (1/4)'
        : mode === 'half_h'
          ? 'Symmetrie-Mittelpunkt klicken (1/2 horizontal, links ↔ rechts)'
          : 'Symmetrie-Mittelpunkt klicken (1/2 vertikal, oben ↕ unten)';
      setPrompt(promptTxt);
    }
    syncDimPicker();
    requestRender();
  });
}

if (lineOffsetPicker) {
  lineOffsetPicker.addEventListener('click', (ev) => {
    const target = ev.target;
    if (!(target instanceof Element)) return;
    // Winkel toggle: independent on/off, doesn't touch the mode radio group.
    const angleBtn = target.closest<HTMLButtonElement>('.line-offset-angle-btn');
    if (angleBtn) {
      runtime.lineOffsetUseAngle = !runtime.lineOffsetUseAngle;
      saveLineOffsetUseAngle(runtime.lineOffsetUseAngle);
      syncDimPicker();
      // When turning the toggle ON, focus the angle input so the user can
      // type the value immediately — matches their "direkt oben eingeben"
      // request. Defer to the next frame so the unhide has taken effect.
      if (runtime.lineOffsetUseAngle && lineOffsetAngleValue) {
        requestAnimationFrame(() => {
          lineOffsetAngleValue.focus();
          lineOffsetAngleValue.select();
        });
      }
      requestRender();
      return;
    }
    const btn = target.closest<HTMLButtonElement>('.line-offset-mode-btn');
    if (!btn) return;
    const mode = btn.dataset.mode as LineOffsetMode | undefined;
    if (!mode || !LINE_OFFSET_MODES.includes(mode)) return;
    runtime.lineOffsetMode = mode;
    saveLineOffsetMode(mode);
    // Don't reset the pick state — the user's picked line and typed values
    // stay valid across the mode switch. The commit path reads the current
    // mode at commit time, so flipping the picker mid-action works fine.
    syncDimPicker();
    requestRender();
  });
}

if (divideCount) {
  // Enter / change → commit the count. We DON'T update on every `input`
  // event — that would transition the tool to 'pick' as soon as the user
  // typed the first digit (e.g. "5" of "50"), which is jarring. The user
  // commits explicitly by pressing Enter (or tabbing out).
  const tryCommit = (): void => {
    const raw = divideCount.value.trim();
    const n = parseInt(raw, 10);
    if (!Number.isInteger(n) || n < 2 || n > 200) {
      // Leave the field's current value; the user will correct it.
      return;
    }
    const tc = runtime.toolCtx;
    if (!tc) return;
    // Reuses the existing commit helper (tools.ts); advances step → 'pick'
    // and sets the "Linie wählen (N=…)" prompt.
    commitDivideXLine(tc, n);
  };
  divideCount.addEventListener('change', tryCommit);
  divideCount.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      ev.stopPropagation();
      tryCommit();
      // Blur so the canvas gets keyboard focus — the next click picks the line.
      divideCount.blur();
    }
    if (ev.key === 'Escape') {
      divideCount.blur();
    }
  });
}

// Fillet radius and chamfer distance accept expression input (so a user can
// type e.g. "L/2" where L is a parameter). Both are sticky — committing stores
// the numeric result so subsequent operations reuse it without re-entering.
// The fields are bound by the same tryCommit pattern as the cmdbar's expr
// fields, just wired to a top-panel input instead of the bottom bar.
function parseExprValue(raw: string): number | null {
  const r = parseExprInput(raw);
  if (!r || r.kind !== 'expr') return null;
  const v = evalExpr(r.expr);
  if (!Number.isFinite(v) || v <= 0) return null;
  return v;
}

if (filletRadius) {
  const tryCommit = (): void => {
    const v = parseExprValue(filletRadius.value);
    if (v == null) {
      // Restore last-valid value so the field never sits on an invalid string.
      filletRadius.value = String(getFilletRadius());
      toast('Radius ungültig');
      return;
    }
    setFilletRadius(v);
    toast('Radius = ' + v);
  };
  filletRadius.addEventListener('change', tryCommit);
  filletRadius.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      ev.stopPropagation();
      tryCommit();
      filletRadius.blur();
    }
    if (ev.key === 'Escape') {
      filletRadius.value = String(getFilletRadius());
      filletRadius.blur();
    }
  });
}

if (chamferDistance) {
  const tryCommit = (): void => {
    const v = parseExprValue(chamferDistance.value);
    if (v == null) {
      chamferDistance.value = String(getChamferDist());
      toast('Abstand ungültig');
      return;
    }
    // If the user has already picked two lines, commit the chamfer right away
    // — matches the old cmdbar semantics where Enter at that point acted on
    // the current selection. Otherwise just update the sticky default.
    const tc = runtime.toolCtx;
    if (tc && tc.step === 'distance' && tc.entity1 && tc.entity2) {
      applyChamfer(v);
    } else {
      setChamferDist(v);
      toast('Abstand = ' + v);
    }
  };
  chamferDistance.addEventListener('change', tryCommit);
  chamferDistance.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      ev.stopPropagation();
      tryCommit();
      chamferDistance.blur();
    }
    if (ev.key === 'Escape') {
      chamferDistance.value = String(getChamferDist());
      chamferDistance.blur();
    }
  });
}

if (lineOffsetAngleValue) {
  // `input` = live updates while the user types, so the preview shape
  // responds in real-time. Parse defensively — clamp to the legal open range
  // (0°, 180°) to avoid degenerate connectors (0° = connectors on top of the
  // line, 180° = flipped to the other side).
  const applyAngle = (commit: boolean): void => {
    const raw = lineOffsetAngleValue.value.replace(',', '.');
    const n = parseFloat(raw);
    // Semantics: 0 = perpendicular connectors (rectangle); positive tilts
    // inward, negative flares outward. Degenerate past ±90° (connectors
    // would fold onto the line), so clamp to the open range (-90, 90).
    if (!Number.isFinite(n) || n <= -90 || n >= 90) {
      if (commit) lineOffsetAngleValue.value = String(runtime.lineOffsetAngleDeg);
      return;
    }
    runtime.lineOffsetAngleDeg = n;
    if (commit) saveLineOffsetAngleDeg(n);
    requestRender();
  };
  lineOffsetAngleValue.addEventListener('input',  () => applyAngle(false));
  lineOffsetAngleValue.addEventListener('change', () => applyAngle(true));
  // Enter commits and blurs so the canvas regains focus for the next click.
  lineOffsetAngleValue.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { applyAngle(true); lineOffsetAngleValue.blur(); }
    if (ev.key === 'Escape') { lineOffsetAngleValue.blur(); }
  });
}

/**
 * Apply a new global dim end-cap style. Called from Format → Bemaßungsstil.
 * Updates the runtime default *and* patches any currently-selected dim
 * features so existing dims repaint immediately — matches the old picker's
 * "selection edits on the fly" behaviour without the canvas HUD clutter.
 */
export function applyDimStyle(style: DimStyle): void {
  runtime.dimStyle = style;
  let patched = 0;
  for (const id of state.selection) {
    const ent = state.entities.find(e => e.id === id);
    if (!ent || ent.type !== 'dim') continue;
    const feat = featureForEntity(id);
    if (feat && feat.kind === 'dim') { feat.style = style; patched++; }
  }
  if (patched > 0) evaluateTimeline();
  requestRender();
}

/** Expression helper — wraps a raw number so it can live in a DimFeature's
 *  textHeight slot. Parametric expressions on text size would need the full
 *  `parseExprInput` path; for direct user input from the properties panel a
 *  constant is enough. */
const numExpr = (v: number): Expr => ({ kind: 'num', value: v });

/**
 * Set the text height on every currently-selected dim. Pushes a single undo
 * frame so the whole batch collapses into one step. Called by the dim
 * properties HUD and by the keyboard shortcut, never by rendering code.
 */
export function applyDimTextHeight(heightMm: number): void {
  if (!(heightMm > 0) || !Number.isFinite(heightMm)) return;
  let patched = 0;
  for (const id of state.selection) {
    const ent = state.entities.find(e => e.id === id);
    if (!ent || ent.type !== 'dim') continue;
    const feat = featureForEntity(id);
    if (feat && feat.kind === 'dim') {
      feat.textHeight = numExpr(heightMm);
      patched++;
    }
  }
  if (patched === 0) return;
  pushUndo();
  evaluateTimeline();
  requestRender();
  updateMeasStatus();
}

/**
 * Set the label alignment (along the dim line / arc / leader) on every
 * selected dim. `center` erases the field so older saves stay identical when
 * they round-trip — the renderer treats `undefined` as `center` for linear
 * and angular dims, and as `end` for radius/diameter (where the anchor is
 * the classic placement).
 */
export function applyDimTextAlign(align: DimTextAlign): void {
  let patched = 0;
  for (const id of state.selection) {
    const ent = state.entities.find(e => e.id === id);
    if (!ent || ent.type !== 'dim') continue;
    const feat = featureForEntity(id);
    if (feat && feat.kind === 'dim') {
      if (align === 'center') delete feat.textAlign;
      else feat.textAlign = align;
      patched++;
    }
  }
  if (patched === 0) return;
  pushUndo();
  evaluateTimeline();
  requestRender();
}

// ── Dim text-height presets ──────────────────────────────────────────────
//
// Four canned sizes exposed as buttons in the dim properties panel (single
// and multi-select). The first three are fixed mm values, tuned so the
// rendered text reads well on typical architectural/mechanical drawings at
// common zoom levels. `auto` is special: it derives a height from the drawing
// bounding box so a 30 m floor plan gets bigger text than a 40 mm detail,
// without the user having to think about it. The computed value is committed
// as a literal Expr at click time — NOT stored as a live "auto" mode — so
// subsequent edits to other geometry don't silently change the dim text size
// behind the user's back. Re-clicking "Automatisch" refreshes it.

type DimSizePresetId = 'xs' | 's' | 'm' | 'auto';
export const DIM_TEXT_PRESET_MM: Record<Exclude<DimSizePresetId, 'auto'>, number> = {
  xs: 2,
  s:  3.5,
  m:  5,
};
// Tolerance for "is the current dim height equal to preset X?" — dim heights
// are stored as Expr so small float drift from repeated parse/eval rounds is
// possible; 0.01 mm is well below anything a human would notice on screen.
const DIM_PRESET_MATCH_EPS = 0.01;

/**
 * Compute a readable text height from the drawing's current bounding box.
 * Formula: diagonal / 120, clamped to [2, 25] mm. Chosen so that a typical
 * A4-sized drawing (~400 mm diagonal) lands at ~3.3 mm — close to our
 * "Klein" preset — and scales linearly from there. We deliberately ignore
 * dims themselves in the bbox: if we included them, text-height changes
 * could shift the bbox (dims that live far from their ref points push the
 * bbox out), which would shift the computed auto-size on the next click.
 */
export function computeAutoDimTextHeight(): number {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const e of state.entities) {
    if (e.type === 'dim' || e.type === 'xline') continue;
    const pts = entityPointsForBBox(e);
    for (const p of pts) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    }
  }
  if (!Number.isFinite(minX)) return DIM_TEXT_PRESET_MM.m; // empty drawing → fall back to "Mittel"
  const diag = Math.hypot(maxX - minX, maxY - minY);
  const raw = diag / 120;
  const clamped = Math.max(2, Math.min(25, raw));
  // Round to 0.5 mm so the committed value looks tidy in the input field
  // ("3.5 mm", not "3.27418 mm").
  return Math.round(clamped * 2) / 2;
}

// Small, dim-local bbox extractor. Pulls the same corner points `view.ts`
// uses but inlined so we don't introduce a circular import (view.ts already
// imports from ui.ts).
function entityPointsForBBox(e: Entity): Array<{ x: number; y: number }> {
  if (e.type === 'line')     return [{ x: e.x1, y: e.y1 }, { x: e.x2, y: e.y2 }];
  if (e.type === 'rect')     return [{ x: e.x1, y: e.y1 }, { x: e.x2, y: e.y2 }];
  if (e.type === 'circle')   return [{ x: e.cx - e.r, y: e.cy - e.r }, { x: e.cx + e.r, y: e.cy + e.r }];
  if (e.type === 'arc')      return [{ x: e.cx - e.r, y: e.cy - e.r }, { x: e.cx + e.r, y: e.cy + e.r }];
  if (e.type === 'ellipse') {
    const m = Math.max(e.rx, e.ry);
    return [{ x: e.cx - m, y: e.cy - m }, { x: e.cx + m, y: e.cy + m }];
  }
  if (e.type === 'spline')   return e.pts;
  if (e.type === 'polyline') return e.pts;
  if (e.type === 'text')     return [{ x: e.x, y: e.y }];
  return [];
}

/**
 * Resolve a preset id to its concrete mm value at this moment. `auto` is
 * recomputed every time so successive clicks stay up to date with the
 * current drawing bbox.
 */
function resolveDimPresetMm(id: DimSizePresetId): number {
  if (id === 'auto') return computeAutoDimTextHeight();
  return DIM_TEXT_PRESET_MM[id];
}

/**
 * Which preset, if any, matches the supplied mm value? Returns null when the
 * current height is a custom one (user typed "4.2 mm" directly). `auto` is
 * never reported as "currently active" — by design, because once committed
 * it's indistinguishable from the matching literal value, and we don't want
 * the auto button to appear permanently active after one click.
 */
function matchDimPreset(mm: number): Exclude<DimSizePresetId, 'auto'> | null {
  for (const id of ['xs', 's', 'm'] as const) {
    if (Math.abs(mm - DIM_TEXT_PRESET_MM[id]) < DIM_PRESET_MATCH_EPS) return id;
  }
  return null;
}

/**
 * Status labels the draft-info strings may contain. Each token is shown in
 * dim, values/numbers shown bold. Keeping this centralized so the regex below
 * renders every tool's readout (B, H, R, ∠, L, a, b, Δ, Faktor, Ref-L,
 * Versatz, Abstand) with consistent typography.
 */
const DRAFT_LABEL_RE = /(Faktor|Ref-L|Versatz|Abstand|[∠BHRLabΔ])/g;

export function updatePosStatus(x: number, y: number): void {
  // During drafting (an active tool anchor) show the tool-specific readout
  // from `getDraftInfo()` — same source as the crosshair label. The bottom
  // bar mirrors the cmdbar input fields so the info always matches what the
  // user is about to type (B/H for rect, R for circle, ∠+L for line, etc.).
  // No tool anchor → classic absolute X/Y.
  const info = getDraftInfo();
  let html: string;
  if (info) {
    // Wrap known labels in dim spans, numbers stay inline. Comma in "Δ dx, dy"
    // stays readable as plain text.
    html = info.replace(DRAFT_LABEL_RE, '<span class="st-dim">$1</span>');
  } else {
    // No tool-specific info: prefer Δ from active anchor over absolute world
    // X/Y. Mirrors the crosshair label so both readouts stay consistent.
    const tc = runtime.toolCtx;
    const anchor = tc?.p1 ?? tc?.click1 ?? tc?.basePt ?? null;
    if (anchor) {
      const dx = x - anchor.x;
      const dy = y - anchor.y;
      html = `<span class="st-dim">Δx</span> <b>${dx.toFixed(2)}</b>  <span class="st-dim">Δy</span> <b>${dy.toFixed(2)}</b>`;
    } else {
      html = `X: <b>${x.toFixed(2)}</b>  Y: <b>${y.toFixed(2)}</b>`;
    }
  }
  dom.stPos.innerHTML = html;
}

export function updateZoomStatus(): void {
  dom.stZoom.innerHTML = `Zoom <b>${(state.view.scale * 25).toFixed(0)}%</b>`;
}

export function updateToolStatus(label: string): void {
  dom.stTool.innerHTML = `Werkzeug: <b>${label}</b>`;
}

export function setTip(text: string): void {
  dom.stTip.textContent = text;
}

function rgbToHex(c: string): string {
  if (c.startsWith('#')) return c;
  const m = c.match(/\d+/g);
  if (!m) return '#ffffff';
  return '#' + m.slice(0, 3).map(x => (+x).toString(16).padStart(2, '0')).join('');
}

/** SVG path strings for layer row icons. */
const EYE_ON  = '<path d="M2 10 C 5 4, 15 4, 18 10 C 15 16, 5 16, 2 10 Z M10 10 m-2.5 0 a 2.5 2.5 0 1 0 5 0 a 2.5 2.5 0 1 0 -5 0"/>';
const EYE_OFF = '<line x1="3" y1="3" x2="17" y2="17"/><path d="M5 9.5 C 3.5 10.8 3 11 3 11 C 6 16, 14 16, 17 11" opacity="0.5"/>';
const LOCK_CLOSED = '<rect x="4" y="9" width="12" height="8" rx="1"/><path d="M7 9 V6.5 A3 3 0 0 1 13 6.5 V9"/>';
const LOCK_OPEN   = '<rect x="4" y="9" width="12" height="8" rx="1"/><path d="M7 9 V6.5 A3 3 0 0 1 13 6.5"/>';
/** Arrow used on the "move selection to this layer" mini-button. */
const MOVE_HERE   = '<path d="M3 10 L14 10 M10 6 L14 10 L10 14"/>';
/** Trash used on the "delete this layer" mini-button. */
const TRASH       = '<path d="M5 6 L5 16 A 1.5 1.5 0 0 0 6.5 17.5 L13.5 17.5 A 1.5 1.5 0 0 0 15 16 L15 6 M3 6 L17 6 M8 6 L8 4.5 A 1 1 0 0 1 9 3.5 L11 3.5 A 1 1 0 0 1 12 4.5 L12 6 M8.5 9 L8.5 14 M11.5 9 L11.5 14"/>';

function svgIcon(paths: string): string {
  return `<svg viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
}

export function renderLayers(): void {
  dom.layersEl.innerHTML = '';

  // Update side-count badge
  const badge = document.getElementById('side-count-layers');
  if (badge) badge.textContent = String(state.layers.length);

  state.layers.forEach((L, i) => {
    const row = document.createElement('div');
    row.className = 'layer-row'
      + (i === state.activeLayer ? ' active' : '')
      + (L.locked ? ' locked' : '')
      + (!L.visible ? ' hidden' : '');

    // Locked layers cannot be made active.
    row.onclick = () => {
      if (L.locked) return;
      state.activeLayer = i;
      renderLayers();
    };

    // Colour swatch — click opens colour picker
    const sw = document.createElement('div');
    sw.className = 'swatch';
    sw.style.background = L.color;
    if (!L.locked) {
      // WKWebView (Tauri on macOS) ignores `input.click()` on a
      // hidden/detached <input type="color"> — it doesn't count the call as
      // a user gesture, so the native colour panel never opens. The robust
      // pattern is to let the user's real click land on the input directly:
      // stretch a transparent colour input over the whole swatch. The
      // visible swatch background still shows the current colour; the input
      // sits on top, transparent, and receives the click itself.
      sw.style.position = 'relative';
      const inp = document.createElement('input');
      inp.type = 'color';
      inp.value = rgbToHex(L.color);
      inp.style.cssText = [
        'position:absolute',
        'inset:0',
        'width:100%',
        'height:100%',
        'opacity:0',
        'cursor:pointer',
        'border:none',
        'padding:0',
        'background:transparent',
      ].join(';');
      // Don't bubble to row.onclick (which would activate the layer).
      inp.addEventListener('click', (ev) => ev.stopPropagation());
      // `input` fires continuously while the user drags the picker — update
      // the canvas + swatch background live, but DO NOT rebuild the layers
      // panel (that would remove this <input> and tear the picker down
      // mid-drag — same trap as the hatch-colour input, see note below).
      // `change` fires once on commit/dismiss; rebuild the panel there.
      inp.oninput = () => { L.color = inp.value; sw.style.background = L.color; render(); };
      inp.onchange = () => { L.color = inp.value; renderLayers(); render(); };
      sw.appendChild(inp);
    }

    // Layer name — double-click to rename
    const name = document.createElement('div');
    name.className = 'layer-name';
    name.textContent = L.name;
    if (!L.locked) {
      name.ondblclick = async (ev) => {
        ev.stopPropagation();
        const nm = await showPrompt({
          title: 'Layer umbenennen',
          defaultValue: L.name,
          validate: (v) => v.trim() ? null : 'Name darf nicht leer sein',
        });
        if (nm) { L.name = nm.trim(); renderLayers(); }
      };
    }

    // Visibility toggle (eye icon)
    const vis = document.createElement('button');
    vis.className = 'layer-vis';
    vis.title = L.visible ? 'Ausblenden' : 'Einblenden';
    vis.innerHTML = svgIcon(L.visible ? EYE_ON : EYE_OFF);
    vis.onclick = (ev) => {
      ev.stopPropagation();
      L.visible = !L.visible;
      renderLayers();
      render();
    };

    // Lock toggle (lock icon)
    const lk = document.createElement('button');
    lk.className = 'layer-lock-btn';
    lk.title = L.locked ? 'Entsperren' : 'Sperren';
    lk.innerHTML = svgIcon(L.locked ? LOCK_CLOSED : LOCK_OPEN);
    lk.onclick = (ev) => {
      ev.stopPropagation();
      // Toggle must be symmetric: if the user can lock a layer, they must
      // be able to unlock it too. An earlier guard blocked unlocking the
      // axis layer (index 0) but still allowed locking it, trapping the
      // user. If the axis layer ever becomes special-cased again, block
      // BOTH directions — never one-way.
      L.locked = !L.locked;
      renderLayers();
    };

    // Move-selection-here button. Only appears when there's a selection AND
    // this layer is unlocked AND at least one selected entity isn't already
    // on this layer. One click moves every eligible selected entity here.
    const mv = document.createElement('button');
    mv.className = 'layer-move-btn';
    mv.title = `Auswahl nach „${L.name}" verschieben`;
    mv.innerHTML = svgIcon(MOVE_HERE);
    const elig = [...state.selection].filter(id => {
      const ent = state.entities.find(e => e.id === id);
      if (!ent) return false;
      if (ent.layer === i) return false;
      if (state.layers[ent.layer]?.locked) return false;
      return true;
    });
    const showMv = !L.locked && elig.length > 0;
    mv.style.display = showMv ? '' : 'none';
    mv.onclick = (ev) => {
      ev.stopPropagation();
      if (!elig.length) return;
      pushUndo();
      let moved = 0;
      for (const id of elig) if (moveEntityToLayer(id, i)) moved++;
      if (moved > 0) {
        evaluateTimeline();
        renderLayers();
        render();
        toast(`${moved} Objekt${moved === 1 ? '' : 'e'} nach „${L.name}" verschoben`);
      }
    };

    // Delete button. Suppressed for locked layers (e.g. the built-in axis row)
    // and when only a single layer remains. Layers with geometry refuse to
    // delete with a toast so the user doesn't silently lose objects — they
    // must move or erase them first.
    const del = document.createElement('button');
    del.className = 'layer-del-btn';
    del.title = `Layer „${L.name}" löschen`;
    del.innerHTML = svgIcon(TRASH);
    const canDelete = !L.locked && state.layers.length > 1;
    del.style.display = canDelete ? '' : 'none';
    del.onclick = async (ev) => {
      ev.stopPropagation();
      const featCount = state.features.filter(f => f.layer === i).length;
      if (featCount > 0) {
        toast(`Layer „${L.name}" enthält ${featCount} Objekt${featCount === 1 ? '' : 'e'} — zuerst verschieben oder löschen`);
        return;
      }
      const ok = await showConfirm({
        title: 'Layer löschen?',
        message: `„${L.name}" wird entfernt.`,
        okText: 'Löschen',
        danger: true,
      });
      if (!ok) return;
      pushUndo();
      state.layers.splice(i, 1);
      // Layers are referenced by INDEX, so everything past the deleted slot
      // shifts down by one. Features are the source of truth; entities are
      // kept in sync so the current frame renders correctly without a full
      // timeline re-evaluation.
      for (const f of state.features) if (f.layer > i) f.layer -= 1;
      for (const e of state.entities) if (e.layer > i) e.layer -= 1;
      if (state.activeLayer === i) {
        state.activeLayer = Math.min(Math.max(1, i), state.layers.length - 1);
      } else if (state.activeLayer > i) {
        state.activeLayer -= 1;
      }
      evaluateTimeline();
      renderLayers();
      render();
      toast(`Layer „${L.name}" gelöscht`);
    };

    // Linetype picker — a compact button showing a mini-preview of the
    // current dash pattern. Click opens a popover with the preset list and
    // a "custom…" entry for arbitrary dash arrays (comma/space-separated mm).
    const ls = document.createElement('button');
    ls.className = 'layer-linestyle-btn';
    ls.title = 'Linientyp';
    const resolved = resolveLineStyle(L.style);
    const labelFor = (): string => {
      if (typeof resolved === 'string') return LINESTYLE_LABELS[resolved];
      return 'Benutzerdefiniert';
    };
    ls.setAttribute('aria-label', labelFor());
    ls.appendChild(linestylePreviewSvg(L.style, L.color));
    if (!L.locked) {
      ls.onclick = (ev) => {
        ev.stopPropagation();
        openLinestylePopover(ls, L, i);
      };
    } else {
      ls.disabled = true;
    }

    row.append(sw, name, mv, ls, del, lk, vis);
    dom.layersEl.appendChild(row);
  });
}

/**
 * Render a 56×10 SVG strip showing the layer's dash pattern in the layer's
 * colour — same visual language as the colour swatch, so the button's current
 * setting is legible at a glance without opening the picker.
 */
function linestylePreviewSvg(style: import('./types').Layer['style'], color: string): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '56');
  svg.setAttribute('height', '10');
  svg.setAttribute('viewBox', '0 0 56 10');
  svg.classList.add('linestyle-preview');
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  line.setAttribute('x1', '2');
  line.setAttribute('y1', '5');
  line.setAttribute('x2', '54');
  line.setAttribute('y2', '5');
  line.setAttribute('stroke', color);
  line.setAttribute('stroke-width', '1.4');
  line.setAttribute('stroke-linecap', 'butt');
  // Scale the world-mm preset to a preview-friendly size so dots don't
  // disappear at 56px. 2.5× feels right for the strip width.
  const resolved = resolveLineStyle(style);
  const patternMm = typeof resolved === 'string'
    ? (LINESTYLE_PATTERNS[resolved] ?? [])
    : resolved.pattern;
  if (patternMm.length) {
    const scaled = patternMm.map(v => (v * 1.6).toFixed(2)).join(' ');
    line.setAttribute('stroke-dasharray', scaled);
  }
  svg.appendChild(line);
  return svg;
}

/**
 * Popover with every preset + a "Benutzerdefiniert…" row that reveals a text
 * input accepting a space/comma-separated mm dash array (e.g. "3 3" or
 * "5,1.5,0.6,1.5"). The popover auto-closes on outside click or Esc.
 */
function openLinestylePopover(anchor: HTMLElement, layer: import('./types').Layer, layerIdx: number): void {
  // Close any existing popover first — there can only be one open.
  document.querySelectorAll('.linestyle-popover').forEach(n => n.remove());

  const pop = document.createElement('div');
  pop.className = 'linestyle-popover';
  // Position is decided after the popover is in the DOM so we can read its
  // measured size. Stash visibility:hidden until then to avoid a one-frame
  // flash in the default corner.
  pop.style.visibility = 'hidden';
  pop.style.left = '0px';
  pop.style.top = '0px';

  const commit = (next: import('./types').Layer['style']): void => {
    pushUndo();
    layer.style = next;
    close();
    renderLayers();
    render();
  };

  for (const preset of LINESTYLE_ORDER) {
    const item = document.createElement('button');
    item.className = 'linestyle-item';
    item.type = 'button';
    const resolvedPreset: LineStylePreset = preset;
    const currentResolved = resolveLineStyle(layer.style);
    if (typeof currentResolved === 'string' && currentResolved === resolvedPreset) {
      item.classList.add('active');
    }
    item.appendChild(linestylePreviewSvg(preset, layer.color));
    const lbl = document.createElement('span');
    lbl.className = 'linestyle-item-label';
    lbl.textContent = LINESTYLE_LABELS[preset];
    item.appendChild(lbl);
    item.onclick = () => commit(preset);
    pop.appendChild(item);
  }

  // Custom row — clicking it reveals the pattern input inline.
  const customRow = document.createElement('div');
  customRow.className = 'linestyle-custom';
  const currentResolved = resolveLineStyle(layer.style);
  const isCustom = typeof currentResolved === 'object' && currentResolved.kind === 'custom';
  const customLabel = document.createElement('div');
  customLabel.className = 'linestyle-item-label' + (isCustom ? ' active' : '');
  customLabel.textContent = 'Benutzerdefiniert (mm):';
  customRow.appendChild(customLabel);
  const inp = document.createElement('input');
  inp.type = 'text';
  inp.className = 'linestyle-custom-input';
  inp.placeholder = 'z. B. 3 3 oder 5,1.5,0.6,1.5';
  if (isCustom && typeof currentResolved === 'object') {
    inp.value = currentResolved.pattern.join(' ');
  }
  inp.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      const nums = inp.value.split(/[\s,]+/).map(s => parseFloat(s)).filter(v => Number.isFinite(v) && v > 0);
      if (nums.length < 2) { toast('Muster benötigt mindestens zwei positive Werte'); return; }
      commit({ kind: 'custom', pattern: nums });
    } else if (ev.key === 'Escape') {
      close();
    }
  });
  customRow.appendChild(inp);
  pop.appendChild(customRow);

  document.body.appendChild(pop);

  // Measure the popover, then decide side + clamp inside the viewport. The
  // layers panel sits on the right edge, so the anchor button is almost
  // always close to the right side — default to opening toward the LEFT of
  // the anchor (i.e. into the canvas area). Fall back to right if there's
  // somehow more room there (e.g. the panel is detached).
  const ar = anchor.getBoundingClientRect();
  const pr = pop.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  const MARGIN = 8;
  const roomLeft = ar.left - MARGIN;
  const roomRight = vw - ar.right - MARGIN;
  let left: number;
  if (roomLeft >= pr.width || roomLeft >= roomRight) {
    left = Math.max(MARGIN, ar.left - pr.width - MARGIN);
  } else {
    left = Math.min(vw - pr.width - MARGIN, ar.right + MARGIN);
  }
  let top = ar.top;
  // Keep the popover inside the viewport vertically — shift up if it would
  // spill below the bottom edge. (Rare for a short list, but harmless.)
  if (top + pr.height > vh - MARGIN) top = Math.max(MARGIN, vh - pr.height - MARGIN);
  pop.style.left = `${Math.round(left)}px`;
  pop.style.top = `${Math.round(top)}px`;
  pop.style.visibility = 'visible';

  inp.focus({ preventScroll: true });

  // Swallow clicks inside the popover; outside clicks close it.
  const onDocDown = (ev: MouseEvent): void => {
    if (!pop.contains(ev.target as Node)) close();
  };
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') close();
  };
  function close(): void {
    document.removeEventListener('mousedown', onDocDown, true);
    document.removeEventListener('keydown', onKey, true);
    pop.remove();
  }
  // Defer attachment so the click that opened the popover doesn't immediately
  // close it via the outside-click listener.
  requestAnimationFrame(() => {
    document.addEventListener('mousedown', onDocDown, true);
    document.addEventListener('keydown', onKey, true);
  });
  // Guard against the layer being deleted while the popover is open.
  if (!state.layers[layerIdx]) close();
}

function formatParamValue(n: number): string {
  if (!Number.isFinite(n)) return '?';
  if (Number.isInteger(n)) return n.toString();
  return n.toFixed(3).replace(/\.?0+$/, '');
}

export function renderParameters(): void {
  dom.paramsEl.innerHTML = '';

  // Update side-count badge
  const badge = document.getElementById('side-count-vars');
  if (badge) badge.textContent = String(state.parameters.length);

  if (!state.parameters.length) {
    const empty = document.createElement('div');
    empty.className = 'panel-empty';
    empty.textContent = 'Keine Variablen. Tippe L, W, … in einem Maß-Prompt.';
    dom.paramsEl.appendChild(empty);
    return;
  }
  for (const p of state.parameters) {
    const row = document.createElement('div');
    row.className = 'param-row';

    const name = document.createElement('div');
    name.className = 'param-name';
    name.textContent = p.name;
    name.title = 'Doppelklick: umbenennen';
    name.ondblclick = async () => {
      const nm = await showPrompt({
        title: 'Variable umbenennen',
        defaultValue: p.name,
        validate: (v) => v.trim() ? null : 'Name darf nicht leer sein',
      });
      if (nm && nm.trim()) {
        updateParameter(p.id, { name: nm.trim() });
        renderParameters();
      }
    };

    const meaning = document.createElement('div');
    meaning.className = 'param-meaning';
    meaning.textContent = p.meaning ?? '';
    meaning.title = 'Doppelklick: Bedeutung ändern';
    meaning.ondblclick = async () => {
      const m = await showPrompt({
        title: `Bedeutung — ${p.name}`,
        message: 'Kurzer Text, wofür diese Variable steht (z.B. „Länge").',
        defaultValue: p.meaning ?? '',
        placeholder: 'z.B. Länge',
      });
      if (m !== null) {
        updateParameter(p.id, { meaning: m.trim() || undefined });
        renderParameters();
      }
    };

    const valueWrap = document.createElement('div');
    valueWrap.className = 'param-value';
    const inp = document.createElement('input');
    inp.type = 'text';
    // Display: formula source if present, else the cached value. Lets the
    // user see and edit "W/4" rather than just the resulting number.
    inp.value = p.formula
      ? (p.formula.kind === 'formula' ? p.formula.src
        : p.formula.kind === 'param'  ? (state.parameters.find(q => q.id === (p.formula as Extract<typeof p.formula, { kind: 'param' }>).id)?.name ?? '?')
        : formatParamValue(p.value))
      : formatParamValue(p.value);
    inp.title = 'Zahl, andere Variable, oder Formel (z.B. W/2, 2*pi*R) — Enter zum Übernehmen';

    // Commit the typed value. Three branches:
    //   1. Plain number → store as constant, clear any existing formula.
    //   2. Single param ref or formula referencing OTHER params → store as
    //      formula, recompute cached value.
    //   3. Self-referential formula (would create a cycle) → reject.
    let committed = false;
    const commit = (): void => {
      if (committed) return;
      const r = parseExprInput(inp.value);
      if (!r || r.kind !== 'expr') {
        inp.value = formatParamValue(p.value);
        toast('Ungültige Eingabe');
        return;
      }
      const expr = r.expr;
      // Self-reference cycle check: a parameter's formula referencing itself
      // (directly or transitively) creates an unsolvable cycle. Detect by
      // seeing if `p.id` appears in this expression's refs OR transitively
      // via other parameters' formulas.
      const refsCycle = (e: Expr, seen: Set<string>): boolean => {
        if (e.kind === 'param') {
          if (e.id === p.id) return true;
          if (seen.has(e.id)) return false;
          seen.add(e.id);
          const dep = state.parameters.find(q => q.id === e.id);
          return !!(dep && dep.formula && refsCycle(dep.formula, seen));
        }
        if (e.kind === 'formula') {
          for (const refId of e.refs) {
            if (refId === p.id) return true;
            if (seen.has(refId)) continue;
            seen.add(refId);
            const dep = state.parameters.find(q => q.id === refId);
            if (dep && dep.formula && refsCycle(dep.formula, seen)) return true;
          }
        }
        return false;
      };
      if (refsCycle(expr, new Set())) {
        inp.value = formatParamValue(p.value);
        toast('Zyklus erkannt — Variable kann sich nicht selbst referenzieren');
        return;
      }
      const v = evalExpr(expr);
      if (!Number.isFinite(v)) {
        inp.value = formatParamValue(p.value);
        toast('Formel ergibt keinen gültigen Wert');
        return;
      }
      committed = true;
      // Decide whether to store as formula or as plain constant.
      const storeFormula = expr.kind !== 'num';
      if (storeFormula) {
        updateParameter(p.id, { value: v, formula: expr });
      } else {
        updateParameter(p.id, { value: v, formula: undefined });
      }
      // Fast-path: tell evaluateTimeline exactly which param changed.
      // recomputeParameters runs first inside evaluateTimeline so any
      // dependent parameters' values catch up before features evaluate.
      evaluateTimeline({ changedParams: [p.id] });
      render();
      renderParameters();
    };

    // Enter in a plain <input type="text"> normally does NOT fire `change` —
    // `change` only fires on blur. Without this handler the Enter keydown
    // bubbles to the window-level Enter shortcut (which re-invokes the last
    // tool) before the value is committed, forcing the user to press Enter a
    // second time. Commit explicitly here and stop the bubble.
    inp.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        ev.stopPropagation();
        commit();
        // commit() rebuilds the panel, so `inp` is already detached — no blur
        // handling needed.
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        inp.value = formatParamValue(p.value);
        inp.blur();
      }
    });
    inp.onchange = commit; // still fires on blur for mouse users
    valueWrap.appendChild(inp);

    const del = document.createElement('div');
    del.className = 'param-del';
    del.textContent = '×';
    del.title = 'Variable löschen';
    del.onclick = () => {
      if (isParameterReferenced(p.id)) {
        toast('Variable wird verwendet — zuerst Referenzen entfernen');
        return;
      }
      deleteParameter(p.id);
      renderParameters();
    };

    row.append(name, meaning, valueWrap, del);
    dom.paramsEl.appendChild(row);
  }
}

const SYSTEM_FEATURE_IDS = new Set([AXIS_X_ID, AXIS_Y_ID]);

/** Map feature kind → tool-column category for the timeline colour bar. */
function featCat(kind: string): string {
  if (['xline', 'parallelXLine', 'dim'].includes(kind)) return 'guide';
  if (['move', 'rotate', 'mirror'].includes(kind)) return 'modify';
  return 'construct';
}

export function renderTimeline(): void {
  dom.timelineEl.innerHTML = '';

  const visible = state.features.filter(f => !SYSTEM_FEATURE_IDS.has(f.id));

  // Update side-count badge
  const badge = document.getElementById('side-count-history');
  if (badge) badge.textContent = String(visible.length);

  if (!visible.length) {
    const empty = document.createElement('div');
    empty.className = 'panel-empty';
    empty.textContent = 'Noch keine Schritte.';
    dom.timelineEl.appendChild(empty);
    return;
  }

  visible.forEach((f, i) => {
    const isLast = i === visible.length - 1;

    const row = document.createElement('div');
    row.className = 'feat-row' + (isLast ? ' active' : '') + (f.hidden ? ' hidden-feat' : '');
    if (f.hidden) row.title = 'Ausgeblendet (noch als Bezug verwendet) — Klick zum Einblenden';

    // Timeline dot
    const dot = document.createElement('div');
    dot.className = 'feat-dot';

    // Category colour bar
    const cat = document.createElement('div');
    cat.className = 'feat-cat';
    cat.dataset.cat = featCat(f.kind);

    // Step number
    const idx = document.createElement('div');
    idx.className = 'feat-idx';
    idx.textContent = (i + 1).toString();

    // Feature type label
    const kind = document.createElement('div');
    kind.className = 'feat-kind';
    kind.textContent = featureLabel(f);

    // Detail string
    const detail = document.createElement('div');
    detail.className = 'feat-detail';
    detail.textContent = featureDetail(f);

    // Delete button
    const del = document.createElement('div');
    del.className = 'feat-del';
    del.textContent = '×';
    del.title = 'Schritt löschen (mit Folge-Schritten)';
    del.onclick = () => {
      pushUndo();
      const { hidden } = deleteFeatures([f.id]);
      updateStats();
      render();
      renderTimeline();
      if (hidden) toast('Ausgeblendet (noch als Bezug verwendet)');
    };

    row.append(dot, cat, idx, kind, detail, del);

    // Click anywhere on a hidden row to unhide (except the × button)
    if (f.hidden) {
      row.addEventListener('click', (ev) => {
        if ((ev.target as HTMLElement).closest('.feat-del')) return;
        pushUndo();
        if (unhideFeature(f.id)) {
          render();
          renderTimeline();
          toast('Wieder eingeblendet');
        }
      });
    }

    dom.timelineEl.appendChild(row);
  });
}

// ============================================================================
// Properties panel
// ============================================================================
//
// Shows editable properties for the currently selected entity. Dispatches on
// entity.type: every shape exposes the fields most users want to tweak after
// the fact (line length/angle, circle radius, text content, …). Fields that
// map 1:1 to an `Expr` accept the same input syntax as draft fields — bare
// number, parameter name (e.g. "L"), or formula ("2*L+5"). Fields backed by a
// non-abs PointRef (a parametric link like "endpoint of feature X") are
// rendered read-only so we don't silently break the linkage.

function mkPropsRow(labelText: string, ...fields: HTMLElement[]): HTMLElement {
  const row = document.createElement('div');
  row.className = 'props-row';
  const lbl = document.createElement('label');
  lbl.className = 'props-label';
  lbl.textContent = labelText;
  row.appendChild(lbl);
  const grp = document.createElement('div');
  grp.className = 'props-field';
  for (const f of fields) grp.appendChild(f);
  row.appendChild(grp);
  return row;
}

function numE(v: number): Expr { return { kind: 'num', value: v }; }

// ── Number / expression helpers ──────────────────────────────────────────

/** Compact numeric display — 3 decimals max, trailing zeros stripped. */
function fmtN(n: number): string {
  if (!Number.isFinite(n)) return '0';
  return (Math.round(n * 1000) / 1000).toString();
}

/** Text representation of an Expr suitable for a text input. Numbers show as
 *  numbers, params as their name, formulas as their source string. */
function exprText(e: Expr): string {
  if (e.kind === 'num')   return fmtN(e.value);
  if (e.kind === 'param') {
    const p = state.parameters.find(x => x.id === e.id);
    return p ? p.name : fmtN(evalExpr(e));
  }
  return e.src;
}

/** Evaluate an Expr to a plain number (0 on failure). */
function exprN(e: Expr): number {
  const v = evalExpr(e);
  return Number.isFinite(v) ? v : 0;
}

/** Parse user input (number / param name / formula). Returns null on invalid. */
function parseExprOrNull(raw: string): Expr | null {
  const r = parseExprInput(raw);
  if (r && r.kind === 'expr') return r.expr;
  return null;
}

// ── Common input factories ───────────────────────────────────────────────

function mkUnit(text: string): HTMLSpanElement {
  const s = document.createElement('span');
  s.className = 'props-unit';
  s.textContent = text;
  return s;
}

function mkMiniLbl(text: string): HTMLSpanElement {
  const s = document.createElement('span');
  s.className = 'props-mini-lbl';
  s.textContent = text;
  return s;
}

/**
 * Text input bound to an Expr. commit() runs on change / Enter. Empty input
 * reverts silently; invalid input toasts and reverts.
 */
function mkExprInput(
  get: () => Expr,
  set: (e: Expr) => void,
  opts?: { unit?: string; min?: number },
): HTMLElement[] {
  const inp = document.createElement('input');
  inp.type = 'text';
  inp.className = 'props-num';
  inp.value = exprText(get());
  const commit = (): void => {
    const raw = inp.value.trim();
    if (!raw) { inp.value = exprText(get()); return; }
    const parsed = parseExprOrNull(raw);
    if (!parsed) { toast('Ungültige Eingabe'); inp.value = exprText(get()); return; }
    // Positive-only guard (radius, width, height…). Evaluate and revert if
    // the value is ≤ min — a non-positive radius would crash the renderer.
    if (opts?.min !== undefined) {
      const v = evalExpr(parsed);
      if (!Number.isFinite(v) || v < opts.min) {
        toast('Wert muss ≥ ' + opts.min + ' sein');
        inp.value = exprText(get());
        return;
      }
    }
    pushUndo();
    set(parsed);
    applyFeaturePatch();
  };
  inp.addEventListener('change', commit);
  inp.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter')       { ev.preventDefault(); inp.blur(); }
    else if (ev.key === 'Escape') { inp.value = exprText(get()); inp.blur(); }
  });
  return opts?.unit ? [inp, mkUnit(opts.unit)] : [inp];
}

/**
 * Degree input for an Expr stored internally as radians. Always commits a
 * `{ kind: 'num' }` expr — formulas and param refs on angles are rare, and
 * replacing them with a literal mirrors how the legacy hatch editor worked.
 */
function mkDegInput(get: () => Expr, set: (e: Expr) => void): HTMLElement[] {
  const inp = document.createElement('input');
  inp.type = 'number';
  inp.step = '1';
  inp.className = 'props-num';
  const toDeg = (): string => fmtN(exprN(get()) * 180 / Math.PI);
  inp.value = toDeg();
  const commit = (): void => {
    const raw = inp.value.replace(',', '.');
    const d = parseFloat(raw);
    if (!Number.isFinite(d)) { inp.value = toDeg(); return; }
    pushUndo();
    set(numE(d * Math.PI / 180));
    applyFeaturePatch();
  };
  inp.addEventListener('change', commit);
  inp.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter')       { ev.preventDefault(); inp.blur(); }
    else if (ev.key === 'Escape') { inp.value = toDeg(); inp.blur(); }
  });
  return [inp, mkUnit('°')];
}

/** Plain-number input that commits to a setter. Used when the underlying
 *  value isn't an Expr (e.g. polyline.closed toggles), but ALSO for length
 *  and angle views where we derive back to the source PointRefs. */
function mkNumInput(
  get: () => number,
  set: (v: number) => void,
  opts?: { unit?: string; step?: string; min?: number; readonly?: boolean },
): HTMLElement[] {
  const inp = document.createElement('input');
  inp.type = 'number';
  inp.step = opts?.step ?? 'any';
  inp.className = 'props-num';
  inp.value = fmtN(get());
  if (opts?.readonly) { inp.readOnly = true; inp.disabled = true; }
  const commit = (): void => {
    const raw = inp.value.replace(',', '.');
    const v = parseFloat(raw);
    if (!Number.isFinite(v)) { inp.value = fmtN(get()); return; }
    if (opts?.min !== undefined && v < opts.min) {
      toast('Wert muss ≥ ' + opts.min + ' sein');
      inp.value = fmtN(get());
      return;
    }
    pushUndo();
    set(v);
    applyFeaturePatch();
  };
  inp.addEventListener('change', commit);
  inp.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter')       { ev.preventDefault(); inp.blur(); }
    else if (ev.key === 'Escape') { inp.value = fmtN(get()); inp.blur(); }
  });
  return opts?.unit ? [inp, mkUnit(opts.unit)] : [inp];
}

// ── PointRef helpers ─────────────────────────────────────────────────────

type AbsRef = Extract<PointRef, { kind: 'abs' }>;

function isAbs(p: PointRef): p is AbsRef { return p.kind === 'abs'; }

/**
 * Render an X/Y editor pair for a PointRef. When the ref is parametric
 * (endpoint/center/intersection/polar), we show the resolved numeric coords
 * as read-only plus a small hint so the user knows the ref is linked.
 */
function mkPointEditor(
  label: string,
  getRef: () => PointRef,
  setRef: (p: PointRef) => void,
  resolved: { x: number; y: number },
): HTMLElement {
  const ref = getRef();
  if (isAbs(ref)) {
    const xFields = mkExprInput(
      () => (getRef() as AbsRef).x,
      (e) => { const c = getRef() as AbsRef; setRef({ kind: 'abs', x: e, y: c.y }); },
    );
    const yFields = mkExprInput(
      () => (getRef() as AbsRef).y,
      (e) => { const c = getRef() as AbsRef; setRef({ kind: 'abs', x: c.x, y: e }); },
    );
    return mkPropsRow(label, mkMiniLbl('X'), ...xFields, mkMiniLbl('Y'), ...yFields);
  }
  // Read-only: just show evaluated coords so the user can still see the
  // point without breaking the parametric link.
  const row = document.createElement('div');
  row.className = 'props-row';
  const lbl = document.createElement('label');
  lbl.className = 'props-label';
  lbl.textContent = label;
  row.appendChild(lbl);
  const grp = document.createElement('div');
  grp.className = 'props-field';
  const info = document.createElement('span');
  info.className = 'props-ref-info';
  info.textContent = `${fmtN(resolved.x)} · ${fmtN(resolved.y)}  (verknüpft)`;
  info.title = 'Dieser Punkt ist an ein anderes Feature gekoppelt und wird nicht direkt bearbeitet.';
  grp.appendChild(info);
  row.appendChild(grp);
  return row;
}

/** Segmented control: one active option at a time. */
function mkSegControl<T extends string>(
  options: ReadonlyArray<{ id: T; label: string; title?: string }>,
  current: T,
  onPick: (id: T) => void,
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'props-seg';
  for (const o of options) {
    const b = document.createElement('button');
    b.className = 'props-seg-btn' + (current === o.id ? ' active' : '');
    b.textContent = o.label;
    if (o.title) b.title = o.title;
    b.onclick = () => onPick(o.id);
    wrap.appendChild(b);
  }
  return wrap;
}

/** Read-only info chip (one small line at the bottom of an editor). */
function mkInfo(text: string): HTMLElement {
  const d = document.createElement('div');
  d.className = 'props-info';
  d.textContent = text;
  return d;
}

/** Write an angle value (degrees from the UI) into a hatch feature; accepts
 *  empty input as "clear" (falls back to the default at render time). */
function patchHatchAngleDeg(fid: string, degText: string): void {
  const f = state.features.find(x => x.id === fid);
  if (!f || f.kind !== 'hatch') return;
  const v = parseFloat(degText);
  if (!isFinite(v)) { f.angle = undefined; return; }
  f.angle = numE(v * Math.PI / 180);
}

function patchHatchSpacing(fid: string, text: string): void {
  const f = state.features.find(x => x.id === fid);
  if (!f || f.kind !== 'hatch') return;
  const v = parseFloat(text);
  if (!isFinite(v) || v <= 0) { f.spacing = undefined; return; }
  f.spacing = numE(v);
}

function patchHatchMode(fid: string, mode: 'solid' | 'lines' | 'cross'): void {
  const f = state.features.find(x => x.id === fid);
  if (!f || f.kind !== 'hatch') return;
  f.mode = mode;
}

function patchHatchColor(fid: string, color: string | undefined): void {
  const f = state.features.find(x => x.id === fid);
  if (!f || f.kind !== 'hatch') return;
  if (color === undefined) delete f.color; else f.color = color;
}

function applyFeaturePatch(): void {
  evaluateTimeline();
  renderProperties();
  renderTimeline();
  render();
}

function renderHatchEditor(fid: string): HTMLElement {
  const f = state.features.find(x => x.id === fid);
  if (!f || f.kind !== 'hatch') return document.createElement('div');

  const root = document.createElement('div');
  root.className = 'props-body';

  // ── Modus (segmented) ──
  const modeWrap = document.createElement('div');
  modeWrap.className = 'props-seg';
  const MODES: Array<{ id: 'solid' | 'lines' | 'cross'; label: string }> = [
    { id: 'solid', label: 'Füllung' },
    { id: 'lines', label: 'Linien' },
    { id: 'cross', label: 'Kreuz'  },
  ];
  for (const m of MODES) {
    const b = document.createElement('button');
    b.className = 'props-seg-btn' + (f.mode === m.id ? ' active' : '');
    b.textContent = m.label;
    b.onclick = () => {
      pushUndo();
      patchHatchMode(fid, m.id);
      applyFeaturePatch();
    };
    modeWrap.appendChild(b);
  }
  root.appendChild(mkPropsRow('Modus', modeWrap));

  // ── Winkel + Abstand (nur bei lines/cross editierbar) ──
  const angleInput = document.createElement('input');
  angleInput.type = 'number';
  angleInput.step = '1';
  angleInput.className = 'props-num';
  const defaultAngleDeg = 45;
  const currentAngleDeg = f.angle ? evalExpr(f.angle) * 180 / Math.PI : defaultAngleDeg;
  angleInput.value = String(Math.round(currentAngleDeg * 100) / 100);
  angleInput.disabled = f.mode === 'solid';
  angleInput.onchange = () => {
    pushUndo();
    patchHatchAngleDeg(fid, angleInput.value);
    applyFeaturePatch();
  };
  const angleUnit = document.createElement('span');
  angleUnit.className = 'props-unit';
  angleUnit.textContent = '°';
  root.appendChild(mkPropsRow('Winkel', angleInput, angleUnit));

  const spacingInput = document.createElement('input');
  spacingInput.type = 'number';
  spacingInput.step = '0.5';
  spacingInput.min = '0.1';
  spacingInput.className = 'props-num';
  const currentSpacing = f.spacing ? evalExpr(f.spacing) : 5;
  spacingInput.value = String(Math.round(currentSpacing * 100) / 100);
  spacingInput.disabled = f.mode === 'solid';
  spacingInput.onchange = () => {
    pushUndo();
    patchHatchSpacing(fid, spacingInput.value);
    applyFeaturePatch();
  };
  const spacingUnit = document.createElement('span');
  spacingUnit.className = 'props-unit';
  spacingUnit.textContent = 'mm';
  root.appendChild(mkPropsRow('Abstand', spacingInput, spacingUnit));

  // ── Farbe ──
  const colorWrap = document.createElement('div');
  colorWrap.className = 'props-color-wrap';
  const useLayerCb = document.createElement('input');
  useLayerCb.type = 'checkbox';
  useLayerCb.checked = f.color === undefined;
  useLayerCb.id = `props-color-layer-${fid}`;
  const useLayerLbl = document.createElement('label');
  useLayerLbl.htmlFor = useLayerCb.id;
  useLayerLbl.textContent = 'Layer';
  useLayerLbl.className = 'props-checkbox-lbl';

  const colorInput = document.createElement('input');
  colorInput.type = 'color';
  colorInput.className = 'props-color';
  colorInput.value = f.color ?? state.layers[f.layer]?.color ?? '#ffffff';
  colorInput.disabled = useLayerCb.checked;

  useLayerCb.onchange = () => {
    pushUndo();
    if (useLayerCb.checked) {
      patchHatchColor(fid, undefined);
    } else {
      patchHatchColor(fid, colorInput.value);
    }
    applyFeaturePatch();
  };

  // Native <input type="color"> is a short-lived popover on most platforms —
  // the dialog closes the moment its input element is removed from the DOM.
  // `applyFeaturePatch()` does exactly that (`renderProperties()` rebuilds
  // the panel via `innerHTML = ''`), so calling it on every `input` event
  // killed the picker before the user could even drag the swatch.
  //
  // New flow:
  //   - `input` fires continuously while the user drags in the picker:
  //     update the hatch colour live on the canvas, but leave the panel DOM
  //     intact so the picker stays open. Push one undo snapshot on the
  //     *first* input event of the session; subsequent drag frames reuse it.
  //   - `change` fires once when the picker closes (commit or dismiss):
  //     rebuild the panel so derived UI (disabled states, checkbox sync) is
  //     refreshed. No second undo push — the snapshot from `input` already
  //     captured the pre-change state.
  let colorUndoPushed = false;
  colorInput.addEventListener('input', () => {
    if (!colorUndoPushed) { pushUndo(); colorUndoPushed = true; }
    patchHatchColor(fid, colorInput.value);
    evaluateTimeline();
    render();
  });
  colorInput.addEventListener('change', () => {
    renderProperties();
    renderTimeline();
  });
  colorWrap.append(useLayerCb, useLayerLbl, colorInput);
  root.appendChild(mkPropsRow('Farbe', colorWrap));

  // ── Info-Zeile: Boundary & Holes ──
  const info = document.createElement('div');
  info.className = 'props-info';
  const holes = f.holes?.length ?? 0;
  info.textContent = `Kontur: ${f.pts.length} Punkte` + (holes > 0 ? ` · ${holes} Aussparung${holes === 1 ? '' : 'en'}` : '');
  root.appendChild(info);

  return root;
}

export function renderProperties(): void {
  const el = dom.propsEl;
  el.innerHTML = '';
  const badge = document.getElementById('side-count-props');

  const selIds = Array.from(state.selection);
  if (selIds.length === 0) {
    if (badge) badge.textContent = '';
    const empty = document.createElement('div');
    empty.className = 'panel-empty';
    empty.textContent = 'Kein Objekt ausgewählt.';
    el.appendChild(empty);
    return;
  }
  if (selIds.length > 1) {
    if (badge) badge.textContent = String(selIds.length);
    // Homogeneous-dim shortcut: when every selected object is a Bemaßung,
    // offer a compact panel that batch-edits text height (+ presets) and the
    // style/align fields across the whole selection. Everything else still
    // hits the "bitte einzeln auswählen" fallback — we haven't generalised
    // multi-edit to other entity types yet.
    const allDims = selIds.every(id => {
      const ent = state.entities.find(e => e.id === id);
      return ent?.type === 'dim';
    });
    if (allDims) {
      el.appendChild(renderMultiDimEditor(selIds));
      return;
    }
    const multi = document.createElement('div');
    multi.className = 'panel-empty';
    multi.textContent = `${selIds.length} Objekte — bitte einzeln auswählen.`;
    el.appendChild(multi);
    return;
  }

  const eid = selIds[0];
  const ent = state.entities.find(e => e.id === eid);
  if (!ent) {
    if (badge) badge.textContent = '';
    const empty = document.createElement('div');
    empty.className = 'panel-empty';
    empty.textContent = 'Objekt nicht gefunden.';
    el.appendChild(empty);
    return;
  }
  if (badge) badge.textContent = '1';

  const feat = featureForEntity(eid);

  // Header: entity type + layer chip.
  const header = document.createElement('div');
  header.className = 'props-header';
  const [sing] = ENTITY_TYPE_LABELS[ent.type] ?? [ent.type, ent.type];
  const title = document.createElement('div');
  title.className = 'props-title';
  title.textContent = sing;
  header.appendChild(title);
  const layer = state.layers[ent.layer];
  if (layer) {
    const chip = document.createElement('div');
    chip.className = 'props-layer-chip';
    const sw = document.createElement('span');
    sw.className = 'props-layer-sw';
    sw.style.background = layer.color;
    const nm = document.createElement('span');
    nm.textContent = layer.name;
    chip.append(sw, nm);
    header.appendChild(chip);
  }
  el.appendChild(header);

  // Dispatch: each editor reads its own feature out of `state.features` by id
  // so mutations always target the persistent source of truth, never the
  // evaluated entity copy.
  if (feat) {
    const body = renderEditorFor(ent, feat);
    if (body) { el.appendChild(body); return; }
  }

  // Fallback: no editor yet for this entity type. Still show "Noch nicht
  // editierbar" so the panel doesn't feel broken.
  const placeholder = document.createElement('div');
  placeholder.className = 'panel-empty';
  placeholder.textContent = 'Noch keine bearbeitbaren Eigenschaften.';
  el.appendChild(placeholder);
}

// ── Per-type editor dispatch ─────────────────────────────────────────────

function renderEditorFor(ent: Entity, feat: Feature): HTMLElement | null {
  if (ent.type === 'hatch'    && feat.kind === 'hatch')    return renderHatchEditor(feat.id);
  if (ent.type === 'line'     && feat.kind === 'line')     return renderLineEditor(feat.id, ent);
  if (ent.type === 'rect'     && feat.kind === 'rect')     return renderRectEditor(feat.id);
  if (ent.type === 'circle'   && feat.kind === 'circle')   return renderCircleEditor(feat.id, ent);
  if (ent.type === 'arc'      && feat.kind === 'arc')      return renderArcEditor(feat.id, ent);
  if (ent.type === 'ellipse'  && feat.kind === 'ellipse')  return renderEllipseEditor(feat.id, ent);
  if (ent.type === 'polyline' && feat.kind === 'polyline') return renderPolylineEditor(feat.id, ent);
  if (ent.type === 'spline'   && feat.kind === 'spline')   return renderSplineEditor(feat.id, ent);
  if (ent.type === 'text'     && feat.kind === 'text')     return renderTextEditor(feat.id);
  if (ent.type === 'dim'      && feat.kind === 'dim')      return renderDimEditor(feat.id, ent);
  return null;
}

// ── Line editor ──────────────────────────────────────────────────────────
//
// Shows start/end points (editable when the refs are abs) plus length and
// angle derived from the evaluated entity. Length/angle edits rebuild p2 as
// a fresh abs PointRef; they work as long as p2 is already abs (a parametric
// p1 stays untouched — we only rewrite p2 relative to the resolved p1). If
// p2 itself is parametric, we block the edit to avoid silently breaking the
// link.

function renderLineEditor(fid: string, ent: Entity): HTMLElement {
  const root = document.createElement('div');
  root.className = 'props-body';
  if (ent.type !== 'line') return root;

  const getF = () => {
    const f = state.features.find(x => x.id === fid);
    return f && f.kind === 'line' ? f : null;
  };

  // Points
  const f0 = getF();
  if (!f0) return root;
  root.appendChild(mkPointEditor('Start',
    () => getF()!.p1,
    (p) => { const f = getF(); if (f) f.p1 = p; },
    { x: ent.x1, y: ent.y1 },
  ));
  root.appendChild(mkPointEditor('Ende',
    () => getF()!.p2,
    (p) => { const f = getF(); if (f) f.p2 = p; },
    { x: ent.x2, y: ent.y2 },
  ));

  // Length + angle: numeric derived view. Editable as long as p2 is abs — a
  // setP2FromPolar only rewrites p2 (p1 stays intact, even when parametric).
  // If p2 is parametric, blocking the edit prevents us from silently
  // converting the p2 link into a numeric coordinate.
  const p2Editable = isAbs(f0.p2);
  const ent2 = () => {
    const e = state.entities.find(x => x.id === ent.id);
    return e && e.type === 'line' ? e : ent;
  };
  const getLen = (): number => {
    const e = ent2();
    return Math.hypot(e.x2 - e.x1, e.y2 - e.y1);
  };
  const getAngDeg = (): number => {
    const e = ent2();
    return Math.atan2(e.y2 - e.y1, e.x2 - e.x1) * 180 / Math.PI;
  };
  const setP2FromPolar = (lenMm: number, angDeg: number): void => {
    const f = getF(); if (!f) return;
    const e = ent2();
    const rad = angDeg * Math.PI / 180;
    const x = e.x1 + Math.cos(rad) * lenMm;
    const y = e.y1 + Math.sin(rad) * lenMm;
    f.p2 = { kind: 'abs', x: numE(x), y: numE(y) };
  };

  root.appendChild(mkPropsRow('Länge',
    ...mkNumInput(
      getLen,
      (v) => setP2FromPolar(v, getAngDeg()),
      { unit: 'mm', min: 0.0001, readonly: !p2Editable },
    ),
  ));
  root.appendChild(mkPropsRow('Winkel',
    ...mkNumInput(
      getAngDeg,
      (v) => setP2FromPolar(getLen(), v),
      { unit: '°', step: '1', readonly: !p2Editable },
    ),
  ));
  if (!p2Editable) {
    // p2 ist parametrisch (z.B. Endpunkt-Referenz auf ein anderes Objekt) —
    // Länge/Winkel würden den Link überschreiben. Zwei Auswege:
    //   (a) Endpunkt-Editor oben → Ende entkoppeln (auf 'Absolut' stellen),
    //   (b) PARAM-Modus (Snap-Toolbar) ausschalten, dann Endpunkt-Grip direkt
    //       auf der Zeichenfläche ziehen.
    root.appendChild(mkInfo('Länge und Winkel sind gesperrt, weil das Ende verknüpft ist. Endpunkt oben entkoppeln — oder PARAM-Modus ausschalten und den Endpunkt direkt ziehen.'));
  }
  return root;
}

// ── Rect editor ──────────────────────────────────────────────────────────

function renderRectEditor(fid: string): HTMLElement {
  const root = document.createElement('div');
  root.className = 'props-body';
  const getF = () => {
    const f = state.features.find(x => x.id === fid);
    return f && f.kind === 'rect' ? f : null;
  };
  const f0 = getF();
  if (!f0) return root;

  // Position (p1 corner)
  root.appendChild(mkPointEditor('Ecke',
    () => getF()!.p1,
    (p) => { const f = getF(); if (f) f.p1 = p; },
    { x: exprN(isAbs(f0.p1) ? f0.p1.x : numE(0)),
      y: exprN(isAbs(f0.p1) ? f0.p1.y : numE(0)) },
  ));

  // Width / height
  root.appendChild(mkPropsRow('Breite',
    ...mkExprInput(
      () => getF()!.width,
      (e) => { const f = getF(); if (f) f.width = e; },
      { unit: 'mm', min: 0.0001 },
    ),
  ));
  root.appendChild(mkPropsRow('Höhe',
    ...mkExprInput(
      () => getF()!.height,
      (e) => { const f = getF(); if (f) f.height = e; },
      { unit: 'mm', min: 0.0001 },
    ),
  ));
  return root;
}

// ── Circle editor ────────────────────────────────────────────────────────

function renderCircleEditor(fid: string, ent: Entity): HTMLElement {
  const root = document.createElement('div');
  root.className = 'props-body';
  if (ent.type !== 'circle') return root;
  const getF = () => {
    const f = state.features.find(x => x.id === fid);
    return f && f.kind === 'circle' ? f : null;
  };
  if (!getF()) return root;

  root.appendChild(mkPointEditor('Zentrum',
    () => getF()!.center,
    (p) => { const f = getF(); if (f) f.center = p; },
    { x: ent.cx, y: ent.cy },
  ));
  root.appendChild(mkPropsRow('Radius',
    ...mkExprInput(
      () => getF()!.radius,
      (e) => { const f = getF(); if (f) f.radius = e; },
      { unit: 'mm', min: 0.0001 },
    ),
  ));
  root.appendChild(mkInfo(`⌀ ${fmtN(ent.r * 2)} mm · Umfang ${fmtN(2 * Math.PI * ent.r)} mm`));
  return root;
}

// ── Arc editor ───────────────────────────────────────────────────────────

function renderArcEditor(fid: string, ent: Entity): HTMLElement {
  const root = document.createElement('div');
  root.className = 'props-body';
  if (ent.type !== 'arc') return root;
  const getF = () => {
    const f = state.features.find(x => x.id === fid);
    return f && f.kind === 'arc' ? f : null;
  };
  if (!getF()) return root;

  root.appendChild(mkPointEditor('Zentrum',
    () => getF()!.center,
    (p) => { const f = getF(); if (f) f.center = p; },
    { x: ent.cx, y: ent.cy },
  ));
  root.appendChild(mkPropsRow('Radius',
    ...mkExprInput(
      () => getF()!.radius,
      (e) => { const f = getF(); if (f) f.radius = e; },
      { unit: 'mm', min: 0.0001 },
    ),
  ));
  root.appendChild(mkPropsRow('Start',
    ...mkDegInput(
      () => getF()!.a1,
      (e) => { const f = getF(); if (f) f.a1 = e; },
    ),
  ));
  root.appendChild(mkPropsRow('Ende',
    ...mkDegInput(
      () => getF()!.a2,
      (e) => { const f = getF(); if (f) f.a2 = e; },
    ),
  ));

  // Sweep / arc length readout
  let sweep = (ent.a2 - ent.a1) * 180 / Math.PI;
  while (sweep < 0)   sweep += 360;
  while (sweep > 360) sweep -= 360;
  const arcLen = ent.r * sweep * Math.PI / 180;
  root.appendChild(mkInfo(`Winkel ${fmtN(sweep)}° · Länge ${fmtN(arcLen)} mm`));
  return root;
}

// ── Ellipse editor ───────────────────────────────────────────────────────

function renderEllipseEditor(fid: string, ent: Entity): HTMLElement {
  const root = document.createElement('div');
  root.className = 'props-body';
  if (ent.type !== 'ellipse') return root;
  const getF = () => {
    const f = state.features.find(x => x.id === fid);
    return f && f.kind === 'ellipse' ? f : null;
  };
  if (!getF()) return root;

  root.appendChild(mkPointEditor('Zentrum',
    () => getF()!.center,
    (p) => { const f = getF(); if (f) f.center = p; },
    { x: ent.cx, y: ent.cy },
  ));
  root.appendChild(mkPropsRow('Radius X',
    ...mkExprInput(
      () => getF()!.rx,
      (e) => { const f = getF(); if (f) f.rx = e; },
      { unit: 'mm', min: 0.0001 },
    ),
  ));
  root.appendChild(mkPropsRow('Radius Y',
    ...mkExprInput(
      () => getF()!.ry,
      (e) => { const f = getF(); if (f) f.ry = e; },
      { unit: 'mm', min: 0.0001 },
    ),
  ));
  root.appendChild(mkPropsRow('Drehung',
    ...mkDegInput(
      () => getF()!.rot,
      (e) => { const f = getF(); if (f) f.rot = e; },
    ),
  ));
  return root;
}

// ── Polyline editor ──────────────────────────────────────────────────────

function renderPolylineEditor(fid: string, ent: Entity): HTMLElement {
  const root = document.createElement('div');
  root.className = 'props-body';
  if (ent.type !== 'polyline') return root;
  const getF = () => {
    const f = state.features.find(x => x.id === fid);
    return f && f.kind === 'polyline' ? f : null;
  };
  const f0 = getF();
  if (!f0) return root;

  // Closed toggle — the only structural change a single-row editor can make
  // without exposing per-vertex XY (too much UI for the sidebar).
  const row = document.createElement('div');
  row.className = 'props-row';
  const lbl = document.createElement('label');
  lbl.className = 'props-label';
  lbl.textContent = 'Geschlossen';
  const field = document.createElement('div');
  field.className = 'props-field';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = !!f0.closed;
  cb.onchange = () => {
    pushUndo();
    const f = getF(); if (f) f.closed = cb.checked;
    applyFeaturePatch();
  };
  field.appendChild(cb);
  row.append(lbl, field);
  root.appendChild(row);

  const L = polylineLength(ent.pts, !!ent.closed);
  root.appendChild(mkInfo(`${ent.pts.length} Punkte · Länge ${fmtN(L)} mm`));
  return root;
}

// ── Spline editor ────────────────────────────────────────────────────────

function renderSplineEditor(fid: string, ent: Entity): HTMLElement {
  const root = document.createElement('div');
  root.className = 'props-body';
  if (ent.type !== 'spline') return root;
  const getF = () => {
    const f = state.features.find(x => x.id === fid);
    return f && f.kind === 'spline' ? f : null;
  };
  const f0 = getF();
  if (!f0) return root;

  const row = document.createElement('div');
  row.className = 'props-row';
  const lbl = document.createElement('label');
  lbl.className = 'props-label';
  lbl.textContent = 'Geschlossen';
  const field = document.createElement('div');
  field.className = 'props-field';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = !!f0.closed;
  cb.onchange = () => {
    pushUndo();
    const f = getF(); if (f) f.closed = cb.checked;
    applyFeaturePatch();
  };
  field.appendChild(cb);
  row.append(lbl, field);
  root.appendChild(row);

  root.appendChild(mkInfo(`${ent.pts.length} Kontrollpunkte`));
  return root;
}

// ── Text editor ──────────────────────────────────────────────────────────

function renderTextEditor(fid: string): HTMLElement {
  const root = document.createElement('div');
  root.className = 'props-body';
  const getF = () => {
    const f = state.features.find(x => x.id === fid);
    return f && f.kind === 'text' ? f : null;
  };
  const f0 = getF();
  if (!f0) return root;

  // Text content — the most common "I need to edit this" for text.
  const textRow = document.createElement('div');
  textRow.className = 'props-row props-row-stack';
  const textLbl = document.createElement('label');
  textLbl.className = 'props-label';
  textLbl.textContent = 'Text';
  const textField = document.createElement('div');
  textField.className = 'props-field';
  const ta = document.createElement('textarea');
  ta.className = 'props-textarea';
  ta.value = f0.text;
  ta.rows = 2;
  ta.onchange = () => {
    const f = getF(); if (!f) return;
    if (f.text === ta.value) return;
    pushUndo();
    f.text = ta.value;
    applyFeaturePatch();
  };
  // Enter in a textarea = newline, as the user expects for multi-line text.
  // Cmd/Ctrl+Enter commits.
  ta.addEventListener('keydown', (ev) => {
    if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') {
      ev.preventDefault(); ta.blur();
    } else if (ev.key === 'Escape') {
      const f = getF(); if (f) ta.value = f.text;
      ta.blur();
    }
  });
  textField.appendChild(ta);
  textRow.append(textLbl, textField);
  root.appendChild(textRow);

  root.appendChild(mkPropsRow('Höhe',
    ...mkExprInput(
      () => getF()!.height,
      (e) => { const f = getF(); if (f) f.height = e; },
      { unit: 'mm', min: 0.0001 },
    ),
  ));
  root.appendChild(mkPropsRow('Drehung',
    ...mkDegInput(
      () => getF()!.rotation,
      (e) => { const f = getF(); if (f) f.rotation = e; },
    ),
  ));

  // Position
  root.appendChild(mkPointEditor('Position',
    () => getF()!.p,
    (p) => { const f = getF(); if (f) f.p = p; },
    { x: exprN(isAbs(f0.p) ? f0.p.x : numE(0)),
      y: exprN(isAbs(f0.p) ? f0.p.y : numE(0)) },
  ));

  // Rahmentext toggle + width
  const wrapRow = document.createElement('div');
  wrapRow.className = 'props-row';
  const wrapLbl = document.createElement('label');
  wrapLbl.className = 'props-label';
  wrapLbl.textContent = 'Umbruch';
  const wrapField = document.createElement('div');
  wrapField.className = 'props-field';
  const wrapCb = document.createElement('input');
  wrapCb.type = 'checkbox';
  wrapCb.checked = f0.boxWidth !== undefined;
  wrapCb.onchange = () => {
    pushUndo();
    const f = getF(); if (!f) return;
    if (wrapCb.checked) {
      // Default wrap width ≈ 40 × text height, matching the draft-tool default.
      f.boxWidth = numE(Math.max(20, exprN(f.height) * 40));
    } else {
      delete f.boxWidth;
    }
    applyFeaturePatch();
  };
  wrapField.appendChild(wrapCb);
  const wrapHint = document.createElement('span');
  wrapHint.className = 'props-checkbox-lbl';
  wrapHint.textContent = f0.boxWidth !== undefined ? 'Rahmentext' : 'Grafiktext';
  wrapField.appendChild(wrapHint);
  wrapRow.append(wrapLbl, wrapField);
  root.appendChild(wrapRow);

  if (f0.boxWidth !== undefined) {
    root.appendChild(mkPropsRow('Breite',
      ...mkExprInput(
        () => {
          const f = getF();
          return f && f.boxWidth !== undefined ? f.boxWidth : numE(0);
        },
        (e) => { const f = getF(); if (f) f.boxWidth = e; },
        { unit: 'mm', min: 0.0001 },
      ),
    ));
  }
  return root;
}

// ── Dim editor ───────────────────────────────────────────────────────────
//
// Dims already have a canvas HUD for text height + align. The properties
// panel mirrors those fields (useful when the dim isn't visible on screen)
// and adds the end-cap style dropdown so users don't have to dig into
// Format → Bemaßungsstil to change a single dim.

/**
 * Shared dim-style + align + size-preset segmented controls. Used by both
 * the single-dim editor and the multi-dim editor so the two panels stay
 * visually consistent and there's only one copy of the click-handler wiring.
 *
 * `currentHeightMm` supplies the value the preset row highlights as active
 * (null for a heterogeneous multi-selection). `applyHeight` commits a new
 * height — single-dim flows go through `applyFeaturePatch` after a direct
 * feature mutation, multi-dim flows call the shared `applyDimTextHeight`.
 */
const DIM_SIZE_PRESETS: ReadonlyArray<{ id: DimSizePresetId; label: string; title: string }> = [
  { id: 'xs',   label: 'XS',  title: `Sehr klein (${DIM_TEXT_PRESET_MM.xs} mm)` },
  { id: 's',    label: 'S',   title: `Klein (${DIM_TEXT_PRESET_MM.s} mm)` },
  { id: 'm',    label: 'M',   title: `Mittel (${DIM_TEXT_PRESET_MM.m} mm)` },
  { id: 'auto', label: 'Auto', title: 'Automatisch – an Zeichnungsgröße anpassen' },
];

function mkDimSizePresetRow(
  currentHeightMm: number | null,
  applyHeight: (mm: number) => void,
): HTMLElement {
  const activeId = currentHeightMm !== null ? matchDimPreset(currentHeightMm) : null;
  // mkSegControl expects a non-null active id; pass a sentinel that won't
  // match any preset so nothing is highlighted when we're in a custom or
  // mixed state.
  const current: DimSizePresetId = (activeId ?? '__none__') as DimSizePresetId;
  return mkPropsRow('Größe',
    mkSegControl(DIM_SIZE_PRESETS, current, (id) => applyHeight(resolveDimPresetMm(id))),
  );
}

function renderDimEditor(fid: string, ent: Entity): HTMLElement {
  const root = document.createElement('div');
  root.className = 'props-body';
  if (ent.type !== 'dim') return root;
  const getF = () => {
    const f = state.features.find(x => x.id === fid);
    return f && f.kind === 'dim' ? f : null;
  };
  const f0 = getF();
  if (!f0) return root;

  // Size presets first — most users don't want to type a number, they want
  // to pick "klein" and move on. The raw Textgröße input below stays for
  // anyone who needs a precise value or a parametric expression.
  root.appendChild(mkDimSizePresetRow(
    exprN(f0.textHeight),
    (mm) => {
      pushUndo();
      const f = getF(); if (f) f.textHeight = numExpr(mm);
      applyFeaturePatch();
    },
  ));

  root.appendChild(mkPropsRow('Textgröße',
    ...mkExprInput(
      () => getF()!.textHeight,
      (e) => { const f = getF(); if (f) f.textHeight = e; },
      { unit: 'mm', min: 0.1 },
    ),
  ));

  const STYLES: ReadonlyArray<{ id: DimStyle; label: string; title: string }> = [
    { id: 'arrow', label: '→',  title: 'Pfeilspitze' },
    { id: 'open',  label: '⟩',  title: 'Offener Pfeil' },
    { id: 'tick',  label: '╱',  title: 'Architekturstrich' },
    { id: 'arch',  label: '⌒',  title: 'Bogen' },
  ];
  const curStyle: DimStyle = f0.style ?? runtime.dimStyle;
  root.appendChild(mkPropsRow('Endpunkt',
    mkSegControl(STYLES, curStyle, (id) => {
      pushUndo();
      const f = getF(); if (f) f.style = id;
      applyFeaturePatch();
    }),
  ));

  const ALIGNS: ReadonlyArray<{ id: DimTextAlign; label: string; title: string }> = [
    { id: 'start',  label: '├', title: 'Am ersten Endpunkt' },
    { id: 'center', label: '┼', title: 'Mittig' },
    { id: 'end',    label: '┤', title: 'Am zweiten Endpunkt' },
  ];
  const curAlign: DimTextAlign = f0.textAlign ?? 'center';
  root.appendChild(mkPropsRow('Textlage',
    mkSegControl(ALIGNS, curAlign, (id) => {
      pushUndo();
      const f = getF(); if (!f) return;
      if (id === 'center') delete f.textAlign; else f.textAlign = id;
      applyFeaturePatch();
    }),
  ));

  // Readout
  const L = Math.hypot(ent.p2.x - ent.p1.x, ent.p2.y - ent.p1.y);
  root.appendChild(mkInfo(`Abstand ${fmtN(L)} mm`));
  return root;
}

/**
 * Properties panel for a homogeneous multi-selection of dims. Exposes the
 * same controls as the single-dim editor — size presets, text height, style,
 * align — but writes through the existing `applyDim*` helpers that iterate
 * the selection and push a single undo frame.
 *
 * Heterogeneous fields (e.g. some dims are 3 mm, others 5 mm) render with
 * no active preset and a placeholder-style text height input. Typing a value
 * or clicking a preset unifies the batch.
 */
function renderMultiDimEditor(selIds: number[]): HTMLElement {
  const root = document.createElement('div');
  root.className = 'props-body';

  // Summary header — so the user knows the panel applies to the whole batch,
  // not just one item (the single-select panel's title is identical otherwise).
  const header = document.createElement('div');
  header.className = 'props-header';
  const title = document.createElement('div');
  title.className = 'props-title';
  title.textContent = `${selIds.length} Bemaßungen`;
  header.appendChild(title);
  root.appendChild(header);

  // Collect current values so we can show a unified state when the batch
  // happens to agree, and an "indeterminate" state when they don't.
  const heights: number[] = [];
  const styles = new Set<DimStyle>();
  const aligns = new Set<DimTextAlign>();
  for (const id of selIds) {
    const feat = featureForEntity(id);
    if (feat?.kind !== 'dim') continue;
    heights.push(evalExpr(feat.textHeight));
    styles.add(feat.style ?? runtime.dimStyle);
    aligns.add(feat.textAlign ?? 'center');
  }
  const uniformHeight = heights.length > 0 && heights.every(h => Math.abs(h - heights[0]) < DIM_PRESET_MATCH_EPS)
    ? heights[0] : null;
  const uniformStyle  = styles.size === 1  ? [...styles][0]  : null;
  const uniformAlign  = aligns.size === 1  ? [...aligns][0]  : null;

  root.appendChild(mkDimSizePresetRow(uniformHeight, (mm) => applyDimTextHeight(mm)));

  // Raw mm input — plain number rather than Expr so we don't have to guess
  // which feature's expression to seed the field with. Empty / invalid input
  // reverts silently, matching the single-dim editor's UX.
  const heightInp = document.createElement('input');
  heightInp.type = 'text';
  heightInp.className = 'props-num';
  heightInp.value = uniformHeight !== null ? fmtN(uniformHeight) : '';
  heightInp.placeholder = uniformHeight === null ? 'gemischt' : '';
  const commitHeight = (): void => {
    const raw = heightInp.value.replace(',', '.').trim();
    if (!raw) { heightInp.value = uniformHeight !== null ? fmtN(uniformHeight) : ''; return; }
    const v = parseFloat(raw);
    if (!Number.isFinite(v) || v < 0.1) {
      toast('Wert muss ≥ 0.1 sein');
      heightInp.value = uniformHeight !== null ? fmtN(uniformHeight) : '';
      return;
    }
    applyDimTextHeight(v);
  };
  heightInp.addEventListener('change', commitHeight);
  heightInp.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter')       { ev.preventDefault(); heightInp.blur(); }
    else if (ev.key === 'Escape') { heightInp.blur(); }
  });
  root.appendChild(mkPropsRow('Textgröße', heightInp, mkUnit('mm')));

  const STYLES: ReadonlyArray<{ id: DimStyle; label: string; title: string }> = [
    { id: 'arrow', label: '→',  title: 'Pfeilspitze' },
    { id: 'open',  label: '⟩',  title: 'Offener Pfeil' },
    { id: 'tick',  label: '╱',  title: 'Architekturstrich' },
    { id: 'arch',  label: '⌒',  title: 'Bogen' },
  ];
  // When the selection is mixed we still need to pass an id; use a sentinel
  // that won't match so nothing is highlighted. Same trick as mkDimSizePresetRow.
  const curStyle: DimStyle = (uniformStyle ?? '__none__') as DimStyle;
  root.appendChild(mkPropsRow('Endpunkt',
    mkSegControl(STYLES, curStyle, (styleId) => {
      // Match the single-dim editor's pattern: pushUndo first, mutate every
      // selected dim's feature, then let applyFeaturePatch refresh panel +
      // canvas. We don't go through `applyDimStyle` here because that helper
      // also rewrites `runtime.dimStyle` (the global default for new dims),
      // which is a side-effect the single-dim editor avoids and we want
      // parity between the two panels.
      pushUndo();
      for (const id of selIds) {
        const f = featureForEntity(id);
        if (f?.kind === 'dim') f.style = styleId;
      }
      applyFeaturePatch();
    }),
  ));

  const ALIGNS: ReadonlyArray<{ id: DimTextAlign; label: string; title: string }> = [
    { id: 'start',  label: '├', title: 'Am ersten Endpunkt' },
    { id: 'center', label: '┼', title: 'Mittig' },
    { id: 'end',    label: '┤', title: 'Am zweiten Endpunkt' },
  ];
  const curAlign: DimTextAlign = (uniformAlign ?? '__none__') as DimTextAlign;
  root.appendChild(mkPropsRow('Textlage',
    mkSegControl(ALIGNS, curAlign, (id) => applyDimTextAlign(id)),
  ));

  // Summary footer — quick sanity check that mirrors the single-dim readout.
  if (uniformHeight !== null) {
    root.appendChild(mkInfo(`${selIds.length} Bemaßungen · Texthöhe ${fmtN(uniformHeight)} mm`));
  } else {
    root.appendChild(mkInfo(`${selIds.length} Bemaßungen · gemischte Texthöhen`));
  }
  return root;
}
