/**
 * In-app replacement for `window.alert / confirm / prompt`.
 *
 * Why: native browser dialogs break our theme, steal OS focus, and (in some
 * browsers) block the event loop in ways that clash with canvas interaction.
 * The three helpers below return Promises so callers can `await` them.
 *
 *   await showAlert({ title, message })        → void
 *   await showConfirm({ title, message })      → boolean
 *   await showPrompt({ title, message, ... })  → string | null   (null = cancel)
 *
 * Keyboard: Escape = cancel, Enter = confirm (default action).
 * Backdrop click also cancels.
 * Only one modal is visible at a time — if a second is requested while one is
 * open, the queued call waits for its turn.
 *
 * The root element is created on demand and appended to <body>; styles live in
 * styles.css under `.hk-modal*`.
 */

let rootEl: HTMLDivElement | null = null;
let activeClose: (() => void) | null = null;
let queue: Array<() => void> = [];

/** True while any modal is on screen. Checked by global keyboard handlers so
 *  they don't steal keystrokes from the modal's input. */
export function isModalOpen(): boolean {
  return activeClose !== null;
}

function ensureRoot(): HTMLDivElement {
  if (rootEl) return rootEl;
  const el = document.createElement('div');
  el.className = 'hk-modal-root';
  el.hidden = true;
  document.body.appendChild(el);
  rootEl = el;
  return el;
}

/**
 * Serialize modal presentation: subsequent openModal calls wait their turn.
 *
 * Exported so callers with richer UI (the export dialog, import preview)
 * can build their own panel body while still reusing the backdrop / focus /
 * keyboard / queue plumbing defined here.
 */
export function openModal(build: (close: (reason: 'ok' | 'cancel') => void) => HTMLElement): Promise<'ok' | 'cancel'> {
  return new Promise((resolve) => {
    const start = (): void => {
      const root = ensureRoot();
      root.innerHTML = '';
      root.hidden = false;

      const previouslyFocused = document.activeElement as HTMLElement | null;

      const backdrop = document.createElement('div');
      backdrop.className = 'hk-modal-backdrop';
      backdrop.addEventListener('mousedown', (ev) => {
        if (ev.target === backdrop) close('cancel');
      });

      let closed = false;
      const close = (reason: 'ok' | 'cancel'): void => {
        if (closed) return;
        closed = true;
        document.removeEventListener('keydown', onKey, true);
        root.hidden = true;
        root.innerHTML = '';
        activeClose = null;
        // Restore focus so keyboard workflows aren't disrupted.
        if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
          try { previouslyFocused.focus(); } catch { /* noop */ }
        }
        resolve(reason);
        // Kick the next queued modal, if any.
        const next = queue.shift();
        if (next) next();
      };

      activeClose = () => close('cancel');

      const panel = build(close);
      panel.classList.add('hk-modal');
      backdrop.appendChild(panel);
      root.appendChild(backdrop);

      // Global keyboard: Escape cancels from anywhere. Enter is handled by the
      // focused element (input → commit; button → click), so no global Enter.
      const onKey = (ev: KeyboardEvent): void => {
        if (ev.key === 'Escape') {
          ev.preventDefault();
          ev.stopPropagation();
          close('cancel');
        }
      };
      document.addEventListener('keydown', onKey, true);
    };

    if (activeClose) queue.push(start);
    else start();
  });
}

// ---------------------------------------------------------------------------
// Button helpers
// ---------------------------------------------------------------------------

