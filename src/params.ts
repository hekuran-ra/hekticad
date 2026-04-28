import type { Expr, FormulaNode, Parameter, ParameterGroup } from './types';
import { state } from './state';

/** Generate a short, stable id for a new parameter. */
export function newParamId(): string {
  return 'p' + Math.random().toString(36).slice(2, 8);
}

/**
 * Look up a parameter by its user-visible name (case-insensitive match).
 * Returns null if no parameter with that name exists.
 */
export function findParamByName(name: string): Parameter | null {
  const lc = name.toLowerCase();
  return state.parameters.find(p => p.name.toLowerCase() === lc) ?? null;
}

// ============================================================================
// Arithmetic formula parser (safe — no eval/new Function).
// Grammar (standard precedence):
//   expr   := term (('+'|'-') term)*
//   term   := factor (('*'|'/') factor)*
//   factor := unary ('^' factor)?          right-associative
//   unary  := '-' unary | call
//   call   := primary | ident '(' expr ')'
//   primary:= number | ident | '(' expr ')'
// Comma is accepted as decimal separator (German locale).
// Identifiers resolve to parameters or the constants pi, π, e, PI, E.
// Whitelisted 1-arg functions: sin cos tan asin acos atan sqrt abs exp log
//                              floor ceil round sign.
// ============================================================================

const CONSTANTS: Record<string, number> = {
  pi: Math.PI,  PI: Math.PI,  π: Math.PI,
  e:  Math.E,   E:  Math.E,
};

const FUNCTIONS: Record<string, (x: number) => number> = {
  sin: Math.sin,   cos: Math.cos,   tan: Math.tan,
  asin: Math.asin, acos: Math.acos, atan: Math.atan,
  sqrt: Math.sqrt, abs: Math.abs,   exp: Math.exp,   log: Math.log,
  floor: Math.floor, ceil: Math.ceil, round: Math.round, sign: Math.sign,
};

type Tok =
  | { t: 'num'; v: number }
  | { t: 'id'; v: string }
  | { t: 'op'; v: '+' | '-' | '*' | '/' | '^' | '(' | ')' };

function tokenize(input: string): Tok[] {
  const s = input.replace(/,/g, '.');   // German decimal separator
  const out: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t') { i++; continue; }
    if ('+-*/^()'.includes(c)) {
      out.push({ t: 'op', v: c as '+' | '-' | '*' | '/' | '^' | '(' | ')' });
      i++; continue;
    }
    // Number (optionally with decimal point, exponent, or unary sign handled by parser).
    if ((c >= '0' && c <= '9') || c === '.') {
      let j = i, seenDot = false, seenE = false;
      while (j < s.length) {
        const ch = s[j];
        if (ch >= '0' && ch <= '9') { j++; continue; }
        if (ch === '.' && !seenDot && !seenE) { seenDot = true; j++; continue; }
        if ((ch === 'e' || ch === 'E') && !seenE) {
          seenE = true; j++;
          if (s[j] === '+' || s[j] === '-') j++;
          continue;
        }
        break;
      }
      const num = parseFloat(s.slice(i, j));
      if (!Number.isFinite(num)) throw new Error(`Zahl ungültig bei "${s.slice(i, j)}"`);
      out.push({ t: 'num', v: num });
      i = j; continue;
    }
    // Identifier (letters, digits, underscore; must start with letter or _ or π).
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c === 'π') {
      let j = i + 1;
      while (j < s.length) {
        const ch = s[j];
        if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z')
            || (ch >= '0' && ch <= '9') || ch === '_') { j++; continue; }
        break;
      }
      out.push({ t: 'id', v: s.slice(i, j) });
      i = j; continue;
    }
    throw new Error(`Unerwartetes Zeichen "${c}"`);
  }
  return out;
}

