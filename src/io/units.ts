/**
 * Unit conversions and paper-size constants for the I/O subsystem.
 *
 * HektikCad stores all world coordinates in millimetres. Exporters convert
 * to the format's native unit (PDF/EPS → points, DXF → mm). Importers
 * convert back to mm before entities reach the state.
 */

export const MM_PER_PT   = 0.352777778;    // 1pt = 0.352778mm
export const PT_PER_MM   = 2.834645669;    // 1mm = 2.834645pt
export const MM_PER_INCH = 25.4;

export function mmToPt(mm: number): number { return mm * PT_PER_MM; }
export function ptToMm(pt: number): number { return pt * MM_PER_PT; }

/** World-mm bounding-box. Matches the SPEC_TEMPLATES `Bbox` shape. */
export type Bbox = {
  x: number;       // min-X in mm
  y: number;       // min-Y in mm
  width: number;   // mm
  height: number;  // mm
};

/** ISO A-series paper sizes, in millimetres (portrait: w < h). */
export const PAPER_SIZES = {
  A4: { w: 210,  h: 297 },
  A3: { w: 297,  h: 420 },
  A2: { w: 420,  h: 594 },
  A1: { w: 594,  h: 841 },
  A0: { w: 841,  h: 1189 },
} as const;

export type PaperFormat = keyof typeof PAPER_SIZES;
export type Orientation = 'portrait' | 'landscape';

/** Returns paper dimensions (in mm) for the given format + orientation. */
export function paperDims(fmt: PaperFormat, orient: Orientation): { w: number; h: number } {
  const s = PAPER_SIZES[fmt];
  return orient === 'landscape' ? { w: s.h, h: s.w } : { w: s.w, h: s.h };
}

/**
 * Map world-mm to paper-pt for a given scale denominator.
 *   paperPt = worldMm × (1 / scaleDenom) × PT_PER_MM
 *
 * Example: scale 1:50, world-line 1000mm → 1000 × (1/50) × 2.834645 = 56.69pt
 */
export function worldMmToPaperPt(worldMm: number, scaleDenom: number): number {
  return worldMm * (1 / scaleDenom) * PT_PER_MM;
}

/** Inverse of {@link worldMmToPaperPt} — for import-side scaling. */
export function paperPtToWorldMm(paperPt: number, scaleDenom: number): number {
  return paperPt * MM_PER_PT * scaleDenom;
}

/**
 * Auto-fit scale denominator: picks the "nicest" round scale where the bbox
 * still fits inside the usable area of the paper (90% fill).
 *
 * @param bbox          world bbox of drawing (mm)
 * @param paperMm       paper dimensions (mm)
 * @param titleBlockMm  title-block reserved area (mm) or null if no block
 */
export function computeAutoScaleDenom(
  bbox: Bbox,
  paperMm: { w: number; h: number },
  titleBlockMm: { w: number; h: number } | null,
): number {
  const margin = 5;  // 5mm border on each side
  const usable = {
    w: paperMm.w - 2 * margin,
    h: paperMm.h - 2 * margin - (titleBlockMm?.h ?? 0),
  };
  const fill = 0.9;
  const scaleFitW = (usable.w * fill) / Math.max(1e-6, bbox.width);
  const scaleFitH = (usable.h * fill) / Math.max(1e-6, bbox.height);
  const rawScale = Math.min(scaleFitW, scaleFitH);
  const rawDenom = 1 / Math.max(1e-9, rawScale);

  // Snap up to the next "nice" denominator.
  const nice = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000];
  for (const n of nice) if (n >= rawDenom) return n;
  return nice[nice.length - 1];
}

/**
 * `custom-1to1` paper size: bbox + symmetric margin on all sides, 1:1 scale.
 */
export function computeCustomPaperMm(bbox: Bbox, marginMm: number = 10): { w: number; h: number } {
  return {
    w: bbox.width  + 2 * marginMm,
    h: bbox.height + 2 * marginMm,
  };
}
