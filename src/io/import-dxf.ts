/**
 * DXF R12 parser. Filled in Phase 9.
 *
 * Contract:
 *   `importDxf(text, filename)` parses the ENTITIES section group-code by
 *   group-code, maps LINE/LWPOLYLINE/POLYLINE/CIRCLE/ARC/POINT to HektikCad
 *   entities (minus the `id`/`layer` fields, which the importer assigns),
 *   counts and reports skipped TEXT/HATCH/INSERT/SPLINE.
 */

import type { ImportResult } from '../types';

export function importDxf(_text: string, _filename: string): ImportResult {
  throw new Error('importDxf: not yet implemented (Phase 9)');
}
