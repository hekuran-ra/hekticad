import './styles.css';

import type { Pt } from './types';
import { state, runtime } from './state';
import { screenToWorld } from './math';
import { collectSnapPoints } from './snap';
import { hitTest } from './hittest';
import { render, requestRender, resize } from './render';
import {
  cancelTool, deleteSelection, handleClick,
  renderToolsPanel, selectByBox, setTool, TOOLS, updatePreview,
} from './tools';
import { clearAll, exportSvg, loadJson, saveJson } from './io';
import { zoomFit } from './view';
import { ensureAxisFeatures, evaluateTimeline, featureForEntity, replaceFeatureFromInit } from './features';
import { createParameter, findParamByName } from './params';
import { pushUndo, redo, undo } from './undo';
import {
  renderLayers, toast, updatePosStatus, updateSelStatus,
  updateStats, updateZoomStatus,
} from './ui';
import { cmdBarHasFocus, cmdBarHasFields, focusCmdBar, handleBareEnter } from './cmdbar';
import { dom } from './dom';
import { initThemes } from './themes';

// Keep the linter happy in case future phases remove direct usage.
void updateStats;

const { cv } = dom;

/** Reference point for tangent/perpendicular snap: the tool's current anchor. */
function snapFromPt(): Pt | null {
  const tc = runtime.toolCtx;
  if (!tc) return null;
  if (state.tool === 'line' && tc.step === 'p2' && tc.p1) return tc.p1;
  if (state.tool === 'polyline' && tc.pts && tc.pts.length > 0) return tc.pts[tc.pts.length - 1];
  if ((state.tool === 'move' || state.tool === 'copy') && tc.step === 'target' && tc.basePt) return tc.basePt;
  return null;
}

// ----------------- Mouse -----------------

cv.addEventListener('mousemove', (e) => {
  const r = cv.getBoundingClientRect();
  state.mouseScreen = { x: e.clientX - r.left, y: e.clientY - r.top };
  state.mouseWorld = screenToWorld(state.mouseScreen);
  runtime.orthoSnap = e.shiftKey && state.tool !== 'select';
  updatePosStatus(state.mouseWorld.x, state.mouseWorld.y);

  if (runtime.pan) {
    state.view.x += e.clientX - runtime.pan.lastX;
    state.view.y += e.clientY - runtime.pan.lastY;
    runtime.pan.lastX = e.clientX;
    runtime.pan.lastY = e.clientY;
    runtime.lastSnap = null;
    runtime.hoveredId = null;
  } else {
    runtime.lastSnap = collectSnapPoints(state.mouseWorld, snapFromPt());
    // Include locked layers so axis xlines also highlight on hover.
    runtime.hoveredId = hitTest(state.mouseWorld, undefined, true)?.id ?? null;
  }
  if (runtime.dragSelect && !runtime.dragSelect.active) {
    const dx = e.clientX - runtime.dragSelect.startClientX;
    const dy = e.clientY - runtime.dragSelect.startClientY;
    if (dx * dx + dy * dy > 9) runtime.dragSelect.active = true;
  }
  updatePreview();
  requestRender();
});

cv.addEventListener('mousedown', (e) => {
  if (e.button === 1 || (e.button === 0 && runtime.spacePan) || (e.button === 0 && state.tool === 'pan')) {
    runtime.pan = { lastX: e.clientX, lastY: e.clientY };
    cv.style.cursor = 'grabbing';
    return;
  }
  if (e.button === 2) { e.preventDefault(); cancelTool(); return; }
  if (e.button === 0) {
    const world: Pt = runtime.lastSnap
      ? { x: runtime.lastSnap.x, y: runtime.lastSnap.y }
      : { ...state.mouseWorld };
    if (state.tool === 'select') {
      // Alt+Drag: duplicate hit entity (or current selection if hit is in it)
      // and drag the copy. Existing copy-tool pipeline handles the transform.
      if (e.altKey) {
        const hit = hitTest(world);
        if (hit) {
          if (!state.selection.has(hit.id)) {
            state.selection.clear();
            state.selection.add(hit.id);
          }
          setTool('copy');
          runtime.toolCtx = { step: 'target', basePt: world };
          runtime.dragCopy = true;
          return;
        }
      }
      runtime.dragSelect = {
        worldStart: world,
        startClientX: e.clientX,
        startClientY: e.clientY,
        active: false,
        shift: e.shiftKey,
      };
      return;
    }
    handleClick(world, e.shiftKey);
  }
});

