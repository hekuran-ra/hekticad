/**
 * Bemaßungsstil — global end-cap style for dimension entities.
 *
 * Four styles, inline SVG preview for each:
 *   - arrow   filled triangle         (default)
 *   - open    two-stroke V            (minimalist)
 *   - tick    45° cross               (architectural short dash)
 *   - arch    one-sided + dot         (Swiss/DIN architectural)
 *
 * The selection is committed on OK (Cancel discards). `applyDimStyle()` also
 * patches any selected dim features so existing dims repaint immediately —
 * matches the old on-canvas picker's "edit as you click" feel, just without
 * the permanent HUD clutter.
 *
 * This is a document-wide setting, not a per-dim property, so Format menu is
 * the right home for it — it stays out of the way until the user wants to
 * tweak the drawing's appearance.
 */

import { openModal } from '../modal';
import { runtime, saveDimStyle } from '../state';
import type { DimStyle } from '../types';
import { applyDimStyle, toast } from '../ui';

type Option = {
  style: DimStyle;
  label: string;
  /** Inline SVG, 80×20 viewBox, drawn in currentColor. The dim "body" is a
   *  horizontal rule centred vertically; the end-caps sit on the left and
   *  right tips so both sides are visible simultaneously. */
  svg: string;
};

const ARROW_SVG = `
  <svg viewBox="0 0 80 20" class="dim-style-preview" aria-hidden="true">
    <line x1="8" y1="10" x2="72" y2="10" stroke="currentColor" stroke-width="1.2"/>
    <polygon points="8,10 16,6.5 16,13.5" fill="currentColor"/>
    <polygon points="72,10 64,6.5 64,13.5" fill="currentColor"/>
  </svg>`;
const OPEN_SVG = `
  <svg viewBox="0 0 80 20" class="dim-style-preview" aria-hidden="true">
    <line x1="8" y1="10" x2="72" y2="10" stroke="currentColor" stroke-width="1.2"/>
    <polyline points="18,5 8,10 18,15" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
    <polyline points="62,5 72,10 62,15" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
const TICK_SVG = `
  <svg viewBox="0 0 80 20" class="dim-style-preview" aria-hidden="true">
    <line x1="8" y1="10" x2="72" y2="10" stroke="currentColor" stroke-width="1.2"/>
    <line x1="4" y1="15" x2="12" y2="5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
    <line x1="68" y1="15" x2="76" y2="5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
  </svg>`;
const ARCH_SVG = `
  <svg viewBox="0 0 80 20" class="dim-style-preview" aria-hidden="true">
    <line x1="8" y1="10" x2="72" y2="10" stroke="currentColor" stroke-width="1.2"/>
    <line x1="16" y1="6" x2="8" y2="10" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
    <circle cx="8" cy="10" r="1.6" fill="currentColor"/>
    <line x1="64" y1="6" x2="72" y2="10" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
    <circle cx="72" cy="10" r="1.6" fill="currentColor"/>
  </svg>`;

const OPTIONS: readonly Option[] = [
  { style: 'arrow', label: 'Pfeil',          svg: ARROW_SVG },
  { style: 'open',  label: 'Offen',          svg: OPEN_SVG  },
  { style: 'tick',  label: 'Architektur',    svg: TICK_SVG  },
  { style: 'arch',  label: 'Punkt',          svg: ARCH_SVG  },
];

export async function showDimStyleDialog(): Promise<void> {
  let picked: DimStyle = runtime.dimStyle;

  const result = await openModal((close) => buildPanel(picked, (s) => { picked = s; }, close));
  if (result !== 'ok') return;

  if (picked !== runtime.dimStyle) {
    applyDimStyle(picked);
    saveDimStyle(picked);
    toast('Bemaßungsstil aktualisiert');
  }
}

function buildPanel(
  initial: DimStyle,
  onPick: (s: DimStyle) => void,
  close: (reason: 'ok' | 'cancel') => void,
): HTMLElement {
  const panel = document.createElement('div');
  panel.classList.add('hk-modal-company');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-labelledby', 'hk-dimstyle-title');

  // ── Header ──
  const head = document.createElement('div');
  head.className = 'hk-modal-head';
  const title = document.createElement('div');
  title.className = 'hk-modal-title';
  title.id = 'hk-dimstyle-title';
  title.textContent = 'Bemaßungsstil';
  head.appendChild(title);
  const msg = document.createElement('div');
  msg.className = 'hk-modal-msg';
  msg.textContent = 'Die Endpunkt-Markierung gilt für alle Bemaßungen der Zeichnung.';
  head.appendChild(msg);
  panel.appendChild(head);

  // ── Body ──
  const body = document.createElement('div');
  body.className = 'hk-modal-body hk-export-body';

  const grid = document.createElement('div');
  grid.className = 'dim-style-dialog-grid';

  let current: DimStyle = initial;
  const buttons: HTMLButtonElement[] = [];

  for (const opt of OPTIONS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dim-style-option';
    btn.dataset.style = opt.style;
    btn.innerHTML = `${opt.svg}<span class="dim-style-label">${opt.label}</span>`;
    btn.addEventListener('click', () => {
      current = opt.style;
      onPick(current);
      syncOn();
    });
    grid.appendChild(btn);
    buttons.push(btn);
  }

  const syncOn = (): void => {
    for (const b of buttons) {
      b.classList.toggle('on', b.dataset.style === current);
    }
  };
  syncOn();

  body.appendChild(grid);
  panel.appendChild(body);

  // ── Footer ──
  const actions = document.createElement('div');
  actions.className = 'hk-modal-actions';
  const cancel = mkBtn('Abbrechen', 'secondary', () => close('cancel'));
  const ok = mkBtn('Übernehmen', 'primary', () => close('ok'));
  actions.append(cancel, ok);
  panel.appendChild(actions);

  return panel;
}

function mkBtn(label: string, variant: 'primary' | 'secondary', onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `hk-modal-btn hk-modal-btn-${variant}`;
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}