/** Recursive-descent parser for the grammar above. */
class Parser {
  private i = 0;
  constructor(private readonly toks: Tok[]) {}
  parse(): FormulaNode {
    const node = this.parseExpr();
    if (this.i < this.toks.length) throw new Error('Unerwartete zusätzliche Eingabe');
    return node;
  }
  private peek(): Tok | undefined { return this.toks[this.i]; }
  private eat(): Tok { return this.toks[this.i++]; }
  private expect(op: string): void {
    const t = this.peek();
    if (!t || t.t !== 'op' || t.v !== op) throw new Error(`Erwartet "${op}"`);
    this.i++;
  }
  private parseExpr(): FormulaNode {
    let left = this.parseTerm();
    while (true) {
      const t = this.peek();
      if (!t || t.t !== 'op' || (t.v !== '+' && t.v !== '-')) break;
      this.eat();
      const right = this.parseTerm();
      left = { t: 'bin', op: t.v, a: left, b: right };
    }
    return left;
  }
  private parseTerm(): FormulaNode {
    let left = this.parseFactor();
    while (true) {
      const t = this.peek();
      if (!t || t.t !== 'op' || (t.v !== '*' && t.v !== '/')) break;
      this.eat();
      const right = this.parseFactor();
      left = { t: 'bin', op: t.v, a: left, b: right };
    }
    return left;
  }
  private parseFactor(): FormulaNode {
    const left = this.parseUnary();
    const t = this.peek();
    if (t && t.t === 'op' && t.v === '^') {
      this.eat();
      const right = this.parseFactor();     // right-associative
      return { t: 'bin', op: '^', a: left, b: right };
    }
    return left;
  }
  private parseUnary(): FormulaNode {
    const t = this.peek();
    if (t && t.t === 'op' && t.v === '-') { this.eat(); return { t: 'neg', a: this.parseUnary() }; }
    if (t && t.t === 'op' && t.v === '+') { this.eat(); return this.parseUnary(); }
    return this.parseCallOrPrimary();
  }
  private parseCallOrPrimary(): FormulaNode {
    const t = this.peek();
    if (!t) throw new Error('Ausdruck unvollständig');
    if (t.t === 'num') { this.eat(); return { t: 'num', v: t.v }; }
    if (t.t === 'op' && t.v === '(') {
      this.eat();
      const node = this.parseExpr();
      this.expect(')');
      return node;
    }
    if (t.t === 'id') {
      this.eat();
      const name = t.v;
      const next = this.peek();
      if (next && next.t === 'op' && next.v === '(') {
        // Function call.
        this.eat();
        const arg = this.parseExpr();
        this.expect(')');
        const fn = FUNCTIONS[name];
        if (!fn) throw new Error(`Unbekannte Funktion "${name}"`);
        return { t: 'fn', name, a: arg };
      }
      // Constant first, then parameter.
      if (Object.prototype.hasOwnProperty.call(CONSTANTS, name)) {
        return { t: 'const', v: CONSTANTS[name] };
      }
      const p = findParamByName(name);
      if (p) return { t: 'param', id: p.id };
      // Unknown identifier — bubble up as a sentinel error; caller can decide
      // whether to prompt the user to create a parameter on the fly.
      throw new UnknownIdentError(name);
    }
    throw new Error('Ungültiger Ausdruck');
  }
}

class UnknownIdentError extends Error {
  public readonly ident: string;
  constructor(name: string) {
    super(`Unbekannt: ${name}`);
    this.ident = name;
  }
}

// ============================================================================
// Public parse API
// ============================================================================

/**
 * Parse a user-typed value.
 *
 * Returns:
 *   - `{ kind: 'expr', expr }` on success (literal, single param, or formula)
 *   - `{ kind: 'unknown', name }` if the input is a single bare identifier
 *     that doesn't match any existing parameter — caller typically offers to
 *     create it. Formulas that contain unknown names return 'unknown' for
 *     the FIRST such name so the UI can prompt and retry.
 *   - `null` if the input cannot be parsed at all.
 */
export type ParseResult =
  | { kind: 'expr'; expr: Expr }
  | { kind: 'unknown'; name: string }
  | null;

