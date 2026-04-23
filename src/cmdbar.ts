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

import type { Expr, Feature, PointRef, Pt, ToolCtx, ToolId } from './types';
import { state, runtime } from './state';
import { dom } from './dom';
import { add, directionAtAngle, dot, len, norm, perp, perpOffset, scale, sub } from './math';
import {
  addEntity, applyGroupOffsetAt, applyLineOffsetAt, applyRotate, applyScale,
  applyStretchTarget, commitArcBulge, commitRectAsLines,
  commitRectAsLinesExpr, crossMirrorPrompt, finishPolyline, finishSpline,
  getPolygonSides, handleClick, handlePolylineClick, makeAxisParallelXLine,
  makeParallelXLine, makeXLineThroughRef, promptDivideCount,
  setPolygonSides, cancelTool,
} from './tools';
import { createParameter, evalExpr, findParamByName, parseExprInput } from './params';
import { ensureParametricModeOn } from './parametric-mode';
import { evaluateTimeline, newFeatureId } from './features';
import { pushUndo } from './undo';
import { requestRender as render } from './render';
import { toast, updateSelStatus, updateStats } from './ui';
import { showPrompt } from './modal';

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
  /**
   * Called when Enter on a field advances focus to the next empty field
   * instead of committing. Lets a schema "lock" the partial value into its
   * tool context so the live preview and a subsequent cursor click respect
   * it — e.g. rect: typing a width and pressing Enter locks the width and
   * leaves the height to the cursor.
   */
  onPartial?: (values: CmdValues, advancedFrom: string) => void;
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
  hideSuggestions();
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

async function parseField(inp: HTMLInputElement): Promise<boolean> {
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
  // expr: number or parameter name — async because unknown-ident dialogs are modal.
  const r = await parseValueInput(raw, hint);
  if (!r) { toast('Eingabe nicht erkannt'); markInvalid(inp); return false; }
  fieldValues[name] = r;
  return true;
}

// ============================================================================
// Variable / parameter autocomplete
// ============================================================================
//
// When the user types an identifier-like prefix into an `expr`-kind field, pop
// a floating list of matching parameter names underneath. Arrow keys walk the
// list; Enter (with a highlighted suggestion) inserts it into the field
// instead of committing the field. This makes "use a variable" discoverable —
// users no longer need to remember exactly what they named it.

/** Is the character typeable as part of a parameter identifier? */
function isIdentChar(c: string): boolean {
  return /[A-Za-z0-9_]/.test(c);
}

/**
 * Extract the identifier token the caret is currently sitting in (or on the
 * right edge of). Returns `{ token, start }` where `start` is the index the
 * token begins at, used to replace it on accept. Returns null if the caret
 * isn't next to an identifier (e.g. right after an operator / space).
 */
function identTokenAtCaret(inp: HTMLInputElement): { token: string; start: number } | null {
  const caret = inp.selectionStart ?? inp.value.length;
  const v = inp.value;
  let start = caret;
  while (start > 0 && isIdentChar(v[start - 1])) start--;
  let end = caret;
  while (end < v.length && isIdentChar(v[end])) end++;
  const token = v.slice(start, end);
  // Don't suggest for purely numeric tokens — they're just numbers.
  if (!token || /^\d+(\.\d*)?$/.test(token)) return null;
  return { token, start };
}

/** DOM for the dropdown. Built lazily and reused. */
let suggestionBox: HTMLDivElement | null = null;
let activeSuggestions: Array<{ name: string; value: number; meaning?: string }> = [];
let suggestionIndex = -1;
let suggestionFor: HTMLInputElement | null = null;

function ensureSuggestionBox(): HTMLDivElement {
  if (suggestionBox) return suggestionBox;
  const box = document.createElement('div');
  box.className = 'cmd-suggest';
  box.style.position = 'absolute';
  box.style.display = 'none';
  box.style.zIndex = '50';
  document.body.appendChild(box);
  box.addEventListener('mousedown', (e) => {
    // Prevent input blur on click; accept the clicked suggestion.
    e.preventDefault();
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    const idx = Number(target.dataset.idx);
    if (Number.isInteger(idx) && suggestionFor) {
      acceptSuggestion(suggestionFor, idx);
    }
  });
  suggestionBox = box;
  return box;
}

function hideSuggestions(): void {
  if (suggestionBox) suggestionBox.style.display = 'none';
  activeSuggestions = [];
  suggestionIndex = -1;
  suggestionFor = null;
}

