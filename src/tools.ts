import type { Entity, EntityInit, EntityShape, Expr, Feature, LineEntity, PointRef, Pt, RectEntity, SnapPoint, ToolId } from './types';
import { state, runtime } from './state';
import {
  add, dist, dot, len, norm, orthoSnap, perp, perpOffset, scale, sub,
} from './math';
import { angleInSweep, hitTest, nearestPolySegment, nearestRectEdge, pickReference } from './hittest';
import { render } from './render';
import { dom } from './dom';
import {
  setPrompt, setTip, syncDimPicker, toast, updateSelStatus, updateStats,
} from './ui';
import { pushUndo } from './undo';
import { evalExpr } from './params';
import {
  addFeatureFromInit, deleteFeatures, entityIdForFeature, evaluateTimeline,
  featureForEntity, featureFromEntityInit, newFeatureId, replaceFeatureFromInit,
} from './features';

const numE = (v: number): Expr => ({ kind: 'num', value: v });

/**
 * Convert a snap point into a PointRef. When the snap has an entityId that
 * maps to a known feature, we create a relational ref (endpoint/center/mid)
 * so the geometry stays live when parameters change. Otherwise we fall back
 * to an absolute coord ref.
 */
function snapToPointRef(snap: SnapPoint | null, fallback: Pt): PointRef {
  const abs = (p: Pt): PointRef => ({ kind: 'abs', x: numE(p.x), y: numE(p.y) });
  const pt: Pt = snap ?? fallback;

  // Intersection of two lines/xlines: link to both features so the point tracks
  // when either feature or its parameters change.
  if (snap?.type === 'int' && snap.entityId !== undefined && snap.entityId2 !== undefined) {
    const feat1 = featureForEntity(snap.entityId);
    const feat2 = featureForEntity(snap.entityId2);
    if (feat1 && feat2) {
      return { kind: 'intersection', feature1: feat1.id, feature2: feat2.id };
    }
  }

  if (!snap?.entityId) return abs(pt);
  const feat = featureForEntity(snap.entityId);
  if (!feat) return abs(pt);
  const fid = feat.id;
  if (snap.type === 'center') return { kind: 'center', feature: fid };
  if (snap.type === 'mid')    return { kind: 'mid',    feature: fid };
  if (snap.type === 'end') {
    const ent = state.entities.find(e => e.id === snap.entityId);
    if (!ent) return abs(pt);
    if (ent.type === 'line') {
      const d0 = dist(snap, { x: ent.x1, y: ent.y1 });
      const d1 = dist(snap, { x: ent.x2, y: ent.y2 });
      return { kind: 'endpoint', feature: fid, end: d0 <= d1 ? 0 : 1 };
    }
    if (ent.type === 'xline') return { kind: 'endpoint', feature: fid, end: 0 };
    if (ent.type === 'polyline') {
      const d0 = dist(snap, ent.pts[0]);
      const dL = dist(snap, ent.pts[ent.pts.length - 1]);
      return { kind: 'endpoint', feature: fid, end: d0 <= dL ? 0 : 1 };
    }
  }
  return abs(pt);
}

export type ToolDef = {
  id: ToolId | 'delete';
  label: string;
  key: string;
  group: 'pointer' | 'guide' | 'construct' | 'modify';
  icon: string;
  action?: 'delete';
};

export const TOOLS: ToolDef[] = [
  // ── Pointer ──
  { id: 'select', label: 'Auswahl', key: 'Esc', group: 'pointer',
    icon: '<path d="M4 2 L4 16 L7.5 12.5 L10 18.5 L12 17.5 L9.5 11.5 L14 11.5 Z" fill="currentColor" stroke="none"/>' },
  { id: 'select_similar', label: 'Ähnliche auswählen', key: 'Q', group: 'pointer',
    icon: '<path d="M3 2 L3 14 L6 11.5 L8 16 L9.5 15.3 L7.6 11 L11 11 Z" fill="currentColor" stroke="none"/><path d="M12 9 L12 19 L14.5 17 L16 20 L17 19.5 L15.6 17 L18.5 17 Z" fill="currentColor" stroke="none" opacity="0.45"/>' },
  { id: 'pan',    label: 'Canvas verschieben', key: 'Z', group: 'pointer',
    icon: '<path d="M9 11 L9 4.5 Q9 3.3 10 3.3 Q11 3.3 11 4.5 L11 10 M11 10 L11 3.5 Q11 2.3 12 2.3 Q13 2.3 13 3.5 L13 10 M13 10 L13 4 Q13 2.8 14 2.8 Q15 2.8 15 4 L15 11 M15 11 L15 6 Q15 5 16 5 Q17 5 17 6 L17 13 Q17 18 13 19.5 L10 19.5 Q7 18.5 6.5 16 L4.5 13 Q4 11.5 5 11 Q6 10.5 7 12 L9 14 Z"/>' },

  // ── Hilfen ──
  { id: 'xline',      label: 'Hilfslinie',    key: 'H', group: 'guide',
    icon: '<line x1="2" y1="19" x2="20" y2="3" stroke-dasharray="4 2.5"/><circle cx="7" cy="15" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="7" r="1.3" fill="currentColor" stroke="none"/>' },
  { id: 'dim',        label: 'Bemaßung',      key: 'D', group: 'guide',
    icon: '<path d="M4 5 L4 11 M18 5 L18 11"/><path d="M4 8 L18 8"/><path d="M6 6 L4 8 L6 10 M16 6 L18 8 L16 10" fill="currentColor" stroke="none"/><path d="M4 15 L18 15" stroke-dasharray="2.5 2"/>' },
  { id: 'ref_circle', label: 'Hilfskreis',    key: 'K', group: 'guide',
    icon: '<circle cx="11" cy="11" r="7" stroke-dasharray="3 2"/><path d="M11 4.5 L11 17.5 M4.5 11 L17.5 11" stroke-width="0.8" opacity="0.45" stroke-dasharray="1 1.5"/><circle cx="11" cy="11" r="1" fill="currentColor" stroke="none"/>' },
  { id: 'angle',      label: 'Winkel messen', key: 'W', group: 'guide',
    icon: '<path d="M4 18 L4 4 M4 18 L18 18"/><path d="M4 12 A 6 6 0 0 1 10 18" stroke-dasharray="2 1.8"/><circle cx="4" cy="18" r="1.2" fill="currentColor" stroke="none"/>' },

  // ── Zeichnen ──
  { id: 'line',     label: 'Linie',     key: 'L', group: 'construct',
    icon: '<line x1="4" y1="18" x2="18" y2="4"/><circle cx="4" cy="18" r="1.4" fill="currentColor"/><circle cx="18" cy="4" r="1.4" fill="currentColor"/>' },
  { id: 'polyline', label: 'Polylinie', key: 'Y', group: 'construct',
    icon: '<polyline points="3,17 7,9 12,13 16,5 19,9"/><circle cx="3" cy="17" r="1.2" fill="currentColor"/><circle cx="19" cy="9" r="1.2" fill="currentColor"/>' },
  { id: 'rect',     label: 'Rechteck',  key: 'R', group: 'construct',
    icon: '<rect x="4" y="6" width="14" height="10"/>' },
  { id: 'circle',   label: 'Kreis',     key: 'C', group: 'construct',
    icon: '<circle cx="11" cy="11" r="7"/><circle cx="11" cy="11" r="0.9" fill="currentColor" stroke="none"/>' },
  { id: 'arc3',     label: 'Bogen',     key: 'A', group: 'construct',
    icon: '<path d="M3 16 A 9 9 0 0 1 19 16"/><circle cx="3" cy="16" r="1.3" fill="currentColor" stroke="none"/><circle cx="19" cy="16" r="1.3" fill="currentColor" stroke="none"/><circle cx="11" cy="7" r="1.1" fill="currentColor" stroke="none"/>' },
  { id: 'ellipse',  label: 'Ellipse',   key: 'E', group: 'construct',
    icon: '<ellipse cx="11" cy="11" rx="8" ry="5"/><path d="M3 11 L19 11" stroke-dasharray="1.5 1.5" opacity="0.5"/><circle cx="11" cy="11" r="0.9" fill="currentColor" stroke="none"/>' },
  { id: 'spline',   label: 'Spline',    key: 'N', group: 'construct',
    icon: '<path d="M3 14 C 6 6, 10 18, 13 10 S 18 6, 19 8"/>' },
  { id: 'text',     label: 'Text',      key: 'T', group: 'construct',
    icon: '<path d="M3 5 L19 5 M3 5 L3 8 M19 5 L19 8 M11 5 L11 17 M8 17 L14 17"/>' },

  // ── Ändern ──
  { id: 'move',   label: 'Verschieben', key: 'V', group: 'modify',
    icon: '<path d="M11 2.5 L11 19.5 M2.5 11 L19.5 11"/><path d="M11 2.5 L8.5 5 M11 2.5 L13.5 5 M11 19.5 L8.5 17 M11 19.5 L13.5 17 M2.5 11 L5 8.5 M2.5 11 L5 13.5 M19.5 11 L17 8.5 M19.5 11 L17 13.5" stroke-linecap="round" stroke-linejoin="round"/>' },
  { id: 'copy',   label: 'Kopieren',    key: 'J', group: 'modify',
    icon: '<rect x="3.5" y="7" width="10" height="11" rx="1"/><rect x="8" y="3.5" width="10.5" height="11" rx="1" opacity="0.55"/>' },
  { id: 'rotate', label: 'Drehen',      key: 'O', group: 'modify',
    icon: '<path d="M18 11 A 7 7 0 1 1 11 4" stroke-linecap="round"/><path d="M11 2 L11 6 L15 4" stroke-linejoin="round"/><circle cx="11" cy="11" r="1.1" fill="currentColor" stroke="none"/>' },
  { id: 'scale',  label: 'Skalieren',   key: 'S', group: 'modify',
    icon: '<rect x="4" y="4" width="6" height="6"/><rect x="10" y="10" width="8" height="8" stroke-dasharray="2.5 1.8"/><path d="M8 8 L14 14 M11.5 14 L14 14 L14 11.5" stroke-linecap="round"/>' },
  { id: 'mirror', label: 'Spiegeln',    key: 'M', group: 'modify',
    icon: '<line x1="11" y1="2.5" x2="11" y2="19.5" stroke-dasharray="2 1.8"/><path d="M3 17 L9 5 L9 17 Z"/><path d="M19 17 L13 5 L13 17 Z" opacity="0.35"/>' },
  { id: 'trim',   label: 'Stutzen',     key: 'B', group: 'modify',
    icon: '<path d="M3 11 L8 11 M14 11 L19 11"/><path d="M11 3 L11 19" stroke-dasharray="2 1.8" opacity="0.6"/><path d="M8 8 L14 14 M14 8 L8 14"/>' },
  { id: 'fillet', label: 'Abrunden',    key: 'G', group: 'modify',
    icon: '<path d="M4 4 L4 18 L18 18" stroke-dasharray="2 2" opacity="0.35"/><path d="M4 4 L4 11 A 7 7 0 0 0 11 18 L18 18"/>' },
  { id: 'offset', label: 'Versatz',     key: 'U', group: 'modify',
    icon: '<rect x="4" y="4" width="9" height="9"/><rect x="8" y="8" width="10" height="10" stroke-dasharray="2 1.8"/><path d="M13 13 L16 16 M14.5 16 L16 16 L16 14.5" stroke-linecap="round"/>' },
  { id: 'delete', label: 'Löschen',     key: 'Del', group: 'modify', action: 'delete',
    icon: '<path d="M3 6 L19 6 M8 6 L8 4 L14 4 L14 6 M5.5 6 L7 18 L15 18 L16.5 6 M9 9 L9.5 16 M11 9 L11 16 M13 9 L12.5 16"/>' },
];

// ---------------- Tool-rail: drag-reorder + localStorage persist ----------------
//
// Each visual column ('guide' | 'construct' | 'modify') has its own ordered
// list of tool ids. The 'guide' column hosts the pointer group at the top
// (select, select_similar, pan) followed by the guide tools themselves.
// Users can freely drag entries within a column; cross-column drops are
// rejected (groups have semantic meaning for the sidebar layout).

type ColKey = 'guide' | 'construct' | 'modify';
const ORDER_STORAGE_KEY = 'hekticad.toolOrder.v1';

function columnOf(t: ToolDef): ColKey {
  return t.group === 'pointer' ? 'guide' : (t.group as ColKey);
}

function defaultOrder(col: ColKey): string[] {
  // Mirror the hard-coded TOOLS order: pointer first inside 'guide'.
  const out: string[] = [];
  if (col === 'guide') {
    for (const t of TOOLS) if (t.group === 'pointer') out.push(String(t.id));
    for (const t of TOOLS) if (t.group === 'guide')   out.push(String(t.id));
  } else {
    for (const t of TOOLS) if (t.group === col) out.push(String(t.id));
  }
  return out;
}

function loadToolOrder(): Record<ColKey, string[]> {
  const fresh: Record<ColKey, string[]> = {
    guide: defaultOrder('guide'),
    construct: defaultOrder('construct'),
    modify: defaultOrder('modify'),
  };
  try {
    const raw = localStorage.getItem(ORDER_STORAGE_KEY);
    if (!raw) return fresh;
    const parsed = JSON.parse(raw) as Partial<Record<ColKey, string[]>>;
    const valid = new Set(TOOLS.map(t => String(t.id)));
    (['guide', 'construct', 'modify'] as ColKey[]).forEach(col => {
      const stored = Array.isArray(parsed[col]) ? parsed[col]! : [];
      const seen = new Set<string>();
      const merged: string[] = [];
      // Keep stored ids that still exist and belong in this column.
      for (const id of stored) {
        if (!valid.has(id)) continue;
        const def = TOOLS.find(t => String(t.id) === id);
        if (!def || columnOf(def) !== col) continue;
        if (seen.has(id)) continue;
        merged.push(id); seen.add(id);
      }
      // Append any column tools missing from the stored list (new tools since last save).
      for (const id of defaultOrder(col)) {
        if (!seen.has(id)) { merged.push(id); seen.add(id); }
      }
      fresh[col] = merged;
    });
  } catch { /* corrupt storage — fall through to defaults */ }
  return fresh;
}

function saveToolOrder(order: Record<ColKey, string[]>): void {
  try { localStorage.setItem(ORDER_STORAGE_KEY, JSON.stringify(order)); }
  catch { /* quota or disabled — ignore */ }
}