export function parseExprInput(raw: string): ParseResult {
  const s = raw.trim();
  if (!s) return null;

  // Fast-path: pure number literal (also handles German comma).
  const num = parseFloat(s.replace(',', '.'));
  if (Number.isFinite(num) && /^[+-]?\s*[\d.,]+(e[+-]?\d+)?$/i.test(s)) {
    return { kind: 'expr', expr: { kind: 'num', value: num } };
  }

  // Fast-path: single bare identifier → existing param or 'unknown'.
  if (/^[a-zA-Z_π][a-zA-Z0-9_]*$/.test(s)) {
    if (Object.prototype.hasOwnProperty.call(CONSTANTS, s)) {
      return { kind: 'expr', expr: { kind: 'num', value: CONSTANTS[s] } };
    }
    const p = findParamByName(s);
    if (p) return { kind: 'expr', expr: { kind: 'param', id: p.id } };
    return { kind: 'unknown', name: s };
  }

  // Full formula.
  try {
    const toks = tokenize(s);
    const ast = new Parser(toks).parse();
    const refs: string[] = [];
    collectRefs(ast, refs);
    return { kind: 'expr', expr: { kind: 'formula', src: s, ast, refs } };
  } catch (err) {
    if (err instanceof UnknownIdentError) return { kind: 'unknown', name: err.ident };
    return null;
  }
}

function collectRefs(n: FormulaNode, out: string[]): void {
  if (n.t === 'param') { if (!out.includes(n.id)) out.push(n.id); return; }
  if (n.t === 'neg' || n.t === 'fn') { collectRefs(n.a, out); return; }
  if (n.t === 'bin') { collectRefs(n.a, out); collectRefs(n.b, out); }
}

// ============================================================================
// Evaluation + formatting
// ============================================================================

/** Evaluate an Expr against current state.parameters. Tolerates a bare number
 *  for legacy compatibility — fillet/chamfer used to store radius/distance as
 *  plain `number`, and old `.hcad` saves still come in with that shape. */
export function evalExpr(e: Expr | number): number {
  if (typeof e === 'number') return e;
  if (e.kind === 'num') return e.value;
  if (e.kind === 'param') {
    const p = state.parameters.find(x => x.id === e.id);
    return p ? p.value : NaN;
  }
  return evalFormula(e.ast);
}

function evalFormula(n: FormulaNode): number {
  switch (n.t) {
    case 'num':   return n.v;
    case 'const': return n.v;
    case 'param': {
      const p = state.parameters.find(x => x.id === n.id);
      return p ? p.value : NaN;
    }
    case 'neg':   return -evalFormula(n.a);
    case 'bin': {
      const a = evalFormula(n.a), b = evalFormula(n.b);
      switch (n.op) {
        case '+': return a + b;
        case '-': return a - b;
        case '*': return a * b;
        case '/': return a / b;
        case '^': return Math.pow(a, b);
      }
      return NaN;
    }
    case 'fn': {
      const fn = FUNCTIONS[n.name];
      return fn ? fn(evalFormula(n.a)) : NaN;
    }
  }
}

/** Human-readable form of an Expr — literal, parameter name, or source text. */
export function exprLabel(e: Expr): string {
  if (e.kind === 'num') return formatNumber(e.value);
  if (e.kind === 'param') {
    const p = state.parameters.find(x => x.id === e.id);
    return p ? p.name : '?';
  }
  return e.src;
}

function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return '?';
  if (Number.isInteger(n)) return n.toString();
  return n.toFixed(3).replace(/\.?0+$/, '');
}

export function createParameter(name: string, value: number, meaning?: string): Parameter {
  const p: Parameter = { id: newParamId(), name, value, meaning };
  state.parameters.push(p);
  return p;
}

