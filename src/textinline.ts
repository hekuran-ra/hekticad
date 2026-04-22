/**
 * Inline text editor. A single, unified flow: every text is a framed text.
 *
 * Visually the editor IS the frame — a dashed, accent-coloured border that
 * matches the selection grips the user sees on an already-placed text. This
 * way there's one mental model: place a frame, type into it, resize via
 * grips later.
 *
 * A compact pill toolbar floats above the frame showing the current height
 * and a hint. The toolbar is deliberately small and muted so the user's eye
 * stays on the text they're typing; size changes are usually a detail, not
 * the main action.
 *
 * Keyboard:
 *   - plain Enter     → newline (normal editor behaviour)
 *   - Ctrl/Cmd+Enter  → commit
 *   - Ctrl/Cmd+↑ / ↓  → nudge height by 0.5 mm
 *   - Escape          → cancel
 *   - right-click on the canvas / blur → commit (handled from main.ts)
 */

import { state } from './state';
import { worldToScreen } from './math';
import { dom } from './dom';

export type InlineTextOpts = {
  /** Top-left corner of the text frame, in world coords. */
  worldAnchor: { x: number; y: number };
  initialText?: string;
  /** Text height in world-mm. */
  initialHeight: number;
  /** Frame width in world-mm. Required — every text has a frame. */
  boxWidth: number;
};

export type InlineTextResult = { text: string; height: number };

type ActiveEditor = { commit: () => void; cancel: () => void };
let currentEditor: ActiveEditor | null = null;

export function isInlineTextOpen(): boolean {
  return currentEditor !== null;
}
export function commitInlineTextIfOpen(): void {
  currentEditor?.commit();
}
export function cancelInlineTextIfOpen(): void {
  currentEditor?.cancel();
}

