/**
 * Central DOM refs. This module is imported by other modules and its lookups
 * run at module load. With Vite's `type="module"` script tag (at the end of
 * the body), the DOM is already parsed when this runs.
 */

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`DOM element #${id} not found`);
  return el as T;
};

export const dom = {
  cv: $<HTMLCanvasElement>('cv'),
  cmdFields: $<HTMLDivElement>('cmd-fields'),
  cmdPrompt: $('cmd-prompt'),
  stPos: $('st-pos'),
  stZoom: $('st-zoom'),
  stMeas: $('st-meas'),
  stTool: $('st-tool'),
  stSel: $('st-sel'),
  stTip: $('st-tip'),
  stats: $('stats'),
  layersEl: $('layers'),
  paramsEl: $('parameters'),
  timelineEl: $('timeline'),
  propsEl: $('props'),
  toastEl: $('toast'),
  toolsPanel: $('tools'),
} as const;

const ctx2d = dom.cv.getContext('2d');
if (!ctx2d) throw new Error('2D canvas context not available');
export const ctx: CanvasRenderingContext2D = ctx2d;