/**
 * Reorder + re-evaluate `state.parameters` in topological order so that any
 * parameter whose `formula` references other parameters reads their freshly
 * recomputed values. Idempotent and cheap (parameter count is small).
 *
 * Cycle handling: if a cycle exists (A.formula references B and B.formula
 * references A), the cycle members keep their last cached `value` and the
 * cycle is logged to the console via `console.warn`. This matches how
 * `topoSortFeatures` handles feature cycles — the system stays alive but the
 * computed values may be stale until the user breaks the cycle.
 *
 * Called from `evaluateTimeline` (in features.ts) so feature evaluation
 * always sees fresh parameter values, and from the param-edit UI after a
 * value or formula change so the panel reflects new computed values
 * immediately.
 */
export function recomputeParameters(): void {
  const params = state.parameters;
  if (params.length === 0) return;
  const indexById = new Map<string, number>();
  for (let i = 0; i < params.length; i++) indexById.set(params[i].id, i);

  // Build dependency edges: param i depends on every param id its formula
  // references (via `refs` for formulas, `id` for direct param refs).
  const deps: Set<number>[] = params.map(() => new Set());
  for (let i = 0; i < params.length; i++) {
    const f = params[i].formula;
    if (!f) continue;
    if (f.kind === 'param') {
      const di = indexById.get(f.id);
      if (di != null && di !== i) deps[i].add(di);
    } else if (f.kind === 'formula') {
      for (const refId of f.refs) {
        const di = indexById.get(refId);
        if (di != null && di !== i) deps[i].add(di);
      }
    }
  }

  // Kahn's topo sort.
  const indeg = params.map((_, i) => deps[i].size);
  const ready: number[] = [];
  for (let i = 0; i < params.length; i++) if (indeg[i] === 0) ready.push(i);
  const dependents: number[][] = params.map(() => []);
  for (let i = 0; i < params.length; i++) for (const d of deps[i]) dependents[d].push(i);

  const order: number[] = [];
  while (ready.length) {
    let minPos = 0;
    for (let k = 1; k < ready.length; k++) if (ready[k] < ready[minPos]) minPos = k;
    const idx = ready.splice(minPos, 1)[0];
    order.push(idx);
    for (const dep of dependents[idx]) {
      indeg[dep]--;
      if (indeg[dep] === 0) ready.push(dep);
    }
  }

  if (order.length !== params.length) {
    const stuckNames: string[] = [];
    for (let i = 0; i < params.length; i++) if (indeg[i] > 0) stuckNames.push(params[i].name);
    console.warn('[recomputeParameters] cycle detected — stuck:', stuckNames);
    // Don't return — still evaluate the parameters that aren't part of the
    // cycle. Stuck params keep their cached `value`.
    for (let i = 0; i < params.length; i++) if (!order.includes(i)) order.push(i);
  }

  // Evaluate in topo order. Skip params whose formula resolves to NaN —
  // keep the cached value so the drawing keeps drawing instead of all
  // dependent geometry collapsing.
  for (const idx of order) {
    const p = params[idx];
    if (!p.formula) continue;
    const v = evalExpr(p.formula);
    if (Number.isFinite(v)) p.value = v;
  }
}

export function updateParameter(id: string, patch: Partial<Omit<Parameter, 'id'>>): void {
  const p = state.parameters.find(x => x.id === id);
  if (!p) return;
  Object.assign(p, patch);
}

export function deleteParameter(id: string): void {
  state.parameters = state.parameters.filter(p => p.id !== id);
}

// ============================================================================
// Parameter groups (folders) — purely UI organisation, no eval semantics
// ============================================================================

export function newGroupId(): string {
  return 'g' + Math.random().toString(36).slice(2, 8);
}

/**
 * Returns parameter groups in display order. Adds the synthetic "Allgemein"
 * group only when the panel actually needs it (any param with no groupId, or
 * no groups at all). The synthetic group has id `''` so existing parameters
 * with `groupId == null` map cleanly into it.
 */
