/**
 * Tool-aware input bar. Each tool+step pair declares a schema of labeled fields;
 * user fills them (numbers or parameter names), Tab/Enter advances, Enter on the
 * last field commits. Replaces the single-input command line.
 *
 * Field lifecycle:
 *   setPrompt(text) → rebuildCmdBar(text)
 *   rebuildCmdBar   → schemaFor(tool, tc) → render labeled inputs
 *   Enter           → parse current field, advance or commit
 *   commit()        → may call setPrompt again for the next step
 */

import type { Expr, Feature, Pt, ToolCtx, ToolId } from './types';
import { state, runtime } from './state';
import { dom } from './dom';
import { add, directionAtAngle, dot, len, norm, perp, perpOffset, scale, sub } from './math';
import {
  addEntity, applyChamfer, applyGroupOffsetAt, applyRotate, applyScale,
  finishPolyline, finishSpline, getFilletRadius, getPolygonSides, handleClick,
  handlePolylineClick, makeParallelXLine, makeXLineThrough, setChamferDist,
  setFilletRadius, setPolygonSides, setTextHeight, cancelTool,
} from './tools';
import { createParameter, evalExpr, findParamByName, parseExprInput } from './params';
import { evaluateTimeline, newFeatureId } from './features';
import { pushUndo } from './undo';
import { requestRender as render } from './render';
import { toast, updateSelStatus, updateStats } from './ui';

const numE = (v: number): Expr => ({ kind: 'num', value: v });

// ============================================================================
// Field types
// ============================================================================

export type CmdFieldKind = 'expr' | 'angle' | 'integer' | 'text';

export type CmdField = {
  name: string;
  label: string;
  kind: CmdFieldKind;
  placeholder?: string;
  /** Hint shown in the "Bedeutung" prompt when a new parameter gets created. */
  meaningHint?: string;
  /** If true (default), commit is blocked when this field is empty. */
  required?: boolean;
  /**
   * Initial value rendered into the input. Used e.g. for the line/polyline
   * angle field once the direction is locked — the user sees the locked value
   * persist instead of an empty "°" placeholder.
   */
  value?: string;
};

export type CmdValue = { expr: Expr; value: number; text?: string };
export type CmdValues = Record<string, CmdValue | undefined>;

export type CmdSchema = {
  prompt: string;
  fields: CmdField[];
  /**
   * Applied when the user presses Enter on the last field or all fields are
   * filled. `values` has `undefined` for empty fields, meaning "use mouse".
   */
  commit: (values: CmdValues) => void;
  /**
   * If true, pressing Enter on ANY field commits immediately instead of
   * advancing focus to the next empty field. Used by line/polyline where
   * typing just an angle and hitting Enter must lock the direction right
   * away — the old advance-then-commit behaviour made users press Enter
   * twice to lock.
   */
  commitOnEnter?: boolean;
};

// ============================================================================
// Render + input handling
// ============================================================================

let currentSchema: CmdSchema | null = null;
let fieldValues: CmdValues = {};
/**
 * When set, the next rebuild focuses this field instead of the first one.
 * Used after a "partial commit" (e.g. line-angle lock) so focus jumps to the
 * next field the user expects to fill, not back to the field they just left.
 */
let pendingFocusField: string | null = null;

/**
 * Re-evaluate the current (tool, step) and rebuild the input row.
 * Called from `setPrompt` on every step transition.
 */
export function rebuildCmdBar(promptFallback: string): void {
  const schema = schemaFor(state.tool, runtime.toolCtx ?? null);
  currentSchema = schema;
  fieldValues = {};
  const label = (schema?.prompt ?? promptFallback) + ':';
  dom.cmdPrompt.textContent = label;
  dom.cmdFields.innerHTML = '';
  if (!schema) return;
  for (const f of schema.fields) {
    const wrap = document.createElement('div');
    wrap.className = 'cmd-field';
    const lbl = document.createElement('span');
    lbl.className = 'cmd-field-label';
    lbl.textContent = f.label;
    const inp = document.createElement('input');
    inp.className = 'cmd-field-input';
    inp.autocomplete = 'off';
    inp.spellcheck = false;
    inp.dataset.fieldName = f.name;
    inp.dataset.fieldKind = f.kind;
    if (f.placeholder) inp.placeholder = f.placeholder;
    if (f.meaningHint) inp.dataset.meaningHint = f.meaningHint;
    if (f.value) inp.value = f.value;
    wrap.append(lbl, inp);
    dom.cmdFields.appendChild(wrap);
  }
  if (pendingFocusField) {
    const el = dom.cmdFields.querySelector<HTMLInputElement>(
      `.cmd-field-input[data-field-name="${pendingFocusField}"]`,
    );
    pendingFocusField = null;
    if (el) { el.focus(); el.select(); return; }
  }
  focusFirstField();
}