export function renderToolsPanel(): void {
  const panel = dom.toolsPanel;
  panel.innerHTML = '';
  // Right-click the rail (on empty areas or column headers) to reset order.
  panel.oncontextmenu = (ev) => {
    const onBtn = (ev.target as HTMLElement | null)?.closest('.tool-btn');
    if (onBtn) return; // keep default on buttons
    ev.preventDefault();
    if (confirm('Werkzeugleiste auf Standard-Anordnung zurücksetzen?')) {
      resetToolOrder();
    }
  };
  const byId = new Map<string, ToolDef>(TOOLS.map(t => [String(t.id), t]));
  const order = loadToolOrder();

  const mkBtn = (t: ToolDef): HTMLButtonElement => {
    const b = document.createElement('button');
    b.className = 'tool-btn';
    b.dataset.tool = String(t.id);
    b.dataset.label = t.label;
    b.dataset.key = t.key;
    if (t.action) b.dataset.action = t.action;
    b.title = `${t.label}  [${t.key}]  — ziehen zum Umsortieren`;
    b.innerHTML = `<svg viewBox="0 0 22 22">${t.icon}</svg>`;
    b.draggable = true;
    b.onclick = () => {
      if (t.action === 'delete') { deleteSelection(); return; }
      setTool(t.id as ToolId);
    };
    b.addEventListener('dragstart', (ev) => {
      if (!ev.dataTransfer) return;
      ev.dataTransfer.effectAllowed = 'move';
      ev.dataTransfer.setData('text/x-hekticad-tool', String(t.id));
      b.classList.add('dragging');
    });
    b.addEventListener('dragend', () => {
      b.classList.remove('dragging');
      document.querySelectorAll<HTMLElement>('.tool-btn.drop-before, .tool-btn.drop-after')
        .forEach(el => el.classList.remove('drop-before', 'drop-after'));
    });
    return b;
  };

  const cols = document.createElement('div');
  cols.className = 'tool-cols';
  const columns: { key: ColKey; label: string; cls: string }[] = [
    { key: 'guide',     label: 'Hilfen',   cls: 'tool-col--guide' },
    { key: 'construct', label: 'Zeichnen', cls: 'tool-col--construct' },
    { key: 'modify',    label: 'Ändern',   cls: 'tool-col--modify' },
  ];
  for (const c of columns) {
    const col = document.createElement('div');
    col.className = 'tool-col ' + c.cls;
    col.dataset.col = c.key;
    const hdr = document.createElement('div');
    hdr.className = 'tool-col-hdr';
    hdr.textContent = c.label;
    col.appendChild(hdr);
    for (const id of order[c.key]) {
      const def = byId.get(id);
      if (def) col.appendChild(mkBtn(def));
    }
    wireColumnDrop(col, c.key);
    cols.appendChild(col);
  }
  panel.appendChild(cols);
}

function wireColumnDrop(col: HTMLElement, colKey: ColKey): void {
  const draggedBtn = (): HTMLElement | null =>
    document.querySelector<HTMLElement>('.tool-btn.dragging');

  col.addEventListener('dragover', (ev) => {
    const src = draggedBtn();
    if (!src) return;
    // Only accept within the same column.
    if (src.closest('.tool-col') !== col) return;
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
    const target = (ev.target as HTMLElement | null)?.closest<HTMLElement>('.tool-btn');
    // Clear prior hints.
    col.querySelectorAll<HTMLElement>('.tool-btn.drop-before, .tool-btn.drop-after')
      .forEach(el => el.classList.remove('drop-before', 'drop-after'));
    if (!target || target === src) return;
    const rect = target.getBoundingClientRect();
    const before = ev.clientY < rect.top + rect.height / 2;
    target.classList.add(before ? 'drop-before' : 'drop-after');
  });

  col.addEventListener('dragleave', (ev) => {
    // Only clear when leaving the column entirely.
    if (ev.target === col) {
      col.querySelectorAll<HTMLElement>('.tool-btn.drop-before, .tool-btn.drop-after')
        .forEach(el => el.classList.remove('drop-before', 'drop-after'));
    }
  });

  col.addEventListener('drop', (ev) => {
    const src = draggedBtn();
    if (!src || src.closest('.tool-col') !== col) return;
    ev.preventDefault();
    const target = (ev.target as HTMLElement | null)?.closest<HTMLElement>('.tool-btn');
    if (target && target !== src) {
      const rect = target.getBoundingClientRect();
      const before = ev.clientY < rect.top + rect.height / 2;
      target.parentElement?.insertBefore(src, before ? target : target.nextSibling);
    }
    col.querySelectorAll<HTMLElement>('.tool-btn.drop-before, .tool-btn.drop-after')
      .forEach(el => el.classList.remove('drop-before', 'drop-after'));
    // Persist the new order of this column.
    const order = loadToolOrder();
    const ids: string[] = [];
    col.querySelectorAll<HTMLElement>('.tool-btn').forEach(el => {
      if (el.dataset.tool) ids.push(el.dataset.tool);
    });
    order[colKey] = ids;
    saveToolOrder(order);
  });
}

/** Reset the persisted tool-rail ordering back to the default layout. */
export function resetToolOrder(): void {
  try { localStorage.removeItem(ORDER_STORAGE_KEY); } catch { /* ignore */ }
  renderToolsPanel();
  // Restore active highlight after re-render.
  document.querySelectorAll<HTMLElement>('.tool-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.tool === state.tool);
  });
}

export function setTool(id: ToolId): void {
  // Remember the last "working" tool so Enter in idle can re-invoke it.
  // Pointer tools are just navigation modes — they don't count.
  if (id !== 'select' && id !== 'select_similar' && id !== 'pan') {
    runtime.lastInvokedTool = id;
  }
  state.tool = id;
  runtime.toolCtx = null;
  document.querySelectorAll<HTMLElement>('.tool-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.tool === id);
  });
  const t = TOOLS.find(x => x.id === id);
  dom.stTool.innerHTML = `Werkzeug: <b>${t ? t.label : id}</b>`;
  if (id === 'select') {
    state.selection.clear();
    updateSelStatus();
    dom.cv.style.cursor = '';
    setPrompt('Kommando');
  } else if (id === 'select_similar') {
    dom.cv.style.cursor = '';
    setPrompt('Objekt anklicken — alle mit gleichem Typ & Layer werden gewählt (Shift = ergänzen)');
  } else if (id === 'pan') {
    runtime.toolCtx = { step: 'idle' };
    dom.cv.style.cursor = 'grab';
    setPrompt('Canvas ziehen');
  } else if (id === 'line')     { runtime.toolCtx = { step: 'p1' }; setPrompt('Erster Punkt'); }
  else if (id === 'polyline')   { runtime.toolCtx = { step: 'p1', pts: [] }; setPrompt('Erster Punkt'); }
  else if (id === 'xline')      { runtime.toolCtx = { step: 'ref' }; setPrompt('Referenzlinie/-achse oder Snap-Punkt'); }
  else if (id === 'rect')       { runtime.toolCtx = { step: 'p1' }; setPrompt('Erster Eckpunkt'); }
  else if (id === 'circle')     { runtime.toolCtx = { step: 'p1' }; setPrompt('Mittelpunkt'); }
  else if (id === 'circle3')    { runtime.toolCtx = { step: 'p1', pts: [] }; setPrompt('Erster Punkt auf Kreis'); }
  else if (id === 'arc3')       { runtime.toolCtx = { step: 'p1', pts: [] }; setPrompt('Startpunkt des Bogens'); }
  else if (id === 'ellipse')    { runtime.toolCtx = { step: 'center' }; setPrompt('Mittelpunkt der Ellipse'); }
  else if (id === 'spline')     { runtime.toolCtx = { step: 'p1', pts: [] }; setPrompt('Erster Punkt der Spline'); }
  else if (id === 'polygon')    { runtime.toolCtx = { step: 'center' }; setPrompt(`Mittelpunkt (n=${lastPolygonSides}, Zahl ändert)`); }
  else if (id === 'offset')     { runtime.toolCtx = { step: 'pick' }; setPrompt('Objekt wählen'); }
  else if (id === 'move') {
    runtime.toolCtx = state.selection.size ? { step: 'base' } : { step: 'pick' };
    setPrompt(runtime.toolCtx.step === 'base' ? 'Basispunkt' : 'Objekte wählen, dann Enter');
  } else if (id === 'copy') {
    runtime.toolCtx = state.selection.size ? { step: 'base' } : { step: 'pick' };
    setPrompt(runtime.toolCtx.step === 'base' ? 'Basispunkt' : 'Objekte wählen, dann Enter');
  } else if (id === 'rotate') {
    runtime.toolCtx = state.selection.size ? { step: 'center' } : { step: 'pick' };
    setPrompt(runtime.toolCtx.step === 'center' ? 'Drehzentrum' : 'Objekte wählen, dann Enter');
  } else if (id === 'mirror') {
    runtime.toolCtx = state.selection.size ? { step: 'axis1' } : { step: 'pick' };
    setPrompt(runtime.toolCtx.step === 'axis1' ? 'Spiegelachse: erster Punkt' : 'Objekte wählen, dann Enter');
  } else if (id === 'stretch') {
    runtime.toolCtx = { step: 'win1' };
    setPrompt('Fenster: erster Punkt (Crossing-Box bestimmt bewegte Endpunkte)');
  } else if (id === 'fillet') {
    runtime.toolCtx = { step: 'pick1' };
    setPrompt('Erste Linie wählen');
  } else if (id === 'chamfer') {
    runtime.toolCtx = { step: 'pick1' };
    setPrompt('Erste Linie wählen');
  } else if (id === 'extend') {
    runtime.toolCtx = { step: 'pick' };
    setPrompt('Linie am zu verlängernden Ende anklicken');
  } else if (id === 'trim') {
    runtime.toolCtx = { step: 'pick' };
    setPrompt('Linien-Abschnitt anklicken (wird bis zum nächsten Schnittpunkt gestutzt)');
  } else if (id === 'text') {
    runtime.toolCtx = { step: 'pt', textHeight: lastTextHeight };
    setPrompt(`Einfügepunkt für Text (Höhe=${lastTextHeight}, Zahl ändert)`);
  } else if (id === 'dim') {
    runtime.toolCtx = { step: 'pick1' };
    setPrompt('Erster Messpunkt');
  } else if (id === 'point') {
    runtime.toolCtx = { step: 'pt' };
    setPrompt('Punkt setzen');
  } else if (id === 'axis') {
    runtime.toolCtx = { step: 'pt' };
    setPrompt('Bezugsachse: Ursprungspunkt');
  } else if (id === 'ref_circle') {
    runtime.toolCtx = { step: 'center' };
    setPrompt('Hilfskreis: Mittelpunkt');
  } else if (id === 'angle') {
    runtime.toolCtx = { step: 'vertex' };
    setPrompt('Winkel messen: Scheitelpunkt');
  } else if (id === 'scale') {
    runtime.toolCtx = state.selection.size ? { step: 'base' } : { step: 'pick' };
    setPrompt(runtime.toolCtx.step === 'base' ? 'Basispunkt' : 'Objekte wählen, dann Enter');
  }
  syncDimPicker();
  render();
}

export function cancelTool(): void {
  runtime.dragSelect = null;
  if (state.tool === 'polyline' && runtime.toolCtx?.pts && runtime.toolCtx.pts.length >= 2) {
    finishPolyline(false);
    return;
  }
  if (state.tool === 'spline' && runtime.toolCtx?.pts && runtime.toolCtx.pts.length >= 2) {
    finishSpline(false);
    return;
  }
  runtime.toolCtx = null;
  setTool('select');
}

/**
 * Create an entity by appending a feature to the timeline. Every user-visible
 * creation flows through here so the timeline stays authoritative. Returns the
 * stable entity id allocated for the new feature (0 if allocation fails).
 */
export function addEntity(e: EntityInit): number {
  pushUndo();
  const fid = addFeatureFromInit(e);
  updateStats();
  return entityIdForFeature(fid) ?? 0;
}

export function deleteSelection(): void {
  if (!state.selection.size) return;
  pushUndo();
  const fids = new Set<string>();
  for (const id of state.selection) {
    const ent = state.entities.find(e => e.id === id);
    if (ent && state.layers[ent.layer]?.locked) continue;
    const f = featureForEntity(id);
    if (f) fids.add(f.id);
  }
  deleteFeatures(fids);
  state.selection.clear();
  updateStats();
  updateSelStatus();
  render();
}

/** Strip the persistent `id` from an Entity so it can feed back into the feature builder. */
function entityInit<T extends Entity>(e: T): EntityInit {
  const { id: _id, ...rest } = e;
  return rest as EntityInit;
}

// ---------------- Transforms ----------------

type TransformFn = (p: Pt) => Pt;

function transformEntity(
  e: Entity,
  fn: TransformFn,
  opts: { pureTranslation?: boolean } = {},
): EntityInit[] {
  const pureTranslation = opts.pureTranslation ?? false;
  if (e.type === 'line') {
    const a = fn({ x: e.x1, y: e.y1 });
    const b = fn({ x: e.x2, y: e.y2 });
    return [{ type: 'line', x1: a.x, y1: a.y, x2: b.x, y2: b.y, layer: e.layer }];
  }
  if (e.type === 'xline') {
    const base = fn({ x: e.x1, y: e.y1 });
    const tip  = fn({ x: e.x1 + e.dx, y: e.y1 + e.dy });
    const d = norm(sub(tip, base));
    return [{ type: 'xline', x1: base.x, y1: base.y, dx: d.x, dy: d.y, layer: e.layer }];
  }
  if (e.type === 'rect') {
    if (pureTranslation) {
      const a = fn({ x: e.x1, y: e.y1 });
      const b = fn({ x: e.x2, y: e.y2 });
      return [{ type: 'rect', x1: a.x, y1: a.y, x2: b.x, y2: b.y, layer: e.layer }];
    }
    const xl = Math.min(e.x1, e.x2), xr = Math.max(e.x1, e.x2);
    const yb = Math.min(e.y1, e.y2), yt = Math.max(e.y1, e.y2);
    const corners = [{ x: xl, y: yb }, { x: xr, y: yb }, { x: xr, y: yt }, { x: xl, y: yt }];
    return [{ type: 'polyline', pts: corners.map(fn), closed: true, layer: e.layer }];
  }
  if (e.type === 'circle') {
    const c = fn({ x: e.cx, y: e.cy });
    return [{ type: 'circle', cx: c.x, cy: c.y, r: e.r, layer: e.layer }];
  }
  if (e.type === 'arc') {
    // Sample three points on the arc and re-fit to stay correct under rotation/mirror.
    const c = fn({ x: e.cx, y: e.cy });
    const pa = fn({ x: e.cx + Math.cos(e.a1) * e.r, y: e.cy + Math.sin(e.a1) * e.r });
    const pb = fn({ x: e.cx + Math.cos(e.a2) * e.r, y: e.cy + Math.sin(e.a2) * e.r });
    const am = (e.a1 + e.a2) / 2;
    const pm = fn({ x: e.cx + Math.cos(am) * e.r, y: e.cy + Math.sin(am) * e.r });
    let a1 = Math.atan2(pa.y - c.y, pa.x - c.x);
    let a2 = Math.atan2(pb.y - c.y, pb.x - c.x);
    const amNew = Math.atan2(pm.y - c.y, pm.x - c.x);
    // Ensure mid lies within [a1, a2] CCW sweep; otherwise swap (mirror flips winding).
    const twoPi = Math.PI * 2;
    const normA = (x: number) => ((x % twoPi) + twoPi) % twoPi;
    const sweepForward = normA(a2 - a1);
    const deltaMid = normA(amNew - a1);
    if (deltaMid > sweepForward) { const t = a1; a1 = a2; a2 = t; }
    return [{ type: 'arc', cx: c.x, cy: c.y, r: e.r, a1, a2, layer: e.layer }];
  }
  if (e.type === 'ellipse') {
    // Sample center + axis tips, recover new axes from them. Handles conformal
    // transforms (rotate, mirror, translate) correctly; shear/non-uniform scale
    // would deform the ellipse, so we just re-derive from the tip images.
    const cos0 = Math.cos(e.rot), sin0 = Math.sin(e.rot);
    const c = fn({ x: e.cx, y: e.cy });
    const a = fn({ x: e.cx + e.rx * cos0,      y: e.cy + e.rx * sin0 });
    const b = fn({ x: e.cx - e.ry * sin0,      y: e.cy + e.ry * cos0 });
    const rx = Math.hypot(a.x - c.x, a.y - c.y);
    const ry = Math.hypot(b.x - c.x, b.y - c.y);
    const rot = Math.atan2(a.y - c.y, a.x - c.x);
    return [{ type: 'ellipse', cx: c.x, cy: c.y, rx, ry, rot, layer: e.layer }];
  }
  if (e.type === 'spline') {
    return [{ type: 'spline', pts: e.pts.map(fn), closed: !!e.closed, layer: e.layer }];
  }
  if (e.type === 'polyline') {
    return [{ type: 'polyline', pts: e.pts.map(fn), closed: !!e.closed, layer: e.layer }];
  }
  if (e.type === 'text') {
    const anchor = fn({ x: e.x, y: e.y });
    if (pureTranslation) {
      return [{ type: 'text', x: anchor.x, y: anchor.y, text: e.text, height: e.height, rotation: e.rotation, layer: e.layer }];
    }
    // Sample a unit vector along baseline to recover rotation + mirroring.
    const base0 = { x: e.x, y: e.y };
    const base1 = { x: e.x + Math.cos(e.rotation ?? 0), y: e.y + Math.sin(e.rotation ?? 0) };
    const p0 = fn(base0), p1 = fn(base1);
    const rot = Math.atan2(p1.y - p0.y, p1.x - p0.x);
    return [{ type: 'text', x: anchor.x, y: anchor.y, text: e.text, height: e.height, rotation: rot, layer: e.layer }];
  }
  if (e.type === 'dim') {
    return [{
      type: 'dim',
      p1: fn(e.p1), p2: fn(e.p2), offset: fn(e.offset),
      textHeight: e.textHeight, layer: e.layer,
    }];
  }
  return [];
}