export function getOrderedGroups(): ParameterGroup[] {
  const groups = [...state.parameterGroups].sort((a, b) => a.order - b.order);
  const hasUngrouped = state.parameters.some(p => !p.groupId);
  if (hasUngrouped || groups.length === 0) {
    return [{ id: '', name: 'Allgemein', order: -1 }, ...groups];
  }
  return groups;
}

/** Parameters that belong to a group, sorted by `order` (then array position). */
export function getParamsForGroup(groupId: string): Parameter[] {
  const params = state.parameters
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => (p.groupId ?? '') === groupId);
  params.sort((a, b) => {
    const oa = a.p.order ?? a.i;
    const ob = b.p.order ?? b.i;
    return oa - ob;
  });
  return params.map(({ p }) => p);
}

export function createParameterGroup(name: string): ParameterGroup {
  const maxOrder = state.parameterGroups.reduce((m, g) => Math.max(m, g.order), -1);
  const g: ParameterGroup = { id: newGroupId(), name, order: maxOrder + 1 };
  state.parameterGroups.push(g);
  return g;
}

export function renameParameterGroup(id: string, name: string): void {
  const g = state.parameterGroups.find(x => x.id === id);
  if (g) g.name = name;
}

export function toggleParameterGroupCollapsed(id: string): void {
  const g = state.parameterGroups.find(x => x.id === id);
  if (g) g.collapsed = !g.collapsed;
}

/**
 * Delete a group. Parameters inside fall back into the synthetic "Allgemein"
 * group (their `groupId` is cleared). Group order is renormalised so the
 * remaining groups stay 0..n-1.
 */
export function deleteParameterGroup(id: string): void {
  state.parameterGroups = state.parameterGroups.filter(g => g.id !== id);
  for (const p of state.parameters) {
    if (p.groupId === id) p.groupId = undefined;
  }
  state.parameterGroups.forEach((g, i) => { g.order = i; });
}

/**
 * Reorder groups. `groupIds` is the desired sequence — any missing group keeps
 * its existing relative order at the end.
 */
export function reorderParameterGroups(groupIds: string[]): void {
  const seen = new Set<string>();
  const ordered: ParameterGroup[] = [];
  for (const gid of groupIds) {
    const g = state.parameterGroups.find(x => x.id === gid);
    if (g && !seen.has(gid)) { ordered.push(g); seen.add(gid); }
  }
  for (const g of state.parameterGroups) {
    if (!seen.has(g.id)) ordered.push(g);
  }
  ordered.forEach((g, i) => { g.order = i; });
  state.parameterGroups = ordered;
}

/**
 * Move a parameter into a group at the given position (0-based within that
 * group's parameter list). Sets groupId on the moved parameter and renormalises
 * `order` on every parameter that ends up in the target group.
 */
export function moveParameter(paramId: string, targetGroupId: string, targetIndex: number): void {
  const param = state.parameters.find(p => p.id === paramId);
  if (!param) return;
  param.groupId = targetGroupId === '' ? undefined : targetGroupId;
  const inGroup = getParamsForGroup(targetGroupId).filter(p => p.id !== paramId);
  const insertAt = Math.max(0, Math.min(targetIndex, inGroup.length));
  inGroup.splice(insertAt, 0, param);
  inGroup.forEach((p, i) => { p.order = i; });
}

/**
 * Is the parameter referenced by any Expr in any feature?
 * Walks all features defensively — if the feature schema grows, add fields here.
 */
