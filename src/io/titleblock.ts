/**
 * Title-block renderer + plot-frame helper.
 *
 * Pure(-ish) functions that paint onto a pdf-lib `PDFPage`. Pure in the
 * sense that the layout is data-driven: feed them the resolved template
 * and title-block data, they do the geometry. No hidden state, no closures
 * over mutable data — good for testability and for the future (user-
 * configurable title-block layout).
 *
 * Layout (matches SPEC_TEMPLATES.md, fixed for phase 1):
 *
 *   bottom-right block (180×40mm):
 *     ┌──────────────┬────────────────┬──────────────┐
 *     │              │  PROJEKT       │ FORMAT       │
 *     │              │  {name}        │ {fmt}        │
 *     │  LOGO        ├────────────────┼──────────────┤
 *     │  (40×40 mm)  │  ZEICHNUNG     │ MASSSTAB     │
 *     │              │  {title}       │ {scale}      │
 *     │              ├────────────────┼──────────────┤
 *     │              │  ZEICHN.-NR.   │ REVISION     │
 *     │              │  {nr}          │ {rev}        │
 *     │              ├────────────────┼──────────────┤
 *     │              │  AUTOR         │ DATUM        │
 *     │              │  {author}      │ {date}       │
 *     └──────────────┴────────────────┴──────────────┘
 *
 *   bottom-full variant (190×30mm, A4 portrait) stacks fields in two rows
 *   with logo on the far left (30×30mm).
 *
 * Typography: Helvetica (built into pdf-lib), labels 6pt, values 10pt bold.
 * Missing values render as "—" (em-dash) so labels stay meaningful.
 */

import {
  PDFDocument, PDFFont, PDFImage, PDFPage, StandardFonts, rgb,
} from 'pdf-lib';
import type { TitleBlockData } from '../types';
import type { ResolvedTemplate, TitleBlockPosition } from './templates';
import { PT_PER_MM } from './units';

// ────────────────────────────────────────────────────────────────────────────
// Plot frame
// ────────────────────────────────────────────────────────────────────────────

/**
 * Thin black rectangle 5mm inside the paper edge. Called by `exportPdf` only
 * for templates with `drawPlotFrame: true` (i.e. everything except
 * `custom-1to1`).
 */
export function drawPlotFrame(page: PDFPage, paperMm: { w: number; h: number }): void {
  const marginMm = 5;
  const mPt = marginMm * PT_PER_MM;
  const x0 = mPt, y0 = mPt;
  const x1 = (paperMm.w - marginMm) * PT_PER_MM;
  const y1 = (paperMm.h - marginMm) * PT_PER_MM;
  const thickness = 0.5; // 0.5pt black
  const black = rgb(0, 0, 0);
  page.drawLine({ start: { x: x0, y: y0 }, end: { x: x1, y: y0 }, thickness, color: black });
  page.drawLine({ start: { x: x1, y: y0 }, end: { x: x1, y: y1 }, thickness, color: black });
  page.drawLine({ start: { x: x1, y: y1 }, end: { x: x0, y: y1 }, thickness, color: black });
  page.drawLine({ start: { x: x0, y: y1 }, end: { x: x0, y: y0 }, thickness, color: black });
}

// ────────────────────────────────────────────────────────────────────────────
// Title block
// ────────────────────────────────────────────────────────────────────────────

/** Em-dash for blank fields — keeps column widths consistent. */
const DASH = '—';
/** Normalise field: empty/undefined → em-dash. */
function fv(v: string | undefined): string {
  const t = (v ?? '').trim();
  return t.length > 0 ? t : DASH;
}

/** Box coordinates in pt, Y-up from page bottom-left. */
type BoxPt = { x: number; y: number; w: number; h: number };

/** Turn a title-block position spec + paper into the block's bottom-left + size. */
function titleBlockBox(pos: TitleBlockPosition, paperMm: { w: number; h: number }): BoxPt | null {
  if (pos.kind === 'none') return null;
  if (pos.kind === 'bottom-right') {
    const x = (paperMm.w - pos.wMm - pos.marginMm) * PT_PER_MM;
    const y = pos.marginMm * PT_PER_MM;
    return { x, y, w: pos.wMm * PT_PER_MM, h: pos.hMm * PT_PER_MM };
  }
  // bottom-full — centre horizontally.
  const x = (paperMm.w - pos.wMm) / 2 * PT_PER_MM;
  const y = pos.marginMm * PT_PER_MM;
  return { x, y, w: pos.wMm * PT_PER_MM, h: pos.hMm * PT_PER_MM };
}

/**
 * Paint the title block. Returns void — caller handles errors on image embed.
 *
 * @param page   pdf-lib page to draw on.
 * @param doc    owning document (needed for font embedding).
 * @param rt     resolved template (provides paper size + auto-filled labels).
 * @param data   title-block fields.
 * @param logo   pre-embedded PDFImage for the logo cell, or undefined.
 */