cv.addEventListener('mouseup', () => {
  runtime.pan = null;
  cv.style.cursor = state.tool === 'pan' ? 'grab' : '';
  if (runtime.dragCopy) {
    const target: Pt = runtime.lastSnap
      ? { x: runtime.lastSnap.x, y: runtime.lastSnap.y }
      : { ...state.mouseWorld };
    handleClick(target);
    runtime.dragCopy = false;
    setTool('select');
    return;
  }
  const ds = runtime.dragSelect;
  if (ds) {
    if (ds.active) {
      const end: Pt = runtime.lastSnap
        ? { x: runtime.lastSnap.x, y: runtime.lastSnap.y }
        : state.mouseWorld;
      selectByBox(ds.worldStart, end, ds.shift);
    } else {
      handleClick(ds.worldStart, ds.shift);
    }
    runtime.dragSelect = null;
    requestRender();
  }
});

cv.addEventListener('dblclick', (e) => {
  const r = cv.getBoundingClientRect();
  const world = screenToWorld({ x: e.clientX - r.left, y: e.clientY - r.top });
  const hit = hitTest(world);
  if (!hit || hit.type !== 'dim') return;
  const dx = hit.p2.x - hit.p1.x, dy = hit.p2.y - hit.p1.y;
  const L = Math.hypot(dx, dy);
  if (L < 1e-9) return;
  const input = window.prompt('Neues Maß:', L.toFixed(3));
  if (input == null) return;
  const val = parseFloat(input.replace(',', '.'));
  if (!isFinite(val) || val <= 0) { toast('Ungültiges Maß'); return; }
  pushUndo();
  const ux = dx / L, uy = dy / L;
  const fid = featureForEntity(hit.id)?.id;
  if (!fid) return;
  replaceFeatureFromInit(fid, {
    type: 'dim',
    p1: { x: hit.p1.x, y: hit.p1.y },
    p2: { x: hit.p1.x + ux * val, y: hit.p1.y + uy * val },
    offset: { x: hit.offset.x, y: hit.offset.y },
    textHeight: hit.textHeight,
    layer: hit.layer,
  });
  evaluateTimeline();
  requestRender();
});

cv.addEventListener('contextmenu', (e) => e.preventDefault());

cv.addEventListener('wheel', (e) => {
  e.preventDefault();
  const factor = Math.exp(-e.deltaY * 0.0015);
  const r = cv.getBoundingClientRect();
  const mx = e.clientX - r.left, my = e.clientY - r.top;
  const before = screenToWorld({ x: mx, y: my });
  state.view.scale *= factor;
  state.view.scale = Math.max(0.01, Math.min(2000, state.view.scale));
  const after = screenToWorld({ x: mx, y: my });
  state.view.x += (after.x - before.x) * state.view.scale;
  state.view.y -= (after.y - before.y) * state.view.scale;
  updateZoomStatus();
  render();
}, { passive: false });

// ----------------- Keyboard -----------------