function mkBtn(label: string, variant: 'primary' | 'secondary' | 'danger', onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `hk-modal-btn hk-modal-btn-${variant}`;
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function mkHead(titleText: string, messageText?: string): HTMLElement {
  const head = document.createElement('div');
  head.className = 'hk-modal-head';
  const title = document.createElement('div');
  title.className = 'hk-modal-title';
  title.textContent = titleText;
  head.appendChild(title);
  if (messageText) {
    const msg = document.createElement('div');
    msg.className = 'hk-modal-msg';
    msg.textContent = messageText;
    head.appendChild(msg);
  }
  return head;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type AlertOpts = {
  title: string;
  message?: string;
  okText?: string;
};

export async function showAlert(opts: AlertOpts): Promise<void> {
  await openModal((close) => {
    const panel = document.createElement('div');
    panel.appendChild(mkHead(opts.title, opts.message));

    const actions = document.createElement('div');
    actions.className = 'hk-modal-actions';
    const ok = mkBtn(opts.okText ?? 'OK', 'primary', () => close('ok'));
    actions.appendChild(ok);
    panel.appendChild(actions);

    // Focus OK so Enter commits.
    queueMicrotask(() => ok.focus());
    return panel;
  });
}

export type ConfirmOpts = {
  title: string;
  message?: string;
  okText?: string;
  cancelText?: string;
  /** Renders OK as a red button — use for destructive actions. */
  danger?: boolean;
};

export async function showConfirm(opts: ConfirmOpts): Promise<boolean> {
  const reason = await openModal((close) => {
    const panel = document.createElement('div');
    panel.appendChild(mkHead(opts.title, opts.message));

    const actions = document.createElement('div');
    actions.className = 'hk-modal-actions';
    const cancel = mkBtn(opts.cancelText ?? 'Abbrechen', 'secondary', () => close('cancel'));
    const ok = mkBtn(opts.okText ?? 'OK', opts.danger ? 'danger' : 'primary', () => close('ok'));
    actions.append(cancel, ok);
    panel.appendChild(actions);

    queueMicrotask(() => ok.focus());
    return panel;
  });
  return reason === 'ok';
}

/**
 * Three-way choice for the "unsaved changes?" flow on app close. Returns:
 *   - 'save'    → user asked to save, caller should run the save flow
 *   - 'discard' → user asked to close without saving
 *   - 'cancel'  → user dismissed the prompt, caller should NOT close
 *
 * `openModal` only knows about 'ok' and 'cancel' reasons, so we stash the
 * outcome in a closure variable and always resolve with `'ok'` from the
 * three non-cancel branches. `Escape` / backdrop-click still close with
 * `'cancel'`, which we map to `'cancel'` here too.
 */
export type UnsavedChangesOpts = {
  title: string;
  message?: string;
  saveText?: string;
  discardText?: string;
  cancelText?: string;
};

export async function showUnsavedChangesPrompt(
  opts: UnsavedChangesOpts,
): Promise<'save' | 'discard' | 'cancel'> {
  let outcome: 'save' | 'discard' | 'cancel' = 'cancel';
  const reason = await openModal((close) => {
    const panel = document.createElement('div');
    panel.appendChild(mkHead(opts.title, opts.message));

    const actions = document.createElement('div');
    actions.className = 'hk-modal-actions';
    // Order (left → right): Cancel / Discard / Save. Save is the default /
    // Enter-commits button because the safer default is "don't lose work".
    const cancel = mkBtn(opts.cancelText ?? 'Abbrechen', 'secondary',
      () => { outcome = 'cancel'; close('cancel'); });
    const discard = mkBtn(opts.discardText ?? 'Verwerfen', 'danger',
      () => { outcome = 'discard'; close('ok'); });
    const save = mkBtn(opts.saveText ?? 'Speichern', 'primary',
      () => { outcome = 'save'; close('ok'); });
    actions.append(cancel, discard, save);
    panel.appendChild(actions);

    queueMicrotask(() => save.focus());
    return panel;
  });
  // Backdrop-click / Escape routes through `close('cancel')` but doesn't
  // mutate `outcome`, so the default 'cancel' still applies here.
  if (reason === 'cancel') return 'cancel';
  return outcome;
}

export type PromptOpts = {
  title: string;
  message?: string;
  defaultValue?: string;
  placeholder?: string;
  okText?: string;
  cancelText?: string;
  /** Basic client-side validation. Return an error string to block commit. */
  validate?: (value: string) => string | null;
  /** Passed to the <input> — e.g. 'text' (default) or 'number'. */
  inputType?: string;
};

// ---------------------------------------------------------------------------
// Text editor — multi-line text + size, used for placing and editing text
// entities. Returns `{ text, height }` on OK, `null` on cancel.
// ---------------------------------------------------------------------------

export type TextEditorOpts = {
  title: string;
  text?: string;
  height?: number;
  okText?: string;
  cancelText?: string;
};

export type TextEditorResult = { text: string; height: number };

export async function showTextEditor(opts: TextEditorOpts): Promise<TextEditorResult | null> {
  let result: TextEditorResult | null = null;
  const reason = await openModal((close) => {
    const panel = document.createElement('div');
    panel.classList.add('hk-modal-text');
    panel.appendChild(mkHead(opts.title));

    const body = document.createElement('div');
    body.className = 'hk-modal-body';

    // Size toolbar above the textarea: label + numeric input + A-/A+ nudgers.
    // Kept compact so it reads as a single strip like a text-editor ribbon.
    const toolbar = document.createElement('div');
    toolbar.className = 'hk-texted-toolbar';

    const sizeWrap = document.createElement('label');
    sizeWrap.className = 'hk-texted-size';
    const sizeLabel = document.createElement('span');
    sizeLabel.textContent = 'Höhe';
    const sizeInput = document.createElement('input');
    sizeInput.type = 'number';
    sizeInput.className = 'hk-modal-input hk-texted-size-input';
    sizeInput.step = '0.1';
    sizeInput.min = '0.1';
    sizeInput.value = (opts.height ?? 5).toString();
    const sizeUnit = document.createElement('span');
    sizeUnit.className = 'hk-texted-unit';
    sizeUnit.textContent = 'mm';
    sizeWrap.append(sizeLabel, sizeInput, sizeUnit);

    const nudge = (delta: number): void => {
      const cur = parseFloat(sizeInput.value.replace(',', '.'));
      const next = Math.max(0.1, (isFinite(cur) ? cur : 5) + delta);
      sizeInput.value = (Math.round(next * 100) / 100).toString();
      updatePreview();
    };
    const mkSizeBtn = (label: string, delta: number): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'hk-texted-nudge';
      b.textContent = label;
      b.title = delta > 0 ? 'Vergrößern' : 'Verkleinern';
      b.addEventListener('click', () => nudge(delta));
      return b;
    };
    toolbar.append(mkSizeBtn('A−', -1), mkSizeBtn('A+', +1), sizeWrap);
    body.appendChild(toolbar);

    // Main textarea. `Enter` inserts newlines (like a normal editor);
    // Ctrl/Cmd+Enter commits — standard in Slack, GitHub, Discord etc.
    const textarea = document.createElement('textarea');
    textarea.className = 'hk-modal-input hk-texted-area';
    textarea.value = opts.text ?? '';
    textarea.spellcheck = false;
    textarea.rows = 6;
    textarea.placeholder = 'Text eingeben…';
    body.appendChild(textarea);

    // Live preview strip beneath the textarea. Mirrors content + font size so
    // the user sees roughly what the text will look like on the canvas.
    const preview = document.createElement('div');
    preview.className = 'hk-texted-preview';
    const previewLabel = document.createElement('span');
    previewLabel.className = 'hk-texted-preview-label';
    previewLabel.textContent = 'Vorschau';
    const previewText = document.createElement('div');
    previewText.className = 'hk-texted-preview-text';
    preview.append(previewLabel, previewText);
    body.appendChild(preview);

    const err = document.createElement('div');
    err.className = 'hk-modal-err';
    err.hidden = true;
    body.appendChild(err);

    panel.appendChild(body);

    const updatePreview = (): void => {
      previewText.textContent = textarea.value || '\u00A0';
      const h = parseFloat(sizeInput.value.replace(',', '.'));
      if (isFinite(h) && h > 0) {
        // Cap preview at a reasonable on-screen size so a 500mm height doesn't
        // blow the modal. The value stored is still the real one.
        const px = Math.max(10, Math.min(48, h * 4));
        previewText.style.fontSize = `${px}px`;
      }
    };
    textarea.addEventListener('input', updatePreview);
    sizeInput.addEventListener('input', updatePreview);
    updatePreview();

    const tryCommit = (): void => {
      const text = textarea.value;
      if (!text.trim()) {
        err.textContent = 'Text darf nicht leer sein';
        err.hidden = false;
        textarea.focus();
        return;
      }
      const h = parseFloat(sizeInput.value.replace(',', '.'));
      if (!isFinite(h) || h <= 0) {
        err.textContent = 'Höhe muss eine positive Zahl sein';
        err.hidden = false;
        sizeInput.focus();
        sizeInput.select();
        return;
      }
      result = { text, height: h };
      close('ok');
    };

    // Ctrl/Cmd+Enter in textarea commits; plain Enter inserts newline.
    textarea.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
        ev.preventDefault();
        ev.stopPropagation();
        tryCommit();
      }
    });
    // Plain Enter in the size input commits (single-value semantics there).
    sizeInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        ev.stopPropagation();
        tryCommit();
      }
    });

    const actions = document.createElement('div');
    actions.className = 'hk-modal-actions';
    const hint = document.createElement('span');
    hint.className = 'hk-texted-hint';
    hint.textContent = 'Strg+Enter bestätigt';
    const cancel = mkBtn(opts.cancelText ?? 'Abbrechen', 'secondary', () => close('cancel'));
    const ok = mkBtn(opts.okText ?? 'OK', 'primary', () => tryCommit());
    actions.append(hint, cancel, ok);
    panel.appendChild(actions);

    queueMicrotask(() => {
      textarea.focus();
      // Place cursor at end so existing text isn't overwritten on first keystroke.
      const len = textarea.value.length;
      textarea.setSelectionRange(len, len);
    });
    return panel;
  });
  return reason === 'ok' ? result : null;
}

