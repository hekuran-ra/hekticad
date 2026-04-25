/**
 * EPS / PostScript Level 2 parser.
 *
 * Only what HektikCad's own EPS exporter (and the dialect Illustrator /
 * Inkscape produce) emits is supported:
 *   - `M` / `L` / `Z` / `S` / `newpath` (the export shorthand).
 *   - Standard PostScript operators `moveto`, `lineto`, `curveto`,
 *     `closepath`, `stroke`, `arc`, `arcn`.
 *   - `gsave` / `grestore` and `scale` / `rotate` / `translate` for the
 *     current transformation matrix (used by the EPS exporter for ellipses).
 *
 * The CTM stack starts with `2.834645 2.834645 scale` (the exporter uses it
 * to flip from default-pt to mm). When the file starts with a different
 * `scale` we honour it; otherwise we assume mm — matching the user's
 * "1:1 import as authored" requirement.
 *
 * `curveto` gets sampled to 12 line segments. `arc` is converted to an arc
 * entity (no sampling) so downstream tools can re-snap to the centre. Text
 * and font operators are ignored.
 */

import type { ArcEntity, EntityInit, ImportResult, Layer, LineEntity,
              PolylineEntity, Pt } from '../types';

const DEFAULT_LAYER_NAME = 'EPS-Import';

/** 2D affine matrix, column-major: [a b c d tx ty] applied as [x' y'] = M·[x y 1]. */
type Mat = [number, number, number, number, number, number];

const ID: Mat = [1, 0, 0, 1, 0, 0];
const apply = (m: Mat, x: number, y: number): Pt => ({
  x: m[0] * x + m[2] * y + m[4],
  y: m[1] * x + m[3] * y + m[5],
});
const compose = (a: Mat, b: Mat): Mat => [
  a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
];
const scaleM     = (sx: number, sy: number): Mat => [sx, 0, 0, sy, 0, 0];
const translateM = (tx: number, ty: number): Mat => [1, 0, 0, 1, tx, ty];
const rotateM    = (rad: number): Mat => [Math.cos(rad), Math.sin(rad), -Math.sin(rad), Math.cos(rad), 0, 0];