function transformSelection(
  fn: TransformFn,
  { copy = false, pureTranslation = false }: { copy?: boolean; pureTranslation?: boolean } = {},
): void {
  const ids = [...state.selection];
  if (!ids.length) return;
  pushUndo();
  const keepFids: string[] = [];
  const removedFids = new Set<string>();
  for (const id of ids) {
    const e = state.entities.find(x => x.id === id);
    if (!e) continue;
    const srcFid = featureForEntity(id)?.id ?? null;
    const transformed = transformEntity(e, fn, { pureTranslation });
    if (!transformed.length) continue;
    if (copy) {
      for (const t of transformed) {
        const f = featureFromEntityInit(t);
        state.features.push(f);
        keepFids.push(f.id);
      }
    } else if (srcFid) {
      // Keep the feature id when the entity type is preserved (line→line, etc.)
      // so the stable entity id is retained and selection survives the transform.
      if (transformed.length === 1 && transformed[0].type === e.type) {
        replaceFeatureFromInit(srcFid, transformed[0]);
        keepFids.push(srcFid);
      } else {
        removedFids.add(srcFid);
        for (const t of transformed) {
          const f = featureFromEntityInit(t);
          state.features.push(f);
          keepFids.push(f.id);
        }
      }
    }
  }
  if (removedFids.size) {
    state.features = state.features.filter(f => !removedFids.has(f.id));
  }
  evaluateTimeline();
  if (!copy) state.selection.clear();
  for (const fid of keepFids) {
    const eid = entityIdForFeature(fid);
    if (eid !== null) state.selection.add(eid);
  }
  updateStats();
  updateSelStatus();
}

// ---------------- Offset / parallel ----------------

function offsetInfo(e: Entity, pt: Pt): { dist: number; sign: 1 | -1 } | null {
  if (e.type === 'line') {
    const a = { x: e.x1, y: e.y1 }, b = { x: e.x2, y: e.y2 };
    const dir = norm(sub(b, a));
    const n = perp(dir);
    const rel = sub(pt, a);
    const sd = dot(rel, n);
    return { dist: Math.abs(sd), sign: sd >= 0 ? 1 : -1 };
  }
  if (e.type === 'xline') {
    const n = perp({ x: e.dx, y: e.dy });
    const rel = sub(pt, { x: e.x1, y: e.y1 });
    const sd = dot(rel, n);
    return { dist: Math.abs(sd), sign: sd >= 0 ? 1 : -1 };
  }
  if (e.type === 'rect') {
    const xl = Math.min(e.x1, e.x2), xr = Math.max(e.x1, e.x2);
    const yb = Math.min(e.y1, e.y2), yt = Math.max(e.y1, e.y2);
    const inside = pt.x > xl && pt.x < xr && pt.y > yb && pt.y < yt;
    const d = inside
      ? Math.min(pt.x - xl, xr - pt.x, pt.y - yb, yt - pt.y)
      : Math.min(
          distPtSeg(pt, { x: xl, y: yb }, { x: xr, y: yb }),
          distPtSeg(pt, { x: xr, y: yb }, { x: xr, y: yt }),
          distPtSeg(pt, { x: xr, y: yt }, { x: xl, y: yt }),
          distPtSeg(pt, { x: xl, y: yt }, { x: xl, y: yb }),
        );
    return { dist: d, sign: inside ? -1 : 1 };
  }
  if (e.type === 'circle') {
    const d = dist(pt, { x: e.cx, y: e.cy });
    return { dist: Math.abs(d - e.r), sign: d > e.r ? 1 : -1 };
  }
  return null;
}

function distPtSeg(p: Pt, a: Pt, b: Pt): number {
  const ab = sub(b, a);
  const ap = sub(p, a);
  const L2 = dot(ab, ab);
  if (L2 < 1e-12) return len(ap);
  let t = dot(ap, ab) / L2;
  t = Math.max(0, Math.min(1, t));
  return len(sub(ap, scale(ab, t)));
}

export function makeOffsetPreview(e: Entity, d: number, sign: 1 | -1): EntityShape | null {
  if (e.type === 'line') {
    const a = { x: e.x1, y: e.y1 }, b = { x: e.x2, y: e.y2 };
    const dir = norm(sub(b, a));
    const n = perp(dir);
    const off = scale(n, d * sign);
    return { type: 'line', x1: a.x + off.x, y1: a.y + off.y, x2: b.x + off.x, y2: b.y + off.y };
  }
  if (e.type === 'xline') {
    const n = perp({ x: e.dx, y: e.dy });
    const off = scale(n, d * sign);
    return { type: 'xline', x1: e.x1 + off.x, y1: e.y1 + off.y, dx: e.dx, dy: e.dy };
  }
  if (e.type === 'rect') {
    const xl = Math.min(e.x1, e.x2), xr = Math.max(e.x1, e.x2);
    const yb = Math.min(e.y1, e.y2), yt = Math.max(e.y1, e.y2);
    const dd = d * sign;
    return { type: 'rect', x1: xl - dd, y1: yb - dd, x2: xr + dd, y2: yt + dd };
  }
  if (e.type === 'circle') {
    const nr = e.r + d * sign;
    return { type: 'circle', cx: e.cx, cy: e.cy, r: Math.max(0.001, nr) };
  }
  return null;
}

function createOffset(e: Entity, d: number, sign: 1 | -1): void {
  const prev = makeOffsetPreview(e, d, sign);
  if (!prev) return;
  addEntity({ ...prev, layer: e.layer } as EntityInit);
}

function hilfslinieLayer(): number {
  let layer = state.layers.findIndex(L => L.name.toLowerCase().includes('hilfslin'));
  if (layer < 0) layer = state.activeLayer;
  return layer;
}

/**
 * Create a parallel helper line. When `refEntity` is a line or xline that maps
 * to a feature, the result is a `parallelXLine` feature bound to that source —
 * moving or reshaping the source then moves the parallel automatically.
 * Falls back to a plain, absolute xline when no feature binding is available.
 */
export function makeParallelXLine(
  base: Pt, dir: Pt, distExpr: Expr, sign: 1 | -1,
  refEntity?: Entity,
): void {
  const layer = hilfslinieLayer();
  if (refEntity && (refEntity.type === 'line' || refEntity.type === 'xline')) {
    const refFeat = featureForEntity(refEntity.id);
    if (refFeat) {
      pushUndo();
      state.features.push({
        id: newFeatureId(),
        kind: 'parallelXLine',
        refFeature: refFeat.id,
        distance: distExpr,
        side: sign,
        layer,
      });
      evaluateTimeline();
      updateStats();
      return;
    }
  }
  const distance = evalExpr(distExpr);
  const n = perp(dir);
  const offsetBase = add(base, scale(n, distance * sign));
  addEntity({
    type: 'xline',
    x1: offsetBase.x, y1: offsetBase.y,
    dx: dir.x, dy: dir.y,
    layer,
  });
}

export function makeXLineThrough(pt: Pt, dir: Pt): void {
  addEntity({
    type: 'xline',
    x1: pt.x, y1: pt.y,
    dx: dir.x, dy: dir.y,
    layer: hilfslinieLayer(),
  });
}

// ---------------- Click dispatch ----------------

export function handleClick(worldPt: Pt, shiftKey = false): void {
  const snap = runtime.lastSnap;
  const p: Pt = snap ? { x: snap.x, y: snap.y } : worldPt;

  if (state.tool === 'select') {
    const hit = hitTest(worldPt);
    if (!shiftKey) state.selection.clear();
    if (hit) state.selection.add(hit.id);
    updateSelStatus();
    render();
    return;
  }
  if (state.tool === 'select_similar') {
    const hit = hitTest(worldPt);
    if (!shiftKey) state.selection.clear();
    if (hit) {
      for (const e of state.entities) {
        if (e.type !== hit.type) continue;
        if (e.layer !== hit.layer) continue;
        const layer = state.layers[e.layer];
        if (!layer || !layer.visible || layer.locked) continue;
        state.selection.add(e.id);
      }
      const layerName = state.layers[hit.layer]?.name ?? `#${hit.layer}`;
      toast(`${state.selection.size} × ${hit.type} auf „${layerName}" gewählt`);
    }
    updateSelStatus();
    render();
    return;
  }
  if (state.tool === 'line')     { handleLineClick(p); return; }
  if (state.tool === 'polyline') { handlePolylineClick(p); return; }
  if (state.tool === 'rect')     { handleRectClick(p); return; }
  if (state.tool === 'circle')   { handleCircleClick(p); return; }
  if (state.tool === 'circle3')  { handleCircle3Click(p); return; }
  if (state.tool === 'arc3')     { handleArc3Click(p); return; }
  if (state.tool === 'ellipse')  { handleEllipseClick(p); return; }
  if (state.tool === 'spline')   { handleSplineClick(p); return; }
  if (state.tool === 'polygon')  { handlePolygonClick(p); return; }
  if (state.tool === 'xline')    { handleXLineClick(p, worldPt); return; }
  if (state.tool === 'offset')   { handleOffsetClick(p, worldPt); return; }
  if (state.tool === 'move')     { handleMoveCopyClick(p, worldPt, false); return; }
  if (state.tool === 'copy')     { handleMoveCopyClick(p, worldPt, true); return; }
  if (state.tool === 'rotate')   { handleRotateClick(p, worldPt); return; }
  if (state.tool === 'mirror')   { handleMirrorClick(p, worldPt); return; }
  if (state.tool === 'stretch')  { handleStretchClick(p, worldPt); return; }
  if (state.tool === 'fillet')   { handleFilletClick(worldPt); return; }
  if (state.tool === 'chamfer')  { handleChamferClick(worldPt); return; }
  if (state.tool === 'extend')   { handleExtendClick(worldPt); return; }
  if (state.tool === 'trim')     { handleTrimClick(worldPt); return; }
  if (state.tool === 'text')     { handleTextClick(p); return; }
  if (state.tool === 'dim')      { handleDimClick(p); return; }
  if (state.tool === 'ref_circle') { handleRefCircleClick(p); return; }
  if (state.tool === 'angle')    { handleAngleClick(p); return; }
  if (state.tool === 'scale')    { handleScaleClick(p, worldPt); return; }
}

/** If Shift is held and no geometry snap is active, lock direction to 15° steps. */
function maybeOrtho(ref: Pt, p: Pt): Pt {
  if (!runtime.orthoSnap || runtime.lastSnap) return p;
  return orthoSnap(ref, p);
}

function handleLineClick(p: Pt): void {
  const snap = runtime.lastSnap;
  const tc = runtime.toolCtx;
  if (!tc || tc.step === 'p1') {
    const p1Ref = snapToPointRef(snap, p);
    runtime.toolCtx = { step: 'p2', p1: p, p1Ref, lockedDir: null, angleDeg: null };
    setPrompt('Zahl = Winkel 0-90° (dann Länge) oder Endpunkt klicken');
  } else if (tc.p1) {
    let endPt: Pt;
    let endRef: PointRef;
    if (tc.lockedDir) {
      const ap = sub(p, tc.p1);
      const length = dot(ap, tc.lockedDir);
      if (length < 1e-6) { toast('Klick auf die andere Seite oder Länge eintippen'); return; }
      endPt = add(tc.p1, scale(tc.lockedDir, length));
      endRef = { kind: 'abs', x: numE(endPt.x), y: numE(endPt.y) };
    } else {
      endPt = maybeOrtho(tc.p1, p);
      // Only use snap-ref when ortho didn't alter the point.
      endRef = snapToPointRef(endPt === p ? snap : null, endPt);
    }
    const p1Ref: PointRef = tc.p1Ref ?? { kind: 'abs', x: numE(tc.p1.x), y: numE(tc.p1.y) };
    pushUndo();
    const feat: Feature = {
      id: newFeatureId(), kind: 'line', layer: state.activeLayer,
      p1: p1Ref, p2: endRef,
    };
    state.features.push(feat);
    evaluateTimeline();
    updateStats();
    // LINE tool: each click pair creates ONE independent segment. After commit,
    // reset to p1 and wait for a fresh start point. For a chained workflow the
    // user picks POLYLINE instead (that tool keeps the previous endpoint as
    // the next p1 until Enter/Esc).
    runtime.toolCtx = { step: 'p1' };
    setPrompt('Erster Punkt');
  }
  render();
}

export function handlePolylineClick(p: Pt): void {
  const tc = runtime.toolCtx;
  if (!tc) return;
  if (!tc.pts)    tc.pts    = [];
  if (!tc.ptRefs) tc.ptRefs = [];
  const prevPt = tc.pts.length > 0 ? tc.pts[tc.pts.length - 1] : null;
  const pt = prevPt ? maybeOrtho(prevPt, p) : p;
  // When ortho altered the point, snap-ref doesn't apply — use abs.
  const snap = (pt === p) ? runtime.lastSnap : null;
  tc.pts.push(pt);
  tc.ptRefs.push(snapToPointRef(snap, pt));
  tc.lockedDir = null;
  tc.angleDeg = null;
  setPrompt(tc.pts.length === 1 ? 'Nächster Punkt' : 'Nächster Punkt (Enter beendet)');
  render();
}

