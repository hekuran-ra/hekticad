/**
 * Tiny bridge that flips `runtime.parametricMode` on when the user implicitly
 * opts in — i.e. the moment they create or reference a variable. Lives in its
 * own file because both `main.ts` and `cmdbar.ts` need to call it, and
 * routing it through either would create an import cycle.
 *
 * Side effects, in order:
 *   - toggle the runtime flag
 *   - persist it (so the next session remembers)
 *   - light up the PARAM button in the snap toolbar
 *   - toast the user so the mode change is discoverable
 *
 * No-op if the mode is already on.
 */
import { runtime, saveParametricMode } from './state';
import { toast } from './ui';

export function ensureParametricModeOn(): void {
  if (runtime.parametricMode) return;
  runtime.parametricMode = true;
  saveParametricMode(true);
  const btn = document.getElementById('tb-parametric');
  if (btn) btn.classList.add('on');
  toast('Parametrisches Zeichnen aktiviert – Variablen sind verknüpft.');
}