function focusFirstField(): void {
  const first = dom.cmdFields.querySelector<HTMLInputElement>('.cmd-field-input');
  if (first) first.focus();
}

function allInputs(): HTMLInputElement[] {
  return [...dom.cmdFields.querySelectorAll<HTMLInputElement>('.cmd-field-input')];
}

/**
 * True when focus is on a cmdbar field. Used by the global key handler to
 * avoid stealing keys that belong to the active field.
 */
export function cmdBarHasFocus(): boolean {
  const el = document.activeElement;
  return el instanceof HTMLInputElement && el.classList.contains('cmd-field-input');
}

/** True when at least one tool-input field is visible. */
export function cmdBarHasFields(): boolean {
  return currentSchema !== null && currentSchema.fields.length > 0;
}

/** Give the first field focus (used when the user types a digit on the canvas). */
export function focusCmdBar(): void {
  focusFirstField();
}

function markInvalid(inp: HTMLInputElement): void {
  inp.classList.add('cmd-field-invalid');
  setTimeout(() => inp.classList.remove('cmd-field-invalid'), 600);
}

function parseField(inp: HTMLInputElement): boolean {
  const name = inp.dataset.fieldName!;
  const kind = inp.dataset.fieldKind as CmdFieldKind;
  const hint = inp.dataset.meaningHint;
  const raw = inp.value.trim();
  if (kind === 'text') {
    // Accept any non-empty string (preserve internal spaces but trim edges).
    if (!raw) { fieldValues[name] = undefined; return true; }
    fieldValues[name] = { expr: numE(0), value: 0, text: raw } as CmdValue;
    return true;
  }
  if (!raw) { fieldValues[name] = undefined; return true; }
  if (kind === 'integer') {
    const n = parseInt(raw, 10);
    if (!Number.isInteger(n) || !/^-?\d+$/.test(raw)) { toast('Ganze Zahl erwartet'); markInvalid(inp); return false; }
    fieldValues[name] = { expr: numE(n), value: n };
    return true;
  }
  if (kind === 'angle') {
    const n = parseFloat(raw.replace(',', '.'));
    if (!Number.isFinite(n)) { toast('Ungültiger Winkel'); markInvalid(inp); return false; }
    fieldValues[name] = { expr: numE(n), value: n };
    return true;
  }
  // expr: number or parameter name
  const r = parseValueInput(raw, hint);
  if (!r) { toast('Eingabe nicht erkannt'); markInvalid(inp); return false; }
  fieldValues[name] = r;
  return true;
}

dom.cmdFields.addEventListener('keydown', (e) => {
  const target = e.target;
  if (!(target instanceof HTMLInputElement) || !target.classList.contains('cmd-field-input')) return;

  if (e.key === 'Escape') {
    e.preventDefault();
    cancelTool();
    return;
  }

  if (e.key === 'Backspace' && target.value === '') {
    const inputs = allInputs();
    const idx = inputs.indexOf(target);
    if (idx > 0) {
      e.preventDefault();
      inputs[idx - 1].focus();
      inputs[idx - 1].select();
    }
    return;
  }

  if (e.key === 'Tab') {
    // Let the browser handle tabbing between fields.
    return;
  }

  if (e.key === 'Enter') {
    e.preventDefault();
    if (!currentSchema) return;
    if (!parseField(target)) return;
    const inputs = allInputs();
    const idx = inputs.indexOf(target);
    const isLast = idx === inputs.length - 1;
    // Advance to the next empty field unless we're on the last one — OR unless
    // the schema wants commit-on-Enter (line/polyline: angle-only Enter must
    // lock immediately, not bounce focus to the length field).
    if (!isLast && !currentSchema.commitOnEnter) {
      for (let i = idx + 1; i < inputs.length; i++) {
        if (!inputs[i].value) { inputs[i].focus(); return; }
      }
      // All later fields already filled → commit (fall through).
    }
    // Before committing, ensure all required fields are filled.
    const firstMissing = inputs.find(inp => {
      const fname = inp.dataset.fieldName!;
      const field = currentSchema!.fields.find(f => f.name === fname);
      return (field?.required !== false) && fieldValues[fname] === undefined;
    });
    if (firstMissing) {
      markInvalid(firstMissing);
      firstMissing.focus();
      return;
    }
    const schema = currentSchema;
    const values = fieldValues;
    schema.commit(values);
    return;
  }
});