export function finishPolyline(closed: boolean): void {
  const tc = runtime.toolCtx;
  if (tc && tc.pts && tc.pts.length >= 2) {
    const refs: PointRef[] = (tc.ptRefs && tc.ptRefs.length === tc.pts.length)
      ? (tc.ptRefs as PointRef[])
      : tc.pts.map((pt): PointRef => ({ kind: 'abs', x: numE(pt.x), y: numE(pt.y) }));
    pushUndo();
    state.features.push({
      id: newFeatureId(), kind: 'polyline', layer: state.activeLayer,
      pts: refs, closed: !!closed,
    });
    evaluateTimeline();
    updateStats();
  }
  runtime.toolCtx = { step: 'p1', pts: [] };
  setPrompt('Erster Punkt');
  render();
}

function handleRectClick(p: Pt): void {
  const tc = runtime.toolCtx;
  if (!tc || tc.step === 'p1') {
    runtime.toolCtx = { step: 'dims', p1: p, vertical: null, horizontal: null };
    setPrompt('Breite + Höhe eingeben');
  } else if (tc.step === 'dims' && tc.p1) {
    let x1 = tc.p1.x, y1 = tc.p1.y, x2 = p.x, y2 = p.y;
    if (tc.vertical != null)   y2 = y1 + (Math.sign(p.y - y1) || 1) * tc.vertical;
    if (tc.horizontal != null) x2 = x1 + (Math.sign(p.x - x1) || 1) * tc.horizontal;
    if (Math.abs(x2 - x1) < 1e-6 || Math.abs(y2 - y1) < 1e-6) {
      toast('Rechteck zu klein');
      return;
    }
    addEntity({ type: 'rect', x1, y1, x2, y2, layer: state.activeLayer });
    runtime.toolCtx = { step: 'p1' };
    setPrompt('Erster Eckpunkt');
  }
  render();
}

function handleCircleClick(p: Pt): void {
  const tc = runtime.toolCtx;
  if (!tc || tc.step === 'p1') {
    runtime.toolCtx = { step: 'r', cx: p.x, cy: p.y };
    setPrompt('Radius eingeben oder Punkt klicken');
  } else if (tc.cx != null && tc.cy != null) {
    const r = dist(p, { x: tc.cx, y: tc.cy });
    if (r < 1e-6) return;
    addEntity({ type: 'circle', cx: tc.cx, cy: tc.cy, r, layer: state.activeLayer });
    runtime.toolCtx = { step: 'p1' };
    setPrompt('Mittelpunkt');
  }
  render();
}

/**
 * Hilfskreis: same UX flow as circle, but commits onto the Hilfslinie layer
 * (dashed/ghost style via layer property). Useful as a construction aid that
 * isn't part of the printed drawing. Reuses the 'circle' cmdbar schema via
 * the shared 'r' step + cx/cy.
 */
function handleRefCircleClick(p: Pt): void {
  const tc = runtime.toolCtx;
  if (!tc || tc.step === 'center') {
    runtime.toolCtx = { step: 'r', cx: p.x, cy: p.y };
    setPrompt('Radius eingeben oder Punkt klicken');
  } else if (tc.cx != null && tc.cy != null) {
    const r = dist(p, { x: tc.cx, y: tc.cy });
    if (r < 1e-6) return;
    addEntity({ type: 'circle', cx: tc.cx, cy: tc.cy, r, layer: hilfslinieLayer() });
    runtime.toolCtx = { step: 'center' };
    setPrompt('Hilfskreis: Mittelpunkt');
  }
  render();
}

/**
 * Winkel messen: vertex + 2 ray points → angle readout via toast + status tip.
 * Pure measurement — no entity is created. Loops back to 'vertex' so the user
 * can measure several angles in a row without re-selecting the tool.
 */
function handleAngleClick(p: Pt): void {
  const tc = runtime.toolCtx;
  if (!tc) return;
  if (tc.step === 'center' || tc.step === 'vertex') {
    runtime.toolCtx = { step: 'ray1', centerPt: p };
    setPrompt('Erster Schenkel-Punkt');
  } else if (tc.step === 'ray1' && tc.centerPt) {
    runtime.toolCtx = { step: 'ray2', centerPt: tc.centerPt, p1: p };
    setPrompt('Zweiter Schenkel-Punkt');
  } else if (tc.step === 'ray2' && tc.centerPt && tc.p1) {
    const v = tc.centerPt;
    const a = tc.p1;
    const b = p;
    const va = { x: a.x - v.x, y: a.y - v.y };
    const vb = { x: b.x - v.x, y: b.y - v.y };
    const ang1 = Math.atan2(va.y, va.x);
    const ang2 = Math.atan2(vb.y, vb.x);
    let diff = (ang2 - ang1) * 180 / Math.PI;
    // Normalise to signed (-180, 180] for a "shortest rotation" reading.
    while (diff >  180) diff -= 360;
    while (diff <= -180) diff += 360;
    const absDeg = Math.abs(diff).toFixed(2);
    toast(`Winkel: ${absDeg}°  (${diff.toFixed(2)}° vorzeichenbehaftet)`);
    setTip(`∠ ${absDeg}°`);
    runtime.toolCtx = { step: 'vertex' };
    setPrompt('Winkel messen: Scheitelpunkt (oder Esc)');
  }
  render();
}

// ---------------- Polygon ----------------

let lastPolygonSides = 6;

export function setPolygonSides(n: number): void {
  if (n >= 3 && n <= 64) lastPolygonSides = Math.floor(n);
}

export function getPolygonSides(): number { return lastPolygonSides; }

function polygonPoints(cx: number, cy: number, r: number, n: number, startAng: number): Pt[] {
  const pts: Pt[] = [];
  const step = 2 * Math.PI / n;
  for (let i = 0; i < n; i++) {
    const a = startAng + i * step;
    pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
  }
  return pts;
}

function handlePolygonClick(p: Pt): void {
  const tc = runtime.toolCtx;
  if (!tc || tc.step === 'center') {
    runtime.toolCtx = { step: 'radius', cx: p.x, cy: p.y };
    setPrompt(`Radius eingeben oder Eckpunkt klicken (n=${lastPolygonSides})`);
    updatePreview();
    render();
    return;
  }
  if (tc.step === 'radius' && tc.cx != null && tc.cy != null) {
    const r = dist(p, { x: tc.cx, y: tc.cy });
    if (r < 1e-6) return;
    const startAng = Math.atan2(p.y - tc.cy, p.x - tc.cx);
    addEntity({
      type: 'polyline',
      pts: polygonPoints(tc.cx, tc.cy, r, lastPolygonSides, startAng),
      closed: true,
      layer: state.activeLayer,
    });
    runtime.toolCtx = { step: 'center' };
    setPrompt(`Mittelpunkt (n=${lastPolygonSides}, Zahl ändert)`);
    render();
  }
}

// ---------------- 3-Punkt-Kreis / 3-Punkt-Bogen ----------------

/**
 * Circumscribed circle through three points. Returns null for collinear points.
 */
function circleFrom3(a: Pt, b: Pt, c: Pt): { cx: number; cy: number; r: number } | null {
  const ax = a.x, ay = a.y, bx = b.x, by = b.y, cx = c.x, cy = c.y;
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-9) return null;
  const ux = ((ax * ax + ay * ay) * (by - cy) +
              (bx * bx + by * by) * (cy - ay) +
              (cx * cx + cy * cy) * (ay - by)) / d;
  const uy = ((ax * ax + ay * ay) * (cx - bx) +
              (bx * bx + by * by) * (ax - cx) +
              (cx * cx + cy * cy) * (bx - ax)) / d;
  const r = Math.hypot(ax - ux, ay - uy);
  return { cx: ux, cy: uy, r };
}

function handleCircle3Click(p: Pt): void {
  const tc = runtime.toolCtx;
  if (!tc) return;
  if (!tc.pts) tc.pts = [];
  tc.pts.push(p);
  if (tc.pts.length === 1) {
    tc.step = 'p2';
    setPrompt('Zweiter Punkt auf Kreis');
  } else if (tc.pts.length === 2) {
    tc.step = 'p3';
    setPrompt('Dritter Punkt auf Kreis');
  } else {
    const [a, b, c] = tc.pts;
    const circ = circleFrom3(a, b, c);
    if (!circ) {
      toast('Punkte sind kollinear');
      runtime.toolCtx = { step: 'p1', pts: [] };
      setPrompt('Erster Punkt auf Kreis');
      render();
      return;
    }
    addEntity({ type: 'circle', cx: circ.cx, cy: circ.cy, r: circ.r, layer: state.activeLayer });
    runtime.toolCtx = { step: 'p1', pts: [] };
    setPrompt('Erster Punkt auf Kreis');
  }
  render();
}

/**
 * Arc from start→through→end. Sweep direction (CCW vs CW) is determined so
 * the `through` point lies on the resulting arc. Stored with a1 < a2 (CCW sweep);
 * if the natural sweep is CW, start/end are swapped.
 */
