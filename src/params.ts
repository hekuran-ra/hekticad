import type { Expr, FormulaNode, Parameter } from './types';
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

/** Evaluate an Expr against current state.parameters. */
export function evalExpr(e: Expr): number {
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

export function updateParameter(id: string, patch: Partial<Omit<Parameter, 'id'>>): void {
  const p = state.parameters.find(x => x.id === id);
  if (!p) return;
  Object.assign(p, patch);
}

export function deleteParameter(id: string): void {
  state.parameters = state.parameters.filter(p => p.id !== id);
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
  for (const f of state.features) {
    switch (f.kind) {
      case 'line':
      case 'polyline':
        for (const pt of ('pts' in f ? f.pts : [f.p1, f.p2])) {
          if (pt.kind === 'abs' && (inExpr(pt.x) || inExpr(pt.y))) return true;
        }
        break;
      case 'rect':
        if (f.p1.kind === 'abs' && (inExpr(f.p1.x) || inExpr(f.p1.y))) return true;
        if (inExpr(f.width) || inExpr(f.height)) return true;
        break;
      case 'circle':
        if (f.center.kind === 'abs' && (inExpr(f.center.x) || inExpr(f.center.y))) return true;
        if (inExpr(f.radius)) return true;
        break;
      case 'parallelXLine':
        if (inExpr(f.distance)) return true;
        break;
      case 'text':
        if (f.p.kind === 'abs' && (inExpr(f.p.x) || inExpr(f.p.y))) return true;
        if (inExpr(f.height) || inExpr(f.rotation)) return true;
        break;
    }
  }
  return false;
}