export function importEps(text: string, filename: string): ImportResult {
  // Strip comments — `%` to end-of-line — but keep `%%` DSC headers visible
  // to the tokeniser in case someone ever wants to mine them. They get
  // ignored as no-op operators below.
  const cleaned = text.replace(/%[^\n]*/g, '');
  const tokens = cleaned.split(/\s+/).filter(Boolean);

  // Stacks
  const operandStack: (number | string)[] = [];
  const ctmStack: Mat[] = [ID];

  // Path + emitted entities
  const layers: Layer[] = [{ name: DEFAULT_LAYER_NAME, color: '#ffffff', visible: true }];
  const out: EntityInit[] = [];
  const skipped = { text: 0, hatch: 0, spline: 0, insert: 0, unknown: 0 };

  // Current sub-path state
  let curPath: Pt[] = [];          // accumulated points in the current sub-path
  let curStart: Pt | null = null;  // sub-path start (for closepath)
  let pendingArc: { cx: number; cy: number; r: number; a1: number; a2: number; ccw: boolean } | null = null;

  const flushPath = (closed: boolean): void => {
    if (pendingArc) {
      // An arc operator is its own primitive — emit + reset.
      const A = pendingArc;
      pendingArc = null;
      const m = ctmStack[ctmStack.length - 1];
      const c = apply(m, A.cx, A.cy);
      // Take r from the X-axis basis length (assumes uniform scale, which is
      // what the EPS exporter sets up). For asymmetric scaling we'd need an
      // ellipse — keep it simple here, the exporter never emits that.
      const r = A.r * Math.hypot(m[0], m[1]);
      const e: Omit<ArcEntity, 'id'> = {
        type: 'arc',
        layer: 0,
        cx: c.x, cy: c.y, r,
        a1: A.a1, a2: A.a2,
      };
      out.push(e);
    }
    if (curPath.length >= 2) {
      const e: Omit<PolylineEntity, 'id'> = {
        type: 'polyline',
        layer: 0,
        pts: curPath.slice(),
        closed,
      };
      out.push(e);
    } else if (curPath.length === 2 && !closed) {
      // Two-point path → emit a LINE so the entity stays editable in HektikCad
      // as a real line, not a degenerate polyline.
      const [a, b] = curPath;
      const e: Omit<LineEntity, 'id'> = {
        type: 'line', layer: 0, x1: a.x, y1: a.y, x2: b.x, y2: b.y,
      };
      out.push(e);
    }
    curPath = [];
    curStart = null;
  };

  const popN = (n: number): number[] => {
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      const v = operandStack.pop();
      out.unshift(typeof v === 'number' ? v : parseFloat(String(v ?? 0)));
    }
    return out;
  };

  for (let ti = 0; ti < tokens.length; ti++) {
    const tk = tokens[ti];
    // Numeric literal — push.
    if (/^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(tk)) {
      operandStack.push(parseFloat(tk));
      continue;
    }
    // String literal `(…)` — could span multiple tokens. We don't use it but
    // we must consume balanced parens so they don't poison the stack.
    if (tk.startsWith('(')) {
      let depth = 0;
      let buf = tk;
      for (; ti < tokens.length; ti++) {
        for (const ch of tokens[ti]) {
          if (ch === '(') depth += 1;
          else if (ch === ')') depth -= 1;
        }
        if (depth <= 0) break;
        buf += ' ' + tokens[ti + 1];
      }
      operandStack.push(buf);
      continue;
    }
    // Name literals `/foo` — push as string. Used for fonts, definedicts, etc.
    if (tk.startsWith('/')) {
      operandStack.push(tk);
      continue;
    }
    // Operators
    switch (tk) {
      case 'newpath':
        flushPath(false);
        break;
      case 'moveto':
      case 'M': {
        const [x, y] = popN(2);
        flushPath(false);
        const m = ctmStack[ctmStack.length - 1];
        const p = apply(m, x, y);
        curPath.push(p);
        curStart = p;
        break;
      }
      case 'lineto':
      case 'L': {
        const [x, y] = popN(2);
        const m = ctmStack[ctmStack.length - 1];
        curPath.push(apply(m, x, y));
        break;
      }
      case 'rlineto': {
        const [dx, dy] = popN(2);
        const last = curPath[curPath.length - 1];
        if (!last) break;
        // Relative line: world-mm dx/dy aren't directly meaningful under a
        // non-identity CTM — interpret as user-space delta and apply to last
        // user-space pt. We don't track user-space pts separately, so use the
        // CTM linear part.
        const m = ctmStack[ctmStack.length - 1];
        curPath.push({ x: last.x + m[0] * dx + m[2] * dy, y: last.y + m[1] * dx + m[3] * dy });
        break;
      }
      case 'curveto': {
        const [x1, y1, x2, y2, x3, y3] = popN(6);
        const last = curPath[curPath.length - 1];
        if (!last) break;
        const m = ctmStack[ctmStack.length - 1];
        const c1 = apply(m, x1, y1), c2 = apply(m, x2, y2), p3 = apply(m, x3, y3);
        for (let s = 1; s <= 12; s++) {
          const t = s / 12, it = 1 - t;
          const b0 = it * it * it, b1 = 3 * it * it * t, b2 = 3 * it * t * t, b3 = t * t * t;
          curPath.push({
            x: b0 * last.x + b1 * c1.x + b2 * c2.x + b3 * p3.x,
            y: b0 * last.y + b1 * c1.y + b2 * c2.y + b3 * p3.y,
          });
        }
        break;
      }
      case 'arc':
      case 'arcn': {
        const [cx, cy, r, a1Deg, a2Deg] = popN(5);
        // Stash the arc for emission at the next stroke/closepath. PostScript
        // arc semantics: the operator both establishes a moveto-like context
        // and adds a path segment — for simplicity we treat each arc as its
        // own standalone arc entity rather than appending to a poly path.
        pendingArc = {
          cx, cy, r,
          a1: a1Deg * Math.PI / 180,
          a2: a2Deg * Math.PI / 180,
          ccw: tk === 'arc',
        };
        break;
      }
      case 'closepath':
      case 'Z': {
        if (curStart) curPath.push(curStart);
        flushPath(true);
        break;
      }
      case 'stroke':
      case 'S': {
        flushPath(false);
        break;
      }
      case 'fill':
      case 'eofill':
        // Fills aren't preserved — emit boundary polyline like stroke does.
        flushPath(true);
        break;
      case 'gsave':
        ctmStack.push(ctmStack[ctmStack.length - 1].slice() as Mat);
        break;
      case 'grestore':
        if (ctmStack.length > 1) ctmStack.pop();
        break;
      case 'scale': {
        const [sx, sy] = popN(2);
        ctmStack[ctmStack.length - 1] = compose(ctmStack[ctmStack.length - 1], scaleM(sx, sy));
        break;
      }
      case 'translate': {
        const [tx, ty] = popN(2);
        ctmStack[ctmStack.length - 1] = compose(ctmStack[ctmStack.length - 1], translateM(tx, ty));
        break;
      }
      case 'rotate': {
        const [deg] = popN(1);
        ctmStack[ctmStack.length - 1] = compose(ctmStack[ctmStack.length - 1], rotateM(deg * Math.PI / 180));
        break;
      }
      case 'show':
      case 'ashow':
      case 'widthshow':
      case 'awidthshow':
      case 'kshow':
      case 'stringwidth':
        skipped.text = (skipped.text ?? 0) + 1;
        operandStack.length = 0;  // these operators consume strings + state
        break;
      case 'setrgbcolor':
      case 'setgray':
      case 'setcmykcolor':
      case 'setlinewidth':
      case 'setlinecap':
      case 'setlinejoin':
      case 'setdash':
      case 'setflat':
      case 'setmiterlimit':
      case 'concat':
      case 'matrix':
      case 'currentmatrix':
      case 'setmatrix':
      case 'def':
      case 'bind':
      case 'load':
      case 'pop':
      case 'dup':
      case 'exch':
      case 'findfont':
      case 'scalefont':
      case 'setfont':
      case 'showpage':
      case 'clip':
      case 'eoclip':
        // Drain operands for graphics-state operators. Cheap-and-safe: pop one
        // value if present. For unrecognised commands we leave the stack alone.
        operandStack.pop();
        break;
      default:
        // Unknown operator — could be procedure name or DSC marker. Skip.
        break;
    }
  }
  // Trailing path with no explicit stroke — emit anyway so we don't lose it.
  flushPath(false);

  return { entities: out, layers, skipped, filename, format: 'eps' };
}