window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.altKey) {
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) { undo(); e.preventDefault(); return; }
    if (k === 'y' || (k === 'z' && e.shiftKey)) { redo(); e.preventDefault(); return; }
    if (k === 's') { saveJson(); e.preventDefault(); return; }
    if (k === 'a' && !cmdBarHasFocus()) {
      state.selection.clear();
      for (const ent of state.entities) {
        if (!state.layers[ent.layer]?.locked) state.selection.add(ent.id);
      }
      updateSelStatus();
      requestRender();
      e.preventDefault();
      return;
    }
  }

  // Cmdbar fields handle their own Enter/Tab/Escape/Backspace.
  if (cmdBarHasFocus()) return;

  if (e.key === 'Enter') {
    if (handleBareEnter()) { e.preventDefault(); return; }
    // AutoCAD convention: Enter in idle re-invokes the most recent tool.
    if (state.tool === 'select' && runtime.lastInvokedTool) {
      setTool(runtime.lastInvokedTool as Parameters<typeof setTool>[0]);
      e.preventDefault();
      return;
    }
  }
  // Any printable character while tool-input fields are active → route to first field.
  // This prevents tool shortcuts (e.g. L → Line) from firing when the user intends
  // to type a parameter name like "L" or "W" into a dimension field.
  if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && cmdBarHasFields()) {
    e.preventDefault();
    focusCmdBar();
    const inp = document.activeElement as HTMLInputElement | null;
    if (inp && inp.classList.contains('cmd-field-input')) inp.value += e.key;
    return;
  }
  if (e.key === ' ') { runtime.spacePan = true; cv.style.cursor = 'grab'; e.preventDefault(); return; }
  if (e.key === 'Escape') { cancelTool(); return; }
  if (e.key === 'Home') { zoomFit(); e.preventDefault(); return; }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    deleteSelection();
    e.preventDefault();
    return;
  }
  const shortcut = TOOLS.find(t => t.key.toLowerCase() === e.key.toLowerCase() && !t.action);
  if (shortcut) {
    setTool(shortcut.id as Exclude<typeof shortcut.id, 'delete'>);
    return;
  }
});

window.addEventListener('keyup', (e) => {
  if (e.key === ' ') { runtime.spacePan = false; cv.style.cursor = ''; }
  if (e.key === 'Shift' && runtime.orthoSnap) {
    runtime.orthoSnap = false;
    updatePreview();
    requestRender();
  }
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Shift' && state.tool !== 'select' && !runtime.orthoSnap) {
    runtime.orthoSnap = true;
    updatePreview();
    requestRender();
  }
}, { passive: true });

// ----------------- Grid size input (in snap overlay) -----------------

const gridInput = document.getElementById('grid-size') as HTMLInputElement | null;
if (gridInput) {
  gridInput.value = String(runtime.snapSettings.gridSize);
  gridInput.oninput = () => {
    runtime.snapSettings.gridSize = Math.max(0.1, parseFloat(gridInput.value) || 10);
    requestRender();
  };
}

const btnAddLayer = document.getElementById('btn-addlayer') as HTMLButtonElement;
btnAddLayer.onclick = () => {
  const name = prompt('Layer-Name:', 'Layer ' + (state.layers.length + 1));
  if (!name) return;
  state.layers.push({ name, color: '#cccccc', visible: true });
  renderLayers();
};

const btnAddParam = document.getElementById('btn-addparam') as HTMLButtonElement;
btnAddParam.onclick = () => {
  const name = prompt('Variablen-Name (z.B. L):');
  if (!name || !name.trim()) return;
  const trimmed = name.trim();
  if (findParamByName(trimmed)) { toast('Variable existiert bereits'); return; }
  const valRaw = prompt(`Wert für ${trimmed}:`, '0');
  if (valRaw == null) return;
  const val = parseFloat(valRaw.replace(',', '.'));
  if (!Number.isFinite(val)) { toast('Ungültige Zahl'); return; }
  const meaning = prompt(`Bedeutung von ${trimmed} (z.B. „Länge"):`, '') ?? '';
  createParameter(trimmed, val, meaning.trim() || undefined);
  updateStats();
};

(document.getElementById('btn-save')   as HTMLButtonElement).onclick = saveJson;
(document.getElementById('btn-load')   as HTMLButtonElement).onclick = loadJson;
(document.getElementById('btn-export') as HTMLButtonElement).onclick = exportSvg;
(document.getElementById('btn-clear')  as HTMLButtonElement).onclick = clearAll;

// ----------------- Boot -----------------

ensureAxisFeatures();
evaluateTimeline();

window.addEventListener('resize', resize);
initThemes();
renderToolsPanel();
renderLayers();
updateStats();
updateSelStatus();
setTool('select');
resize();

