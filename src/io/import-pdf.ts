/**
 * PDF parser via pdfjs-dist.
 *
 * Walks every page of the document, calling `getOperatorList()` and
 * translating moveTo / lineTo / curveTo / closePath / arc-like operators
 * into HektikCad polylines. Curves get sampled to 12 segments. Coordinates
 * are converted from PDF points (1/72 in) to millimetres so the imported
 * geometry lands at its drawn size; the PDF Y axis (up) matches HektikCad's,
 * so no flip.
 *
 * The worker is loaded lazily — pdfjs in the Vite dev server needs a
 * worker URL it can resolve. We try `?worker&url` first, then fall back to
 * disabling the worker (`disableWorker: true`) which makes parsing a bit
 * slower but works in every environment, including the Tauri webview.
 */

import type { EntityInit, ImportResult, Layer, Pt } from '../types';

const DEFAULT_LAYER_NAME = 'PDF-Import';
const PT_PER_MM = 72 / 25.4;

/**
 * pdfjs operator list IDs we care about. The exact integer values are
 * defined inside pdfjs's `OPS` enum — pulling that enum at runtime keeps us
 * resilient against version bumps that renumber operators.
 */
type Ops = Record<string, number>;

export async function importPdf(buf: ArrayBuffer, filename: string): Promise<ImportResult> {
  // Dynamic import — keeps the upfront bundle size lean (the legacy build is
  // ~2 MB on its own).
  const pdfjs: typeof import('pdfjs-dist') = await import('pdfjs-dist');
  // pdfjs needs a worker. Resolve its URL relative to this module via
  // `import.meta.url` so Vite emits the worker bundle next to ours and the
  // Tauri webview can fetch it without a separate origin-config step.
  // Falls back to a relative path if `new URL` ever throws (Node test env).
  try {
    pdfjs.GlobalWorkerOptions.workerSrc =
      new URL('pdfjs-dist/build/pdf.worker.mjs', import.meta.url).href;
  } catch {
    pdfjs.GlobalWorkerOptions.workerSrc = '';
  }

  // Source layers: a single bucket for now. Could be split per-page if the
  // user ever asks, but most CAD-imported PDFs are single-page.
  const layers: Layer[] = [{ name: DEFAULT_LAYER_NAME, color: '#ffffff', visible: true }];
  const out: EntityInit[] = [];
  const skipped = { text: 0, hatch: 0, spline: 0, insert: 0, unknown: 0 };

  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buf),
    isEvalSupported: false,
    disableFontFace: true,
  }).promise;

  const OPS = (pdfjs as unknown as { OPS: Ops }).OPS;

  for (let pageIdx = 1; pageIdx <= doc.numPages; pageIdx++) {
    const page = await doc.getPage(pageIdx);
    const opList = await page.getOperatorList();
    const ops = opList.fnArray;
    const args = opList.argsArray as unknown[][];

    // pdfjs internally tracks the CTM, but operator-list path coordinates are
    // already in user-space pre-CTM. We multiply by the CTM ourselves via the
    // current `transform` op stream. Matrix is column-major (a, b, c, d, e, f).
    type Mat = [number, number, number, number, number, number];
    const ID: Mat = [1, 0, 0, 1, 0, 0];
    const ctmStack: Mat[] = [ID];
    const apply = (m: Mat, x: number, y: number): Pt => ({
      x: m[0] * x + m[2] * y + m[4],
      y: m[1] * x + m[3] * y + m[5],
    });
    const compose = (a: Mat, b: Mat): Mat => [
      a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
      a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
      a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
    ];

    // Path accumulator.
    let curPath: Pt[] = [];
    let curStart: Pt | null = null;
    const flush = (closed: boolean): void => {
      if (curPath.length >= 2) {
        out.push({
          type: 'polyline',
          layer: 0,
          pts: curPath.slice().map(p => ({ x: p.x / PT_PER_MM, y: p.y / PT_PER_MM })),
          closed,
        });
      }
      curPath = [];
      curStart = null;
    };

    // pdfjs encodes path *building* and path *painting* as separate ops:
    // `constructPath` populates a list of subops, and `stroke` / `fill` /
    // `eoFill` triggers the actual rendering. The args of `constructPath` are
    // [subOps[], subArgs[]].
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      const a = args[i] ?? [];
      if (op === OPS.save) {
        ctmStack.push(ctmStack[ctmStack.length - 1].slice() as Mat);
      } else if (op === OPS.restore) {
        if (ctmStack.length > 1) ctmStack.pop();
      } else if (op === OPS.transform) {
        const m = a as unknown as number[];
        ctmStack[ctmStack.length - 1] = compose(
          ctmStack[ctmStack.length - 1],
          [m[0], m[1], m[2], m[3], m[4], m[5]] as Mat,
        );
      } else if (op === OPS.constructPath) {
        const subOps  = a[0] as number[];
        const subArgs = a[1] as number[];
        let argi = 0;
        const m = ctmStack[ctmStack.length - 1];
        for (const sub of subOps) {
          if (sub === OPS.moveTo) {
            const p = apply(m, subArgs[argi], subArgs[argi + 1]);
            argi += 2;
            flush(false);
            curPath.push(p);
            curStart = p;
          } else if (sub === OPS.lineTo) {
            const p = apply(m, subArgs[argi], subArgs[argi + 1]);
            argi += 2;
            curPath.push(p);
          } else if (sub === OPS.curveTo) {
            // Cubic with two control points — args are (cx1, cy1, cx2, cy2, x, y).
            const last = curPath[curPath.length - 1];
            const c1 = apply(m, subArgs[argi],     subArgs[argi + 1]);
            const c2 = apply(m, subArgs[argi + 2], subArgs[argi + 3]);
            const p3 = apply(m, subArgs[argi + 4], subArgs[argi + 5]);
            argi += 6;
            if (!last) { curPath.push(p3); continue; }
            for (let s = 1; s <= 12; s++) {
              const t = s / 12, it = 1 - t;
              const b0 = it * it * it, b1 = 3 * it * it * t, b2 = 3 * it * t * t, b3 = t * t * t;
              curPath.push({
                x: b0 * last.x + b1 * c1.x + b2 * c2.x + b3 * p3.x,
                y: b0 * last.y + b1 * c1.y + b2 * c2.y + b3 * p3.y,
              });
            }
          } else if (sub === OPS.curveTo2) {
            // First control = current point. Args: (cx2, cy2, x, y).
            const last = curPath[curPath.length - 1];
            const c2 = apply(m, subArgs[argi],     subArgs[argi + 1]);
            const p3 = apply(m, subArgs[argi + 2], subArgs[argi + 3]);
            argi += 4;
            if (!last) { curPath.push(p3); continue; }
            const c1 = last;
            for (let s = 1; s <= 12; s++) {
              const t = s / 12, it = 1 - t;
              const b0 = it * it * it, b1 = 3 * it * it * t, b2 = 3 * it * t * t, b3 = t * t * t;
              curPath.push({
                x: b0 * last.x + b1 * c1.x + b2 * c2.x + b3 * p3.x,
                y: b0 * last.y + b1 * c1.y + b2 * c2.y + b3 * p3.y,
              });
            }
          } else if (sub === OPS.curveTo3) {
            // Second control = end point. Args: (cx1, cy1, x, y).
            const last = curPath[curPath.length - 1];
            const c1 = apply(m, subArgs[argi],     subArgs[argi + 1]);
            const p3 = apply(m, subArgs[argi + 2], subArgs[argi + 3]);
            argi += 4;
            if (!last) { curPath.push(p3); continue; }
            const c2 = p3;
            for (let s = 1; s <= 12; s++) {
              const t = s / 12, it = 1 - t;
              const b0 = it * it * it, b1 = 3 * it * it * t, b2 = 3 * it * t * t, b3 = t * t * t;
              curPath.push({
                x: b0 * last.x + b1 * c1.x + b2 * c2.x + b3 * p3.x,
                y: b0 * last.y + b1 * c1.y + b2 * c2.y + b3 * p3.y,
              });
            }
          } else if (sub === OPS.closePath) {
            if (curStart) curPath.push(curStart);
          } else if (sub === OPS.rectangle) {
            // PDF rectangle = (x, y, w, h). Translates to a closed quad.
            const [rx, ry, rw, rh] = [subArgs[argi], subArgs[argi + 1], subArgs[argi + 2], subArgs[argi + 3]];
            argi += 4;
            const a1 = apply(m, rx, ry), a2 = apply(m, rx + rw, ry);
            const a3 = apply(m, rx + rw, ry + rh), a4 = apply(m, rx, ry + rh);
            // Emit immediately as a closed polyline; rectangles often coexist
            // with other path ops in the same constructPath.
            flush(false);
            out.push({
              type: 'polyline', layer: 0,
              pts: [a1, a2, a3, a4].map(p => ({ x: p.x / PT_PER_MM, y: p.y / PT_PER_MM })),
              closed: true,
            });
          }
        }
      } else if (op === OPS.stroke || op === OPS.closeStroke) {
        if (op === OPS.closeStroke && curStart) curPath.push(curStart);
        flush(op === OPS.closeStroke);
      } else if (op === OPS.fill || op === OPS.eoFill) {
        flush(true);
      } else if (op === OPS.fillStroke || op === OPS.eoFillStroke
              || op === OPS.closeFillStroke || op === OPS.closeEOFillStroke) {
        flush(true);
      } else if (op === OPS.endPath) {
        // Path ended without paint — discard.
        curPath = [];
        curStart = null;
      } else if (op === OPS.showText || op === OPS.showSpacedText
              || op === OPS.nextLineShowText || op === OPS.nextLineSetSpacingShowText) {
        skipped.text = (skipped.text ?? 0) + 1;
      } else if (op === OPS.paintImageXObject || op === OPS.paintImageXObjectRepeat
              || op === OPS.paintInlineImageXObject) {
        skipped.unknown = (skipped.unknown ?? 0) + 1;
      }
    }
    flush(false);

    page.cleanup();
  }
  await doc.destroy();

  return { entities: out, layers, skipped, filename, format: 'pdf' };
}