// ============================================================================
// Number/parameter parsing with create-on-unknown dialog
// ============================================================================

function parseValueInput(raw: string, meaningHint?: string): CmdValue | null {
  const r = parseExprInput(raw);
  if (!r) return null;
  if (r.kind === 'expr') return { expr: r.expr, value: evalExpr(r.expr) };
  const valRaw = prompt(`Neuer Parameter „${r.name}" — Wert:`, '');
  if (valRaw == null) return null;
  const val = parseFloat(valRaw.replace(',', '.'));
  if (!Number.isFinite(val)) { toast('Ungültige Zahl'); return null; }
  const meaning = prompt(
    `Bedeutung von ${r.name}${meaningHint ? ` (z.B. ${meaningHint})` : ''}:`,
    meaningHint ?? '',
  ) ?? '';
  const existing = findParamByName(r.name);
  const p = existing ?? createParameter(r.name, val, meaning.trim() || undefined);
  return { expr: { kind: 'param', id: p.id }, value: p.value };
}

// ============================================================================
// Schema registry: (tool, step) → schema
// ============================================================================

function schemaFor(tool: ToolId, tc: ToolCtx | null): CmdSchema | null {
  if (tool === 'line' && tc && tc.step === 'p2' && tc.p1) {
    const locked = tc.lockedDir != null;
    const lockNote = locked ? ` (${tc.angleDeg}° gelockt)` : '';
    const angleVal = locked && tc.angleDeg != null ? String(tc.angleDeg) : undefined;
    return {
      prompt: 'Winkel + Länge' + lockNote,
      fields: [
        { name: 'angle',  label: 'Winkel', kind: 'angle', placeholder: '°',    required: false, value: angleVal },
        { name: 'length', label: 'Länge',  kind: 'expr',  meaningHint: 'Länge', required: false },
      ],
      commit: (v) => commitLine(tc, v),
      commitOnEnter: true,
    };
  }
  if (tool === 'polyline' && tc && tc.pts && tc.pts.length > 0) {
    const locked = tc.lockedDir != null;
    const lockNote = locked ? ` (${tc.angleDeg}° gelockt)` : '';
    const angleVal = locked && tc.angleDeg != null ? String(tc.angleDeg) : undefined;
    return {
      prompt: 'Winkel + Länge' + lockNote,
      fields: [
        { name: 'angle',  label: 'Winkel', kind: 'angle', placeholder: '°',  required: false, value: angleVal },
        { name: 'length', label: 'Länge',  kind: 'expr',                      required: false },
      ],
      commit: (v) => commitPolyline(tc, v),
      commitOnEnter: true,
    };
  }
  if (tool === 'rect' && tc && tc.step === 'dims' && tc.p1) {
    return {
      prompt: 'Breite + Höhe',
      fields: [
        { name: 'width',  label: 'Breite', kind: 'expr', meaningHint: 'Breite' },
        { name: 'height', label: 'Höhe',   kind: 'expr', meaningHint: 'Höhe' },
      ],
      commit: (v) => commitRect(tc, v),
    };
  }
  if (tool === 'circle' && tc && tc.step === 'r' && tc.cx != null && tc.cy != null) {
    return {
      prompt: 'Radius',
      fields: [{ name: 'radius', label: 'Radius', kind: 'expr', meaningHint: 'Radius' }],
      commit: (v) => commitCircle(tc, v),
    };
  }
  if (tool === 'ref_circle' && tc && tc.step === 'r' && tc.cx != null && tc.cy != null) {
    return {
      prompt: 'Radius (Hilfskreis)',
      fields: [{ name: 'radius', label: 'Radius', kind: 'expr', meaningHint: 'Hilfsradius' }],
      commit: (v) => commitRefCircle(tc, v),
    };
  }
  if (tool === 'ellipse' && tc) {
    if (tc.step === 'axis1' && tc.centerPt) {
      return {
        prompt: 'Halbachse 1: Länge + Winkel',
        fields: [
          { name: 'length', label: 'Länge',  kind: 'expr',  meaningHint: 'Halbachse 1' },
          { name: 'angle',  label: 'Winkel', kind: 'angle', placeholder: '°', required: false },
        ],
        commit: (v) => commitEllipseAxis1(tc, v),
      };
    }
    if (tc.step === 'axis2' && tc.centerPt && tc.radius != null && tc.angleDeg != null) {
      return {
        prompt: 'Halbachse 2: Länge',
        fields: [{ name: 'length', label: 'Länge', kind: 'expr', meaningHint: 'Halbachse 2' }],
        commit: (v) => commitEllipseAxis2(tc, v),
      };
    }
  }
  if (tool === 'mirror' && tc && tc.step === 'axis2' && tc.a1) {
    return {
      prompt: 'Spiegelachse: Winkel',
      fields: [{ name: 'angle', label: 'Winkel', kind: 'angle', placeholder: '°' }],
      commit: (v) => commitMirrorAxis2(tc, v),
    };
  }
  if (tool === 'dim' && tc && tc.step === 'place' && tc.click1 && tc.click2) {
    return {
      prompt: 'Abstand zur Messlinie',
      fields: [{ name: 'offset', label: 'Abstand', kind: 'expr' }],
      commit: (v) => commitDimOffset(tc, v),
    };
  }
  if (tool === 'scale' && tc && tc.step === 'factor' && tc.basePt && tc.refLen != null) {
    return {
      prompt: 'Skalierfaktor',
      fields: [{ name: 'factor', label: 'Faktor', kind: 'expr', placeholder: 'z.B. 2 oder 0.5' }],
      commit: (v) => commitScaleFactor(tc, v),
    };
  }
  if (tool === 'polygon' && tc) {
    if (tc.step === 'center') {
      return {
        prompt: 'Seiten (n=' + getPolygonSides() + ')',
        fields: [{ name: 'sides', label: 'Seiten', kind: 'integer', placeholder: '3-64' }],
        commit: (v) => commitPolygonSides(v),
      };
    }
    if (tc.step === 'radius' && tc.cx != null && tc.cy != null) {
      return {
        prompt: 'Radius',
        fields: [{ name: 'radius', label: 'Radius', kind: 'expr' }],
        commit: (v) => commitPolygonRadius(tc, v),
      };
    }
  }
  if (tool === 'xline' && tc) {
    if (tc.step === 'dist' && tc.base && tc.dir) {
      return {
        prompt: 'Abstand (oder Seite klicken)',
        fields: [{ name: 'distance', label: 'Abstand', kind: 'expr', meaningHint: 'Abstand' }],
        commit: (v) => commitXlineDist(tc, v),
      };
    }
    if (tc.step === 'angle-pt' && tc.p1) {
      return {
        prompt: 'Winkel',
        fields: [{ name: 'angle', label: 'Winkel', kind: 'angle' }],
        commit: (v) => commitXlineAngle(tc, v),
      };
    }
  }
  if (tool === 'offset' && tc && tc.step === 'side') {
    return {
      prompt: 'Abstand, dann Seite klicken',
      fields: [{ name: 'distance', label: 'Abstand', kind: 'expr' }],
      commit: (v) => commitOffsetDistance(tc, v),
    };
  }
  if (tool === 'text' && tc) {
    if (tc.step === 'text' && tc.basePt) {
      return {
        prompt: 'Text eingeben',
        fields: [{ name: 'text', label: 'Text', kind: 'text', placeholder: 'z.B. M8' }],
        commit: (v) => commitTextCreate(tc, v),
      };
    }
    return {
      prompt: 'Texthöhe',
      fields: [{ name: 'height', label: 'Höhe', kind: 'expr' }],
      commit: (v) => commitTextHeight(v),
    };
  }
  if (tool === 'fillet' && tc) {
    return {
      prompt: 'Radius (sticky — gilt bis neu eingegeben)',
      fields: [{
        name: 'radius', label: 'Radius', kind: 'expr',
        value: String(getFilletRadius()),
      }],
      commit: (v) => commitFilletRadius(tc, v),
    };
  }
  if (tool === 'chamfer' && tc) {
    return {
      prompt: tc.entity1 && tc.entity2 ? 'Abstand (Enter committed)' : 'Abstand (Default)',
      fields: [{ name: 'distance', label: 'Abstand', kind: 'expr' }],
      commit: (v) => commitChamferDistance(tc, v),
    };
  }
  if (tool === 'rotate' && tc && tc.step === 'angle' && tc.centerPt) {
    return {
      prompt: 'Drehwinkel',
      fields: [{ name: 'angle', label: 'Winkel', kind: 'angle' }],
      commit: (v) => commitRotate(tc, v),
    };
  }
  if ((tool === 'move' || tool === 'copy') && tc && tc.step === 'target' && tc.basePt) {
    return {
      prompt: 'Abstand (Richtung = Maus)',
      fields: [{ name: 'distance', label: 'Abstand', kind: 'expr' }],
      commit: (v) => commitMoveCopyTarget(tc, v),
    };
  }
  if (tool === 'stretch' && tc && tc.step === 'target' && tc.basePt) {
    return {
      prompt: 'Abstand (Richtung = Maus)',
      fields: [{ name: 'distance', label: 'Abstand', kind: 'expr' }],
      commit: (v) => commitStretchTarget(tc, v),
    };
  }
  return null;
}

