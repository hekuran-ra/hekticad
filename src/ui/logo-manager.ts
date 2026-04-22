/**
 * Logo upload / storage helpers.
 *
 * Flow:
 *   1. User clicks "Logo ändern" in the export dialog
 *   2. Native `<input type="file">` opens — PNG / JPEG only
 *   3. `FileReader.readAsDataURL` produces a data-URL
 *   4. If the source is larger than MAX_LOGO_DIMENSION on either axis, we
 *      downscale via `<canvas>` to keep the PDF small
 *   5. The result is stored in `state.projectMeta.logoDataUrl` and persisted
 *      via `saveProjectMeta`, so it survives reloads
 *
 * Size budget: the title-block logo cell is 40×40mm. At 300dpi equivalent
 * that's ~470px — anything over 512px on the longest side is pointless.
 * We cap at 400 to match the handoff spec.
 */

const MAX_LOGO_DIMENSION = 400;   // longest-side pixel cap
const MAX_FILE_BYTES = 4 * 1024 * 1024;   // hard stop on pathological inputs (4MB)

/** Accepted mime-types. SVG intentionally omitted (phase 2 — needs rasterisation). */
export const LOGO_MIME_TYPES = ['image/png', 'image/jpeg'];

/**
 * Open a file picker, read the selected image, and return a normalised
 * (possibly-downscaled) data-URL. Returns null if the user cancels or
 * the file is invalid.
 *
 * Kept decoupled from `state` on purpose — the caller decides whether to
 * persist. Makes the function trivial to unit-test or reuse in the future
 * import-preview flow.
 */
export async function pickAndNormaliseLogo(): Promise<string | null> {
  const file = await pickFile();
  if (!file) return null;
  if (!LOGO_MIME_TYPES.includes(file.type)) {
    throw new Error(`Nicht unterstütztes Format: ${file.type || 'unbekannt'}. Nur PNG oder JPEG.`);
  }
  if (file.size > MAX_FILE_BYTES) {
    throw new Error('Datei zu groß (max. 4 MB).');
  }

  const rawDataUrl = await fileToDataUrl(file);
  // Downscale if the natural size exceeds our cap. This also re-encodes as
  // PNG to get a clean data-URL regardless of the source format.
  return downscaleIfNeeded(rawDataUrl, MAX_LOGO_DIMENSION);
}

// ────────────────────────────────────────────────────────────────────────────
// Primitives
// ────────────────────────────────────────────────────────────────────────────

/** Prompt the user for a single image file. Resolves to null on cancel. */
function pickFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = LOGO_MIME_TYPES.join(',');
    // The `cancel` event fires when the user dismisses the picker without
    // choosing a file (Chromium 113+, Firefox 91+). Older browsers leave the
    // promise pending — acceptable: the caller's next action will trigger GC.
    input.addEventListener('cancel', () => resolve(null));
    input.addEventListener('change', () => {
      resolve(input.files?.[0] ?? null);
    });
    input.click();
  });
}

/** Read a File as data URL (base64). */
function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

/**
 * If the image is larger than `maxDim` on its longest side, re-render it on
 * an offscreen canvas at the capped size and return the resulting PNG data
 * URL. Otherwise return the original unchanged.
 */
async function downscaleIfNeeded(dataUrl: string, maxDim: number): Promise<string> {
  const img = await loadImage(dataUrl);
  const { naturalWidth: w, naturalHeight: h } = img;
  if (w <= maxDim && h <= maxDim) return dataUrl;

  const scale = Math.min(maxDim / w, maxDim / h);
  const outW = Math.max(1, Math.round(w * scale));
  const outH = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas nicht verfügbar');
  ctx.drawImage(img, 0, 0, outW, outH);
  return canvas.toDataURL('image/png');
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Bild konnte nicht geladen werden'));
    img.src = src;
  });
}
