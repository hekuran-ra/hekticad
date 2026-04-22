/**
 * PDF template definitions.
 *
 * A template is a pure description — paper size, orientation, scale mode,
 * title-block position. The PDF export consumes a `ResolvedTemplate` produced
 * from these defs plus the drawing bbox. `custom-1to1` is the special case
 * with `scaleMode: 'one-to-one'` and no title block / plot frame.
 */

import type { PdfTemplateId } from '../types';
import {
  computeAutoScaleDenom,
  computeCustomPaperMm,
  paperDims,
  type Bbox,
  type Orientation,
  type PaperFormat,
} from './units';

/** Where the title block sits on the page. */
export type TitleBlockPosition =
  | { kind: 'bottom-right'; wMm: number; hMm: number; marginMm: number }
  | { kind: 'bottom-full';  wMm: number; hMm: number; marginMm: number }
  | { kind: 'none' };

export type TemplateDef = {
  id: PdfTemplateId;
  label: string;  // human-readable, shown in the export dialog
  /** 'custom' means the paper size is derived from bbox + margin. */
  paper: PaperFormat | 'custom';
  orientation: Orientation | 'auto';
  /** 'fixed' = scaleDenom is hard-coded; 'auto' = fit bbox to usable area; 'one-to-one' = no scaling. */
  scaleMode: 'fixed' | 'auto' | 'one-to-one';
  scaleDenom?: number;  // only used when scaleMode === 'fixed'
  titleBlock: TitleBlockPosition;
  /** Thin rectangle around the usable area, 5mm inside the paper edge. */
  drawPlotFrame: boolean;
};

/**
 * Template table. Positions and dimensions match SPEC_TEMPLATES.md — keep
 * this file thin (no rendering code here); the PDF exporter does all geometry.
 */
export const TEMPLATES: Record<PdfTemplateId, TemplateDef> = {
  'a4-landscape-1to50': {
    id: 'a4-landscape-1to50',
    label: 'A4 Querformat 1:50',
    paper: 'A4',
    orientation: 'landscape',
    scaleMode: 'fixed',
    scaleDenom: 50,
    titleBlock: { kind: 'bottom-right', wMm: 180, hMm: 40, marginMm: 5 },
    drawPlotFrame: true,
  },
  'a4-landscape-1to100': {
    id: 'a4-landscape-1to100',
    label: 'A4 Querformat 1:100',
    paper: 'A4',
    orientation: 'landscape',
    scaleMode: 'fixed',
    scaleDenom: 100,
    titleBlock: { kind: 'bottom-right', wMm: 180, hMm: 40, marginMm: 5 },
    drawPlotFrame: true,
  },
  'a4-portrait-fit': {
    id: 'a4-portrait-fit',
    label: 'A4 Hochformat einpassen',
    paper: 'A4',
    orientation: 'portrait',
    scaleMode: 'auto',
    titleBlock: { kind: 'bottom-full', wMm: 190, hMm: 30, marginMm: 5 },
    drawPlotFrame: true,
  },
  'a3-landscape-1to50': {
    id: 'a3-landscape-1to50',
    label: 'A3 Querformat 1:50',
    paper: 'A3',
    orientation: 'landscape',
    scaleMode: 'fixed',
    scaleDenom: 50,
    titleBlock: { kind: 'bottom-right', wMm: 180, hMm: 40, marginMm: 5 },
    drawPlotFrame: true,
  },
  'a3-landscape-1to100': {
    id: 'a3-landscape-1to100',
    label: 'A3 Querformat 1:100',
    paper: 'A3',
    orientation: 'landscape',
    scaleMode: 'fixed',
    scaleDenom: 100,
    titleBlock: { kind: 'bottom-right', wMm: 180, hMm: 40, marginMm: 5 },
    drawPlotFrame: true,
  },
  'a2-landscape-1to50': {
    id: 'a2-landscape-1to50',
    label: 'A2 Querformat 1:50',
    paper: 'A2',
    orientation: 'landscape',
    scaleMode: 'fixed',
    scaleDenom: 50,
    titleBlock: { kind: 'bottom-right', wMm: 180, hMm: 40, marginMm: 5 },
    drawPlotFrame: true,
  },
  'custom-1to1': {
    id: 'custom-1to1',
    label: '1:1 ohne Vorlage',
    paper: 'custom',
    orientation: 'auto',
    scaleMode: 'one-to-one',
    titleBlock: { kind: 'none' },
    drawPlotFrame: false,
  },
};