// ============================================================================
// Empty-Enter advance for pick steps (move/rotate/mirror after object select)
// ============================================================================

/**
 * Called by main.ts when Enter is pressed and the cmdbar doesn't have its own
 * field to handle it (tool has no schema, or a polyline/spline is ready to
 * finish). Returns true if handled.
 */
export function handleBareEnter(): boolean {
  const tc = runtime.toolCtx;
  if (state.tool === 'polyline' && tc?.pts && tc.pts.length >= 2) {
    finishPolyline(false); return true;
  }
  if (state.tool === 'spline' && tc?.pts && tc.pts.length >= 2) {
    finishSpline(false); return true;
  }
  if ((state.tool === 'move' || state.tool === 'copy') && tc?.step === 'pick') {
    if (!state.selection.size) { toast('Erst Objekte wählen'); return true; }
    runtime.toolCtx = { step: 'base' };
    setPromptRef('Basispunkt');
    render();
    return true;
  }
  if (state.tool === 'rotate' && tc?.step === 'pick') {
    if (!state.selection.size) { toast('Erst Objekte wählen'); return true; }
    runtime.toolCtx = { step: 'center' };
    setPromptRef('Drehzentrum');
    render();
    return true;
  }
  if (state.tool === 'mirror' && tc?.step === 'pick') {
    if (!state.selection.size) { toast('Erst Objekte wählen'); return true; }
    runtime.toolCtx = { step: 'axis1' };
    setPromptRef('Spiegelachse: erster Punkt');
    render();
    return true;
  }
  if (state.tool === 'offset' && tc?.step === 'pick') {
    if (!state.selection.size) { toast('Erst Objekte wählen'); return true; }
    // Snapshot the selection into the tool ctx so subsequent clicks don't
    // affect which entities get offset — the 'side' step only cares about
    // which side of these entities the cursor sits on.
    const ents = state.entities.filter(e => state.selection.has(e.id));
    runtime.toolCtx = { step: 'side', entities: ents, distance: null };
    setPromptRef('Abstand eingeben oder Seite klicken');
    render();
    return true;
  }
  return false;
}