// ----------------- Sidebar collapsible sections -----------------

document.querySelectorAll<HTMLButtonElement>('.side-section-header').forEach(btn => {
  btn.addEventListener('click', () => {
    const section = btn.closest<HTMLElement>('.side-section');
    if (!section) return;
    const opening = section.classList.contains('closed');
    section.classList.toggle('open', opening);
    section.classList.toggle('closed', !opening);
  });
});

// ----------------- Canvas snap-toolbar overlay wiring -----------------
//
// The overlay is the ONLY source of truth for snap settings. State lives in
// `runtime.snapSettings`; buttons toggle fields directly and re-sync visuals.

/** Keys of SnapSettings that correspond to individual snap types (not grid). */
const FANG_KEYS = ['end', 'mid', 'int', 'center', 'tangent', 'perp'] as const;
type FangKey = typeof FANG_KEYS[number];

function syncSnapOverlay(): void {
  const s = runtime.snapSettings;
  const setOn = (id: string, on: boolean) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('on', on);
  };
  setOn('tb-raster',   s.showGrid);
  setOn('tb-gridsnap', s.grid);
  setOn('tb-end',      s.end);
  setOn('tb-mid',      s.mid);
  setOn('tb-int',      s.int);
  setOn('tb-ctr',      s.center);
  setOn('tb-perp',     s.perp);
  setOn('tb-tan',      s.tangent);
  // Master FANG lights up if ANY individual snap is active.
  const anyFang = FANG_KEYS.some(k => s[k]);
  setOn('tb-fang', anyFang);
}

function tbBind(btnId: string, toggle: () => void): void {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.addEventListener('click', () => {
    toggle();
    syncSnapOverlay();
    requestRender();
  });
}

tbBind('tb-raster',   () => { runtime.snapSettings.showGrid = !runtime.snapSettings.showGrid; });
tbBind('tb-gridsnap', () => { runtime.snapSettings.grid     = !runtime.snapSettings.grid; });
tbBind('tb-end',      () => { runtime.snapSettings.end      = !runtime.snapSettings.end; });
tbBind('tb-mid',      () => { runtime.snapSettings.mid      = !runtime.snapSettings.mid; });
tbBind('tb-int',      () => { runtime.snapSettings.int      = !runtime.snapSettings.int; });
tbBind('tb-ctr',      () => { runtime.snapSettings.center   = !runtime.snapSettings.center; });
tbBind('tb-perp',     () => { runtime.snapSettings.perp     = !runtime.snapSettings.perp; });
tbBind('tb-tan',      () => { runtime.snapSettings.tangent  = !runtime.snapSettings.tangent; });

// Master FANG: all individual snaps on if any was off, otherwise all off.
tbBind('tb-fang', () => {
  const s = runtime.snapSettings;
  const anyOn = FANG_KEYS.some(k => s[k]);
  const target = !anyOn;
  FANG_KEYS.forEach((k: FangKey) => { s[k] = target; });
});

syncSnapOverlay();

// ----------------- Viewcube overlay wiring -----------------

const vcZoomIn  = document.getElementById('vc-zoom-in')  as HTMLButtonElement | null;
const vcZoomOut = document.getElementById('vc-zoom-out') as HTMLButtonElement | null;
const vcFit     = document.getElementById('vc-zoom-fit') as HTMLButtonElement | null;

if (vcZoomIn) vcZoomIn.onclick = () => {
  state.view.scale = Math.min(2000, state.view.scale * 1.25);
  updateZoomStatus(); requestRender();
};
if (vcZoomOut) vcZoomOut.onclick = () => {
  state.view.scale = Math.max(0.01, state.view.scale / 1.25);
  updateZoomStatus(); requestRender();
};
if (vcFit) vcFit.onclick = () => zoomFit();

// Dev-only debug hook for programmatic verification in the browser console.
// Stripped from production builds via the DEV guard.
if ((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV) {
  (window as unknown as { __hek: unknown }).__hek = {
    state, runtime, setTool, handleClick,
    updateSelStatus,
  };
}
