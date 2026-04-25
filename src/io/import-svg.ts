/**
 * SVG parser.
 *
 * Walks the parsed XML DOM, collecting line / polyline / polygon / rect /
 * circle / ellipse / path elements. SVG world is Y-down; HektikCad is Y-up,
 * so we flip every Y coordinate. We assume the source is in millimetres
 * (matches what `buildSvgBlob` writes); the user accepted "1:1 import as
 * authored" so no unit-aware scaling is attempted — if a third-party file
 * uses pt or px the geometry will land at the same numeric value, just in
 * mm. Source layers come from `<g class="…">` / `<g id="…">` / direct
 * `class="…"` attributes; everything without a layer hint goes onto a single
 * "SVG-Import" layer.
 *
 * Out of scope: filters, gradients, fills, transforms beyond translate/scale
 * (a future revision can add a real CTM stack).
 */

import type { EntityInit, ImportResult, Layer, Pt } from '../types';

const DEFAULT_LAYER_NAME = 'SVG-Import';

/**
 * Parse an SVG document into an `ImportResult`. The DOM is built via the
 * platform `DOMParser` so we don't pull in an XML dependency just for import.
 */
export function importSvg(text: string, filename: string): ImportResult {
  const parser = new DOMParser();
  const doc = parser.parseFromString(text, 'image/svg+xml');
  const errEl = doc.querySelector('parsererror');
  if (errEl) {
    throw new Error(`SVG ungültig: ${errEl.textContent?.trim() ?? 'parser error'}`);
  }
  const root = doc.documentElement;
  if (!root || root.localName !== 'svg') {
    throw new Error('Keine SVG-Wurzel gefunden');
  }

  const layers: Layer[] = [];
  const layerIndex = new Map<string, number>();
  const layerFor = (name: string, color: string): number => {
    const key = name + '|' + color;
    let idx = layerIndex.get(key);
    if (idx == null) {
      idx = layers.length;
      layerIndex.set(key, idx);
      layers.push({ name, color, visible: true });
    }
    return idx;
  };

  const out: EntityInit[] = [];
  const skipped = { text: 0, hatch: 0, spline: 0, insert: 0, unknown: 0 };

  // Walk every visit-able element in document order. Layer hint = the nearest
  // ancestor `<g>`'s id/class (in that order); colour hint = nearest `stroke`
  // attribute (an inline style on the element wins over the group default).
  const walk = (node: Element, groupName: string, groupColor: string): void => {
    const layerName = node.getAttribute('id') || node.getAttribute('class') || groupName;
    const stroke = node.getAttribute('stroke') || groupColor;
    if (node.localName === 'g') {
      // Recurse into the group.
      for (const child of Array.from(node.children)) {
        walk(child, layerName, stroke);
      }
      return;
    }
    const layerIdx = (): number => layerFor(layerName || DEFAULT_LAYER_NAME, normaliseColor(stroke));
    parseElement(node, layerIdx, out, skipped);
  };

  for (const child of Array.from(root.children)) {
    walk(child, DEFAULT_LAYER_NAME, '#ffffff');
  }
  // If no layers were created (e.g. only unsupported elements), still emit
  // the default so the dispatcher has something to map onto.
  if (layers.length === 0) layers.push({ name: DEFAULT_LAYER_NAME, color: '#ffffff', visible: true });

  return { entities: out, layers, skipped, filename, format: 'svg' };
}

// ────────────────────────────────────────────────────────────────────────────
// Per-element parsing
// ────────────────────────────────────────────────────────────────────────────