export function isParameterReferenced(id: string): boolean {
  const inExpr = (e: Expr): boolean => {
    if (e.kind === 'param') return e.id === id;
    if (e.kind === 'formula') return e.refs.includes(id);
    return false;
  };
  // Other parameters' formulas can reference this parameter — block delete
  // when any do, otherwise the dependent variable goes broken on next
  // recompute.
  for (const p of state.parameters) {
    if (p.id !== id && p.formula && inExpr(p.formula)) return true;
  }
  // All Exprs transitively contained by a PointRef (polar carries angle +
  // distance and can nest another PointRef as `from`).
  const inPtRef = (pt: import('./types').PointRef): boolean => {
    if (pt.kind === 'abs') return inExpr(pt.x) || inExpr(pt.y);
    if (pt.kind === 'polar') return inExpr(pt.angle) || inExpr(pt.distance) || inPtRef(pt.from);
    if (pt.kind === 'rayHit') return inExpr(pt.angle) || inPtRef(pt.from);
    if (pt.kind === 'axisProject') return inPtRef(pt.xFrom) || inPtRef(pt.yFrom);
    if (pt.kind === 'interpolate') return inExpr(pt.t) || inPtRef(pt.from) || inPtRef(pt.to);
    return false; // endpoint / center / mid / intersection carry no Exprs
  };
  for (const f of state.features) {
    switch (f.kind) {
      case 'line':
        if (inPtRef(f.p1) || inPtRef(f.p2)) return true;
        break;
      case 'polyline':
        for (const pt of f.pts) if (inPtRef(pt)) return true;
        break;
      case 'rect':
        if (inPtRef(f.p1)) return true;
        if (inExpr(f.width) || inExpr(f.height)) return true;
        break;
      case 'circle':
        if (inPtRef(f.center)) return true;
        if (inExpr(f.radius)) return true;
        break;
      case 'arc':
        if (inPtRef(f.center)) return true;
        if (inExpr(f.radius) || inExpr(f.a1) || inExpr(f.a2)) return true;
        if (f.p1 && inPtRef(f.p1)) return true;
        if (f.p2 && inPtRef(f.p2)) return true;
        if (f.bulgeHeight && inExpr(f.bulgeHeight)) return true;
        break;
      case 'ellipse':
        if (inPtRef(f.center)) return true;
        if (inExpr(f.rx) || inExpr(f.ry) || inExpr(f.rot)) return true;
        if (f.axisEnd && inPtRef(f.axisEnd)) return true;
        break;
      case 'spline':
        for (const pt of f.pts) if (inPtRef(pt)) return true;
        break;
      case 'xline':
        if (inPtRef(f.p)) return true;
        if (inExpr(f.dx) || inExpr(f.dy)) return true;
        break;
      case 'parallelXLine':
        if (inExpr(f.distance)) return true;
        break;
      case 'text':
        if (inPtRef(f.p)) return true;
        if (inExpr(f.height) || inExpr(f.rotation)) return true;
        break;
      case 'dim':
        if (inPtRef(f.p1) || inPtRef(f.p2) || inPtRef(f.offset)) return true;
        if (f.vertex && inPtRef(f.vertex)) return true;
        if (f.ray1   && inPtRef(f.ray1))   return true;
        if (f.ray2   && inPtRef(f.ray2))   return true;
        if (inExpr(f.textHeight)) return true;
        break;
      case 'axisParallelXLine':
        if (inExpr(f.distance)) return true;
        break;
      case 'hatch':
        for (const pt of f.pts) if (inPtRef(pt)) return true;
        if (f.holes) for (const h of f.holes) for (const pt of h) if (inPtRef(pt)) return true;
        if (f.angle   && inExpr(f.angle))   return true;
        if (f.spacing && inExpr(f.spacing)) return true;
        break;
      case 'mirror':
        if (f.axis.kind === 'twoPoints') {
          if (inPtRef(f.axis.p1) || inPtRef(f.axis.p2)) return true;
        }
        break;
      case 'array':
        if (inPtRef(f.offset.p1) || inPtRef(f.offset.p2)) return true;
        if (f.rowOffset) {
          if (inPtRef(f.rowOffset.p1) || inPtRef(f.rowOffset.p2)) return true;
        }
        if (inExpr(f.cols) || inExpr(f.rows)) return true;
        break;
      case 'rotate':
        if (inPtRef(f.center)) return true;
        if (inExpr(f.angle)) return true;
        break;
      case 'crossMirror':
        if (inPtRef(f.center)) return true;
        if (inExpr(f.angle)) return true;
        break;
    }
  }
  return false;
}
