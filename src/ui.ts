import type { DimEntity, DimStyle } from './types';
import { state, runtime } from './state';
import { render, requestRender } from './render';
import { dom } from './dom';
import {
  deleteParameter, evalExpr, isParameterReferenced, parseExprInput, updateParameter,
} from './params';
import {
  AXIS_X_ID, AXIS_Y_ID,
  deleteFeatures, evaluateTimeline, featureDetail, featureForEntity, featureLabel,
  moveEntityToLayer,
} from './features';
import { pushUndo } from './undo';
import { bindSetPrompt, rebuildCmdBar } from './cmdbar';
import { getDraftInfo } from './draftinfo';
import { syncToolAvailability } from './tools';

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
  dom.stats.textContent = `${n} Objekt${n === 1 ? '' : 'e'}`;
  renderParameters();
  renderTimeline();
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
  // Layer rows show a "move selection here" button whose visibility depends
  // on the current selection, so re-render whenever selection changes.
  renderLayers();
  // Selection-gated tools (move, offset, mirror, …) greyed-out when nothing
  // is selected — re-sync the rail whenever the selection count changes.
  syncToolAvailability();
}

// ----------------- Dimension style picker -----------------
//
// Floats below the snap-overlay. Visible when the dim tool is active OR when
// at least one dim entity is selected. Clicking a style button:
//   - updates runtime.dimStyle (the global default for new dims),
//   - and patches `style` on any dim features whose entities are selected, so
//     existing dims repaint immediately.

const DIM_STYLES: readonly DimStyle[] = ['arrow', 'open', 'tick', 'arch'];
const dimPicker = document.getElementById('dim-picker') as HTMLElement | null;

export function syncDimPicker(): void {
  if (!dimPicker) return;
  const toolIsDim = state.tool === 'dim';
  const selectedDims = [...state.selection]
    .map(id => state.entities.find(e => e.id === id))
    .filter((e): e is DimEntity => !!e && e.type === 'dim');
  const show = toolIsDim || selectedDims.length > 0;
  dimPicker.toggleAttribute('hidden', !show);
  if (!show) return;

  // Effective style: when a homogeneous selection of dims exists, reflect
  // their shared style; otherwise reflect the runtime default.
  let effective: DimStyle = runtime.dimStyle;
  if (selectedDims.length > 0) {
    const styles = new Set(selectedDims.map(d => d.style ?? runtime.dimStyle));
    if (styles.size === 1) effective = [...styles][0];
  }
  dimPicker.querySelectorAll<HTMLButtonElement>('.dim-style-btn').forEach(btn => {
    btn.classList.toggle('on', btn.dataset.style === effective);
  });
}

if (dimPicker) {
  dimPicker.addEventListener('click', (ev) => {
    const target = ev.target;
    if (!(target instanceof Element)) return;
    const btn = target.closest<HTMLButtonElement>('.dim-style-btn');
    if (!btn) return;
    const style = btn.dataset.style as DimStyle | undefined;
    if (!style || !DIM_STYLES.includes(style)) return;
    runtime.dimStyle = style;
    let patched = 0;
    for (const id of state.selection) {
      const ent = state.entities.find(e => e.id === id);
      if (!ent || ent.type !== 'dim') continue;
      const feat = featureForEntity(id);
      if (feat && feat.kind === 'dim') { feat.style = style; patched++; }
    }
    if (patched > 0) evaluateTimeline();
    syncDimPicker();
    requestRender();
  });
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
    html = `X: <b>${x.toFixed(2)}</b>  Y: <b>${y.toFixed(2)}</b>`;
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
      sw.onclick = (ev) => {
        ev.stopPropagation();
        const inp = document.createElement('input');
        inp.type = 'color';
        inp.value = rgbToHex(L.color);
        inp.oninput = () => { L.color = inp.value; renderLayers(); render(); };
        inp.click();
      };
    }

    // Layer name — double-click to rename
    const name = document.createElement('div');
    name.className = 'layer-name';
    name.textContent = L.name;
    if (!L.locked) {
      name.ondblclick = (ev) => {
        ev.stopPropagation();
        const nm = prompt('Layer umbenennen:', L.name);
        if (nm) { L.name = nm; renderLayers(); }
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
      // Don't allow unlocking built-in axis layer (index 0).
      if (L.locked && i === 0) return;
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

    row.append(sw, name, mv, lk, vis);
    dom.layersEl.appendChild(row);
  });
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
    name.ondblclick = () => {
      const nm = prompt('Variable umbenennen:', p.name);
      if (nm && nm.trim()) {
        updateParameter(p.id, { name: nm.trim() });
        renderParameters();
      }
    };

    const meaning = document.createElement('div');
    meaning.className = 'param-meaning';
    meaning.textContent = p.meaning ?? '';
    meaning.title = 'Doppelklick: Bedeutung ändern';
    meaning.ondblclick = () => {
      const m = prompt('Bedeutung:', p.meaning ?? '');
      if (m !== null) {
        updateParameter(p.id, { meaning: m.trim() || undefined });
        renderParameters();
      }
    };

    const valueWrap = document.createElement('div');
    valueWrap.className = 'param-value';
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.value = formatParamValue(p.value);
    inp.title = 'Zahl oder Formel (z.B. L/2, 2*pi*R)';
    inp.onchange = () => {
      // Accept literal numbers AND formulas. Parameter VALUES are stored as
      // plain numbers (the parameter itself isn't a formula), so we parse,
      // evaluate once, and persist the result. If a user wants one parameter
      // to always follow another, they'd build a feature with a formula Expr;
      // that's out of scope for the Parameters panel.
      const r = parseExprInput(inp.value);
      let v: number | null = null;
      if (r && r.kind === 'expr') v = evalExpr(r.expr);
      if (v == null || !Number.isFinite(v)) {
        inp.value = formatParamValue(p.value);
        toast('Ungültige Eingabe');
        return;
      }
      updateParameter(p.id, { value: v });
      evaluateTimeline();
      render();
      renderParameters();
    };
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
    row.className = 'feat-row' + (isLast ? ' active' : '');

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
      deleteFeatures([f.id]);
      updateStats();
      render();
    };

    row.append(dot, cat, idx, kind, detail, del);
    dom.timelineEl.appendChild(row);
  });
}