// Late-bind to avoid circular-import headaches (ui.ts imports cmdbar.ts).
let setPromptFn: ((t: string) => void) | null = null;
export function bindSetPrompt(fn: (t: string) => void): void { setPromptFn = fn; }
function setPromptRef(t: string): void { if (setPromptFn) setPromptFn(t); }

// ============================================================================
// Commit handlers — one per (tool, step)
// ============================================================================

function commitLine(tc: ToolCtx, v: CmdValues): void {
  if (!tc.p1) return;
  const angle = v.angle?.value;
  const length = v.length?.value;

  // User typed a different angle than the current lock → re-lock with the new
  // angle. Persisted angle value in the field means "angle already equals
  // tc.angleDeg" on commit; only a *changed* value triggers re-lock.
  if (angle !== undefined && tc.lockedDir && tc.angleDeg !== angle) {
    tc.lockedDir = directionAtAngle(tc.p1, state.mouseWorld, angle);
    tc.angleDeg = angle;
  }

  // First-time lock: no length yet → set lock, jump to length field.
  if (angle !== undefined && !tc.lockedDir) {
    tc.lockedDir = directionAtAngle(tc.p1, state.mouseWorld, angle);
    tc.angleDeg = angle;
    if (length === undefined || length <= 0) {
      pendingFocusField = 'length';
      setPromptRef(`Länge (Winkel ${angle}° gelockt)`);
      render();
      return;
    }
  }

  // Commit the line: use the lock if it exists, otherwise the typed angle,
  // otherwise the mouse direction.
  if (length !== undefined && length > 0) {
    const dir = tc.lockedDir
      ?? (angle !== undefined ? directionAtAngle(tc.p1, state.mouseWorld, angle) : norm(sub(state.mouseWorld, tc.p1)));
    if (len(dir) < 1e-9) { toast('Erst Mausrichtung wählen'); return; }
    handleClick(add(tc.p1, scale(dir, length)));
    return;
  }
  toast('Mindestens Winkel oder Länge eingeben');
}