function renderSuggestions(inp: HTMLInputElement): void {
  const box = ensureSuggestionBox();
  if (!activeSuggestions.length) { hideSuggestions(); return; }
  const rect = inp.getBoundingClientRect();
  box.style.left = `${rect.left}px`;
  box.style.top = `${rect.bottom + 2}px`;
  box.style.minWidth = `${rect.width}px`;
  box.innerHTML = '';
  for (let i = 0; i < activeSuggestions.length; i++) {
    const s = activeSuggestions[i];
    const row = document.createElement('div');
    row.className = 'cmd-suggest-row' + (i === suggestionIndex ? ' active' : '');
    row.dataset.idx = String(i);
    const name = document.createElement('span');
    name.className = 'cmd-suggest-name';
    name.textContent = s.name;
    const val = document.createElement('span');
    val.className = 'cmd-suggest-val';
    val.textContent = ` = ${s.value}`;
    row.append(name, val);
    if (s.meaning) {
      const m = document.createElement('span');
      m.className = 'cmd-suggest-meaning';
      m.textContent = ` — ${s.meaning}`;
      row.append(m);
    }
    box.appendChild(row);
  }
  box.style.display = 'block';
  suggestionFor = inp;
}

function updateSuggestions(inp: HTMLInputElement): void {
  // Only for expr-kind fields. Angle/integer/text don't accept identifiers.
  if (inp.dataset.fieldKind !== 'expr') { hideSuggestions(); return; }
  const tok = identTokenAtCaret(inp);
  if (!tok) { hideSuggestions(); return; }
  const q = tok.token.toLowerCase();
  const matches = state.parameters
    .filter(p => p.name.toLowerCase().includes(q))
    // Exact-prefix matches first, then contains-matches. Preserves user intent
    // when they type the full name (shows it on top) but still surfaces loose
    // matches when they type e.g. "L" for "BoxLength".
    .sort((a, b) => {
      const an = a.name.toLowerCase(), bn = b.name.toLowerCase();
      const ap = an.startsWith(q) ? 0 : 1;
      const bp = bn.startsWith(q) ? 0 : 1;
      if (ap !== bp) return ap - bp;
      return an.localeCompare(bn);
    })
    .slice(0, 8);
  if (!matches.length || (matches.length === 1 && matches[0].name === tok.token)) {
    hideSuggestions();
    return;
  }
  activeSuggestions = matches.map(p => ({ name: p.name, value: p.value, meaning: p.meaning }));
  suggestionIndex = 0;
  renderSuggestions(inp);
}

function acceptSuggestion(inp: HTMLInputElement, idx: number): void {
  if (idx < 0 || idx >= activeSuggestions.length) return;
  const pick = activeSuggestions[idx];
  const tok = identTokenAtCaret(inp);
  if (!tok) return;
  const v = inp.value;
  const before = v.slice(0, tok.start);
  const after = v.slice(tok.start + tok.token.length);
  inp.value = before + pick.name + after;
  const caret = (before + pick.name).length;
  inp.setSelectionRange(caret, caret);
  hideSuggestions();
}

dom.cmdFields.addEventListener('input', (e) => {
  const target = e.target;
  if (!(target instanceof HTMLInputElement) || !target.classList.contains('cmd-field-input')) return;
  updateSuggestions(target);
});

dom.cmdFields.addEventListener('focusin', (e) => {
  const target = e.target;
  if (target instanceof HTMLInputElement && target.classList.contains('cmd-field-input')) {
    updateSuggestions(target);
  }
});

dom.cmdFields.addEventListener('focusout', () => {
  // Defer hiding a tick so a click on a suggestion row can fire first.
  setTimeout(hideSuggestions, 100);
});

dom.cmdFields.addEventListener('keydown', (e) => {
  const target = e.target;
  if (!(target instanceof HTMLInputElement) || !target.classList.contains('cmd-field-input')) return;

  // When the suggestion dropdown is visible, arrow keys navigate it and Tab /
  // Enter accept. Escape also closes it without cancelling the tool.
  if (activeSuggestions.length && suggestionFor === target) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      suggestionIndex = (suggestionIndex + 1) % activeSuggestions.length;
      renderSuggestions(target);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      suggestionIndex = (suggestionIndex - 1 + activeSuggestions.length) % activeSuggestions.length;
      renderSuggestions(target);
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      acceptSuggestion(target, suggestionIndex);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      hideSuggestions();
      return;
    }
    if (e.key === 'Enter') {
      // Enter on a highlighted suggestion accepts it rather than committing
      // the field — users expect autocomplete to consume Enter.
      if (suggestionIndex >= 0) {
        e.preventDefault();
        acceptSuggestion(target, suggestionIndex);
        return;
      }
    }
  }

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
    // parseField is async because it may pop a modal for unknown identifiers.
    // Guard against the schema changing between await boundaries (cancel / new
    // tool) by capturing a snapshot and re-checking before commit.
    const schemaAtStart = currentSchema;
    void (async () => {
      const ok = await parseField(target);
      if (!ok) return;
      if (currentSchema !== schemaAtStart) return;
      const inputs = allInputs();
      const idx = inputs.indexOf(target);
      const isLast = idx === inputs.length - 1;
      // Advance to the next empty field unless we're on the last one — OR unless
      // the schema wants commit-on-Enter (line/polyline: angle-only Enter must
      // lock immediately, not bounce focus to the length field).
      if (!isLast && !currentSchema.commitOnEnter) {
        for (let i = idx + 1; i < inputs.length; i++) {
          if (!inputs[i].value) {
            // Before we hand focus to the next field, give the schema a chance
            // to "lock" the value the user just typed into the tool context —
            // rect uses this to pin the width so the live preview and a
            // subsequent cursor click both respect it.
            if (currentSchema.onPartial) {
              currentSchema.onPartial(fieldValues, target.dataset.fieldName!);
              // onPartial may have swapped the schema via setPrompt → rebuild;
              // in that case the new schema's focus logic (pendingFocusField)
              // takes over and we stop touching the old input list.
              if (currentSchema !== schemaAtStart) return;
            }
            inputs[i].focus();
            return;
          }
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
    })();
    return;
  }
});