/**
 * The concrete numbers a template resolves to once the drawing bbox is
 * known. Everything the PDF exporter needs to place geometry.
 */
export type ResolvedTemplate = {
  def: TemplateDef;
  paperMm: { w: number; h: number };
  scaleDenom: number;
  /** Where world(0,0) maps to on the page, in mm, measured from page bottom-left
   *  (matches PDF's Y-up convention). Centres the drawing inside the usable area. */
  originMm: { x: number; y: number };
  /** Human-readable strings derived for the title-block auto-fields. */
  formatLabel: string;  // e.g. "A3 Querformat"
  scaleLabel: string;   // e.g. "1:50" / "1:1"
};

/**
 * Turn a `TemplateDef` + drawing bbox into concrete numbers:
 *   - paper dimensions
 *   - scale denominator (fixed / fit-computed / 1)
 *   - world-to-page origin offset so the drawing sits inside the usable area
 */
export function resolveTemplate(def: TemplateDef, bbox: Bbox): ResolvedTemplate {
  // Paper size
  let paperMm: { w: number; h: number };
  if (def.paper === 'custom') {
    paperMm = computeCustomPaperMm(bbox, 10);
  } else {
    // 'auto' orientation falls back to portrait for template-driven cases;
    // templates only use 'auto' together with scaleMode === 'one-to-one'.
    const orient = def.orientation === 'auto' ? 'portrait' : def.orientation;
    paperMm = paperDims(def.paper, orient);
  }

  // Title block footprint (for scale auto-fit and origin math)
  const tb = def.titleBlock;
  const tbFootprint = tb.kind === 'none'
    ? null
    : { w: tb.wMm, h: tb.hMm + tb.marginMm };

  // Scale
  let scaleDenom: number;
  if (def.scaleMode === 'one-to-one')    scaleDenom = 1;
  else if (def.scaleMode === 'fixed')    scaleDenom = def.scaleDenom ?? 1;
  else                                   scaleDenom = computeAutoScaleDenom(bbox, paperMm, tbFootprint);

  // Usable area: paper minus 5mm margin on all sides minus title-block footprint.
  const margin = 5;
  const usable = {
    x: margin,
    y: margin + (tb.kind === 'bottom-full' || tb.kind === 'bottom-right' ? tb.hMm + tb.marginMm : 0),
    w: paperMm.w - 2 * margin,
    h: paperMm.h - 2 * margin - (tb.kind === 'bottom-full' || tb.kind === 'bottom-right' ? tb.hMm + tb.marginMm : 0),
  };

  // Drawing size on paper (world-mm × 1/scaleDenom)
  const drawnW = bbox.width  / scaleDenom;
  const drawnH = bbox.height / scaleDenom;

  // Center drawing in usable area; originMm is page position for world (0,0).
  // Template uses Y-up (PDF convention), so positive Y = up.
  const originMm = {
    x: usable.x + (usable.w - drawnW) / 2 - bbox.x / scaleDenom,
    y: usable.y + (usable.h - drawnH) / 2 - bbox.y / scaleDenom,
  };

  // Labels
  const orientLabel = def.orientation === 'landscape' ? 'Querformat'
                   : def.orientation === 'portrait'  ? 'Hochformat'
                   : '';
  const formatLabel = def.paper === 'custom'
    ? 'Individuell'
    : `${def.paper}${orientLabel ? ' ' + orientLabel : ''}`;
  const scaleLabel  = `1:${scaleDenom}`;

  return { def, paperMm, scaleDenom, originMm, formatLabel, scaleLabel };
}