function commitPolyline(tc: ToolCtx, v: CmdValues): void {
  if (!tc.pts || tc.pts.length === 0) return;
  const last = tc.pts[tc.pts.length - 1];
  const angle = v.angle?.value;
  const length = v.length?.value;

  if (angle === undefined && length === undefined) {
    if (tc.pts.length >= 2) finishPolyline(false);
    return;
  }

  // Re-lock if the user changed the angle value.
  if (angle !== undefined && tc.lockedDir && tc.angleDeg !== angle) {
    tc.lockedDir = directionAtAngle(last, state.mouseWorld, angle);
    tc.angleDeg = angle;
  }

  // First-time lock: no length yet → set lock, jump to length field.
  if (angle !== undefined && !tc.lockedDir) {
    tc.lockedDir = directionAtAngle(last, state.mouseWorld, angle);
    tc.angleDeg = angle;
    if (length === undefined || length <= 0) {
      pendingFocusField = 'length';
      setPromptRef(`Länge (Winkel ${angle}° gelockt)`);
      render();
      return;
    }
  }

  if (length !== undefined && length > 0) {
    const dir = tc.lockedDir
      ?? (angle !== undefined ? directionAtAngle(last, state.mouseWorld, angle) : norm(sub(state.mouseWorld, last)));
    if (len(dir) < 1e-9) { toast('Erst Mausrichtung wählen'); return; }
    handlePolylineClick(add(last, scale(dir, length)));
  }
}

function commitRect(tc: ToolCtx, v: CmdValues): void {
  if (!tc.p1) return;
  const w = v.width, h = v.height;
  if (!w || w.value <= 0 || !h || h.value <= 0) { toast('Breite und Höhe eingeben'); return; }
  const cur = state.mouseWorld;
  const sX: 1 | -1 = (cur.x - tc.p1.x) >= 0 ? 1 : -1;
  const sY: 1 | -1 = (cur.y - tc.p1.y) >= 0 ? 1 : -1;
  pushUndo();
  const feat: Feature = {
    id: newFeatureId(),
    kind: 'rect',
    layer: state.activeLayer,
    p1: { kind: 'abs', x: numE(tc.p1.x), y: numE(tc.p1.y) },
    width:  w.expr,
    height: h.expr,
    signX: sX, signY: sY,
  };
  state.features.push(feat);
  evaluateTimeline();
  updateStats();
  runtime.toolCtx = { step: 'p1' };
  setPromptRef('Erster Eckpunkt');
  render();
}

function commitCircle(tc: ToolCtx, v: CmdValues): void {
  if (tc.cx == null || tc.cy == null) return;
  const r = v.radius;
  if (!r || r.value <= 0) { toast('Radius eingeben'); return; }
  pushUndo();
  const feat: Feature = {
    id: newFeatureId(),
    kind: 'circle',
    layer: state.activeLayer,
    center: { kind: 'abs', x: numE(tc.cx), y: numE(tc.cy) },
    radius: r.expr,
  };
  state.features.push(feat);
  evaluateTimeline();
  updateStats();
  runtime.toolCtx = { step: 'p1' };
  setPromptRef('Mittelpunkt');
  render();
}

function commitPolygonSides(v: CmdValues): void {
  const n = v.sides?.value;
  if (n === undefined || !Number.isInteger(n) || n < 3 || n > 64) {
    toast('Seiten 3-64'); return;
  }
  setPolygonSides(n);
  toast('n = ' + n);
  setPromptRef(`Mittelpunkt (n=${n})`);
  render();
}

function commitPolygonRadius(tc: ToolCtx, v: CmdValues): void {
  if (tc.cx == null || tc.cy == null) return;
  const r = v.radius;
  if (!r || r.value <= 0) { toast('Radius eingeben'); return; }
  const startAng = Math.atan2(state.mouseWorld.y - tc.cy, state.mouseWorld.x - tc.cx);
  const n = getPolygonSides();
  const step = 2 * Math.PI / n;
  const pts: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a = startAng + i * step;
    pts.push({ x: tc.cx + Math.cos(a) * r.value, y: tc.cy + Math.sin(a) * r.value });
  }
  addEntity({ type: 'polyline', pts, closed: true, layer: state.activeLayer });
  runtime.toolCtx = { step: 'center' };
  setPromptRef(`Mittelpunkt (n=${n})`);
  render();
}