// ============================================================================
// Number/parameter parsing with create-on-unknown dialog
// ============================================================================

async function parseValueInput(raw: string, meaningHint?: string): Promise<CmdValue | null> {
  // Repeatedly parse; whenever the parser reports an unknown identifier, ask
  // the user for its value, create the parameter, then re-parse the ORIGINAL
  // input from scratch. This matters for mixed formulas like `L-X` where only
  // X is missing — the old code returned just X's param and silently dropped
  // the surrounding formula, so the dimension ended up as X instead of L-X.
  // Cap retries to avoid infinite loops if something pathological happens.
  for (let attempt = 0; attempt < 8; attempt++) {
    const r = parseExprInput(raw);
    if (!r) return null;
    if (r.kind === 'expr') return { expr: r.expr, value: evalExpr(r.expr) };

    // r.kind === 'unknown' — ask the user to define it, then retry.
    const isBareIdent = raw.trim() === r.name;
    const hint = isBareIdent ? meaningHint : undefined;
    const valRaw = await showPrompt({
      title: `Neue Variable: ${r.name}`,
      message: 'Wert eingeben (Zahl oder Formel).',
      validate: (v) => Number.isFinite(parseFloat(v.replace(',', '.'))) ? null : 'Zahl erwartet',
    });
    if (valRaw == null) return null;
    const val = parseFloat(valRaw.replace(',', '.'));
    if (!Number.isFinite(val)) { toast('Ungültige Zahl'); return null; }
    const meaning = await showPrompt({
      title: `Bedeutung von ${r.name}`,
      message: hint ? `Optional — z.B. ${hint}` : 'Optional — wofür steht diese Variable?',
      defaultValue: hint ?? '',
      placeholder: hint ?? 'z.B. Länge',
    }) ?? '';
    const existing = findParamByName(r.name);
    if (!existing) {
      createParameter(r.name, val, meaning.trim() || undefined);
      // Typing an unknown identifier in a measurement prompt is an implicit
      // opt-in to parametric mode — switch it on so the dimension actually
      // binds to the variable (instead of baking in the current numeric value).
      ensureParametricModeOn();
    }
    // loop: re-parse the original input now that this name is defined.
  }
  toast('Zu viele unbekannte Namen');
  return null;
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
    // Partial-lock: if the user typed a width and pressed Enter without also
    // entering a height, the width gets pinned into `tc.horizontal` / its expr
    // into `tc.horizontalExpr` (see onPartial below). The live preview and the
    // next canvas click both already respect those fields — we just surface
    // the lock state back into the prompt + field values so the user sees the
    // pinned number instead of an empty input after rebuild.
    const wLocked = tc.horizontal != null;
    const hLocked = tc.vertical != null;
    const lockNote = wLocked && hLocked
      ? ' (Breite + Höhe gelockt)'
      : wLocked ? ' (Breite gelockt)'
      : hLocked ? ' (Höhe gelockt)'
      : '';
    const wVal = wLocked ? String(tc.horizontal) : undefined;
    const hVal = hLocked ? String(tc.vertical) : undefined;
    return {
      prompt: 'Breite + Höhe' + lockNote,
      fields: [
        { name: 'width',  label: 'Breite', kind: 'expr', meaningHint: 'Breite', value: wVal, required: false },
        { name: 'height', label: 'Höhe',   kind: 'expr', meaningHint: 'Höhe',   value: hVal, required: false },
      ],
      commit: (v) => commitRect(tc, v),
      onPartial: (values, advancedFrom) => {
        // Enter on Breite without Höhe → lock width, let cursor (or typed
        // height) finish the rectangle. Symmetric for Höhe, though the field
        // order means this path is rarely hit in practice.
        const v = values[advancedFrom];
        if (!v || v.value <= 0) return;
        const cur = runtime.toolCtx;
        if (!cur || cur.step !== 'dims') return;
        if (advancedFrom === 'width') {
          runtime.toolCtx = { ...cur, horizontal: v.value, horizontalExpr: v.expr };
        } else if (advancedFrom === 'height') {
          runtime.toolCtx = { ...cur, vertical: v.value, verticalExpr: v.expr };
        }
        // Refresh the prompt + field values so the user sees the lock badge.
        // `setPromptRef` → `rebuildCmdBar` → new schema with value preset.
        // We use the existing height-focus field so focus lands on the one the
        // user still needs to fill.
        pendingFocusField = advancedFrom === 'width' ? 'height' : 'width';
        setPromptRef('Breite + Höhe');
        render();
      },
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
  if (tool === 'arc3' && tc && tc.step === 'bulge' && tc.pts && tc.pts.length === 2) {
    return {
      prompt: 'Bogenhöhe (Abstand zur Sehne)',
      fields: [{ name: 'bulge', label: 'Höhe', kind: 'expr', meaningHint: 'Bogenhöhe', placeholder: 'z.B. 5' }],
      commit: (v) => {
        const b = v.bulge;
        if (!b) { toast('Höhe eingeben'); return; }
        commitArcBulge(tc, b.value);
      },
    };
  }
  if (tool === 'ellipse' && tc) {
    if (tc.step === 'axis1' && tc.centerPt) {
      return {
        prompt: 'Halbachse 1: Winkel + Länge',
        // Angle first per user preference — Tab from the angle field jumps to
        // length, matching the "polar (α, r)" order common in CAD prompts.
        fields: [
          { name: 'angle',  label: 'Winkel', kind: 'angle', placeholder: '°', required: false },
          { name: 'length', label: 'Länge',  kind: 'expr',  meaningHint: 'Halbachse 1' },
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
  if (tool === 'line_offset' && tc && tc.step === 'side') {
    // Only the distance field lives here. The Winkel angle moved to the
    // top-right picker (next to the Winkel toggle) per user request —
    // entering both values in the same place is the natural ergonomic.
    return {
      prompt: 'Abstand, dann Seite klicken',
      fields: [
        { name: 'distance', label: 'Abstand', kind: 'expr', required: false },
      ],
      commit: (v) => commitLineOffset(tc, v),
    };
  }
  // Text tool: all content + size editing happens in the text-editor modal.
  // Deliberately no cmdbar fields here — the bottom command bar is for
  // parameter values only and must never steal focus while the text modal is
  // building its own editor.
  // Fillet / chamfer: radius and distance are sticky modifiers, not per-step
  // length values, so they live in the top panels (fillet-picker /
  // chamfer-picker). The cmdbar stays empty for these tools — keeps the rule
  // "cmdbar = lengths/angles per step, top panel = modifiers/properties".
  if (tool === 'rotate' && tc && tc.step === 'angle' && tc.centerPt) {
    return {
      prompt: 'Drehwinkel',
      fields: [{ name: 'angle', label: 'Winkel', kind: 'angle' }],
      commit: (v) => commitRotate(tc, v),
    };
  }
  if (tool === 'move' && tc && tc.step === 'target' && tc.basePt) {
    return {
      prompt: 'Abstand (Richtung = Maus)',
      fields: [{ name: 'distance', label: 'Abstand', kind: 'expr' }],
      commit: (v) => commitMoveCopyTarget(tc, v, false),
    };
  }
  if (tool === 'copy' && tc && tc.step === 'target' && tc.basePt) {
    return {
      prompt: 'Abstand + Matrix (Spalten×Zeilen)',
      fields: [
        { name: 'distance', label: 'Abstand', kind: 'expr' },
        { name: 'cols',     label: 'Spalten', kind: 'integer', placeholder: String(runtime.copyCols), required: false, value: String(runtime.copyCols) },
        { name: 'rows',     label: 'Zeilen',  kind: 'integer', placeholder: String(runtime.copyRows), required: false, value: String(runtime.copyRows) },
      ],
      commit: (v) => commitMoveCopyTarget(tc, v, true),
    };
  }
  if (tool === 'stretch' && tc && tc.step === 'direction' && tc.basePt) {
    return {
      prompt: 'Winkel (oder Richtung klicken)',
      fields: [{ name: 'angle', label: 'Winkel', kind: 'angle' }],
      commit: (v) => commitStretchDirection(tc, v),
    };
  }
  if (tool === 'stretch' && tc && tc.step === 'distance' && tc.basePt) {
    return {
      prompt: 'Abstand (oder klicken)',
      fields: [{ name: 'distance', label: 'Abstand', kind: 'expr' }],
      commit: (v) => commitStretchDistance(tc, v),
    };
  }
  // Backward-compat: the old single-step 'target' schema, in case any entry
  // point still lands on that step.
  if (tool === 'stretch' && tc && tc.step === 'target' && tc.basePt) {
    return {
      prompt: 'Abstand (Richtung = Maus)',
      fields: [{ name: 'distance', label: 'Abstand', kind: 'expr' }],
      commit: (v) => commitStretchTarget(tc, v),
    };
  }
  // Note: divide_xline count is asked via a modal (showPrompt) instead of the
  // cmdbar — see promptDivideCount in tools.ts. Tool activation opens the
  // modal directly; Enter at 'pick' re-opens it (see handleBareEnter below).
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
    setPromptRef(state.tool === 'move' ? 'Basispunkt · Shift = Kopie' : 'Basispunkt');
    render();
    return true;
  }
  if (state.tool === 'rotate' && tc?.step === 'pick') {
    if (!state.selection.size) { toast('Erst Objekte wählen'); return true; }
    runtime.toolCtx = { step: 'center' };
    setPromptRef('Drehzentrum · Shift = Kopie');
    render();
    return true;
  }
  if (state.tool === 'mirror' && tc?.step === 'pick') {
    if (!state.selection.size) { toast('Erst Objekte wählen'); return true; }
    runtime.toolCtx = { step: 'axis1' };
    setPromptRef('Spiegelachse: erster Punkt · Shift = Kopie');
    render();
    return true;
  }
  if (state.tool === 'cross_mirror' && tc?.step === 'pick') {
    if (!state.selection.size) { toast('Erst Objekte wählen'); return true; }
    runtime.toolCtx = { step: 'center' };
    setPromptRef(crossMirrorPrompt(runtime.crossMirrorMode));
    render();
    return true;
  }
  if (state.tool === 'divide_xline' && tc?.step === 'pick') {
    // Enter at the 'pick' step re-focuses the top-docked count panel so the
    // user can adjust N without leaving the tool.
    promptDivideCount();
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
  // otherwise the mouse direction. We compute an exact endpoint from (angle,
  // length), so bypass the cursor-based snap override inside handleClick —
  // otherwise a nearby snappable feature would steal our typed length.
  if (length !== undefined && length > 0) {
    const dir = tc.lockedDir
      ?? (angle !== undefined ? directionAtAngle(tc.p1, state.mouseWorld, angle) : norm(sub(state.mouseWorld, tc.p1)));
    if (len(dir) < 1e-9) { toast('Erst Mausrichtung wählen'); return; }

    // If the user typed a variable or formula (not a plain number) for angle
    // or length, build the LineFeature directly with a polar p2 PointRef so
    // the binding survives. Changing the variable later re-resolves the
    // endpoint via `resolvePt` and moves the line accordingly. For pure
    // numeric input we keep the original handleClick path (cheaper, and the
    // resulting feature is indistinguishable from a mouse-placed one).
    const lenExpr = v.length?.expr;
    const angleExpr = v.angle?.expr;
    const parametric = (lenExpr && lenExpr.kind !== 'num') || (angleExpr && angleExpr.kind !== 'num');
    if (parametric && lenExpr) {
      const angleDeg = Math.atan2(dir.y, dir.x) * 180 / Math.PI;
      const finalAngle: Expr = (angleExpr && angleExpr.kind !== 'num') ? angleExpr : numE(angleDeg);
      const p1Ref: PointRef = tc.p1Ref
        ?? { kind: 'abs', x: numE(tc.p1.x), y: numE(tc.p1.y) };
      const p2Ref: PointRef = {
        kind: 'polar',
        from: p1Ref,
        angle: finalAngle,
        distance: lenExpr,
      };
      pushUndo();
      state.features.push({
        id: newFeatureId(),
        kind: 'line',
        layer: state.activeLayer,
        p1: p1Ref,
        p2: p2Ref,
      });
      evaluateTimeline();
      updateStats();
      runtime.toolCtx = { step: 'p1' };
      setPromptRef('Erster Punkt');
      render();
      return;
    }

    handleClick(add(tc.p1, scale(dir, length)), false, { useSnap: false });
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

    // Parametric path: if the user typed a variable or formula for length or
    // angle, commit the next polyline segment as a polar PointRef off the
    // previous vertex so the binding survives. Mirrors the line tool logic.
    const lenExpr = v.length?.expr;
    const angleExpr = v.angle?.expr;
    const parametric = (lenExpr && lenExpr.kind !== 'num') || (angleExpr && angleExpr.kind !== 'num');
    if (parametric && lenExpr) {
      const angleDeg = Math.atan2(dir.y, dir.x) * 180 / Math.PI;
      const finalAngle: Expr = (angleExpr && angleExpr.kind !== 'num') ? angleExpr : numE(angleDeg);
      // Reuse the existing tail ref as the polar anchor so the new vertex
      // tracks the previous one exactly (important when earlier vertices are
      // themselves parametric — chain stays coherent).
      const prevRef: PointRef = (tc.ptRefs && tc.ptRefs.length > 0 && tc.ptRefs[tc.ptRefs.length - 1])
        ? tc.ptRefs[tc.ptRefs.length - 1] as PointRef
        : { kind: 'abs', x: numE(last.x), y: numE(last.y) };
      const newRef: PointRef = {
        kind: 'polar',
        from: prevRef,
        angle: finalAngle,
        distance: lenExpr,
      };
      const endPt = add(last, scale(dir, length));
      pushUndo();
      state.features.push({
        id: newFeatureId(),
        kind: 'line',
        layer: state.activeLayer,
        p1: prevRef,
        p2: newRef,
      });
      evaluateTimeline();
      updateStats();
      // Advance tool state by hand (we bypassed handlePolylineClick).
      if (!tc.pts) tc.pts = [];
      if (!tc.ptRefs) tc.ptRefs = [];
      tc.pts.push(endPt);
      tc.ptRefs.push(newRef);
      tc.lockedDir = null;
      tc.angleDeg = null;
      setPromptRef('Nächster Punkt (Enter beendet)');
      render();
      return;
    }

    // Mask the cursor snap — same reason as in commitLine: the computed
    // endpoint is exact, and handlePolylineClick would otherwise read
    // runtime.lastSnap and parametrize to whatever the cursor hovers over.
    const savedSnap = runtime.lastSnap;
    runtime.lastSnap = null;
    try { handlePolylineClick(add(last, scale(dir, length))); }
    finally { runtime.lastSnap = savedSnap; }
  }
}

function commitRect(tc: ToolCtx, v: CmdValues): void {
  if (!tc.p1) return;
  // Fall back to values already locked into the tool context from a previous
  // partial-commit (e.g. user typed width + Enter, then typed height + Enter:
  // the width field was rebuilt empty but `tc.horizontalExpr` still holds it).
  const w: CmdValue | undefined = v.width ?? (
    tc.horizontalExpr != null && tc.horizontal != null
      ? { expr: tc.horizontalExpr, value: tc.horizontal }
      : undefined
  );
  const h: CmdValue | undefined = v.height ?? (
    tc.verticalExpr != null && tc.vertical != null
      ? { expr: tc.verticalExpr, value: tc.vertical }
      : undefined
  );
  if (!w || w.value <= 0 || !h || h.value <= 0) { toast('Breite und Höhe eingeben'); return; }
  // Sign follows the cursor direction relative to the first corner, so the
  // rectangle opens "into" the quadrant the mouse is currently in (matches
  // the live preview). Splitting into 4 lines at commit keeps parity with the
  // click-click path — every rect is immediately edge-editable, no single
  // `rect` feature lingers.
  const cur = state.mouseWorld;
  const sX: 1 | -1 = (cur.x - tc.p1.x) >= 0 ? 1 : -1;
  const sY: 1 | -1 = (cur.y - tc.p1.y) >= 0 ? 1 : -1;

  // If the user typed a variable or formula (not a plain number) for either
  // width or height, take the parametric path — corners B/C/D become polar
  // PointRefs off corner A so changing the variable later updates the
  // rectangle automatically. For pure numeric input keep the original
  // constant-coordinate path (matches click-click output exactly).
  const parametric = (w.expr.kind !== 'num') || (h.expr.kind !== 'num');
  if (parametric) {
    const p1Ref: PointRef = tc.p1Ref ?? { kind: 'abs', x: numE(tc.p1.x), y: numE(tc.p1.y) };
    commitRectAsLinesExpr(p1Ref, w.expr, h.expr, sX, sY, state.activeLayer);
  } else {
    const x2 = tc.p1.x + sX * w.value;
    const y2 = tc.p1.y + sY * h.value;
    commitRectAsLines(tc.p1.x, tc.p1.y, x2, y2);
  }
  runtime.toolCtx = { step: 'p1' };
  setPromptRef('Erster Eckpunkt');
  render();
}

function commitCircle(tc: ToolCtx, v: CmdValues): void {
  if (tc.cx == null || tc.cy == null) return;
  const r = v.radius;
  if (!r || r.value <= 0) { toast('Radius eingeben'); return; }
  pushUndo();
  // Parametrischen Mittelpunkt erhalten, falls beim Klicken ein Snap aktiv
  // war. Radius übernimmt den getippten Expr (kann Variable sein) — beides
  // zusammen ergibt einen vollständig parametrischen Kreis.
  const center: PointRef = tc.centerRef
    ?? { kind: 'abs', x: numE(tc.cx), y: numE(tc.cy) };
  const feat: Feature = {
    id: newFeatureId(),
    kind: 'circle',
    layer: state.activeLayer,
    center,
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
  const startAngRad = Math.atan2(state.mouseWorld.y - tc.cy, state.mouseWorld.x - tc.cx);
  const startAngDeg = startAngRad * 180 / Math.PI;
  const n = getPolygonSides();

  // Parametric: build a closed polyline where each vertex is a polar PointRef
  // off a shared center, with the typed radius Expr as distance. Changing the
  // variable later rebuilds the polygon around the same center.
  if (r.expr.kind !== 'num') {
    const center: PointRef = { kind: 'abs', x: numE(tc.cx), y: numE(tc.cy) };
    const refs: PointRef[] = [];
    const stepDeg = 360 / n;
    for (let i = 0; i < n; i++) {
      const angDeg = startAngDeg + i * stepDeg;
      refs.push({
        kind: 'polar',
        from: center,
        angle: numE(angDeg),
        distance: r.expr,
      });
    }
    pushUndo();
    state.features.push({
      id: newFeatureId(),
      kind: 'polyline',
      layer: state.activeLayer,
      pts: refs,
      closed: true,
    });
    evaluateTimeline();
    updateStats();
    runtime.toolCtx = { step: 'center' };
    setPromptRef(`Mittelpunkt (n=${n})`);
    render();
    return;
  }

  const step = 2 * Math.PI / n;
  const pts: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a = startAngRad + i * step;
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
  // Virtual-axis reference → the dedicated `axisParallelXLine` feature that
  // keeps the distance expression live (variable edits propagate). Real
  // entities go through the regular parallelXLine path.
  if (tc.ref && '_axis' in tc.ref) {
    makeAxisParallelXLine(tc.ref._axis, d.expr, off.sign);
  } else {
    makeParallelXLine(tc.base, tc.dir, d.expr, off.sign, tc.ref);
  }
  runtime.toolCtx = { step: 'ref' };
  setPromptRef('Referenzlinie wählen');
  render();
}

function commitXlineAngle(tc: ToolCtx, v: CmdValues): void {
  if (!tc.p1) return;
  const ang = v.angle?.value;
  if (ang === undefined) { toast('Winkel eingeben'); return; }
  // Preserve the anchor's parametric ref (captured on the click that entered
  // `angle-pt`) so the xline stays tied to the source corner/mid/intersection
  // when upstream variables change. Falls through to abs if the anchor had
  // no feature-backed snap.
  makeXLineThroughRef(
    tc.p1Ref ?? null,
    tc.p1,
    directionAtAngle(tc.p1, state.mouseWorld, ang),
  );
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

/**
 * Commit handler for the line_offset tool's 'side' step.
 *
 * Distance is required. If typed as a variable/formula, stash the Expr in the
 * tool ctx so `applyLineOffsetAt` builds a parametric polar PointRef from it.
 * The angle, when enabled via the "Winkel" toggle, is read directly from
 * `runtime.lineOffsetAngleDeg` inside `applyLineOffsetAt` — it's edited in
 * the top picker, not here.
 *
 * Side-of-line is always determined by the current mouse position, so the
 * user can type the distance and then move the cursor to the desired side
 * before pressing Enter — matches the Versatz tool's ergonomics.
 */
function commitLineOffset(tc: ToolCtx, v: CmdValues): void {
  const d = v.distance;
  if (!d || d.value <= 0) { toast('Abstand eingeben'); return; }
  tc.distance = d.value;
  tc.distanceExpr = d.expr;
  applyLineOffsetAt(state.mouseWorld, d.value);
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

function commitMoveCopyTarget(tc: ToolCtx, v: CmdValues, isCopy: boolean): void {
  if (!tc.basePt) return;
  const d = v.distance;
  if (!d || d.value <= 0) { toast('Abstand eingeben'); return; }
  const dir = norm(sub(state.mouseWorld, tc.basePt));
  if (len(dir) < 1e-9) { toast('Erst Mausrichtung wählen'); return; }
  // Copy tool: stash the matrix dims so the click handler (below) uses them.
  // A cols/rows field left empty keeps the previous sticky value.
  if (isCopy) {
    const cols = v.cols?.value;
    const rows = v.rows?.value;
    if (cols !== undefined) runtime.copyCols = Math.max(1, Math.floor(cols));
    if (rows !== undefined) runtime.copyRows = Math.max(1, Math.floor(rows));
  }
  handleClick(add(tc.basePt, scale(dir, d.value)), false, { useSnap: false });
}

function commitStretchTarget(tc: ToolCtx, v: CmdValues): void {
  if (!tc.basePt) return;
  const d = v.distance;
  if (!d || d.value <= 0) { toast('Abstand eingeben'); return; }
  const dir = norm(sub(state.mouseWorld, tc.basePt));
  if (len(dir) < 1e-9) { toast('Erst Mausrichtung wählen'); return; }
  handleClick(add(tc.basePt, scale(dir, d.value)), false, { useSnap: false });
}

/**
 * Lock the stretch direction from a typed angle (absolute world angle, 0° =
 * +x, 90° = +y). Advances the step to 'distance' so the user can type or
 * click the magnitude.
 */
function commitStretchDirection(tc: ToolCtx, v: CmdValues): void {
  if (!tc.basePt || !tc.click1 || !tc.click2) return;
  const a = v.angle;
  if (!a) { toast('Winkel eingeben'); return; }
  const rad = (a.value * Math.PI) / 180;
  const dir: Pt = { x: Math.cos(rad), y: Math.sin(rad) };
  runtime.toolCtx = {
    step: 'distance',
    click1: tc.click1, click2: tc.click2, basePt: tc.basePt,
    lockedDir: dir,
  };
  // `setPromptRef` reaches `rebuildCmdBar` which swaps the schema to the
  // distance step and (via `focusFirstField`) puts the caret in the new
  // "Abstand" input — without this the schema updates but focus stays on the
  // old angle field, and the user has to click the Abstand box to continue.
  setPromptRef('Abstand klicken oder eingeben');
  render();
}

/**
 * Apply the stretch using the locked direction (set by a prior click or typed
 * angle) and the typed magnitude. Falls back to cursor direction when no
 * direction was locked (defensive — the schema only shows this step after
 * direction is set).
 */
function commitStretchDistance(tc: ToolCtx, v: CmdValues): void {
  if (!tc.basePt || !tc.click1 || !tc.click2) return;
  const d = v.distance;
  if (!d || d.value <= 0) { toast('Abstand eingeben'); return; }
  const dir = tc.lockedDir ?? norm(sub(state.mouseWorld, tc.basePt));
  if (len(dir) < 1e-9) { toast('Keine Richtung gesetzt'); return; }
  const target: Pt = add(tc.basePt, scale(dir, d.value));
  applyStretchTarget(tc, target);
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
  const ang = v.angle?.value;

  // Angle-only commit → lock the direction and wait for the user to pick the
  // length with the mouse (or Enter again with a length). Matches the line /
  // polyline angle-lock UX: typing "30" and Enter locks 30°, then dragging
  // lengthens along that ray. Without this, the tool just toasted "Länge
  // eingeben" and the typed angle was discarded.
  if (ang !== undefined && (!L || L.value <= 0)) {
    const radDir = { x: Math.cos(ang * Math.PI / 180), y: Math.sin(ang * Math.PI / 180) };
    runtime.toolCtx = {
      step: 'axis1',
      centerPt: tc.centerPt,
      lockedDir: radDir,
      angleDeg: ang,
    };
    setPromptRef(`Halbachse 1: Länge (Winkel gesperrt ${ang.toFixed(1)}°)`);
    toast(`Winkel gesperrt · ${ang.toFixed(1)}°`);
    render();
    return;
  }

  if (!L || L.value <= 0) { toast('Länge eingeben'); return; }
  // Use mouse direction if no angle supplied and no lock is active.
  let dir: Pt;
  if (ang !== undefined) {
    const radDir = { x: Math.cos(ang * Math.PI / 180), y: Math.sin(ang * Math.PI / 180) };
    dir = radDir;
  } else if (tc.lockedDir) {
    dir = tc.lockedDir;
  } else {
    const m = sub(state.mouseWorld, tc.centerPt);
    if (len(m) < 1e-9) { toast('Erst Richtung wählen'); return; }
    dir = norm(m);
  }
  const a1 = add(tc.centerPt, scale(dir, L.value));
  const rot = Math.atan2(dir.y, dir.x);
  // Stash the parametric radius expr for axis2 to consume — when it's a
  // variable/formula we want to emit an EllipseFeature with the binding intact.
  runtime.toolCtx = {
    step: 'axis2',
    centerPt: tc.centerPt,
    a1,
    angleDeg: rot,
    radius: L.value,
    radiusExpr: L.expr,
  };
  setPromptRef('Länge der zweiten Halbachse');
  render();
}

function commitEllipseAxis2(tc: ToolCtx, v: CmdValues): void {
  if (!tc.centerPt || tc.radius == null || tc.angleDeg == null) return;
  const L = v.length;
  if (!L || L.value <= 0) { toast('Länge eingeben'); return; }

  // Parametric: if axis1 or axis2 was entered as a variable/formula, push the
  // ellipse feature directly so both radii and rotation stay bound. The
  // stashed `radiusExpr` survives from commitEllipseAxis1.
  const rxExpr = tc.radiusExpr;
  const ryExpr = L.expr;
  const parametric = (ryExpr.kind !== 'num')
                  || (rxExpr != null && rxExpr.kind !== 'num');
  if (parametric) {
    const finalRx: Expr = rxExpr ?? numE(tc.radius);
    pushUndo();
    state.features.push({
      id: newFeatureId(),
      kind: 'ellipse',
      layer: state.activeLayer,
      center: { kind: 'abs', x: numE(tc.centerPt.x), y: numE(tc.centerPt.y) },
      rx: finalRx,
      ry: ryExpr,
      rot: numE(tc.angleDeg),
    });
    evaluateTimeline();
    updateStats();
    runtime.toolCtx = { step: 'center' };
    setPromptRef('Mittelpunkt der Ellipse');
    render();
    return;
  }

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
  handleClick(add(tc.a1, scale(d, 1)), false, { useSnap: false });
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
  handleClick(off, false, { useSnap: false });
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