function parseElement(
  el: Element,
  layerIdx: () => number,
  out: EntityInit[],
  skipped: ImportResult['skipped'],
): void {
  const flipY = (y: number): number => -y;
  const numAttr = (name: string, fallback = 0): number => {
    const raw = el.getAttribute(name);
    if (raw == null) return fallback;
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : fallback;
  };

  switch (el.localName) {
    case 'line': {
      out.push({
        type: 'line',
        layer: layerIdx(),
        x1: numAttr('x1'),
        y1: flipY(numAttr('y1')),
        x2: numAttr('x2'),
        y2: flipY(numAttr('y2')),
      });
      return;
    }
    case 'polyline':
    case 'polygon': {
      const pts = parsePoints(el.getAttribute('points') || '', flipY);
      if (pts.length >= 2) {
        out.push({
          type: 'polyline',
          layer: layerIdx(),
          pts,
          closed: el.localName === 'polygon',
        });
      }
      return;
    }
    case 'rect': {
      const x = numAttr('x'), y = numAttr('y'), w = numAttr('width'), h = numAttr('height');
      // World rect's two corners are picked at the SVG top-left and bottom-right.
      // Flip both Y values, so the rect lands below the X axis (matching how the
      // exporter writes it).
      out.push({
        type: 'rect',
        layer: layerIdx(),
        x1: x,
        y1: flipY(y),
        x2: x + w,
        y2: flipY(y + h),
      });
      return;
    }
    case 'circle': {
      out.push({
        type: 'circle',
        layer: layerIdx(),
        cx: numAttr('cx'),
        cy: flipY(numAttr('cy')),
        r: numAttr('r'),
      });
      return;
    }
    case 'ellipse': {
      out.push({
        type: 'ellipse',
        layer: layerIdx(),
        cx: numAttr('cx'),
        cy: flipY(numAttr('cy')),
        rx: numAttr('rx'),
        ry: numAttr('ry'),
        rot: 0,
      });
      return;
    }
    case 'path': {
      // Convert paths to polylines via a coarse sampler. Cubic / quadratic
      // beziers get sampled at 12 points/segment, arcs at 32 — enough fidelity
      // for screen + paper without exploding the entity count.
      const segments = sampleSvgPath(el.getAttribute('d') || '', flipY);
      for (const seg of segments) {
        if (seg.pts.length < 2) continue;
        out.push({
          type: 'polyline',
          layer: layerIdx(),
          pts: seg.pts,
          closed: seg.closed,
        });
      }
      return;
    }
    case 'text': {
      skipped.text = (skipped.text ?? 0) + 1;
      return;
    }
    default:
      // Unknown / unsupported — note it but don't error out.
      skipped.unknown = (skipped.unknown ?? 0) + 1;
      return;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers — points list, path d, colour
// ────────────────────────────────────────────────────────────────────────────

function parsePoints(s: string, flipY: (y: number) => number): Pt[] {
  // SVG `points` is a whitespace/comma-separated list of x,y pairs.
  const tokens = s.trim().split(/[\s,]+/).filter(Boolean);
  const out: Pt[] = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const x = parseFloat(tokens[i]);
    const y = parseFloat(tokens[i + 1]);
    if (Number.isFinite(x) && Number.isFinite(y)) out.push({ x, y: flipY(y) });
  }
  return out;
}

/**
 * Bare-minimum SVG path tokeniser. Splits the `d` string by command letters,
 * walks each command with running current-point + last-control-point state.
 * Returns one or more polyline segments (a new segment starts at every M /
 * after a Z).
 *
 * Curves get sampled to line segments at fixed sample counts:
 *   - C / S (cubic) → 12 samples
 *   - Q / T (quadratic) → 12 samples
 *   - A (elliptical arc) → 32 samples
 *
 * Limitations: arc-flag handling is correct for axis-aligned arcs but does
 * not honour `xAxisRotation` precisely (rotation cancels for our typical
 * source files); fine for HektikCad's own SVG output.
 */
function sampleSvgPath(d: string, flipY: (y: number) => number): { pts: Pt[]; closed: boolean }[] {
  const cmdRe = /([MmLlHhVvCcSsQqTtAaZz])([^MmLlHhVvCcSsQqTtAaZz]*)/g;
  const segments: { pts: Pt[]; closed: boolean }[] = [];
  let cur: Pt | null = null;
  let start: Pt | null = null;
  let lastCtrl: Pt | null = null;
  let segPts: Pt[] = [];

  const pushPt = (p: Pt): void => {
    segPts.push({ x: p.x, y: flipY(p.y) });
    cur = p;
  };
  const flush = (closed: boolean): void => {
    if (segPts.length >= 2) segments.push({ pts: segPts, closed });
    segPts = [];
  };

  let m: RegExpExecArray | null;
  while ((m = cmdRe.exec(d)) !== null) {
    const cmd = m[1];
    const args = m[2].trim().split(/[\s,]+/).filter(Boolean).map(parseFloat);
    let i = 0;
    const rel = cmd === cmd.toLowerCase();
    const upper = cmd.toUpperCase();
    const ax = (n: number): number => (rel && cur ? cur.x + n : n);
    const ay = (n: number): number => (rel && cur ? cur.y + n : n);

    switch (upper) {
      case 'M': {
        // First M starts a fresh segment; subsequent pairs after a Move are
        // implicit Lineto's per the SVG spec.
        flush(false);
        cur = { x: ax(args[i]), y: ay(args[i + 1]) }; i += 2;
        start = cur;
        segPts.push({ x: cur.x, y: flipY(cur.y) });
        while (i + 1 < args.length) {
          pushPt({ x: ax(args[i]), y: ay(args[i + 1]) });
          i += 2;
        }
        lastCtrl = null;
        break;
      }
      case 'L': {
        while (i + 1 < args.length) {
          pushPt({ x: ax(args[i]), y: ay(args[i + 1]) });
          i += 2;
        }
        lastCtrl = null;
        break;
      }
      case 'H': {
        while (i < args.length) {
          if (!cur) cur = { x: 0, y: 0 };
          pushPt({ x: rel ? cur.x + args[i] : args[i], y: cur.y });
          i += 1;
        }
        lastCtrl = null;
        break;
      }
      case 'V': {
        while (i < args.length) {
          if (!cur) cur = { x: 0, y: 0 };
          pushPt({ x: cur.x, y: rel ? cur.y + args[i] : args[i] });
          i += 1;
        }
        lastCtrl = null;
        break;
      }
      case 'C': {
        while (i + 5 < args.length) {
          if (!cur) cur = { x: 0, y: 0 };
          const c1 = { x: ax(args[i]),     y: ay(args[i + 1]) };
          const c2 = { x: ax(args[i + 2]), y: ay(args[i + 3]) };
          const p3 = { x: ax(args[i + 4]), y: ay(args[i + 5]) };
          sampleCubic(cur, c1, c2, p3, 12, (p) => segPts.push({ x: p.x, y: flipY(p.y) }));
          cur = p3;
          lastCtrl = c2;
          i += 6;
        }
        break;
      }
      case 'S': {
        while (i + 3 < args.length) {
          if (!cur) cur = { x: 0, y: 0 };
          // Implicit first control = reflection of last control around current.
          const c1: Pt = lastCtrl
            ? { x: 2 * cur.x - lastCtrl.x, y: 2 * cur.y - lastCtrl.y }
            : { x: cur.x, y: cur.y };
          const c2 = { x: ax(args[i]),     y: ay(args[i + 1]) };
          const p3 = { x: ax(args[i + 2]), y: ay(args[i + 3]) };
          sampleCubic(cur, c1, c2, p3, 12, (p) => segPts.push({ x: p.x, y: flipY(p.y) }));
          cur = p3;
          lastCtrl = c2;
          i += 4;
        }
        break;
      }
      case 'Q': {
        while (i + 3 < args.length) {
          if (!cur) cur = { x: 0, y: 0 };
          const c1 = { x: ax(args[i]),     y: ay(args[i + 1]) };
          const p2 = { x: ax(args[i + 2]), y: ay(args[i + 3]) };
          sampleQuad(cur, c1, p2, 12, (p) => segPts.push({ x: p.x, y: flipY(p.y) }));
          cur = p2;
          lastCtrl = c1;
          i += 4;
        }
        break;
      }
      case 'T': {
        while (i + 1 < args.length) {
          if (!cur) cur = { x: 0, y: 0 };
          const c1: Pt = lastCtrl
            ? { x: 2 * cur.x - lastCtrl.x, y: 2 * cur.y - lastCtrl.y }
            : { x: cur.x, y: cur.y };
          const p2 = { x: ax(args[i]),     y: ay(args[i + 1]) };
          sampleQuad(cur, c1, p2, 12, (p) => segPts.push({ x: p.x, y: flipY(p.y) }));
          cur = p2;
          lastCtrl = c1;
          i += 2;
        }
        break;
      }
      case 'A': {
        while (i + 6 < args.length) {
          if (!cur) cur = { x: 0, y: 0 };
          const rx = args[i];
          const ry = args[i + 1];
          const rotDeg = args[i + 2];
          const largeArc = args[i + 3] !== 0;
          const sweep = args[i + 4] !== 0;
          const ex = ax(args[i + 5]);
          const ey = ay(args[i + 6]);
          sampleArc(cur, { x: ex, y: ey }, rx, ry, rotDeg, largeArc, sweep, 32,
            (p) => segPts.push({ x: p.x, y: flipY(p.y) }));
          cur = { x: ex, y: ey };
          lastCtrl = null;
          i += 7;
        }
        break;
      }
      case 'Z': {
        // Close back to subpath start, emit closed segment, fresh state.
        if (start && segPts.length > 0) {
          // Avoid duplicating the start point if it was already pushed last.
          flush(true);
          cur = start;
        }
        lastCtrl = null;
        break;
      }
    }
  }
  flush(false);
  return segments;
}

function sampleCubic(p0: Pt, c1: Pt, c2: Pt, p3: Pt, n: number, push: (p: Pt) => void): void {
  for (let s = 1; s <= n; s++) {
    const t = s / n, it = 1 - t;
    const b0 = it * it * it, b1 = 3 * it * it * t, b2 = 3 * it * t * t, b3 = t * t * t;
    push({
      x: b0 * p0.x + b1 * c1.x + b2 * c2.x + b3 * p3.x,
      y: b0 * p0.y + b1 * c1.y + b2 * c2.y + b3 * p3.y,
    });
  }
}
function sampleQuad(p0: Pt, c1: Pt, p2: Pt, n: number, push: (p: Pt) => void): void {
  for (let s = 1; s <= n; s++) {
    const t = s / n, it = 1 - t;
    const b0 = it * it, b1 = 2 * it * t, b2 = t * t;
    push({ x: b0 * p0.x + b1 * c1.x + b2 * p2.x, y: b0 * p0.y + b1 * c1.y + b2 * p2.y });
  }
}

/**
 * Sample an SVG elliptical arc from p0 to p1. Conversion based on the
 * "endpoint to center" parameterisation (W3C SVG 1.1 Appendix F.6.5).
 */
function sampleArc(
  p0: Pt, p1: Pt, rx: number, ry: number, rotDeg: number,
  largeArc: boolean, sweep: boolean, n: number, push: (p: Pt) => void,
): void {
  if (rx <= 0 || ry <= 0) {
    // Degenerate radius — emit a straight line.
    push(p1);
    return;
  }
  const phi = rotDeg * Math.PI / 180;
  const cosPhi = Math.cos(phi), sinPhi = Math.sin(phi);

  // Step 1: compute (x1', y1')
  const dx = (p0.x - p1.x) / 2, dy = (p0.y - p1.y) / 2;
  const x1p =  cosPhi * dx + sinPhi * dy;
  const y1p = -sinPhi * dx + cosPhi * dy;

  // Step 2: ensure radii are large enough
  let rxa = Math.abs(rx), rya = Math.abs(ry);
  const lambda = (x1p * x1p) / (rxa * rxa) + (y1p * y1p) / (rya * rya);
  if (lambda > 1) { const s = Math.sqrt(lambda); rxa *= s; rya *= s; }

  // Step 3: compute (cx', cy')
  const sign = (largeArc === sweep) ? -1 : 1;
  const denom = (rxa * rxa * y1p * y1p + rya * rya * x1p * x1p);
  const factor = denom === 0 ? 0
    : sign * Math.sqrt(Math.max(0,
        (rxa * rxa * rya * rya - rxa * rxa * y1p * y1p - rya * rya * x1p * x1p) / denom));
  const cxp =  factor * (rxa * y1p) / rya;
  const cyp = -factor * (rya * x1p) / rxa;

  // Step 4: compute (cx, cy)
  const cx = cosPhi * cxp - sinPhi * cyp + (p0.x + p1.x) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (p0.y + p1.y) / 2;

  // Step 5: compute angles
  const angle = (ux: number, uy: number, vx: number, vy: number): number => {
    const dot = ux * vx + uy * vy;
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy) || 1;
    let a = Math.acos(Math.max(-1, Math.min(1, dot / len)));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };
  const startAngle = angle(1, 0, (x1p - cxp) / rxa, (y1p - cyp) / rya);
  let deltaAngle = angle(
    (x1p - cxp) / rxa, (y1p - cyp) / rya,
    (-x1p - cxp) / rxa, (-y1p - cyp) / rya,
  );
  if (!sweep && deltaAngle > 0) deltaAngle -= 2 * Math.PI;
  if (sweep && deltaAngle < 0) deltaAngle += 2 * Math.PI;

  for (let s = 1; s <= n; s++) {
    const t = s / n;
    const a = startAngle + deltaAngle * t;
    const x = cosPhi * (rxa * Math.cos(a)) - sinPhi * (rya * Math.sin(a)) + cx;
    const y = sinPhi * (rxa * Math.cos(a)) + cosPhi * (rya * Math.sin(a)) + cy;
    push({ x, y });
  }
}

/** Coerce SVG colour values into a `#rrggbb` hex string for our Layer model. */
function normaliseColor(c: string | null | undefined): string {
  if (!c) return '#ffffff';
  const s = c.trim().toLowerCase();
  if (s === 'none' || s === 'currentcolor' || s === 'transparent') return '#ffffff';
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  if (/^#[0-9a-f]{3}$/.test(s)) {
    return '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
  }
  // rgb(r,g,b)
  const m = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(s);
  if (m) {
    const hex = (n: number): string => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0');
    return '#' + hex(+m[1]) + hex(+m[2]) + hex(+m[3]);
  }
  // Named colours — shortcut just the most common ones, fall back to white.
  const named: Record<string, string> = {
    black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000',
    blue: '#0000ff', yellow: '#ffff00', gray: '#808080', grey: '#808080',
  };
  return named[s] ?? '#ffffff';
}