function commitXlineDist(tc: ToolCtx, v: CmdValues): void {
  if (!tc.base || !tc.dir) return;
  const d = v.distance;
  if (!d || d.value <= 0) { toast('Abstand eingeben'); return; }
  const off = perpOffset(tc.base, tc.dir, state.mouseWorld);
  const refEnt = tc.ref && !('_axis' in tc.ref) ? tc.ref : undefined;
  makeParallelXLine(tc.base, tc.dir, d.expr, off.sign, refEnt);
  runtime.toolCtx = { step: 'ref' };
  setPromptRef('Referenzlinie wählen');
  render();
}

function commitXlineAngle(tc: ToolCtx, v: CmdValues): void {
  if (!tc.p1) return;
  const ang = v.angle?.value;
  if (ang === undefined) { toast('Winkel eingeben'); return; }
  makeXLineThrough(tc.p1, directionAtAngle(tc.p1, state.mouseWorld, ang));
  runtime.toolCtx = { step: 'ref' };
  setPromptRef('Referenzlinie wählen');
  render();
}

function commitOffsetDistance(tc: ToolCtx, v: CmdValues): void {
  const d = v.distance;
  if (!d || d.value <= 0) { toast('Abstand eingeben'); return; }
  tc.distance = d.value;
  // Commit immediately using the current mouse position to decide the side.
  // No need for a second "which side" click — if the cursor is inside the
  // selected loop, the offset goes inward; outside → outward. Matches how
  // users actually think about offset ("5 mm nach innen").
  applyGroupOffsetAt(state.mouseWorld);
}

function commitTextHeight(v: CmdValues): void {
  const h = v.height;
  if (!h || h.value <= 0) { toast('Höhe eingeben'); return; }
  setTextHeight(h.value);
  toast('Texthöhe = ' + h.value);
}

function commitFilletRadius(_tc: ToolCtx, v: CmdValues): void {
  const r = v.radius;
  if (!r || r.value <= 0) { toast('Radius eingeben'); return; }
  // Sticky radius: store and reuse until explicitly changed. The fillet
  // itself is committed by picking the second line.
  setFilletRadius(r.value);
  toast('Radius = ' + r.value);
}

function commitChamferDistance(tc: ToolCtx, v: CmdValues): void {
  const d = v.distance;
  if (!d || d.value <= 0) { toast('Abstand eingeben'); return; }
  if (tc.step === 'distance' && tc.entity1 && tc.entity2) {
    applyChamfer(d.value);
  } else {
    setChamferDist(d.value);
    toast('Abstand = ' + d.value);
  }
}

function commitRotate(tc: ToolCtx, v: CmdValues): void {
  if (!tc.centerPt) return;
  const ang = v.angle?.value;
  if (ang === undefined) { toast('Winkel eingeben'); return; }
  applyRotate(tc.centerPt, ang * Math.PI / 180);
  state.selection.clear();
  updateSelStatus();
  runtime.toolCtx = { step: 'pick' };
  setPromptRef('Objekte wählen, dann Enter');
  render();
}

function commitMoveCopyTarget(tc: ToolCtx, v: CmdValues): void {
  if (!tc.basePt) return;
  const d = v.distance;
  if (!d || d.value <= 0) { toast('Abstand eingeben'); return; }
  const dir = norm(sub(state.mouseWorld, tc.basePt));
  if (len(dir) < 1e-9) { toast('Erst Mausrichtung wählen'); return; }
  handleClick(add(tc.basePt, scale(dir, d.value)));
}

function commitStretchTarget(tc: ToolCtx, v: CmdValues): void {
  if (!tc.basePt) return;
  const d = v.distance;
  if (!d || d.value <= 0) { toast('Abstand eingeben'); return; }
  const dir = norm(sub(state.mouseWorld, tc.basePt));
  if (len(dir) < 1e-9) { toast('Erst Mausrichtung wählen'); return; }
  handleClick(add(tc.basePt, scale(dir, d.value)));
}

function commitRefCircle(tc: ToolCtx, v: CmdValues): void {
  if (tc.cx == null || tc.cy == null) return;
  const r = v.radius;
  if (!r || r.value <= 0) { toast('Radius eingeben'); return; }
  // Build the feature directly so a variable/formula radius stays bound —
  // addEntity would pass through EntityInit (literal number) and the
  // variable binding would be lost.
  const hlIdx = state.layers.findIndex(L => L.name.toLowerCase().includes('hilfslin'));
  const layer = hlIdx >= 0 ? hlIdx : state.activeLayer;
  pushUndo();
  const feat: Feature = {
    id: newFeatureId(),
    kind: 'circle',
    layer,
    center: { kind: 'abs', x: numE(tc.cx), y: numE(tc.cy) },
    radius: r.expr,
  };
  state.features.push(feat);
  evaluateTimeline();
  updateStats();
  runtime.toolCtx = { step: 'center' };
  setPromptRef('Hilfskreis: Mittelpunkt');
  render();
}

