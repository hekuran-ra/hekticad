/**
 * EPS parser. Filled in Phase 10.
 *
 * Contract:
 *   `importEps(text, filename)` tokenises PostScript, maintains an operand
 *   stack + current path + CTM (scale/translate only), emits polylines for
 *   line/moveto/lineto/closepath/stroke and arc/arcn → ArcEntity.
 *   `curveto` sampled to 16 line segments. Text and fills ignored.
 */

import type { ImportResult } from '../types';

export function importEps(_text: string, _filename: string): ImportResult {
  throw new Error('importEps: not yet implemented (Phase 10)');
}