export async function showPrompt(opts: PromptOpts): Promise<string | null> {
  let result: string | null = null;
  const reason = await openModal((close) => {
    const panel = document.createElement('div');
    panel.appendChild(mkHead(opts.title, opts.message));

    const body = document.createElement('div');
    body.className = 'hk-modal-body';
    const input = document.createElement('input');
    input.type = opts.inputType ?? 'text';
    input.className = 'hk-modal-input';
    input.value = opts.defaultValue ?? '';
    if (opts.placeholder) input.placeholder = opts.placeholder;
    body.appendChild(input);

    const err = document.createElement('div');
    err.className = 'hk-modal-err';
    err.hidden = true;
    body.appendChild(err);

    panel.appendChild(body);

    const tryCommit = (): void => {
      const v = input.value;
      if (opts.validate) {
        const e = opts.validate(v);
        if (e) {
          err.textContent = e;
          err.hidden = false;
          input.focus();
          input.select();
          return;
        }
      }
      result = v;
      close('ok');
    };

    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        ev.stopPropagation();
        tryCommit();
      }
    });

    const actions = document.createElement('div');
    actions.className = 'hk-modal-actions';
    const cancel = mkBtn(opts.cancelText ?? 'Abbrechen', 'secondary', () => close('cancel'));
    const ok = mkBtn(opts.okText ?? 'OK', 'primary', () => tryCommit());
    actions.append(cancel, ok);
    panel.appendChild(actions);

    queueMicrotask(() => { input.focus(); input.select(); });
    return panel;
  });
  return reason === 'ok' ? result : null;
}