export function showInlineTextEditor(opts: InlineTextOpts): Promise<InlineTextResult | null> {
  // If a previous editor is still open, commit it before starting a new one.
  currentEditor?.commit();

  return new Promise((resolve) => {
    const wrapper = document.createElement('div');
    wrapper.className = 'hk-inlinetext';

    // ── Floating pill toolbar ─────────────────────────────────────────────
    const toolbar = document.createElement('div');
    toolbar.className = 'hk-inlinetext-toolbar';

    const sizeLabel = document.createElement('span');
    sizeLabel.className = 'hk-inlinetext-label';
    sizeLabel.textContent = 'H';

    const sizeInput = document.createElement('input');
    sizeInput.type = 'number';
    sizeInput.className = 'hk-inlinetext-size';
    sizeInput.step = '0.5';
    sizeInput.min = '0.1';
    sizeInput.value = opts.initialHeight.toString();
    sizeInput.title = 'Texthöhe in mm · Strg+↑/↓ zum Ändern';

    const sizeUnit = document.createElement('span');
    sizeUnit.className = 'hk-inlinetext-unit';
    sizeUnit.textContent = 'mm';

    const divider = document.createElement('span');
    divider.className = 'hk-inlinetext-divider';

    const hint = document.createElement('span');
    hint.className = 'hk-inlinetext-hint';
    hint.textContent = 'Rechtsklick bestätigt · Esc bricht ab';

    toolbar.append(sizeLabel, sizeInput, sizeUnit, divider, hint);

    // ── Textarea (the frame) ──────────────────────────────────────────────
    const textarea = document.createElement('textarea');
    textarea.className = 'hk-inlinetext-area';
    textarea.value = opts.initialText ?? '';
    textarea.spellcheck = false;
    textarea.rows = 1;
    textarea.placeholder = 'Text eingeben…';
    // Native right-click context menu would compete with our canvas handler.
    textarea.addEventListener('contextmenu', (ev) => ev.preventDefault());

    wrapper.append(toolbar, textarea);
    document.body.appendChild(wrapper);

    // ── Geometry ───────────────────────────────────────────────────────────
    /** Recompute font, width, height, and position — called on every input,
     *  zoom change, and window resize so the editor stays visually aligned
     *  with where the text will eventually render. */
    const applyGeometry = (): void => {
      const h = parseFloat(sizeInput.value.replace(',', '.'));
      const heightMm = isFinite(h) && h > 0 ? h : opts.initialHeight;
      const pxPerMm = state.view.scale;
      const fontPx = Math.max(6, heightMm * pxPerMm);
      // Match the on-canvas line spacing (LINE_SPACING = 1.2 in textlayout.ts).
      const lineHeightPx = fontPx * 1.2;
      // Frame width in screen px. Guard against microscopic widths so the
      // textarea is still usable when the user drags a nearly-empty frame.
      const wPx = Math.max(60, opts.boxWidth * pxPerMm);

      textarea.style.fontSize = `${fontPx}px`;
      textarea.style.lineHeight = `${lineHeightPx}px`;
      textarea.style.width = `${wPx}px`;

      // Auto-grow vertically. min = one line so the frame is visible even
      // when empty.
      textarea.style.height = 'auto';
      const targetH = Math.max(lineHeightPx, textarea.scrollHeight);
      textarea.style.height = `${targetH}px`;

      // Position in page coords. Canvas rect is viewport-relative, so add
      // scroll offsets for correctness on scrolled pages.
      const screenAnchor = worldToScreen(opts.worldAnchor);
      const canvasRect = dom.cv.getBoundingClientRect();
      const pageX = canvasRect.left + window.scrollX + screenAnchor.x;
      const pageY = canvasRect.top + window.scrollY + screenAnchor.y;

      // Wrapper top = top of the toolbar. Textarea starts below the toolbar
      // and should align with the world anchor, so subtract the toolbar's
      // rendered height (includes gap from `margin-bottom` in CSS).
      const toolbarH = toolbar.getBoundingClientRect().height;
      wrapper.style.left = `${pageX}px`;
      wrapper.style.top = `${pageY - toolbarH}px`;
    };

    textarea.addEventListener('input', applyGeometry);
    sizeInput.addEventListener('input', applyGeometry);
    // Enter in the size input is a quick re-apply and a focus jump back to
    // the text — it should never commit (that's Ctrl+Enter's job) since a
    // user in the middle of editing the size hasn't necessarily finished the
    // text.
    sizeInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        applyGeometry();
        textarea.focus();
      }
    });

    // ── Commit / cancel ────────────────────────────────────────────────────
    let settled = false;
    const cleanup = (): void => {
      settled = true;
      wrapper.remove();
      currentEditor = null;
      window.removeEventListener('resize', applyGeometry);
      document.removeEventListener('keydown', onKey, true);
    };
    const commit = (): void => {
      if (settled) return;
      const text = textarea.value;
      const h = parseFloat(sizeInput.value.replace(',', '.'));
      if (!text.trim() || !isFinite(h) || h <= 0) {
        cleanup();
        resolve(null);
        return;
      }
      cleanup();
      resolve({ text, height: h });
    };
    const cancel = (): void => {
      if (settled) return;
      cleanup();
      resolve(null);
    };

    /** Capture-phase so Escape beats main.ts's global handler. */
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        cancel();
        return;
      }
      if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
        ev.preventDefault();
        ev.stopPropagation();
        commit();
        return;
      }
      // Ctrl/Cmd+Arrow to nudge size. Only when the textarea is focused; the
      // size input has its own arrow-key spinner semantics.
      if ((ev.ctrlKey || ev.metaKey) &&
          (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') &&
          document.activeElement === textarea) {
        ev.preventDefault();
        const cur = parseFloat(sizeInput.value.replace(',', '.'));
        const step = ev.key === 'ArrowUp' ? 0.5 : -0.5;
        const next = Math.max(0.1, (isFinite(cur) ? cur : opts.initialHeight) + step);
        sizeInput.value = (Math.round(next * 10) / 10).toString();
        applyGeometry();
      }
    };
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', applyGeometry);

    // Blur-to-commit, deferred so focus can settle on the size input without
    // closing the editor.
    textarea.addEventListener('blur', () => {
      setTimeout(() => {
        if (settled) return;
        const active = document.activeElement;
        if (active && wrapper.contains(active)) return;
        commit();
      }, 0);
    });

    currentEditor = { commit, cancel };

    requestAnimationFrame(() => {
      applyGeometry();
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    });
  });
}
