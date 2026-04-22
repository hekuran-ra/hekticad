/**
 * PDF parser via pdfjs-dist. Filled in Phase 11 (optional — may stay as
 * a stub past v1 if scope runs tight).
 *
 * Contract:
 *   `importPdf(arrayBuffer, filename)` loads the first page, walks
 *   `getOperatorList()`, extracts moveTo/lineTo/curveTo/closePath → polylines,
 *   converts pdf-pt to mm, Y-flips into world space.
 */

import type { ImportResult } from '../types';

export async function importPdf(_buf: ArrayBuffer, _filename: string): Promise<ImportResult> {
  throw new Error('importPdf: not yet implemented (Phase 11)');
}