export async function drawTitleBlock(
  page: PDFPage,
  doc: PDFDocument,
  rt: ResolvedTemplate,
  data: TitleBlockData,
  logo: PDFImage | undefined,
): Promise<void> {
  const box = titleBlockBox(rt.def.titleBlock, rt.paperMm);
  if (!box) return;

  const fontLabel = await doc.embedFont(StandardFonts.Helvetica);
  const fontValue = await doc.embedFont(StandardFonts.HelveticaBold);

  const black = rgb(0, 0, 0);
  const hair  = 0.5; // 0.5pt — all box borders

  // Outer border
  drawRect(page, box, hair, black);

  if (rt.def.titleBlock.kind === 'bottom-right') {
    drawBottomRight(page, box, data, fontLabel, fontValue, logo, hair, black);
  } else if (rt.def.titleBlock.kind === 'bottom-full') {
    drawBottomFull(page, box, data, fontLabel, fontValue, logo, hair, black);
  }

  // Optional company address under the block (bottom-right only — there's no
  // room under a bottom-full block, which already sits on the bottom margin).
  if (rt.def.titleBlock.kind === 'bottom-right' && data.companyAddress) {
    const lines = data.companyAddress.split(/\r?\n/).slice(0, 3);
    const addrFont = fontLabel;
    const size = 6; // 6pt, small and discreet
    const lineH = size * 1.2;
    const topY = box.y - 2; // 2pt below the block
    for (let i = 0; i < lines.length; i++) {
      page.drawText(lines[i], {
        x: box.x,
        y: topY - (i + 1) * lineH,
        size,
        font: addrFont,
        color: black,
      });
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Layout: bottom-right (A4/A3/A2 landscape)
// ────────────────────────────────────────────────────────────────────────────

function drawBottomRight(
  page: PDFPage,
  box: BoxPt,
  data: TitleBlockData,
  fLabel: PDFFont,
  fValue: PDFFont,
  logo: PDFImage | undefined,
  hair: number,
  black: ReturnType<typeof rgb>,
): void {
  // Column split: logo 40mm | left 90mm | right 50mm (adds to 180mm).
  const logoW = 40 * PT_PER_MM;
  const rightW = 50 * PT_PER_MM;
  const leftW = box.w - logoW - rightW;

  const colLogoX  = box.x;
  const colLeftX  = box.x + logoW;
  const colRightX = box.x + logoW + leftW;

  // Vertical dividers
  vLine(page, colLeftX,  box.y, box.y + box.h, hair, black);
  vLine(page, colRightX, box.y, box.y + box.h, hair, black);

  // Four rows on the right half (each 10mm)
  const rowH = box.h / 4;
  for (let r = 1; r < 4; r++) {
    hLine(page, colLeftX, box.x + box.w, box.y + r * rowH, hair, black);
  }

  // Logo
  if (logo) {
    placeLogo(page, logo, { x: colLogoX, y: box.y, w: logoW, h: box.h }, 4);
  }

  // Field table — 4 rows, each with a label/value on the left and right columns.
  const rows: Array<[string, string, string, string]> = [
    ['PROJEKT',        fv(data.projectName),   'FORMAT',   fv(data.format)],
    ['ZEICHNUNG',      fv(data.drawingTitle),  'MASSSTAB', fv(data.scale)],
    ['ZEICHNUNGS-NR.', fv(data.drawingNumber), 'REVISION', fv(data.revision)],
    ['AUTOR',          fv(data.author),        'DATUM',    fv(data.date)],
  ];

  for (let i = 0; i < 4; i++) {
    const rowY = box.y + box.h - (i + 1) * rowH;  // rows top-to-bottom in reading order
    const [lLabel, lVal, rLabel, rVal] = rows[i];
    drawCell(page, { x: colLeftX,  y: rowY, w: leftW,  h: rowH }, lLabel, lVal, fLabel, fValue, black);
    drawCell(page, { x: colRightX, y: rowY, w: rightW, h: rowH }, rLabel, rVal, fLabel, fValue, black);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Layout: bottom-full (A4 portrait auto-fit)
// ────────────────────────────────────────────────────────────────────────────

function drawBottomFull(
  page: PDFPage,
  box: BoxPt,
  data: TitleBlockData,
  fLabel: PDFFont,
  fValue: PDFFont,
  logo: PDFImage | undefined,
  hair: number,
  black: ReturnType<typeof rgb>,
): void {
  // 30×30mm logo on the far left, 160mm of field grid on the right. Two rows
  // of four cells each (8 fields fit but we only use 6 — pad with blanks).
  const logoW = 30 * PT_PER_MM;
  const gridW = box.w - logoW;
  const gridX = box.x + logoW;

  vLine(page, gridX, box.y, box.y + box.h, hair, black);

  // 2 rows × 4 columns
  const rowH = box.h / 2;
  const colW = gridW / 4;
  hLine(page, gridX, box.x + box.w, box.y + rowH, hair, black);
  for (let c = 1; c < 4; c++) {
    vLine(page, gridX + c * colW, box.y, box.y + box.h, hair, black);
  }

  if (logo) {
    placeLogo(page, logo, { x: box.x, y: box.y, w: logoW, h: box.h }, 3);
  }

  const cells: Array<[string, string]> = [
    ['PROJEKT',        fv(data.projectName)],
    ['ZEICHNUNG',      fv(data.drawingTitle)],
    ['FORMAT',         fv(data.format)],
    ['MASSSTAB',       fv(data.scale)],
    ['ZEICHNUNGS-NR.', fv(data.drawingNumber)],
    ['AUTOR',          fv(data.author)],
    ['REVISION',       fv(data.revision)],
    ['DATUM',          fv(data.date)],
  ];

  for (let i = 0; i < cells.length; i++) {
    const col = i % 4;
    const row = Math.floor(i / 4);  // 0 = top row
    const cellX = gridX + col * colW;
    const cellY = box.y + (1 - row) * rowH;  // y is from bottom; row 0 → top
    drawCell(page, { x: cellX, y: cellY, w: colW, h: rowH }, cells[i][0], cells[i][1], fLabel, fValue, black);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Cell drawing primitives
// ────────────────────────────────────────────────────────────────────────────

/**
 * One label+value cell. `box.y` is the bottom of the cell (Y-up). Label sits
 * 2mm from the top-left; value sits 2mm under the label, 1pt below baseline.
 */
function drawCell(
  page: PDFPage,
  box: BoxPt,
  label: string,
  value: string,
  fLabel: PDFFont,
  fValue: PDFFont,
  black: ReturnType<typeof rgb>,
): void {
  const padX = 1.5 * PT_PER_MM;
  const labelSize = 6;
  const valueSize = 10;

  // Label — 1.5mm from left edge, ~2mm down from top
  const labelY = box.y + box.h - 2 * PT_PER_MM - labelSize * 0.8;
  page.drawText(label, {
    x: box.x + padX,
    y: labelY,
    size: labelSize,
    font: fLabel,
    color: black,
  });

  // Value — truncated to fit the cell width. pdf-lib won't auto-truncate;
  // measure with the font and trim char-by-char until it fits.
  const availW = box.w - 2 * padX;
  const fitted = fitText(value, fValue, valueSize, availW);
  const valueY = box.y + 2 * PT_PER_MM;
  page.drawText(fitted, {
    x: box.x + padX,
    y: valueY,
    size: valueSize,
    font: fValue,
    color: black,
  });
}

/**
 * Truncate `text` so that its rendered width (in `font` at `size`) fits
 * within `maxWidth` pt. Adds an ellipsis when trimmed.
 */
function fitText(text: string, font: PDFFont, size: number, maxWidth: number): string {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  const ellipsis = '…';
  // Binary-search for the longest fitting prefix.
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    const candidate = text.slice(0, mid) + ellipsis;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? text.slice(0, lo) + ellipsis : ellipsis;
}

/**
 * Centre a logo inside its cell with uniform-scale fitting + `padMm` breathing
 * room. Works for any aspect ratio.
 */
function placeLogo(page: PDFPage, img: PDFImage, cell: BoxPt, padMm: number): void {
  const padPt = padMm * PT_PER_MM;
  const availW = cell.w - 2 * padPt;
  const availH = cell.h - 2 * padPt;
  const natW = img.width;
  const natH = img.height;
  const scale = Math.min(availW / natW, availH / natH);
  const drawW = natW * scale;
  const drawH = natH * scale;
  page.drawImage(img, {
    x: cell.x + (cell.w - drawW) / 2,
    y: cell.y + (cell.h - drawH) / 2,
    width: drawW,
    height: drawH,
  });
}

/** Outer rectangle border, 4 lines. */
function drawRect(page: PDFPage, box: BoxPt, thickness: number, color: ReturnType<typeof rgb>): void {
  const x0 = box.x, y0 = box.y, x1 = box.x + box.w, y1 = box.y + box.h;
  page.drawLine({ start: { x: x0, y: y0 }, end: { x: x1, y: y0 }, thickness, color });
  page.drawLine({ start: { x: x1, y: y0 }, end: { x: x1, y: y1 }, thickness, color });
  page.drawLine({ start: { x: x1, y: y1 }, end: { x: x0, y: y1 }, thickness, color });
  page.drawLine({ start: { x: x0, y: y1 }, end: { x: x0, y: y0 }, thickness, color });
}
function hLine(page: PDFPage, x0: number, x1: number, y: number, thickness: number, color: ReturnType<typeof rgb>): void {
  page.drawLine({ start: { x: x0, y }, end: { x: x1, y }, thickness, color });
}
function vLine(page: PDFPage, x: number, y0: number, y1: number, thickness: number, color: ReturnType<typeof rgb>): void {
  page.drawLine({ start: { x, y: y0 }, end: { x, y: y1 }, thickness, color });
}