function commitEllipseAxis1(tc: ToolCtx, v: CmdValues): void {
  if (!tc.centerPt) return;
  const L = v.length;
  if (!L || L.value <= 0) { toast('Länge eingeben'); return; }
  const ang = v.angle?.value;
  // Use mouse direction if no angle supplied.
  let dir: Pt;
  if (ang !== undefined) {
    const radDir = { x: Math.cos(ang * Math.PI / 180), y: Math.sin(ang * Math.PI / 180) };
    dir = radDir;
  } else {
    const m = sub(state.mouseWorld, tc.centerPt);
    if (len(m) < 1e-9) { toast('Erst Richtung wählen'); return; }
    dir = norm(m);
  }
  const a1 = add(tc.centerPt, scale(dir, L.value));
  const rot = Math.atan2(dir.y, dir.x);
  runtime.toolCtx = { step: 'axis2', centerPt: tc.centerPt, a1, angleDeg: rot, radius: L.value };
  setPromptRef('Länge der zweiten Halbachse');
  render();
}

function commitEllipseAxis2(tc: ToolCtx, v: CmdValues): void {
  if (!tc.centerPt || tc.radius == null || tc.angleDeg == null) return;
  const L = v.length;
  if (!L || L.value <= 0) { toast('Länge eingeben'); return; }
  pushUndo();
  addEntity({
    type: 'ellipse',
    cx: tc.centerPt.x, cy: tc.centerPt.y,
    rx: tc.radius, ry: L.value,
    rot: tc.angleDeg,
    layer: state.activeLayer,
  });
  runtime.toolCtx = { step: 'center' };
  setPromptRef('Mittelpunkt der Ellipse');
  render();
}

function commitMirrorAxis2(tc: ToolCtx, v: CmdValues): void {
  if (!tc.a1) return;
  const ang = v.angle?.value;
  if (ang === undefined) { toast('Winkel eingeben'); return; }
  const d = directionAtAngle(tc.a1, state.mouseWorld, ang);
  if (len(d) < 1e-9) return;
  // Delegate to the mirror tool's axis2-click handler by feeding it a
  // synthetic second axis point along the typed direction.
  handleClick(add(tc.a1, scale(d, 1)));
}

function commitDimOffset(tc: ToolCtx, v: CmdValues): void {
  if (!tc.click1 || !tc.click2) return;
  const d = v.offset;
  if (!d || d.value <= 0) { toast('Abstand eingeben'); return; }
  const dir = norm(sub(tc.click2, tc.click1));
  if (len(dir) < 1e-9) return;
  const n = perp(dir);
  // Side = same side as current mouse, so preview and typed value agree.
  const mRel = sub(state.mouseWorld, tc.click1);
  const sgn = dot(mRel, n) >= 0 ? 1 : -1;
  const mid = { x: (tc.click1.x + tc.click2.x) / 2, y: (tc.click1.y + tc.click2.y) / 2 };
  const off = add(mid, scale(n, d.value * sgn));
  handleClick(off);
}

function commitScaleFactor(tc: ToolCtx, v: CmdValues): void {
  if (!tc.basePt) return;
  const k = v.factor?.value;
  if (k === undefined || !(k > 0) || !isFinite(k)) { toast('Faktor > 0 eingeben'); return; }
  applyScale(tc.basePt, k);
  state.selection.clear();
  updateSelStatus();
  runtime.toolCtx = { step: 'pick' };
  setPromptRef('Objekte wählen, dann Enter');
  render();
}

function commitTextCreate(tc: ToolCtx, v: CmdValues): void {
  if (!tc.basePt) return;
  const t = v.text?.text;
  if (!t) { toast('Text eingeben'); return; }
  const h = tc.textHeight ?? 5;
  pushUndo();
  addEntity({
    type: 'text',
    x: tc.basePt.x, y: tc.basePt.y,
    text: t,
    height: h,
    layer: state.activeLayer,
  });
  runtime.toolCtx = { step: 'pt', textHeight: h };
  setPromptRef(`Einfügepunkt für Text (Höhe=${h})`);
  render();
}