function arcFrom3(a: Pt, mid: Pt, c: Pt): { cx: number; cy: number; r: number; a1: number; a2: number } | null {
  const circ = circleFrom3(a, mid, c);
  if (!circ) return null;
  const angA = Math.atan2(a.y - circ.cy, a.x - circ.cx);
  const angM = Math.atan2(mid.y - circ.cy, mid.x - circ.cx);
  const angC = Math.atan2(c.y - circ.cy, c.x - circ.cx);
  // Try CCW sweep from A to C; check if M lies within it
  let a1 = angA, a2 = angC;
  while (a2 < a1) a2 += 2 * Math.PI;
  const mCcw = ((angM - a1) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
  if (mCcw < a2 - a1) {
    return { cx: circ.cx, cy: circ.cy, r: circ.r, a1, a2 };
  }
  // Otherwise CCW sweep from C to A contains M
  a1 = angC; a2 = angA;
  while (a2 < a1) a2 += 2 * Math.PI;
  return { cx: circ.cx, cy: circ.cy, r: circ.r, a1, a2 };
}

function handleArc3Click(p: Pt): void {
  const tc = runtime.toolCtx;
  if (!tc) return;
  if (!tc.pts) tc.pts = [];
  tc.pts.push(p);
  if (tc.pts.length === 1) {
    tc.step = 'p2';
    setPrompt('Durchgangspunkt');
  } else if (tc.pts.length === 2) {
    tc.step = 'p3';
    setPrompt('Endpunkt');
  } else {
    const [a, b, c] = tc.pts;
    const arc = arcFrom3(a, b, c);
    if (!arc) {
      toast('Punkte sind kollinear');
      runtime.toolCtx = { step: 'p1', pts: [] };
      setPrompt('Startpunkt des Bogens');
      render();
      return;
    }
    addEntity({ type: 'arc', cx: arc.cx, cy: arc.cy, r: arc.r, a1: arc.a1, a2: arc.a2, layer: state.activeLayer });
    runtime.toolCtx = { step: 'p1', pts: [] };
    setPrompt('Startpunkt des Bogens');
  }
  render();
}

// ---------------- Ellipse ----------------

function handleEllipseClick(p: Pt): void {
  const tc = runtime.toolCtx;
  if (!tc || tc.step === 'center') {
    runtime.toolCtx = { step: 'axis1', centerPt: p };
    setPrompt('Ende der ersten Halbachse');
    render();
    return;
  }
  if (tc.step === 'axis1' && tc.centerPt) {
    const c = tc.centerPt;
    const dx = p.x - c.x, dy = p.y - c.y;
    const rx = Math.hypot(dx, dy);
    if (rx < 1e-6) return;
    const rot = Math.atan2(dy, dx);
    runtime.toolCtx = { step: 'axis2', centerPt: c, a1: p, angleDeg: rot, radius: rx };
    setPrompt('Länge der zweiten Halbachse');
    render();
    return;
  }
  if (tc.step === 'axis2' && tc.centerPt && tc.a1 && tc.radius != null && tc.angleDeg != null) {
    const c = tc.centerPt;
    // Perpendicular distance from cursor to first axis = ry
    const rot = tc.angleDeg;
    const nx = -Math.sin(rot), ny = Math.cos(rot);
    const ry = Math.abs((p.x - c.x) * nx + (p.y - c.y) * ny);
    if (ry < 1e-6) return;
    addEntity({ type: 'ellipse', cx: c.x, cy: c.y, rx: tc.radius, ry, rot, layer: state.activeLayer });
    runtime.toolCtx = { step: 'center' };
    setPrompt('Mittelpunkt der Ellipse');
    render();
  }
}

// ---------------- Spline ----------------

function handleSplineClick(p: Pt): void {
  const tc = runtime.toolCtx;
  if (!tc) return;
  if (!tc.pts) tc.pts = [];
  tc.pts.push(p);
  setPrompt(tc.pts.length === 1 ? 'Nächster Stützpunkt' : 'Nächster Stützpunkt (Enter beendet)');
  render();
}

export function finishSpline(closed: boolean): void {
  const tc = runtime.toolCtx;
  if (tc && tc.pts && tc.pts.length >= 2) {
    addEntity({
      type: 'spline',
      pts: [...tc.pts],
      closed: !!closed,
      layer: state.activeLayer,
    });
  }
  runtime.toolCtx = { step: 'p1', pts: [] };
  setPrompt('Erster Punkt der Spline');
  render();
}

// ---------------- Stretch ----------------

function isPtInBox(p: Pt, a: Pt, b: Pt): boolean {
  const xmin = Math.min(a.x, b.x), xmax = Math.max(a.x, b.x);
  const ymin = Math.min(a.y, b.y), ymax = Math.max(a.y, b.y);
  return p.x >= xmin && p.x <= xmax && p.y >= ymin && p.y <= ymax;
}

/**
 * Apply delta to every vertex of `e` that falls inside the crossing box [w1,w2].
 * Vertices outside stay put. For rect, promotes to polyline if only one corner
 * is inside (otherwise stays a rect).
 */
function stretchEntity(e: Entity, w1: Pt, w2: Pt, delta: Pt): Entity | null {
  const shift = (p: Pt) => isPtInBox(p, w1, w2) ? { x: p.x + delta.x, y: p.y + delta.y } : p;
  if (e.type === 'line') {
    const p1 = shift({ x: e.x1, y: e.y1 });
    const p2 = shift({ x: e.x2, y: e.y2 });
    return { ...e, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y };
  }
  if (e.type === 'polyline') {
    const pts = e.pts.map(shift);
    return { ...e, pts };
  }
  if (e.type === 'rect') {
    const c1 = { x: e.x1, y: e.y1 };
    const c2 = { x: e.x2, y: e.y1 };
    const c3 = { x: e.x2, y: e.y2 };
    const c4 = { x: e.x1, y: e.y2 };
    const corners = [c1, c2, c3, c4];
    const moved = corners.map(c => isPtInBox(c, w1, w2));
    const movedCount = moved.filter(Boolean).length;
    if (movedCount === 0) return e;
    if (movedCount === 4) {
      return { ...e, x1: e.x1 + delta.x, y1: e.y1 + delta.y, x2: e.x2 + delta.x, y2: e.y2 + delta.y };
    }
    // Partial: promote to polyline
    const shifted = corners.map(shift);
    return {
      id: e.id,
      layer: e.layer,
      type: 'polyline',
      pts: shifted,
      closed: true,
    };
  }
  if (e.type === 'text') {
    const p = shift({ x: e.x, y: e.y });
    return { ...e, x: p.x, y: p.y };
  }
  if (e.type === 'dim') {
    const p1 = shift(e.p1);
    const p2 = shift(e.p2);
    return { ...e, p1, p2 };
  }
  // Circle, arc, xline: translate whole entity if center/base is inside the box
  if (e.type === 'circle') {
    const c = shift({ x: e.cx, y: e.cy });
    return { ...e, cx: c.x, cy: c.y };
  }
  if (e.type === 'arc') {
    const c = shift({ x: e.cx, y: e.cy });
    return { ...e, cx: c.x, cy: c.y };
  }
  if (e.type === 'xline') {
    const b = shift({ x: e.x1, y: e.y1 });
    return { ...e, x1: b.x, y1: b.y };
  }
  return e;
}

function handleStretchClick(p: Pt, _worldPt: Pt): void {
  const tc = runtime.toolCtx;
  if (!tc) return;
  if (tc.step === 'win1') {
    runtime.toolCtx = { step: 'win2', p1: p };
    setPrompt('Fenster: zweiter Punkt');
    render();
    return;
  }
  if (tc.step === 'win2' && tc.p1) {
    runtime.toolCtx = { step: 'base', click1: tc.p1, click2: p };
    setPrompt('Basispunkt');
    render();
    return;
  }
  if (tc.step === 'base' && tc.click1 && tc.click2) {
    runtime.toolCtx = { step: 'target', click1: tc.click1, click2: tc.click2, basePt: p };
    setPrompt('Zielpunkt (Zahl = Distanz in Richtung Maus)');
    render();
    return;
  }
  if (tc.step === 'target' && tc.click1 && tc.click2 && tc.basePt) {
    const target = maybeOrtho(tc.basePt, p);
    const delta = sub(target, tc.basePt);
    if (len(delta) < 1e-9) { toast('Kein Versatz'); return; }
    pushUndo();
    const w1 = tc.click1, w2 = tc.click2;
    // Snapshot entities up-front: we'll be mutating features and re-evaluating,
    // so indexing into the live list mid-loop isn't safe.
    const snapshot = [...state.entities];
    for (const e of snapshot) {
      const replaced = stretchEntity(e, w1, w2, delta);
      if (!replaced || replaced === e) continue;
      const fid = featureForEntity(e.id)?.id;
      if (!fid) continue;
      if (replaced.type === e.type) {
        replaceFeatureFromInit(fid, entityInit(replaced));
      } else {
        state.features = state.features.filter(f => f.id !== fid);
        state.features.push(featureFromEntityInit(entityInit(replaced)));
      }
    }
    evaluateTimeline();
    runtime.toolCtx = { step: 'win1' };
    setPrompt('Fenster: erster Punkt');
    render();
    return;
  }
}

function handleXLineClick(p: Pt, worldPt: Pt): void {
  const tc = runtime.toolCtx;
  if (!tc || tc.step === 'ref') {
    const snap = runtime.lastSnap;
    // `axis` snaps are just cursor→axis projections — they should not take
    // precedence over treating the axis itself as a reference for parallels.
    if (snap && (snap.type === 'end' || snap.type === 'mid' ||
                 snap.type === 'int' || snap.type === 'center')) {
      runtime.toolCtx = { step: 'angle-pt', p1: p };
      setPrompt('Winkel 0-90° eingeben oder Richtung klicken');
      render();
      return;
    }
    const ref = pickReference(worldPt);
    if (!ref) {
      toast('Linie, Achse, Rechteck-Kante oder Polylinien-Segment wählen');
      return;
    }
    runtime.toolCtx = { step: 'dist', dir: ref.dir, base: ref.base, ref: ref.entity };
    setPrompt('Abstand eingeben oder Seite klicken');
  } else if (tc.step === 'angle-pt' && tc.p1) {
    const v = sub(p, tc.p1);
    if (len(v) < 1e-9) { toast('Andere Richtung klicken oder Winkel eingeben'); return; }
    makeXLineThrough(tc.p1, norm(v));
    runtime.toolCtx = { step: 'ref' };
    setPrompt('Referenzlinie wählen');
  } else if (tc.step === 'dist' && tc.dir && tc.base) {
    const off = perpOffset(tc.base, tc.dir, p);
    if (Math.abs(off.dist) < 1e-6) return;
    const refEnt = tc.ref && !('_axis' in tc.ref) ? tc.ref : undefined;
    makeParallelXLine(tc.base, tc.dir, numE(Math.abs(off.dist)), off.sign, refEnt);
    runtime.toolCtx = { step: 'ref' };
    setPrompt('Referenzlinie wählen');
  }
  render();
}

function handleOffsetClick(p: Pt, worldPt: Pt): void {
  const tc = runtime.toolCtx;
  if (!tc || tc.step === 'pick') {
    const hit = hitTest(worldPt);
    if (!hit) { toast('Objekt wählen'); return; }
    runtime.toolCtx = { step: 'side', entity: hit, distance: null };
    state.selection.clear();
    state.selection.add(hit.id);
    updateSelStatus();
    setPrompt('Abstand eingeben oder Seite klicken');
    updatePreview();
    render();
    return;
  }
  if (tc.step === 'side' && tc.entity) {
    const info = offsetInfo(tc.entity, p);
    if (!info) return;
    const d = tc.distance != null ? tc.distance : info.dist;
    if (d < 1e-6) return;
    createOffset(tc.entity, d, info.sign);
    runtime.toolCtx = { step: 'pick' };
    state.selection.clear();
    updateSelStatus();
    setPrompt('Objekt wählen');
    render();
  }
}

function handleMoveCopyClick(p: Pt, worldPt: Pt, isCopy: boolean): void {
  const tc = runtime.toolCtx;
  if (!tc) return;
  if (tc.step === 'pick') {
    const hit = hitTest(worldPt);
    if (hit) state.selection.add(hit.id);
    updateSelStatus();
    render();
    return;
  }
  if (tc.step === 'base') {
    tc.basePt = p;
    tc.step = 'target';
    setPrompt(isCopy ? 'Zielpunkt (mehrfach möglich)' : 'Zielpunkt');
    updatePreview();
    render();
    return;
  }
  if (tc.step === 'target' && tc.basePt) {
    const target = maybeOrtho(tc.basePt, p);
    const delta = sub(target, tc.basePt);
    transformSelection(pt => add(pt, delta), { copy: isCopy, pureTranslation: true });
    if (isCopy) {
      setPrompt('Zielpunkt (Rechtsklick beendet)');
    } else {
      state.selection.clear();
      updateSelStatus();
      runtime.toolCtx = { step: 'pick' };
      setPrompt('Objekte wählen, dann Enter');
    }
    render();
  }
}

function handleRotateClick(p: Pt, worldPt: Pt): void {
  const tc = runtime.toolCtx;
  if (!tc) return;
  if (tc.step === 'pick') {
    const hit = hitTest(worldPt);
    if (hit) state.selection.add(hit.id);
    updateSelStatus();
    render();
    return;
  }
  if (tc.step === 'center') {
    tc.centerPt = p;
    tc.step = 'angle';
    setPrompt('Winkel (°) eingeben oder Referenzpunkt klicken');
    updatePreview();
    render();
    return;
  }
  if (tc.step === 'angle' && tc.centerPt) {
    const v = sub(p, tc.centerPt);
    if (len(v) < 1e-6) return;
    const ang = Math.atan2(v.y, v.x);
    applyRotate(tc.centerPt, ang);
    state.selection.clear();
    updateSelStatus();
    runtime.toolCtx = { step: 'pick' };
    setPrompt('Objekte wählen, dann Enter');
    render();
  }
}

export function applyRotate(center: Pt, rad: number): void {
  const cos = Math.cos(rad), sin = Math.sin(rad);
  transformSelection(pt => {
    const dx = pt.x - center.x, dy = pt.y - center.y;
    return { x: center.x + dx * cos - dy * sin, y: center.y + dx * sin + dy * cos };
  }, { pureTranslation: false });
}

/**
 * Scale: three-step tool (pick → base → factor).
 *   pick    — accumulate selection, Enter to advance (handleBareEnter).
 *   base    — click the scaling centre (immovable point).
 *   factor  — click reference length, commits factor = current/reference distance.
 *             OR type a plain factor in the cmdbar (commitScaleFactor).
 * Refuses factors ≤ 0 (toast) to keep geometry sane.
 */
function handleScaleClick(p: Pt, worldPt: Pt): void {
  const tc = runtime.toolCtx;
  if (!tc) return;
  if (tc.step === 'pick') {
    const hit = hitTest(worldPt);
    if (hit) state.selection.add(hit.id);
    updateSelStatus();
    render();
    return;
  }
  if (tc.step === 'base') {
    tc.basePt = p;
    tc.step = 'refLen';
    setPrompt('Referenzpunkt klicken (definiert Ausgangslänge)');
    updatePreview();
    render();
    return;
  }
  if (tc.step === 'refLen' && tc.basePt) {
    const refLen = dist(p, tc.basePt);
    if (refLen < 1e-6) { toast('Punkt zu nah am Basispunkt'); return; }
    tc.refLen = refLen;
    tc.step = 'factor';
    setPrompt('Neue Länge klicken — oder Faktor eingeben (z.B. 2, 0.5)');
    updatePreview();
    render();
    return;
  }
  if (tc.step === 'factor' && tc.basePt && tc.refLen != null) {
    const newLen = dist(p, tc.basePt);
    if (newLen < 1e-6) { toast('Punkt zu nah am Basispunkt'); return; }
    const k = newLen / tc.refLen;
    applyScale(tc.basePt, k);
    state.selection.clear();
    updateSelStatus();
    runtime.toolCtx = { step: 'pick' };
    setPrompt('Objekte wählen, dann Enter');
    render();
  }
}

export function applyScale(center: Pt, k: number): void {
  if (!(k > 0) || !isFinite(k)) return;
  transformSelection(pt => ({
    x: center.x + (pt.x - center.x) * k,
    y: center.y + (pt.y - center.y) * k,
  }), { pureTranslation: false });
}

function handleMirrorClick(p: Pt, worldPt: Pt): void {
  const tc = runtime.toolCtx;
  if (!tc) return;
  if (tc.step === 'pick') {
    const hit = hitTest(worldPt);
    if (hit) state.selection.add(hit.id);
    updateSelStatus();
    render();
    return;
  }
  if (tc.step === 'axis1') {
    tc.a1 = p;
    tc.step = 'axis2';
    setPrompt('Spiegelachse: zweiter Punkt');
    updatePreview();
    render();
    return;
  }
  if (tc.step === 'axis2' && tc.a1) {
    const a = tc.a1, b = p;
    const d = norm(sub(b, a));
    if (len(d) < 1e-9) return;
    const n = perp(d);
    transformSelection(pt => {
      const rel = sub(pt, a);
      return add(a, add(scale(d, dot(rel, d)), scale(n, -dot(rel, n))));
    }, { pureTranslation: false });
    state.selection.clear();
    updateSelStatus();
    runtime.toolCtx = { step: 'pick' };
    setPrompt('Objekte wählen, dann Enter');
    render();
  }
}

// ---------------- Preview ----------------

export function updatePreview(): void {
  const tc = runtime.toolCtx;
  if (!tc) return;
  const snap = runtime.lastSnap;
  const p: Pt = snap ? { x: snap.x, y: snap.y } : state.mouseWorld;
  tc.preview = null;

  if (state.tool === 'line' && tc.step === 'p2' && tc.p1) {
    let endPt: Pt;
    if (tc.lockedDir) {
      const ap = sub(p, tc.p1);
      const length = Math.max(0, dot(ap, tc.lockedDir));
      endPt = add(tc.p1, scale(tc.lockedDir, length));
    } else {
      endPt = maybeOrtho(tc.p1, p);
    }
    tc.preview = { type: 'line', x1: tc.p1.x, y1: tc.p1.y, x2: endPt.x, y2: endPt.y };
    const L = dist(tc.p1, endPt);
    const ang = Math.atan2(endPt.y - tc.p1.y, endPt.x - tc.p1.x) * 180 / Math.PI;
    const lock = tc.lockedDir ? ` (Lock ${tc.angleDeg}°)` : (runtime.orthoSnap && !runtime.lastSnap ? ' (Ortho)' : '');
    setTip(`L ${L.toFixed(2)} · ${ang.toFixed(1)}°${lock}`);
  } else if (state.tool === 'polyline' && tc.pts && tc.pts.length > 0) {
    const last = tc.pts[tc.pts.length - 1];
    let endPt: Pt;
    if (tc.lockedDir) {
      const ap = sub(p, last);
      const length = Math.max(0, dot(ap, tc.lockedDir));
      endPt = add(last, scale(tc.lockedDir, length));
    } else {
      endPt = maybeOrtho(last, p);
    }
    tc.preview = { type: 'polyline', pts: [...tc.pts, endPt] };
    const L = dist(last, endPt);
    const lock = tc.lockedDir ? ` (Lock ${tc.angleDeg}°)` : (runtime.orthoSnap && !runtime.lastSnap ? ' (Ortho)' : '');
    setTip(`Polyline · Seg ${tc.pts.length} · L ${L.toFixed(2)}${lock}`);
  } else if (state.tool === 'rect' && tc.step === 'dims' && tc.p1) {
    let y2 = p.y, x2 = p.x;
    if (tc.vertical != null)   y2 = tc.p1.y + (Math.sign(p.y - tc.p1.y) || 1) * tc.vertical;
    if (tc.horizontal != null) x2 = tc.p1.x + (Math.sign(p.x - tc.p1.x) || 1) * tc.horizontal;
    tc.preview = { type: 'rect', x1: tc.p1.x, y1: tc.p1.y, x2, y2 };
    const w = Math.abs(x2 - tc.p1.x), h = Math.abs(y2 - tc.p1.y);
    const locked: string[] = [];
    if (tc.vertical != null)   locked.push('V=' + tc.vertical);
    if (tc.horizontal != null) locked.push('H=' + tc.horizontal);
    setTip(`Rect · B ${w.toFixed(2)} · H ${h.toFixed(2)}` + (locked.length ? ' · ' + locked.join(' ') : ''));
  } else if (state.tool === 'circle' && tc.step === 'r' && tc.cx != null && tc.cy != null) {
    const r = dist(p, { x: tc.cx, y: tc.cy });
    tc.preview = { type: 'circle', cx: tc.cx, cy: tc.cy, r };
    setTip(`R ${r.toFixed(2)}`);
  } else if (state.tool === 'ref_circle' && tc.step === 'r' && tc.cx != null && tc.cy != null) {
    const r = dist(p, { x: tc.cx, y: tc.cy });
    tc.preview = { type: 'circle', cx: tc.cx, cy: tc.cy, r };
    setTip(`Hilfskreis · R ${r.toFixed(2)}`);
  } else if (state.tool === 'angle' && tc.centerPt) {
    if (tc.step === 'ray1') {
      tc.preview = { type: 'line', x1: tc.centerPt.x, y1: tc.centerPt.y, x2: p.x, y2: p.y };
      setTip('Erster Schenkel');
    } else if (tc.step === 'ray2' && tc.p1) {
      // Preview both rays + arc hint between them.
      const va = sub(tc.p1, tc.centerPt);
      const vb = sub(p, tc.centerPt);
      let diff = (Math.atan2(vb.y, vb.x) - Math.atan2(va.y, va.x)) * 180 / Math.PI;
      while (diff >  180) diff -= 360;
      while (diff <= -180) diff += 360;
      tc.preview = { type: 'group', entities: [
        { type: 'line', x1: tc.centerPt.x, y1: tc.centerPt.y, x2: tc.p1.x, y2: tc.p1.y },
        { type: 'line', x1: tc.centerPt.x, y1: tc.centerPt.y, x2: p.x, y2: p.y },
      ] };
      setTip(`∠ ${Math.abs(diff).toFixed(2)}°`);
    }
  } else if (state.tool === 'scale' && tc.basePt) {
    if (tc.step === 'refLen') {
      tc.preview = { type: 'line', x1: tc.basePt.x, y1: tc.basePt.y, x2: p.x, y2: p.y };
      setTip(`Ref-Länge: ${dist(tc.basePt, p).toFixed(2)}`);
    } else if (tc.step === 'factor' && tc.refLen != null) {
      const newLen = dist(tc.basePt, p);
      const k = tc.refLen > 1e-9 ? newLen / tc.refLen : 1;
      const base = tc.basePt;
      const previews: EntityShape[] = [];
      for (const id of state.selection) {
        const e = state.entities.find(x => x.id === id);
        if (!e) continue;
        for (const t of transformEntity(e, pt => ({
          x: base.x + (pt.x - base.x) * k,
          y: base.y + (pt.y - base.y) * k,
        }), { pureTranslation: false })) {
          previews.push(t as EntityShape);
        }
      }
      tc.preview = { type: 'group', entities: previews };
      setTip(`Faktor ${k.toFixed(3)}`);
    }
  } else if (state.tool === 'circle3' && tc.pts && tc.pts.length > 0) {
    if (tc.pts.length === 1) {
      // two-point diameter preview
      const a = tc.pts[0];
      const cx = (a.x + p.x) / 2, cy = (a.y + p.y) / 2;
      const r = dist(a, p) / 2;
      tc.preview = { type: 'circle', cx, cy, r };
      setTip(`Kreis (2/3) · R ${r.toFixed(2)}`);
    } else if (tc.pts.length === 2) {
      const circ = circleFrom3(tc.pts[0], tc.pts[1], p);
      if (circ) {
        tc.preview = { type: 'circle', cx: circ.cx, cy: circ.cy, r: circ.r };
        setTip(`Kreis · R ${circ.r.toFixed(2)}`);
      } else {
        setTip('Punkte sind kollinear');
      }
    }
  } else if (state.tool === 'arc3' && tc.pts && tc.pts.length > 0) {
    if (tc.pts.length === 1) {
      tc.preview = { type: 'line', x1: tc.pts[0].x, y1: tc.pts[0].y, x2: p.x, y2: p.y };
      setTip('Bogen (2/3) — Durchgangspunkt');
    } else if (tc.pts.length === 2) {
      const arc = arcFrom3(tc.pts[0], tc.pts[1], p);
      if (arc) {
        tc.preview = { type: 'arc', cx: arc.cx, cy: arc.cy, r: arc.r, a1: arc.a1, a2: arc.a2 };
        setTip(`Bogen · R ${arc.r.toFixed(2)}`);
      } else {
        setTip('Punkte sind kollinear');
      }
    }
  } else if (state.tool === 'ellipse' && tc.centerPt) {
    const c = tc.centerPt;
    if (tc.step === 'axis1') {
      const dx = p.x - c.x, dy = p.y - c.y;
      const rx = Math.hypot(dx, dy);
      if (rx > 1e-6) {
        const rot = Math.atan2(dy, dx);
        tc.preview = { type: 'ellipse', cx: c.x, cy: c.y, rx, ry: rx * 0.5, rot };
        setTip(`Halbachse 1: ${rx.toFixed(2)} · ${(rot * 180 / Math.PI).toFixed(1)}°`);
      }
    } else if (tc.step === 'axis2' && tc.radius != null && tc.angleDeg != null) {
      const rot = tc.angleDeg;
      const nx = -Math.sin(rot), ny = Math.cos(rot);
      const ry = Math.abs((p.x - c.x) * nx + (p.y - c.y) * ny);
      if (ry > 1e-6) {
        tc.preview = { type: 'ellipse', cx: c.x, cy: c.y, rx: tc.radius, ry, rot };
        setTip(`Halbachsen: ${tc.radius.toFixed(2)} × ${ry.toFixed(2)}`);
      }
    }
  } else if (state.tool === 'spline' && tc.pts && tc.pts.length > 0) {
    const pts = [...tc.pts, p];
    tc.preview = { type: 'spline', pts };
    setTip(`Spline · ${pts.length} Punkte`);
  } else if (state.tool === 'stretch' && tc.step === 'win2' && tc.p1) {
    tc.preview = { type: 'rect', x1: tc.p1.x, y1: tc.p1.y, x2: p.x, y2: p.y };
    setTip('Crossing-Fenster aufziehen');
  } else if (state.tool === 'stretch' && tc.step === 'target' && tc.click1 && tc.click2 && tc.basePt) {
    const target = maybeOrtho(tc.basePt, p);
    const delta = sub(target, tc.basePt);
    const previews: EntityShape[] = [];
    for (const e of state.entities) {
      const s = stretchEntity(e, tc.click1, tc.click2, delta);
      if (s) previews.push(s as EntityShape);
    }
    tc.preview = { type: 'group', entities: previews };
    setTip(`Δ ${delta.x.toFixed(2)}, ${delta.y.toFixed(2)}`);
  } else if (state.tool === 'polygon' && tc.step === 'radius' && tc.cx != null && tc.cy != null) {
    const r = dist(p, { x: tc.cx, y: tc.cy });
    if (r > 1e-6) {
      const startAng = Math.atan2(p.y - tc.cy, p.x - tc.cx);
      tc.preview = {
        type: 'polyline',
        pts: polygonPoints(tc.cx, tc.cy, r, lastPolygonSides, startAng),
        closed: true,
      };
      setTip(`n=${lastPolygonSides} · R ${r.toFixed(2)}`);
    }
  } else if (state.tool === 'xline' && tc.step === 'ref') {
    if (snap && (snap.type === 'end' || snap.type === 'mid' || snap.type === 'int' || snap.type === 'center')) {
      setTip('Klick: Hilfslinie durch Snap-Punkt');
    } else {
      setTip('Referenzlinie/-achse/Kante wählen');
    }
  } else if (state.tool === 'xline' && tc.step === 'angle-pt' && tc.p1) {
    const v = sub(p, tc.p1);
    const dir = len(v) < 1e-9 ? { x: 1, y: 0 } : norm(v);
    tc.preview = { type: 'xline', x1: tc.p1.x, y1: tc.p1.y, dx: dir.x, dy: dir.y };
    const ang = Math.atan2(dir.y, dir.x) * 180 / Math.PI;
    setTip(`Hilfslinie durch Punkt · ${ang.toFixed(1)}°`);
  } else if (state.tool === 'xline' && tc.step === 'dist' && tc.base && tc.dir) {
    const off = perpOffset(tc.base, tc.dir, p);
    const n = perp(tc.dir);
    const base = add(tc.base, scale(n, off.dist));
    tc.preview = { type: 'xline', x1: base.x, y1: base.y, dx: tc.dir.x, dy: tc.dir.y };
    setTip(`Abstand ${Math.abs(off.dist).toFixed(2)}`);
  } else if (state.tool === 'offset' && tc.step === 'side' && tc.entity) {
    const info = offsetInfo(tc.entity, p);
    if (info) {
      const d = tc.distance != null ? tc.distance : info.dist;
      const preview = makeOffsetPreview(tc.entity, d, info.sign);
      if (preview) tc.preview = preview;
      setTip(`Offset ${d.toFixed(2)}`);
    }
  } else if ((state.tool === 'move' || state.tool === 'copy') && tc.step === 'target' && tc.basePt) {
    const target = maybeOrtho(tc.basePt, p);
    const delta = sub(target, tc.basePt);
    const previews: EntityShape[] = [];
    for (const id of state.selection) {
      const e = state.entities.find(x => x.id === id);
      if (!e) continue;
      for (const t of transformEntity(e, pt => add(pt, delta), { pureTranslation: true })) {
        previews.push(t as EntityShape);
      }
    }
    tc.preview = { type: 'group', entities: previews };
    setTip(`Δ ${delta.x.toFixed(2)}, ${delta.y.toFixed(2)} · Dist ${len(delta).toFixed(2)}`);
  } else if (state.tool === 'rotate' && tc.step === 'angle' && tc.centerPt) {
    const v = sub(p, tc.centerPt);
    const ang = Math.atan2(v.y, v.x);
    const cos = Math.cos(ang), sin = Math.sin(ang);
    const center = tc.centerPt;
    const fn: TransformFn = (pt) => {
      const dx = pt.x - center.x, dy = pt.y - center.y;
      return { x: center.x + dx * cos - dy * sin, y: center.y + dx * sin + dy * cos };
    };
    const previews: EntityShape[] = [];
    for (const id of state.selection) {
      const e = state.entities.find(x => x.id === id);
      if (!e) continue;
      for (const t of transformEntity(e, fn, { pureTranslation: false })) {
        previews.push(t as EntityShape);
      }
    }
    tc.preview = { type: 'group', entities: previews };
    setTip(`Winkel ${(ang * 180 / Math.PI).toFixed(1)}°`);
  } else if (state.tool === 'fillet' && tc.step === 'radius'
             && tc.entity1 && tc.entity2 && tc.click1 && tc.click2
             && tc.entity1.type === 'line' && tc.entity2.type === 'line') {
    const r = radiusFromPoint(tc.entity1, tc.entity2, p);
    if (r > 1e-4) {
      const result = computeFillet(tc.entity1, tc.click1, tc.entity2, tc.click2, r);
      if (!('error' in result)) {
        tc.preview = {
          type: 'group',
          entities: [
            { type: 'line', x1: result.newL1.x1, y1: result.newL1.y1, x2: result.newL1.x2, y2: result.newL1.y2 },
            { type: 'line', x1: result.newL2.x1, y1: result.newL2.y1, x2: result.newL2.x2, y2: result.newL2.y2 },
            { type: 'arc', cx: result.arc.type === 'arc' ? result.arc.cx : 0,
              cy: result.arc.type === 'arc' ? result.arc.cy : 0,
              r: result.arc.type === 'arc' ? result.arc.r : 0,
              a1: result.arc.type === 'arc' ? result.arc.a1 : 0,
              a2: result.arc.type === 'arc' ? result.arc.a2 : 0 },
          ],
        };
        setTip(`Radius ${r.toFixed(2)}`);
      }
    }
  } else if (state.tool === 'chamfer' && tc.step === 'distance'
             && tc.entity1 && tc.entity2 && tc.click1 && tc.click2
             && tc.entity1.type === 'line' && tc.entity2.type === 'line') {
    const d = radiusFromPoint(tc.entity1, tc.entity2, p);
    if (d > 1e-4) {
      const result = computeChamfer(tc.entity1, tc.click1, tc.entity2, tc.click2, d);
      if (!('error' in result)) {
        tc.preview = {
          type: 'group',
          entities: [
            { type: 'line', x1: result.newL1.x1, y1: result.newL1.y1, x2: result.newL1.x2, y2: result.newL1.y2 },
            { type: 'line', x1: result.newL2.x1, y1: result.newL2.y1, x2: result.newL2.x2, y2: result.newL2.y2 },
            { type: 'line', x1: result.cut.x1, y1: result.cut.y1, x2: result.cut.x2, y2: result.cut.y2 },
          ],
        };
        setTip(`Abstand ${d.toFixed(2)}`);
      }
    }
  } else if (state.tool === 'dim' && tc.click1 && tc.click2 && tc.step === 'place') {
    tc.preview = {
      type: 'dim',
      p1: { x: tc.click1.x, y: tc.click1.y },
      p2: { x: tc.click2.x, y: tc.click2.y },
      offset: { x: p.x, y: p.y },
      textHeight: lastTextHeight,
    };
    setTip(`Distanz ${dist(tc.click1, tc.click2).toFixed(2)}`);
  } else if (state.tool === 'mirror' && tc.step === 'axis2' && tc.a1) {
    const a = tc.a1, b = p;
    const d = norm(sub(b, a));
    if (len(d) > 1e-9) {
      const n = perp(d);
      const fn: TransformFn = (pt) => {
        const rel = sub(pt, a);
        return add(a, add(scale(d, dot(rel, d)), scale(n, -dot(rel, n))));
      };
      const previews: EntityShape[] = [];
      for (const id of state.selection) {
        const e = state.entities.find(x => x.id === id);
        if (!e) continue;
        for (const t of transformEntity(e, fn, { pureTranslation: false })) {
          previews.push(t as EntityShape);
        }
      }
      previews.push({ type: 'line', x1: a.x, y1: a.y, x2: b.x, y2: b.y, layer: state.activeLayer });
      tc.preview = { type: 'group', entities: previews };
    }
  }
}

// ---------------- Fillet ----------------

let lastFilletRadius = 10;

export function setFilletRadius(r: number): void { lastFilletRadius = r; }

function lineIntersectionInfinite(a: { x1: number; y1: number; x2: number; y2: number }, b: { x1: number; y1: number; x2: number; y2: number }): Pt | null {
  const den = (a.x1 - a.x2) * (b.y1 - b.y2) - (a.y1 - a.y2) * (b.x1 - b.x2);
  if (Math.abs(den) < 1e-9) return null;
  const t = ((a.x1 - b.x1) * (b.y1 - b.y2) - (a.y1 - b.y1) * (b.x1 - b.x2)) / den;
  return { x: a.x1 + t * (a.x2 - a.x1), y: a.y1 + t * (a.y2 - a.y1) };
}

function computeFillet(l1: LineEntity, click1: Pt, l2: LineEntity, click2: Pt, r: number):
  | { newL1: LineEntity; newL2: LineEntity; arc: EntityInit; t1: Pt; t2: Pt }
  | { error: string }
{
  const P = lineIntersectionInfinite(l1, l2);
  if (!P) return { error: 'Linien sind parallel' };

  // Keep the endpoint on the same side of P as the click. Using dist-to-click
  // breaks when the click sits at the segment midpoint and one endpoint IS P
  // (common for rect edges meeting at the picked corner).
  const a1 = { x: l1.x1, y: l1.y1 }, b1 = { x: l1.x2, y: l1.y2 };
  const a2 = { x: l2.x1, y: l2.y1 }, b2 = { x: l2.x2, y: l2.y2 };
  const d1 = sub(click1, P), d2 = sub(click2, P);
  const kept1 = dot(sub(a1, P), d1) > dot(sub(b1, P), d1) ? a1 : b1;
  const kept2 = dot(sub(a2, P), d2) > dot(sub(b2, P), d2) ? a2 : b2;

  const u1 = norm(sub(kept1, P));
  const u2 = norm(sub(kept2, P));
  if (len(u1) < 1e-9 || len(u2) < 1e-9) return { error: 'Linie zu kurz' };

  const cosA = Math.max(-1, Math.min(1, dot(u1, u2)));
  const angle = Math.acos(cosA);
  if (angle < 1e-4 || angle > Math.PI - 1e-4) return { error: 'Linien sind kollinear oder parallel' };

  const half = angle / 2;
  const t = r / Math.tan(half);
  const cDist = r / Math.sin(half);
  if (t > dist(P, kept1) - 1e-6) return { error: 'Radius zu groß für Linie 1' };
  if (t > dist(P, kept2) - 1e-6) return { error: 'Radius zu groß für Linie 2' };

  const T1 = add(P, scale(u1, t));
  const T2 = add(P, scale(u2, t));
  const bis = norm(add(u1, u2));
  const C = add(P, scale(bis, cDist));

  let aa1 = Math.atan2(T1.y - C.y, T1.x - C.x);
  let aa2 = Math.atan2(T2.y - C.y, T2.x - C.x);
  const twoPi = Math.PI * 2;
  const normA = (x: number) => ((x % twoPi) + twoPi) % twoPi;
  // Pick the short sweep (the fillet arc never exceeds π).
  if (normA(aa2 - aa1) > Math.PI) { const tmp = aa1; aa1 = aa2; aa2 = tmp; }

  const newL1: LineEntity = { ...l1, x1: kept1.x, y1: kept1.y, x2: T1.x, y2: T1.y };
  const newL2: LineEntity = { ...l2, x1: kept2.x, y1: kept2.y, x2: T2.x, y2: T2.y };
  const arc: EntityInit = { type: 'arc', cx: C.x, cy: C.y, r, a1: aa1, a2: aa2, layer: l1.layer };
  return { newL1, newL2, arc, t1: T1, t2: T2 };
}

/** Rect → 4 line EntityInits (caller is responsible for feature wiring). */
function explodeRect(r: RectEntity): EntityInit[] {
  const xl = Math.min(r.x1, r.x2), xr = Math.max(r.x1, r.x2);
  const yb = Math.min(r.y1, r.y2), yt = Math.max(r.y1, r.y2);
  const mk = (x1: number, y1: number, x2: number, y2: number): EntityInit => ({
    layer: r.layer, type: 'line', x1, y1, x2, y2,
  });
  return [
    mk(xl, yb, xr, yb),
    mk(xr, yb, xr, yt),
    mk(xr, yt, xl, yt),
    mk(xl, yt, xl, yb),
  ];
}

/** Resolve a click into a LineEntity — either a line hit directly, or a rect
 *  whose edge was clicked (the rect is exploded into 4 line features). */
function pickFilletLine(worldPt: Pt): LineEntity | null {
  const hit = hitTest(worldPt);
  if (!hit) { toast('Linie oder Rechteck wählen'); return null; }
  if (hit.type === 'line') return hit;
  if (hit.type === 'rect') {
    pushUndo();
    const rectFid = featureForEntity(hit.id)?.id;
    const lineInits = explodeRect(hit);
    if (rectFid) {
      state.features = state.features.filter(f => f.id !== rectFid);
    }
    const newFids: string[] = [];
    for (const init of lineInits) {
      const f = featureFromEntityInit(init);
      state.features.push(f);
      newFids.push(f.id);
    }
    evaluateTimeline();
    let best: LineEntity | null = null;
    let bestD = Infinity;
    for (const fid of newFids) {
      const eid = entityIdForFeature(fid);
      if (eid === null) continue;
      const ent = state.entities.find(e => e.id === eid);
      if (!ent || ent.type !== 'line') continue;
      const d = distPtSeg(worldPt, { x: ent.x1, y: ent.y1 }, { x: ent.x2, y: ent.y2 });
      if (d < bestD) { bestD = d; best = ent; }
    }
    return best;
  }
  toast('Linie oder Rechteck wählen');
  return null;
}

/** Shortest perpendicular distance from a freely-clicked point to either line. */
function radiusFromPoint(l1: LineEntity, l2: LineEntity, pt: Pt): number {
  const d1 = distPtSeg(pt, { x: l1.x1, y: l1.y1 }, { x: l1.x2, y: l1.y2 });
  const d2 = distPtSeg(pt, { x: l2.x1, y: l2.y1 }, { x: l2.x2, y: l2.y2 });
  return Math.min(d1, d2);
}

function handleFilletClick(worldPt: Pt): void {
  const tc = runtime.toolCtx;
  if (!tc) return;
  if (tc.step === 'pick1') {
    const line = pickFilletLine(worldPt);
    if (!line) return;
    tc.entity1 = line;
    tc.click1 = worldPt;
    state.selection.clear();
    state.selection.add(line.id);
    updateSelStatus();
    tc.step = 'pick2';
    setPrompt('Zweite Linie oder Rechteck-Kante wählen');
    render();
    return;
  }
  if (tc.step === 'pick2') {
    const line = pickFilletLine(worldPt);
    if (!line) return;
    if (line.id === tc.entity1?.id) { toast('Andere Linie wählen'); return; }
    tc.entity2 = line;
    tc.click2 = worldPt;
    state.selection.add(line.id);
    updateSelStatus();
    tc.step = 'radius';
    setPrompt(`Radius eingeben oder Punkt klicken (zuletzt ${lastFilletRadius})`);
    render();
    return;
  }
  if (tc.step === 'radius' && tc.entity1 && tc.entity2
      && tc.entity1.type === 'line' && tc.entity2.type === 'line') {
    const r = radiusFromPoint(tc.entity1, tc.entity2, worldPt);
    if (r < 1e-6) { toast('Klick weiter vom Schnittpunkt entfernt'); return; }
    applyFillet(r);
  }
}

/** Invoked by the command line — `handleCommand` forwards a bare number here. */
export function applyFillet(radius: number): void {
  const tc = runtime.toolCtx;
  if (!tc || state.tool !== 'fillet') return;
  const l1 = tc.entity1, c1 = tc.click1, l2 = tc.entity2, c2 = tc.click2;
  if (!l1 || l1.type !== 'line' || !c1 || !l2 || l2.type !== 'line' || !c2) {
    toast('Erst zwei Linien wählen');
    return;
  }
  if (radius <= 0) { toast('Radius muss > 0 sein'); return; }
  const result = computeFillet(l1, c1, l2, c2, radius);
  if ('error' in result) {
    toast(result.error);
    // Reset pick1 so user can try again
    runtime.toolCtx = { step: 'pick1' };
    state.selection.clear();
    updateSelStatus();
    setPrompt('Erste Linie wählen');
    render();
    return;
  }
  lastFilletRadius = radius;
  pushUndo();
  // Replace each line's source feature in place (entity id preserved) and
  // append a new arc feature.
  const f1 = featureForEntity(l1.id), f2 = featureForEntity(l2.id);
  if (f1) replaceFeatureFromInit(f1.id, entityInit(result.newL1));
  if (f2) replaceFeatureFromInit(f2.id, entityInit(result.newL2));
  state.features.push(featureFromEntityInit(result.arc));
  evaluateTimeline();
  updateStats();
  state.selection.clear();
  updateSelStatus();
  runtime.toolCtx = { step: 'pick1' };
  setPrompt('Erste Linie wählen');
  render();
}

// ---------------- Chamfer ----------------

let lastChamferDist = 10;

export function setChamferDist(d: number): void { lastChamferDist = d; }

function computeChamfer(l1: LineEntity, click1: Pt, l2: LineEntity, click2: Pt, d: number):
  | { newL1: LineEntity; newL2: LineEntity; cut: LineEntity; t1: Pt; t2: Pt }
  | { error: string }
{
  const P = lineIntersectionInfinite(l1, l2);
  if (!P) return { error: 'Linien sind parallel' };
  const a1 = { x: l1.x1, y: l1.y1 }, b1 = { x: l1.x2, y: l1.y2 };
  const a2 = { x: l2.x1, y: l2.y1 }, b2 = { x: l2.x2, y: l2.y2 };
  const d1 = sub(click1, P), d2 = sub(click2, P);
  const kept1 = dot(sub(a1, P), d1) > dot(sub(b1, P), d1) ? a1 : b1;
  const kept2 = dot(sub(a2, P), d2) > dot(sub(b2, P), d2) ? a2 : b2;
  const u1 = norm(sub(kept1, P));
  const u2 = norm(sub(kept2, P));
  if (len(u1) < 1e-9 || len(u2) < 1e-9) return { error: 'Linie zu kurz' };
  const cosA = Math.max(-1, Math.min(1, dot(u1, u2)));
  const angle = Math.acos(cosA);
  if (angle < 1e-4 || angle > Math.PI - 1e-4) return { error: 'Linien sind kollinear oder parallel' };
  if (d > dist(P, kept1) - 1e-6) return { error: 'Abstand zu groß für Linie 1' };
  if (d > dist(P, kept2) - 1e-6) return { error: 'Abstand zu groß für Linie 2' };
  const T1 = add(P, scale(u1, d));
  const T2 = add(P, scale(u2, d));
  const newL1: LineEntity = { ...l1, x1: kept1.x, y1: kept1.y, x2: T1.x, y2: T1.y };
  const newL2: LineEntity = { ...l2, x1: kept2.x, y1: kept2.y, x2: T2.x, y2: T2.y };
  const cut: LineEntity = { id: 0, layer: l1.layer, type: 'line', x1: T1.x, y1: T1.y, x2: T2.x, y2: T2.y };
  return { newL1, newL2, cut, t1: T1, t2: T2 };
}

function handleChamferClick(worldPt: Pt): void {
  const tc = runtime.toolCtx;
  if (!tc) return;
  if (tc.step === 'pick1') {
    const line = pickFilletLine(worldPt);
    if (!line) return;
    tc.entity1 = line;
    tc.click1 = worldPt;
    state.selection.clear();
    state.selection.add(line.id);
    updateSelStatus();
    tc.step = 'pick2';
    setPrompt('Zweite Linie oder Rechteck-Kante wählen');
    render();
    return;
  }
  if (tc.step === 'pick2') {
    const line = pickFilletLine(worldPt);
    if (!line) return;
    if (line.id === tc.entity1?.id) { toast('Andere Linie wählen'); return; }
    tc.entity2 = line;
    tc.click2 = worldPt;
    state.selection.add(line.id);
    updateSelStatus();
    tc.step = 'distance';
    setPrompt(`Abstand eingeben oder Punkt klicken (zuletzt ${lastChamferDist})`);
    render();
    return;
  }
  if (tc.step === 'distance' && tc.entity1 && tc.entity2
      && tc.entity1.type === 'line' && tc.entity2.type === 'line') {
    const d = radiusFromPoint(tc.entity1, tc.entity2, worldPt);
    if (d < 1e-6) { toast('Klick weiter vom Schnittpunkt entfernt'); return; }
    applyChamfer(d);
  }
}

/** Invoked by the command line — `handleCommand` forwards a bare number here. */
export function applyChamfer(distance: number): void {
  const tc = runtime.toolCtx;
  if (!tc || state.tool !== 'chamfer') return;
  const l1 = tc.entity1, c1 = tc.click1, l2 = tc.entity2, c2 = tc.click2;
  if (!l1 || l1.type !== 'line' || !c1 || !l2 || l2.type !== 'line' || !c2) {
    toast('Erst zwei Linien wählen');
    return;
  }
  if (distance <= 0) { toast('Abstand muss > 0 sein'); return; }
  const result = computeChamfer(l1, c1, l2, c2, distance);
  if ('error' in result) {
    toast(result.error);
    runtime.toolCtx = { step: 'pick1' };
    state.selection.clear();
    updateSelStatus();
    setPrompt('Erste Linie wählen');
    render();
    return;
  }
  lastChamferDist = distance;
  pushUndo();
  const f1 = featureForEntity(l1.id), f2 = featureForEntity(l2.id);
  if (f1) replaceFeatureFromInit(f1.id, entityInit(result.newL1));
  if (f2) replaceFeatureFromInit(f2.id, entityInit(result.newL2));
  state.features.push(featureFromEntityInit(entityInit(result.cut)));
  evaluateTimeline();
  updateStats();
  state.selection.clear();
  updateSelStatus();
  runtime.toolCtx = { step: 'pick1' };
  setPrompt('Erste Linie wählen');
  render();
}

// ---------------- Extend ----------------

function handleExtendClick(worldPt: Pt): void {
  const hit = hitTest(worldPt);
  if (!hit) { toast('Nichts getroffen'); return; }
  if (hit.type !== 'line') { toast('Nur Linien können verlängert werden'); return; }
  const a: Pt = { x: hit.x1, y: hit.y1 };
  const b: Pt = { x: hit.x2, y: hit.y2 };
  const dA = dist(worldPt, a), dB = dist(worldPt, b);
  const anchor = dA > dB ? a : b;
  const endpoint = dA > dB ? b : a;
  const dir = norm(sub(endpoint, anchor));
  if (len(dir) < 1e-9) return;
  const dists = extendCutterDistances(endpoint, dir, hit.id);
  const positive = dists.filter(d => d > 1e-6).sort((x, y) => x - y);
  if (!positive.length) { toast('Kein Ziel zum Verlängern gefunden'); return; }
  const d = positive[0];
  const newEnd: Pt = { x: endpoint.x + dir.x * d, y: endpoint.y + dir.y * d };
  pushUndo();
  const fid = featureForEntity(hit.id)?.id;
  if (!fid) return;
  const newLine: LineEntity = dA > dB
    ? { ...hit, x2: newEnd.x, y2: newEnd.y }
    : { ...hit, x1: newEnd.x, y1: newEnd.y };
  replaceFeatureFromInit(fid, entityInit(newLine));
  evaluateTimeline();
  render();
}

/** Distances along a ray from `origin` in unit-direction `dir` where the ray
 *  hits any other entity. The ray is built as a very long segment so the
 *  existing segSegT/lineCircleT helpers (which clamp to [0,1]) work unchanged. */
function extendCutterDistances(origin: Pt, dir: Pt, selfId: number): number[] {
  const HUGE = 1e6;
  const a = origin;
  const b: Pt = { x: origin.x + dir.x * HUGE, y: origin.y + dir.y * HUGE };
  const out: number[] = [];
  for (const e of state.entities) {
    if (e.id === selfId) continue;
    const layer = state.layers[e.layer];
    if (!layer || !layer.visible) continue;
    if (e.type === 'line') {
      const t = segSegT(a, b, { x: e.x1, y: e.y1 }, { x: e.x2, y: e.y2 });
      if (t !== null) out.push(t * HUGE);
    } else if (e.type === 'xline') {
      const t = segSegT(a, b, { x: e.x1, y: e.y1 }, { x: e.x1 + e.dx, y: e.y1 + e.dy }, true);
      if (t !== null) out.push(t * HUGE);
    } else if (e.type === 'rect') {
      const xl = Math.min(e.x1, e.x2), xr = Math.max(e.x1, e.x2);
      const yb = Math.min(e.y1, e.y2), yt = Math.max(e.y1, e.y2);
      const edges: [Pt, Pt][] = [
        [{ x: xl, y: yb }, { x: xr, y: yb }],
        [{ x: xr, y: yb }, { x: xr, y: yt }],
        [{ x: xr, y: yt }, { x: xl, y: yt }],
        [{ x: xl, y: yt }, { x: xl, y: yb }],
      ];
      for (const [p1, p2] of edges) {
        const t = segSegT(a, b, p1, p2);
        if (t !== null) out.push(t * HUGE);
      }
    } else if (e.type === 'circle') {
      for (const t of lineCircleT(a, b, { x: e.cx, y: e.cy }, e.r)) out.push(t * HUGE);
    } else if (e.type === 'arc') {
      for (const t of lineCircleT(a, b, { x: e.cx, y: e.cy }, e.r)) {
        const px = a.x + (b.x - a.x) * t, py = a.y + (b.y - a.y) * t;
        const ang = Math.atan2(py - e.cy, px - e.cx);
        if (angleInSweep(ang, e.a1, e.a2)) out.push(t * HUGE);
      }
    } else if (e.type === 'polyline') {
      for (let i = 0; i < e.pts.length - 1; i++) {
        const t = segSegT(a, b, e.pts[i], e.pts[i + 1]);
        if (t !== null) out.push(t * HUGE);
      }
      if (e.closed && e.pts.length >= 2) {
        const t = segSegT(a, b, e.pts[e.pts.length - 1], e.pts[0]);
        if (t !== null) out.push(t * HUGE);
      }
    }
  }
  return out;
}

// ---------------- Text ----------------

let lastTextHeight = 5;

export function setTextHeight(h: number): void {
  if (h > 0) lastTextHeight = h;
  const tc = runtime.toolCtx;
  if (state.tool === 'text' && tc) {
    tc.textHeight = lastTextHeight;
    setPrompt(`Einfügepunkt für Text (Höhe=${lastTextHeight})`);
  }
}

function handleTextClick(p: Pt): void {
  const tc = runtime.toolCtx;
  if (!tc || state.tool !== 'text') return;
  const h = tc.textHeight ?? lastTextHeight;
  // Two-step flow: point → cmdbar text field. No more native window.prompt.
  runtime.toolCtx = { step: 'text', basePt: p, textHeight: h };
  setPrompt('Text eingeben (Enter bestätigt)');
  render();
}

// ---------------- Dimension ----------------

function dimLayer(): number {
  const idx = state.layers.findIndex(L => L.name.toLowerCase().includes('bemaß'));
  return idx >= 0 ? idx : state.activeLayer;
}

function handleDimClick(p: Pt): void {
  const tc = runtime.toolCtx;
  if (!tc) return;
  if (tc.step === 'pick1') {
    tc.click1 = p;
    tc.step = 'pick2';
    setPrompt('Zweiter Messpunkt');
    render();
    return;
  }
  if (tc.step === 'pick2' && tc.click1) {
    if (dist(tc.click1, p) < 1e-6) { toast('Punkte müssen unterschiedlich sein'); return; }
    tc.click2 = p;
    tc.step = 'place';
    setPrompt('Bemaßungsposition klicken');
    render();
    return;
  }
  if (tc.step === 'place' && tc.click1 && tc.click2) {
    addEntity({
      type: 'dim',
      p1: { x: tc.click1.x, y: tc.click1.y },
      p2: { x: tc.click2.x, y: tc.click2.y },
      offset: { x: p.x, y: p.y },
      textHeight: lastTextHeight,
      style: runtime.dimStyle,
      layer: dimLayer(),
    });
    runtime.toolCtx = { step: 'pick1' };
    setPrompt('Erster Messpunkt');
    render();
  }
}

// ---------------- Trim ----------------

/** Intersect segment a→b with segment c→d. Returns t on a→b, or null. */
function segSegT(a: Pt, b: Pt, c: Pt, d: Pt, bInfinite = false): number | null {
  const rX = b.x - a.x, rY = b.y - a.y;
  const sX = d.x - c.x, sY = d.y - c.y;
  const rxs = rX * sY - rY * sX;
  if (Math.abs(rxs) < 1e-12) return null;
  const qpX = c.x - a.x, qpY = c.y - a.y;
  const t = (qpX * sY - qpY * sX) / rxs;
  const u = (qpX * rY - qpY * rX) / rxs;
  if (t < -1e-9 || t > 1 + 1e-9) return null;
  if (!bInfinite && (u < -1e-9 || u > 1 + 1e-9)) return null;
  return t;
}

function lineCircleT(a: Pt, b: Pt, c: Pt, r: number): number[] {
  const dX = b.x - a.x, dY = b.y - a.y;
  const fX = a.x - c.x, fY = a.y - c.y;
  const A = dX * dX + dY * dY;
  const B = 2 * (fX * dX + fY * dY);
  const C = fX * fX + fY * fY - r * r;
  let disc = B * B - 4 * A * C;
  if (disc < 0 || A < 1e-12) return [];
  disc = Math.sqrt(disc);
  const out: number[] = [];
  const t1 = (-B - disc) / (2 * A);
  const t2 = (-B + disc) / (2 * A);
  if (t1 >= -1e-9 && t1 <= 1 + 1e-9) out.push(t1);
  if (Math.abs(t2 - t1) > 1e-9 && t2 >= -1e-9 && t2 <= 1 + 1e-9) out.push(t2);
  return out;
}

function trimCutterTs(target: LineEntity): number[] {
  const a: Pt = { x: target.x1, y: target.y1 };
  const b: Pt = { x: target.x2, y: target.y2 };
  const out: number[] = [];
  for (const e of state.entities) {
    if (e.id === target.id) continue;
    const layer = state.layers[e.layer];
    if (!layer || !layer.visible) continue;
    if (e.type === 'line') {
      const t = segSegT(a, b, { x: e.x1, y: e.y1 }, { x: e.x2, y: e.y2 });
      if (t !== null) out.push(t);
    } else if (e.type === 'xline') {
      const t = segSegT(a, b, { x: e.x1, y: e.y1 }, { x: e.x1 + e.dx, y: e.y1 + e.dy }, true);
      if (t !== null) out.push(t);
    } else if (e.type === 'rect') {
      const xl = Math.min(e.x1, e.x2), xr = Math.max(e.x1, e.x2);
      const yb = Math.min(e.y1, e.y2), yt = Math.max(e.y1, e.y2);
      const edges: [Pt, Pt][] = [
        [{ x: xl, y: yb }, { x: xr, y: yb }],
        [{ x: xr, y: yb }, { x: xr, y: yt }],
        [{ x: xr, y: yt }, { x: xl, y: yt }],
        [{ x: xl, y: yt }, { x: xl, y: yb }],
      ];
      for (const [p1, p2] of edges) {
        const t = segSegT(a, b, p1, p2);
        if (t !== null) out.push(t);
      }
    } else if (e.type === 'circle') {
      out.push(...lineCircleT(a, b, { x: e.cx, y: e.cy }, e.r));
    } else if (e.type === 'arc') {
      for (const t of lineCircleT(a, b, { x: e.cx, y: e.cy }, e.r)) {
        const px = a.x + (b.x - a.x) * t, py = a.y + (b.y - a.y) * t;
        const ang = Math.atan2(py - e.cy, px - e.cx);
        if (angleInSweep(ang, e.a1, e.a2)) out.push(t);
      }
    } else if (e.type === 'polyline') {
      for (let i = 0; i < e.pts.length - 1; i++) {
        const t = segSegT(a, b, e.pts[i], e.pts[i + 1]);
        if (t !== null) out.push(t);
      }
      if (e.closed && e.pts.length >= 2) {
        const t = segSegT(a, b, e.pts[e.pts.length - 1], e.pts[0]);
        if (t !== null) out.push(t);
      }
    }
  }
  return out;
}

function handleTrimClick(worldPt: Pt): void {
  const hit = hitTest(worldPt);
  if (!hit) { toast('Nichts getroffen'); return; }
  if (hit.type !== 'line') { toast('Nur Linien können gestutzt werden'); return; }
  const a: Pt = { x: hit.x1, y: hit.y1 };
  const b: Pt = { x: hit.x2, y: hit.y2 };
  const abX = b.x - a.x, abY = b.y - a.y;
  const L2 = abX * abX + abY * abY;
  if (L2 < 1e-12) return;
  const tClick = ((worldPt.x - a.x) * abX + (worldPt.y - a.y) * abY) / L2;
  const ts = trimCutterTs(hit).filter(t => t > 1e-6 && t < 1 - 1e-6);
  let tLow = 0, tHigh = 1;
  let hasLow = false, hasHigh = false;
  for (const t of ts) {
    if (t < tClick) { if (t > tLow) { tLow = t; hasLow = true; } }
    else            { if (t < tHigh) { tHigh = t; hasHigh = true; } }
  }
  if (!hasLow && !hasHigh) { toast('Kein Schnittpunkt — nichts zu stutzen'); return; }
  pushUndo();
  const fid = featureForEntity(hit.id)?.id;
  if (!fid) return;
  const mk = (t0: number, t1: number): EntityInit => ({
    type: 'line', layer: hit.layer,
    x1: a.x + abX * t0, y1: a.y + abY * t0,
    x2: a.x + abX * t1, y2: a.y + abY * t1,
  });
  const pieces: EntityInit[] = [];
  if (hasLow)  pieces.push(mk(0, tLow));
  if (hasHigh) pieces.push(mk(tHigh, 1));
  if (!pieces.length) {
    state.features = state.features.filter(f => f.id !== fid);
    state.selection.delete(hit.id);
  } else {
    // Reuse the source feature for the first surviving piece to keep the
    // original entity id; append fresh features for the rest.
    replaceFeatureFromInit(fid, pieces[0]);
    for (let i = 1; i < pieces.length; i++) {
      state.features.push(featureFromEntityInit(pieces[i]));
    }
  }
  evaluateTimeline();
  updateStats();
  updateSelStatus();
  render();
}

// ---------------- Drag-select box ----------------

type Rect = { minX: number; minY: number; maxX: number; maxY: number };

function entityAABB(e: Entity): Rect | null {
  if (e.type === 'line')   return { minX: Math.min(e.x1, e.x2), minY: Math.min(e.y1, e.y2), maxX: Math.max(e.x1, e.x2), maxY: Math.max(e.y1, e.y2) };
  if (e.type === 'rect')   return { minX: Math.min(e.x1, e.x2), minY: Math.min(e.y1, e.y2), maxX: Math.max(e.x1, e.x2), maxY: Math.max(e.y1, e.y2) };
  if (e.type === 'circle') return { minX: e.cx - e.r, minY: e.cy - e.r, maxX: e.cx + e.r, maxY: e.cy + e.r };
  if (e.type === 'arc')    return { minX: e.cx - e.r, minY: e.cy - e.r, maxX: e.cx + e.r, maxY: e.cy + e.r };
  if (e.type === 'text') {
    const w = Math.max(e.height * 0.3, e.height * e.text.length * 0.6);
    return { minX: e.x, minY: e.y, maxX: e.x + w, maxY: e.y + e.height };
  }
  if (e.type === 'dim') {
    const xs = [e.p1.x, e.p2.x, e.offset.x], ys = [e.p1.y, e.p2.y, e.offset.y];
    return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
  }
  if (e.type === 'polyline') {
    if (!e.pts.length) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of e.pts) {
      if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
    }
    return { minX, minY, maxX, maxY };
  }
  return null;
}

