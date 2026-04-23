/**
 * Dirty-flag tracking for the current drawing.
 *
 * "Dirty" means the user has made at least one edit since the last save or
 * since the drawing was loaded. The flag drives two UX affordances:
 *
 *   1. The bullet-dot (`.doc-dirty`) next to the document name in the header.
 *   2. The "unsaved changes?" prompt shown when the Tauri window receives a
 *      close request (see `src/tauribridge.ts`).
 *
 * The single source of truth is the undoable-edit choke-point `pushUndo()`
 * in `src/undo.ts` — every code path that mutates persisted state already
 * pushes an undo snapshot, so wiring `markDirty()` there catches every
 * edit without having to touch each individual tool/command. Cleared from
 * `saveJson()` (successful save) and `loadJson()` (fresh drawing loaded).
 *
 * Kept as a tiny standalone module to avoid a circular import between
 * `undo.ts` (called by every tool) and `io.ts` (which itself imports `undo`).
 */

let dirty = false;
let listeners: Array<(d: boolean) => void> = [];

/** True when there are unsaved edits since the last save/load. */
export function isDirty(): boolean {
  return dirty;
}

/**
 * Flag the drawing as having unsaved edits. Idempotent — no-ops when already
 * dirty so listeners only fire on the clean→dirty transition.
 */
export function markDirty(): void {
  if (dirty) return;
  dirty = true;
  emit();
}

/**
 * Mark the drawing as clean (saved or freshly loaded). Idempotent.
 */
export function markClean(): void {
  if (!dirty) return;
  dirty = false;
  emit();
}

/**
 * Subscribe to dirty-flag transitions. Returns an unsubscribe function. The
 * listener is invoked on every clean↔dirty change (not on idempotent calls).
 */
export function onDirtyChange(fn: (d: boolean) => void): () => void {
  listeners.push(fn);
  return () => { listeners = listeners.filter(l => l !== fn); };
}

function emit(): void {
  for (const fn of listeners) {
    try { fn(dirty); } catch (err) {
      // A listener throwing must not break the others.
      // eslint-disable-next-line no-console
      console.warn('[dirty] listener threw:', err);
    }
  }
}

/**
 * Wire the `.doc-dirty` bullet-dot in the header so it's only visible while
 * the drawing has unsaved edits. Idempotent — safe to call once at startup.
 * Done via a `body.doc-is-dirty` class (vs. direct DOM on the span) so CSS
 * controls visibility and transitions in one place.
 */
export function initDirtyIndicator(): void {
  const apply = (d: boolean): void => {
    document.body.classList.toggle('doc-is-dirty', d);
  };
  apply(dirty);
  onDirtyChange(apply);
}