// Liang-Barsky segment-vs-rect intersection.
function segIntersectsRect(ax: number, ay: number, bx: number, by: number, r: Rect): boolean {
  let t0 = 0, t1 = 1;
  const dx = bx - ax, dy = by - ay;
  const p = [-dx, dx, -dy, dy];
  const q = [ax - r.minX, r.maxX - ax, ay - r.minY, r.maxY - ay];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) { if (q[i] < 0) return false; }
    else {
      const t = q[i] / p[i];
      if (p[i] < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
      else          { if (t < t0) return false; if (t < t1) t1 = t; }
    }
  }
  return true;
}

function entityIntersectsRect(e: Entity, r: Rect): boolean {
  if (e.type === 'xline') {
    const T = 1e6;
    return segIntersectsRect(e.x1 - e.dx * T, e.y1 - e.dy * T, e.x1 + e.dx * T, e.y1 + e.dy * T, r);
  }
  const bb = entityAABB(e);
  if (!bb) return false;
  if (bb.maxX < r.minX || bb.minX > r.maxX || bb.maxY < r.minY || bb.minY > r.maxY) return false;
  if (e.type === 'line') return segIntersectsRect(e.x1, e.y1, e.x2, e.y2, r);
  if (e.type === 'polyline') {
    for (let i = 0; i < e.pts.length - 1; i++) {
      if (segIntersectsRect(e.pts[i].x, e.pts[i].y, e.pts[i + 1].x, e.pts[i + 1].y, r)) return true;
    }
    if (e.closed && e.pts.length > 2) {
      const first = e.pts[0], last = e.pts[e.pts.length - 1];
      if (segIntersectsRect(last.x, last.y, first.x, first.y, r)) return true;
    }
    return false;
  }
  if (e.type === 'circle' || e.type === 'arc') {
    // bbox overlap already checked; treat as circle/circle-arc hit for selection.
    const ex = Math.max(r.minX, Math.min(e.cx, r.maxX));
    const ey = Math.max(r.minY, Math.min(e.cy, r.maxY));
    const dx = e.cx - ex, dy = e.cy - ey;
    return dx * dx + dy * dy <= e.r * e.r;
  }
  return true; // rect passes bbox overlap
}

function entityContainedInRect(e: Entity, r: Rect): boolean {
  if (e.type === 'xline') return false;
  const bb = entityAABB(e);
  if (!bb) return false;
  return bb.minX >= r.minX && bb.minY >= r.minY && bb.maxX <= r.maxX && bb.maxY <= r.maxY;
}

/**
 * Select entities by drag rectangle. Right-to-left drag (a.x > b.x) → crossing:
 * pick anything the box touches. Left-to-right → window: pick only fully enclosed.
 * Shift extends the existing selection.
 */
export function selectByBox(a: Pt, b: Pt, shift: boolean): void {
  const crossing = a.x > b.x;
  const r: Rect = {
    minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y),
    maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y),
  };
  if (!shift) state.selection.clear();
  for (const e of state.entities) {
    const layer = state.layers[e.layer];
    if (!layer || !layer.visible || layer.locked) continue;
    const hit = crossing ? entityIntersectsRect(e, r) : entityContainedInRect(e, r);
    if (hit) state.selection.add(e.id);
  }
  updateSelStatus();
}

// Re-exports so other modules don't need to know about hit-test helpers
export { hitTest, nearestPolySegment, nearestRectEdge };
