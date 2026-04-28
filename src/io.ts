import type { Entity, EntityInit, Expr, ExportOptions, Feature, ImportFormat,
              ImportResult, Layer, Parameter, ParameterGroup, PointRef, Pt } from './types';
import { patternForLineStyle, resolveLineStyle } from './types';
import { consumeNextDrawingNumber, saveProjectMeta, state } from './state';
import { render } from './render';
import { renderLayers, toast, updateSelStatus, updateStats } from './ui';
import { drawingBounds } from './view';
import { ensureAxisFeatures, evaluateTimeline, newFeatureId } from './features';
import { pushUndo, resetHistory } from './undo';
import { markClean } from './dirty';
import { showConfirm } from './modal';
import { exportDxf } from './io/export-dxf';
import { exportEps } from './io/export-eps';
import { exportPdf } from './io/export-pdf';
import { importDxf } from './io/import-dxf';
import { importSvg } from './io/import-svg';
import { importEps } from './io/import-eps';
import { importPdf } from './io/import-pdf';
import {
  getCurrentFilePath, getDefaultSaveFilename, setCurrentFilePath,
} from './docfile';

/**
 * Result of `saveBlobViaDialog`: `path` is set when the user committed to a
 * location, `cancelled` is true when they dismissed the dialog. On browsers
 * (no Tauri runtime), we fall back to the anchor-download trick and report
 * the synthesized filename as `path`.
 */
type SaveResult = { path: string; cancelled: false } | { path: null; cancelled: true };

/**
 * Ask Tauri to open a native save-as dialog; on the user-picked path, write
 * the blob's bytes via the Rust-side `save_bytes_dialog` command. Falls back
 * to the browser-only `<a download>` path when no Tauri bridge is available
 * (dev `vite` preview, unit tests, etc.) so the export flow works everywhere.
 *
 * The Tauri path keeps the bytes entirely inside the command so we don't need
 * to grant the frontend fs-write capability — the Rust command receives
 * `Vec<u8>` and writes it with `std::fs::write` after the dialog confirms.
 */
export async function saveBlobViaDialog(blob: Blob, suggestedName: string): Promise<SaveResult> {
  try {
    const core = await import('@tauri-apps/api/core');
    if (core.isTauri()) {
      const buf = new Uint8Array(await blob.arrayBuffer());
      // Tauri IPC marshals Uint8Array as an array of numbers → `Vec<u8>`.
      // Extract the extension from the suggested filename so the filter
      // matches what the user is actually exporting (pdf / dxf / eps / svg /
      // hcad). Fallback to "*" when missing so the dialog doesn't hide the
      // file.
      const extMatch = /\.([A-Za-z0-9]+)$/.exec(suggestedName);
      const ext = extMatch ? extMatch[1].toLowerCase() : '';
      const filterName = ext ? ext.toUpperCase() : 'Datei';
      const picked = await core.invoke<string | null>('save_bytes_dialog', {
        data: Array.from(buf),
        suggestedName,
        filterName,
        filterExtensions: ext ? [ext] : [],
      });
      if (picked == null) return { path: null, cancelled: true };
      return { path: picked, cancelled: false };
    }
  } catch {
    // `@tauri-apps/api/core` failed to import (dev preview without Tauri) →
    // fall through to browser download below.
  }
  // Browser fallback.
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = suggestedName;
  a.click();
  URL.revokeObjectURL(url);
  return { path: suggestedName, cancelled: false };
}

type SaveFormat = {
  entities: Entity[];
  layers?: Layer[];
  nextId?: number;
  parameters?: Parameter[];
  parameterGroups?: ParameterGroup[];
  features?: Feature[];
};

/**
 * Build the default export filename for a given target format. If the
 * drawing is bound to a `.hcad` file on disk we reuse its basename so the
 * exported artefact lands next to the source with a matching stem (`HLogo.hcad`
 * → `HLogo.pdf`), which is what every other editor does on export. When no
 * binding exists yet (fresh drawing not yet saved) we fall back to the
 * numbered default, swapping the `.hcad` extension for the target format.
 *
 * Prior behaviour was to always suggest `zeichnung.<ext>` regardless of the
 * drawing's identity — annoying if the user had ten drawings in one folder
 * and wanted to keep them organised by name.
 */
function defaultExportFilename(ext: 'pdf' | 'dxf' | 'eps' | 'svg'): string {
  const bound = getCurrentFilePath();
  const source = bound ?? getDefaultSaveFilename();
  // Trim the last path separator segment — handles both POSIX and Windows
  // paths defensively in case a round-tripped Windows path ever reaches here.
  const base = source.split(/[\\/]/).pop() ?? source;
  // Drop the final extension (`.hcad`, `.json`, …) — the file picker adds
  // the target extension on its own via the filter, but prefilling with the
  // full `<stem>.<ext>` means users on platforms where the picker doesn't
  // auto-append still get a correct filename.
  const stem = base.replace(/\.[^.]+$/, '') || base;
  return `${stem}.${ext}`;
}

/**
 * Unified export entry point. The export dialog (Phase 7) and keyboard
 * shortcut both land here. Dispatches to the format-specific writer,
 * wraps the result in a download, and toasts success or failure.
 *
 * This is the router — it does not know how to write any single format.
 * Each sub-exporter returns a `Blob`; this function handles the common
 * plumbing (filename, download anchor, error handling, toast).
 */
export async function exportDrawing(opts: ExportOptions): Promise<void> {
  try {
    let blob: Blob;
    let filename: string;

    switch (opts.format) {
      case 'svg': {
        // Build the SVG blob and route through the shared save-as dialog, so
        // SVG gets the same "choose where to save" flow as PDF / DXF / EPS.
        const svgBlob = buildSvgBlob();
        if (!svgBlob) { toast('Nichts zu exportieren'); return; }
        blob = svgBlob;
        filename = opts.filename ?? defaultExportFilename('svg');
        break;
      }
      case 'dxf':
        blob = exportDxf(state.entities, state.layers);
        filename = opts.filename ?? defaultExportFilename('dxf');
        break;
      case 'eps':
        blob = exportEps(state.entities, state.layers);
        filename = opts.filename ?? defaultExportFilename('eps');
        break;
      case 'pdf':
        blob = await exportPdf(state.entities, state.layers, opts.template, opts.titleBlock);
        filename = opts.filename ?? defaultExportFilename('pdf');
        break;
    }

    const res = await saveBlobViaDialog(blob, filename);
    if (res.cancelled) return;                              // user dismissed — silent
    toast(`Zeichnung exportiert: ${res.path}`);
  } catch (err) {
    console.error('[exportDrawing]', err);
    const msg = err instanceof Error ? err.message : String(err);
    toast(`Fehler beim Export: ${msg}`);
  }
}

/**
 * Build the `.hcad` JSON blob from live state. Shared between the three save
 * entry points (`saveJson`, `saveJsonInteractive`, direct-write path) so the
 * on-disk shape never drifts between them.
 */
function buildSaveBlob(): Blob {
  const data: SaveFormat = {
    entities: state.entities,
    layers: state.layers,
    nextId: state.nextId,
    parameters: state.parameters,
    parameterGroups: state.parameterGroups,
    features: state.features,
  };
  return new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
}

/**
 * Write blob bytes directly to an already-known path via the Rust-side
 * `write_file_bytes` command. Returns true on success, false on any failure
 * (permissions, path gone, not running in Tauri). Callers fall back to the
 * Save-As dialog on false so the user still has an escape hatch.
 */
async function writeBlobToPath(blob: Blob, path: string): Promise<boolean> {
  try {
    const core = await import('@tauri-apps/api/core');
    if (!core.isTauri()) return false;
    const buf = new Uint8Array(await blob.arrayBuffer());
    // `Array.from(buf)` matches the marshaling shape save_bytes_dialog uses;
    // Tauri IPC turns the JS number array into Rust `Vec<u8>` on the other side.
    await core.invoke<void>('write_file_bytes', { path, data: Array.from(buf) });
    return true;
  } catch (err) {
    console.warn('[writeBlobToPath]', err);
    return false;
  }
}

/**
 * Primary save entry. Behavior depends on whether the drawing has a bound
 * file (set by a prior Save-As or Open):
 *
 *   • Bound path present → direct write to that path, no dialog. Matches
 *     what every other editor does on Ctrl+S.
 *   • No bound path      → Save-As dialog, pre-filled with the numbered
 *     default (`${drawingNumber}_zeichnung.hcad`), then bind on success.
 *   • Direct write fails → fall back to the dialog so the user can pick a
 *     new location. Happens rarely (permissions, path moved), but the
 *     toast is explicit about why the dialog appeared.
 */
export async function saveJson(): Promise<void> {
  try {
    const blob = buildSaveBlob();
    const bound = getCurrentFilePath();

    if (bound) {
      const ok = await writeBlobToPath(blob, bound);
      if (ok) {
        markClean();
        toast(`Gespeichert: ${bound}`);
        return;
      }
      // Fall through to Save-As with a toast explaining why.
      toast('Direkt speichern fehlgeschlagen — wähle neuen Ort');
    }

    // `.hcad` = proprietary HektikCad save; JSON-encoded internally but the
    // extension communicates "this is a CAD file" rather than "some random JSON".
    const res = await saveBlobViaDialog(blob, getDefaultSaveFilename());
    if (res.cancelled) return;
    // Remember the chosen path so the next save goes direct — only meaningful
    // inside Tauri, where `res.path` is a real filesystem path. The browser
    // fallback synthesizes a filename and has no way to write back later.
    await rememberSavedPathIfTauri(res.path);
    markClean();
    toast(`Gespeichert: ${res.path}`);
  } catch (err) {
    console.error('[saveJson]', err);
    const msg = err instanceof Error ? err.message : String(err);
    toast(`Fehler beim Speichern: ${msg}`);
  }
}

/**
 * Programmatic save that reports whether the user completed the save or
 * cancelled the dialog. Mirrors `saveJson`'s direct-vs-dialog logic so the
 * close-guard gets the same "silent save to bound path" fast path.
 */
export async function saveJsonInteractive(): Promise<'saved' | 'cancelled' | 'error'> {
  try {
    const blob = buildSaveBlob();
    const bound = getCurrentFilePath();

    if (bound) {
      const ok = await writeBlobToPath(blob, bound);
      if (ok) {
        markClean();
        toast(`Gespeichert: ${bound}`);
        return 'saved';
      }
      toast('Direkt speichern fehlgeschlagen — wähle neuen Ort');
    }

    const res = await saveBlobViaDialog(blob, getDefaultSaveFilename());
    if (res.cancelled) return 'cancelled';
    await rememberSavedPathIfTauri(res.path);
    markClean();
    toast(`Gespeichert: ${res.path}`);
    return 'saved';
  } catch (err) {
    console.error('[saveJsonInteractive]', err);
    const msg = err instanceof Error ? err.message : String(err);
    toast(`Fehler beim Speichern: ${msg}`);
    return 'error';
  }
}

/**
 * Only bind `currentFilePath` when we're actually running inside Tauri — the
 * browser fallback in `saveBlobViaDialog` returns the suggested filename as
 * `res.path`, which is useful for the toast but NOT a real filesystem path
 * we could write back to. Silent no-op on browser builds.
 */
async function rememberSavedPathIfTauri(path: string): Promise<void> {
  try {
    const core = await import('@tauri-apps/api/core');
    if (core.isTauri()) setCurrentFilePath(path);
  } catch {
    /* ignore */
  }
}

/**
 * Apply a loaded drawing JSON to the live state. Shared by the browser-file
 * picker flow (`loadJson`) and the OS file-association flow (`loadJsonFromPath`
 * in `tauribridge.ts`) so both paths go through the same migration,
 * timeline-evaluate and dirty-reset sequence.
 */
export function applyLoadedDrawing(jsonText: string): boolean {
  try {
    const data = JSON.parse(jsonText) as SaveFormat;
    if (data.layers) {
      // Migrate legacy `style: 'dash'` (pre-linetype-expansion) to the new
      // `'dashed'` preset so every save cycle produces type-valid JSON.
      for (const L of data.layers) {
        if ((L.style as unknown) === 'dash') L.style = 'dashed';
      }
      state.layers = data.layers;
    }
    state.nextId = data.nextId ?? 1;
    state.parameters = data.parameters ?? [];
    state.parameterGroups = data.parameterGroups ?? [];
    state.features = data.features ?? [];
    state.selection.clear();
    // Guarantee locked origin axes are present (may be missing in old files).
    ensureAxisFeatures();
    // Features are authoritative — rebuild entities from the timeline.
    // Legacy saves without features fall back to persisted entities as-is.
    if (state.features.length) {
      evaluateTimeline();
    } else {
      state.entities = data.entities ?? [];
    }
    resetHistory();
    // A freshly loaded drawing has no unsaved edits by definition.
    markClean();
    renderLayers();
    updateStats();
    updateSelStatus();
    render();
    return true;
  } catch {
    return false;
  }
}

export async function loadJson(): Promise<void> {
  // Tauri runtime: native open dialog + `read_file_text`. Gives us the real
  // filesystem path so subsequent Ctrl+S writes can go straight back to it
  // and the title bar can show the opened file's name. The dialog plugin
  // needs `dialog:allow-open` in the capabilities manifest.
  try {
    const core = await import('@tauri-apps/api/core');
    if (core.isTauri()) {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const picked = await open({
        multiple: false,
        directory: false,
        filters: [{ name: 'HektikCad', extensions: ['hcad', 'json'] }],
      });
      // Plugin returns `string | string[] | null`. With multiple:false we get
      // a string or null; guard anyway in case the typings drift.
      const path = typeof picked === 'string' ? picked : null;
      if (!path) return;
      const text = await core.invoke<string>('read_file_text', { path });
      if (!applyLoadedDrawing(text)) {
        toast(`Fehler beim Laden: ${path}`);
        return;
      }
      setCurrentFilePath(path);
      toast(`Geladen: ${path}`);
      return;
    }
  } catch (err) {
    // Fall through to browser flow — typically means the dialog plugin API
    // isn't reachable (dev preview, stripped build).
    console.warn('[loadJson] Tauri path failed, using browser fallback:', err);
  }

  // Browser fallback: plain file input. No real FS path, so we clear any
  // previous binding — silent Ctrl+S after opening a different drawing
  // would otherwise overwrite the wrong file.
  const inp = document.createElement('input');
  inp.type = 'file';
  // Accept the current `.hcad` extension plus legacy `.json` so users with
  // files from before the rename can still open them — the parser only cares
  // about the JSON shape, not the extension.
  inp.accept = '.hcad,.json,application/json';
  inp.onchange = () => {
    const f = inp.files?.[0];
    if (!f) return;
    f.text().then(t => {
      const ok = applyLoadedDrawing(t);
      if (ok) setCurrentFilePath(null);
      toast(ok ? 'Geladen' : 'Fehler beim Laden');
    });
  };
  inp.click();
}

/**
 * Build the SVG blob without triggering a download. Used by `exportDrawing`
 * so the SVG format goes through the same save-as dialog as the other
 * exporters. Returns `null` when the drawing is empty (nothing to export).
 */
function buildSvgBlob(): Blob | null {
  const b = drawingBounds();
  if (!b) return null;
  const pad = 10;
  const w = b.maxX - b.minX + pad * 2;
  const h = b.maxY - b.minY + pad * 2;
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${b.minX - pad} ${-(b.maxY + pad)} ${w} ${h}">\n`;
  for (const e of state.entities) {
    const L = state.layers[e.layer];
    if (!L || !L.visible) continue;
    const color = L.color;
    // SVG uses the same world-mm units as the viewBox we emit, so dash arrays
    // go through unscaled. `resolveLineStyle` normalises legacy `'dash'` to
    // `'dashed'` for files saved before the preset expansion.
    const patternMm = patternForLineStyle(resolveLineStyle(L.style));
    const dash = patternMm.length ? ` stroke-dasharray="${patternMm.join(' ')}"` : '';
    if (e.type === 'line') {
      svg += `<line x1="${e.x1}" y1="${-e.y1}" x2="${e.x2}" y2="${-e.y2}" stroke="${color}" stroke-width="0.3"${dash}/>\n`;
    } else if (e.type === 'xline') {
      const T = 10000;
      svg += `<line x1="${e.x1 - e.dx * T}" y1="${-(e.y1 - e.dy * T)}" x2="${e.x1 + e.dx * T}" y2="${-(e.y1 + e.dy * T)}" stroke="${color}" stroke-width="0.3"${dash}/>\n`;
    } else if (e.type === 'rect') {
      const xl = Math.min(e.x1, e.x2), xr = Math.max(e.x1, e.x2);
      const yb = Math.min(e.y1, e.y2), yt = Math.max(e.y1, e.y2);
      svg += `<rect x="${xl}" y="${-yt}" width="${xr - xl}" height="${yt - yb}" stroke="${color}" fill="none" stroke-width="0.3"${dash}/>\n`;
    } else if (e.type === 'circle') {
      svg += `<circle cx="${e.cx}" cy="${-e.cy}" r="${e.r}" stroke="${color}" fill="none" stroke-width="0.3"${dash}/>\n`;
    } else if (e.type === 'arc') {
      const x1 = e.cx + Math.cos(e.a1) * e.r, y1 = -(e.cy + Math.sin(e.a1) * e.r);
      const x2 = e.cx + Math.cos(e.a2) * e.r, y2 = -(e.cy + Math.sin(e.a2) * e.r);
      const twoPi = Math.PI * 2;
      const sweep = ((e.a2 - e.a1) % twoPi + twoPi) % twoPi;
      const large = sweep > Math.PI ? 1 : 0;
      // SVG y is flipped, so world CCW becomes screen CW → sweep-flag 0.
      svg += `<path d="M ${x1} ${y1} A ${e.r} ${e.r} 0 ${large} 0 ${x2} ${y2}" stroke="${color}" fill="none" stroke-width="0.3"${dash}/>\n`;
    } else if (e.type === 'ellipse') {
      // Rotate around center. SVG y is flipped (world y+ = SVG y-), so world CCW
      // rotation becomes SVG CW → negate for the rotate transform.
      const deg = (-e.rot * 180 / Math.PI).toFixed(3);
      svg += `<ellipse cx="${e.cx}" cy="${-e.cy}" rx="${e.rx}" ry="${e.ry}" stroke="${color}" fill="none" stroke-width="0.3"${dash} transform="rotate(${deg} ${e.cx} ${-e.cy})"/>\n`;
    } else if (e.type === 'spline') {
      if (e.pts.length >= 2) {
        // Emit as a cubic-bezier chain: M p0 C c1 c2 p1 C ... matching the render.
        const n = e.pts.length;
        const closed = !!e.closed;
        const get = (i: number) => {
          if (closed) return e.pts[((i % n) + n) % n];
          return e.pts[Math.max(0, Math.min(n - 1, i))];
        };
        const segCount = closed ? n : n - 1;
        let d = `M ${e.pts[0].x} ${-e.pts[0].y}`;
        for (let i = 0; i < segCount; i++) {
          const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
          const c1x = p1.x + (p2.x - p0.x) / 6, c1y = p1.y + (p2.y - p0.y) / 6;
          const c2x = p2.x - (p3.x - p1.x) / 6, c2y = p2.y - (p3.y - p1.y) / 6;
          d += ` C ${c1x} ${-c1y} ${c2x} ${-c2y} ${p2.x} ${-p2.y}`;
        }
        if (closed) d += ' Z';
        svg += `<path d="${d}" stroke="${color}" fill="none" stroke-width="0.3"${dash}/>\n`;
      }
    } else if (e.type === 'polyline') {
      const pts = e.pts.map(p => `${p.x},${-p.y}`).join(' ');
      const tag = e.closed ? 'polygon' : 'polyline';
      svg += `<${tag} points="${pts}" stroke="${color}" fill="none" stroke-width="0.3"${dash}/>\n`;
    } else if (e.type === 'text') {
      const esc = e.text
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const rot = e.rotation ? ` transform="rotate(${(-e.rotation * 180 / Math.PI).toFixed(3)} ${e.x} ${-e.y})"` : '';
      svg += `<text x="${e.x}" y="${-e.y}" font-size="${e.height}" font-family="Inter, sans-serif" fill="${color}"${rot}>${esc}</text>\n`;
    } else if (e.type === 'dim') {
      if (e.dimKind === 'angular' && e.vertex && e.ray1 && e.ray2) {
        // Angular dim → SVG path arc. Match the on-screen convention: the
        // sweep is the sector that contains `offset`.
        const V = e.vertex;
        const dOx = e.offset.x - V.x, dOy = e.offset.y - V.y;
        const R = Math.hypot(dOx, dOy);
        if (R < 1e-9) continue;
        const TAU = Math.PI * 2;
        const norm2pi = (x: number) => ((x % TAU) + TAU) % TAU;
        const a1 = Math.atan2(e.ray1.y - V.y, e.ray1.x - V.x);
        const a2 = Math.atan2(e.ray2.y - V.y, e.ray2.x - V.x);
        const aO = Math.atan2(dOy, dOx);
        const sweep12 = norm2pi(a2 - a1);
        const sweep1O = norm2pi(aO - a1);
        const [aS, aE] = (sweep1O <= sweep12 + 1e-9) ? [a1, a2] : [a2, a1];
        const sweep = norm2pi(aE - aS) || TAU;
        const sx = V.x + R * Math.cos(aS), sy = V.y + R * Math.sin(aS);
        const ex = V.x + R * Math.cos(aE), ey = V.y + R * Math.sin(aE);
        // SVG Y is flipped (we negate); the path sweep flag mirrors too.
        const largeArc = sweep > Math.PI ? 1 : 0;
        const sweepFlag = 0; // CCW in world = CW in flipped SVG → flag 0
        svg += `<path d="M ${sx} ${-sy} A ${R} ${R} 0 ${largeArc} ${sweepFlag} ${ex} ${-ey}" stroke="${color}" fill="none" stroke-width="0.3"/>\n`;
        const aM = aS + sweep / 2;
        const mx = V.x + R * Math.cos(aM), my = V.y + R * Math.sin(aM);
        const degLabel = `${(sweep * 180 / Math.PI).toFixed(1)}°`;
        svg += `<text x="${mx}" y="${-my - 0.5}" font-size="${e.textHeight}" font-family="Inter, sans-serif" fill="${color}" text-anchor="middle">${degLabel}</text>\n`;
        continue;
      }
      if ((e.dimKind === 'radius' || e.dimKind === 'diameter') && e.vertex && e.ray1) {
        // Radius / diameter: single leader from near-edge (or far-edge for Ø)
        // to the label anchor, plus a prefix-labelled text.
        const C = e.vertex;
        const r = Math.hypot(e.ray1.x - C.x, e.ray1.y - C.y);
        if (r < 1e-9) continue;
        let ux = e.offset.x - C.x, uy = e.offset.y - C.y;
        let ul = Math.hypot(ux, uy);
        if (ul < 1e-9) { ux = e.ray1.x - C.x; uy = e.ray1.y - C.y; ul = r; }
        ux /= ul; uy /= ul;
        const nearX = C.x + ux * r, nearY = C.y + uy * r;
        const farX  = C.x - ux * r, farY  = C.y - uy * r;
        const isDia = e.dimKind === 'diameter';
        const leaderX1 = isDia ? farX  : nearX;
        const leaderY1 = isDia ? farY  : nearY;
        svg += `<line x1="${leaderX1}" y1="${-leaderY1}" x2="${e.offset.x}" y2="${-e.offset.y}" stroke="${color}" stroke-width="0.3"/>\n`;
        const label = isDia ? `Ø ${(2 * r).toFixed(2)}` : `R ${r.toFixed(2)}`;
        // Leader angle in SVG space (y flipped).
        let deg = Math.atan2(-(e.offset.y - leaderY1), e.offset.x - leaderX1) * 180 / Math.PI;
        if (deg > 90)  deg -= 180;
        if (deg < -90) deg += 180;
        svg += `<text x="${e.offset.x}" y="${-e.offset.y - 0.5}" font-size="${e.textHeight}" font-family="Inter, sans-serif" fill="${color}" text-anchor="middle" transform="rotate(${deg.toFixed(3)} ${e.offset.x} ${-e.offset.y})">${label}</text>\n`;
        continue;
      }
      const dx = e.p2.x - e.p1.x, dy = e.p2.y - e.p1.y;
      const L = Math.hypot(dx, dy);
      if (L < 1e-9) continue;
      const nx = -dy / L, ny = dx / L;
      const sd = (e.offset.x - e.p1.x) * nx + (e.offset.y - e.p1.y) * ny;
      const ax = e.p1.x + nx * sd, ay = e.p1.y + ny * sd;
      const bx = e.p2.x + nx * sd, by = e.p2.y + ny * sd;
      svg += `<line x1="${ax}" y1="${-ay}" x2="${bx}" y2="${-by}" stroke="${color}" stroke-width="0.3"/>\n`;
      svg += `<line x1="${e.p1.x}" y1="${-e.p1.y}" x2="${ax}" y2="${-ay}" stroke="${color}" stroke-width="0.3"/>\n`;
      svg += `<line x1="${e.p2.x}" y1="${-e.p2.y}" x2="${bx}" y2="${-by}" stroke="${color}" stroke-width="0.3"/>\n`;
      const mx = (ax + bx) / 2, my = (ay + by) / 2;
      let deg = Math.atan2(-(by - ay), bx - ax) * 180 / Math.PI;
      if (deg > 90)  deg -= 180;
      if (deg < -90) deg += 180;
      svg += `<text x="${mx}" y="${-my - 0.5}" font-size="${e.textHeight}" font-family="Inter, sans-serif" fill="${color}" text-anchor="middle" transform="rotate(${deg.toFixed(3)} ${mx} ${-my})">${L.toFixed(2)}</text>\n`;
    }
  }
  svg += '</svg>';
  return new Blob([svg], { type: 'image/svg+xml' });
}

/**
 * Back-compat wrapper for the legacy SVG-only export path. Any caller that
 * still imports `exportSvg` directly now goes through the same save-as
 * dialog as the rest of the export flow.
 */
export async function exportSvg(): Promise<void> {
  const blob = buildSvgBlob();
  if (!blob) { toast('Nichts zu exportieren'); return; }
  const res = await saveBlobViaDialog(blob, 'zeichnung.svg');
  if (res.cancelled) return;
  toast(`Zeichnung exportiert: ${res.path}`);
}

// ────────────────────────────────────────────────────────────────────────────
// Import — DXF / SVG / PDF / EPS / HCAD-merge
// ────────────────────────────────────────────────────────────────────────────

/** Detect import format from a filename's extension. Returns null on unknown. */
function detectImportFormat(filename: string): ImportFormat | null {
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  switch (ext) {
    case 'dxf':  return 'dxf';
    case 'svg':  return 'svg';
    case 'pdf':  return 'pdf';
    case 'eps':  return 'eps';
    case 'ai':   return 'eps';   // Illustrator files are PostScript at heart.
    case 'hcad': return 'hcad';
    case 'json': return 'hcad';  // legacy HektikCad save extension.
  }
  return null;
}

/** Helper — wrap a raw number into the simplest possible Expr. */
const litExpr = (n: number): Expr => ({ kind: 'num', value: n });
/** Helper — abs-PointRef from a world-space point. */
const absRef  = (p: Pt): PointRef => ({ kind: 'abs', x: litExpr(p.x), y: litExpr(p.y) });

/**
 * Convert one parser-emitted EntityInit into a HektikCad Feature with all
 * abs/numeric refs (no parameters). The user explicitly chose `abs ist okay`
 * — we don't try to recover any structural relationships from the source.
 *
 * Returns null when the entity type can't be modelled as a feature (xline at
 * import time, etc. — flat parsers shouldn't emit those, but we guard).
 */
function entityInitToFeature(e: EntityInit): Feature | null {
  switch (e.type) {
    case 'line':
      return {
        id: newFeatureId(), kind: 'line', layer: e.layer,
        p1: absRef({ x: e.x1, y: e.y1 }),
        p2: absRef({ x: e.x2, y: e.y2 }),
      };
    case 'rect': {
      const xl = Math.min(e.x1, e.x2), xr = Math.max(e.x1, e.x2);
      const yb = Math.min(e.y1, e.y2), yt = Math.max(e.y1, e.y2);
      return {
        id: newFeatureId(), kind: 'rect', layer: e.layer,
        p1: absRef({ x: xl, y: yb }),
        width: litExpr(xr - xl),
        height: litExpr(yt - yb),
        signX: 1, signY: 1,
      };
    }
    case 'circle':
      return {
        id: newFeatureId(), kind: 'circle', layer: e.layer,
        center: absRef({ x: e.cx, y: e.cy }),
        radius: litExpr(e.r),
      };
    case 'arc':
      return {
        id: newFeatureId(), kind: 'arc', layer: e.layer,
        center: absRef({ x: e.cx, y: e.cy }),
        radius: litExpr(e.r),
        a1: litExpr(e.a1), a2: litExpr(e.a2),
      };
    case 'ellipse':
      return {
        id: newFeatureId(), kind: 'ellipse', layer: e.layer,
        center: absRef({ x: e.cx, y: e.cy }),
        rx: litExpr(e.rx), ry: litExpr(e.ry), rot: litExpr(e.rot),
      };
    case 'polyline':
      return {
        id: newFeatureId(), kind: 'polyline', layer: e.layer,
        pts: e.pts.map(absRef),
        closed: !!e.closed,
      };
    case 'spline':
      return {
        id: newFeatureId(), kind: 'spline', layer: e.layer,
        pts: e.pts.map(absRef),
        closed: !!e.closed,
      };
    case 'text':
      return {
        id: newFeatureId(), kind: 'text', layer: e.layer,
        p: absRef({ x: e.x, y: e.y }),
        text: e.text,
        height: litExpr(e.height),
        rotation: litExpr(e.rotation ?? 0),
        ...(e.boxWidth != null ? { boxWidth: litExpr(e.boxWidth) } : {}),
      };
    case 'xline':
    case 'dim':
    case 'hatch':
      return null;
  }
}

/**
 * Resolve a parser-local layer index into a `state.layers` index. Layers are
 * matched by name first (so re-importing the same file lands on the same
 * layer), and only a fresh layer is appended when no name match exists. The
 * mapping is cached for the duration of one import to avoid scanning
 * `state.layers` for every entity.
 */
function buildLayerMap(parserLayers: Layer[]): number[] {
  const map: number[] = [];
  for (const L of parserLayers) {
    const existing = state.layers.findIndex(s => s.name === L.name);
    if (existing >= 0) {
      map.push(existing);
    } else {
      state.layers.push({ ...L });
      map.push(state.layers.length - 1);
    }
  }
  return map;
}

/**
 * Apply a flat-geometry import (DXF / SVG / PDF / EPS) to the live drawing.
 * Layer indices are remapped, every entity becomes an abs-coord feature,
 * and the timeline is re-evaluated so the new entities show up immediately.
 */
function applyFlatImport(res: ImportResult): void {
  const layerMap = buildLayerMap(res.layers);
  pushUndo();
  for (const e of res.entities) {
    // Remap the parser-local layer index onto the live state. Out-of-range
    // values default to layer 0 (defensive — parsers shouldn't emit those).
    const remapped = layerMap[e.layer] ?? 0;
    const remappedEntity = { ...e, layer: remapped } as EntityInit;
    const feat = entityInitToFeature(remappedEntity);
    if (feat) state.features.push(feat);
  }
  evaluateTimeline();
  renderLayers();
  updateStats();
  updateSelStatus();
  render();
}

/**
 * HCAD-merge: load a second `.hcad` file's features + parameters and append
 * them to the live drawing. Feature IDs and parameter IDs are remapped so
 * they don't collide; PointRefs that name features get rewritten to the
 * remapped IDs. Layers are merged by name.
 */
function applyHcadMerge(jsonText: string, filename: string): boolean {
  type SaveFormat = {
    entities?: Entity[];
    layers?: Layer[];
    nextId?: number;
    parameters?: Parameter[];
    features?: Feature[];
  };
  let data: SaveFormat;
  try {
    data = JSON.parse(jsonText) as SaveFormat;
  } catch {
    toast(`HCAD ungültig: ${filename}`);
    return false;
  }

  pushUndo();

  // ── Layer merge ──
  const layerMap: number[] = [];
  for (const L of data.layers ?? []) {
    if ((L.style as unknown) === 'dash') L.style = 'dashed';
    const existing = state.layers.findIndex(s => s.name === L.name);
    if (existing >= 0) layerMap.push(existing);
    else { state.layers.push({ ...L }); layerMap.push(state.layers.length - 1); }
  }

  // ── Parameter merge — name collisions get a numeric suffix to keep both
  //    drawings' formulas evaluating; ID collisions get a fresh random ID.
  const paramIdMap = new Map<string, string>();
  for (const p of data.parameters ?? []) {
    const liveByName = state.parameters.find(q => q.name === p.name);
    if (liveByName) {
      // Reuse the live param's id — incoming references will resolve to it.
      paramIdMap.set(p.id, liveByName.id);
      continue;
    }
    const newId = 'p' + Math.random().toString(36).slice(2, 8);
    paramIdMap.set(p.id, newId);
    state.parameters.push({ ...p, id: newId });
  }

  // ── Feature merge — fresh IDs, rewrite layer + nested ID refs ──
  const featIdMap = new Map<string, string>();
  for (const f of data.features ?? []) {
    featIdMap.set(f.id, newFeatureId());
  }
  const remapExpr = (x: Expr): Expr => {
    if (x.kind === 'param') {
      const remapped = paramIdMap.get(x.id);
      return remapped ? { kind: 'param', id: remapped } : x;
    }
    if (x.kind === 'formula') {
      // Rewrite param IDs inside the AST + refs list so re-evaluation finds
      // them under their new ids. The `src` string is kept verbatim because
      // formulas display by parameter NAME and we only ever re-id collision-
      // free imports onto matching live names — so the user-visible source
      // remains correct.
      const refs = x.refs.map(ref => paramIdMap.get(ref) ?? ref);
      const remapNode = (n: typeof x.ast): typeof x.ast => {
        if (n.t === 'param') {
          return { t: 'param', id: paramIdMap.get(n.id) ?? n.id };
        }
        if (n.t === 'neg') return { t: 'neg', a: remapNode(n.a) };
        if (n.t === 'bin') return { t: 'bin', op: n.op, a: remapNode(n.a), b: remapNode(n.b) };
        if (n.t === 'fn')  return { t: 'fn', name: n.name, a: remapNode(n.a) };
        return n;
      };
      return { kind: 'formula', src: x.src, ast: remapNode(x.ast), refs };
    }
    return x;
  };
  const remapPointRef = (r: PointRef): PointRef => {
    switch (r.kind) {
      case 'abs':
        return { kind: 'abs', x: remapExpr(r.x), y: remapExpr(r.y) };
      case 'endpoint':
        return { kind: 'endpoint', feature: featIdMap.get(r.feature) ?? r.feature, end: r.end };
      case 'center':
        return { kind: 'center', feature: featIdMap.get(r.feature) ?? r.feature };
      case 'mid':
        return { kind: 'mid', feature: featIdMap.get(r.feature) ?? r.feature };
      case 'intersection':
        return {
          kind: 'intersection',
          feature1: featIdMap.get(r.feature1) ?? r.feature1,
          feature2: featIdMap.get(r.feature2) ?? r.feature2,
        };
      case 'polar':
        return { kind: 'polar', from: remapPointRef(r.from), angle: remapExpr(r.angle), distance: remapExpr(r.distance) };
      case 'rayHit':
        return {
          kind: 'rayHit', from: remapPointRef(r.from), angle: remapExpr(r.angle),
          target: featIdMap.get(r.target) ?? r.target,
          edge: r.edge,
        };
      case 'axisProject':
        return { kind: 'axisProject', xFrom: remapPointRef(r.xFrom), yFrom: remapPointRef(r.yFrom) };
      case 'interpolate':
        return { kind: 'interpolate', from: remapPointRef(r.from), to: remapPointRef(r.to), t: remapExpr(r.t) };
    }
  };

  for (const f of data.features ?? []) {
    const newF: Feature = JSON.parse(JSON.stringify(f));
    newF.id = featIdMap.get(f.id) ?? f.id;
    newF.layer = layerMap[f.layer] ?? 0;
    // Walk every PointRef + Expr inside the feature and remap.
    const rewritten = rewriteFeatureRefs(newF, remapPointRef, remapExpr, featIdMap);
    state.features.push(rewritten);
  }

  evaluateTimeline();
  renderLayers();
  updateStats();
  updateSelStatus();
  render();
  return true;
}

/**
 * Walk a feature's PointRef / Expr fields and apply remapping. Centralised so
 * the HCAD-merge path stays readable in `applyHcadMerge`. Mutates `f` in
 * place and returns it for chaining.
 */
function rewriteFeatureRefs(
  f: Feature,
  remapRef: (r: PointRef) => PointRef,
  remapExpr: (x: Expr) => Expr,
  featIdMap: Map<string, string>,
): Feature {
  const fAny = f as Feature & Record<string, unknown>;
  // PointRef-typed fields: walk every property generically. The list of
  // possible names mirrors `featureDependencies` in features.ts.
  for (const key of ['p1', 'p2', 'p', 'center', 'offset', 'vertex', 'ray1', 'ray2'] as const) {
    if (fAny[key] != null) (fAny as Record<string, unknown>)[key] = remapRef(fAny[key] as PointRef);
  }
  // PointRef[] (polyline / spline / hatch.pts).
  if (Array.isArray(fAny.pts)) {
    fAny.pts = (fAny.pts as PointRef[]).map(remapRef);
  }
  // Hatch holes: PointRef[][].
  if (Array.isArray(fAny.holes)) {
    fAny.holes = (fAny.holes as PointRef[][]).map(arr => arr.map(remapRef));
  }
  // Expr-typed fields.
  for (const key of ['width', 'height', 'radius', 'a1', 'a2', 'rx', 'ry', 'rot',
                     'distance', 'dx', 'dy', 'angle', 'spacing', 'textHeight',
                     'rotation', 'boxWidth', 't'] as const) {
    if (fAny[key] != null) (fAny as Record<string, unknown>)[key] = remapExpr(fAny[key] as Expr);
  }
  // Feature-id fields (modifier features point at sources).
  if (typeof fAny.refFeature === 'string') {
    fAny.refFeature = featIdMap.get(fAny.refFeature) ?? fAny.refFeature;
  }
  if (Array.isArray(fAny.sourceIds)) {
    fAny.sourceIds = (fAny.sourceIds as string[]).map(id => featIdMap.get(id) ?? id);
  }
  if (Array.isArray(fAny.targetEdges)) {
    // ChamferFeature / FilletFeature target edges: { feature, edge } records.
    fAny.targetEdges = (fAny.targetEdges as Array<{ feature: string }>).map(t => ({
      ...t,
      feature: featIdMap.get(t.feature) ?? t.feature,
    }));
  }
  return f;
}

/**
 * Return a human-readable label like "12 Linien, 3 Polylinien (5 Texte
 * übersprungen)" for the post-import toast. Skip-counts only mention the
 * categories that actually had skips so the toast stays tight.
 */
function importToastMessage(res: ImportResult): string {
  const counts = new Map<string, number>();
  for (const e of res.entities) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
  const labels: Record<string, [string, string]> = {
    line:     ['Linie', 'Linien'],
    polyline: ['Polylinie', 'Polylinien'],
    rect:     ['Rechteck', 'Rechtecke'],
    circle:   ['Kreis', 'Kreise'],
    arc:      ['Bogen', 'Bögen'],
    ellipse:  ['Ellipse', 'Ellipsen'],
    spline:   ['Spline', 'Splines'],
    text:     ['Text', 'Texte'],
  };
  const parts: string[] = [];
  for (const [type, n] of counts) {
    const label = labels[type];
    if (!label) continue;
    parts.push(`${n} ${n === 1 ? label[0] : label[1]}`);
  }
  const skipBits: string[] = [];
  if (res.skipped.text)    skipBits.push(`${res.skipped.text} Text${res.skipped.text === 1 ? '' : 'e'}`);
  if (res.skipped.hatch)   skipBits.push(`${res.skipped.hatch} Hatch`);
  if (res.skipped.spline)  skipBits.push(`${res.skipped.spline} Spline${res.skipped.spline === 1 ? '' : 's'}`);
  if (res.skipped.insert)  skipBits.push(`${res.skipped.insert} Block-Verweise`);
  if (res.skipped.unknown) skipBits.push(`${res.skipped.unknown} unbekannt`);
  const skipPart = skipBits.length ? ` (${skipBits.join(', ')} übersprungen)` : '';
  const head = parts.length ? parts.join(', ') : 'nichts';
  return `${res.format.toUpperCase()} importiert: ${head}${skipPart}`;
}

/**
 * Public entry point — opens the native (or browser) file picker, dispatches
 * to the right parser by extension, and applies the result. The import dialog
 * (later phase) calls this same function so all import flows go through one
 * router. Returns silently on cancel; surfaces errors via toast.
 */
export async function importDrawing(): Promise<void> {
  // ── File picker — Tauri native dialog first, browser fallback after. ──
  let filename: string | null = null;
  let asText: string | null = null;
  let asBytes: ArrayBuffer | null = null;
  try {
    const core = await import('@tauri-apps/api/core');
    if (core.isTauri()) {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const picked = await open({
        multiple: false,
        directory: false,
        filters: [
          { name: 'Importierbare Formate', extensions: ['dxf', 'svg', 'pdf', 'eps', 'ai', 'hcad', 'json'] },
        ],
      });
      const path = typeof picked === 'string' ? picked : null;
      if (!path) return;
      filename = path;
      const ext = path.toLowerCase().split('.').pop() ?? '';
      // PDFs are binary; everything else is text. The Rust side has both
      // helpers already (read_file_text / read_file_bytes — the latter we'll
      // need to add if it doesn't exist).
      if (ext === 'pdf') {
        const bytes = await core.invoke<number[]>('read_file_bytes', { path });
        asBytes = new Uint8Array(bytes).buffer;
      } else {
        asText = await core.invoke<string>('read_file_text', { path });
      }
    }
  } catch (err) {
    console.warn('[importDrawing] Tauri path failed, using browser fallback:', err);
  }

  if (filename == null) {
    // Browser fallback — file input.
    await new Promise<void>((resolve) => {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = '.dxf,.svg,.pdf,.eps,.ai,.hcad,.json';
      inp.onchange = async (): Promise<void> => {
        const f = inp.files?.[0];
        if (!f) return resolve();
        filename = f.name;
        const fmt = detectImportFormat(f.name);
        if (fmt === 'pdf') asBytes = await f.arrayBuffer();
        else                asText  = await f.text();
        resolve();
      };
      // Cancel via the native dialog doesn't fire `change`. Resolve via a
      // microtask after `cancel` (modern browsers) or after focus restores.
      inp.oncancel = (): void => resolve();
      inp.click();
    });
  }

  if (filename == null) return;

  const fmt = detectImportFormat(filename);
  if (fmt == null) {
    toast(`Unbekanntes Format: ${filename}`);
    return;
  }

  try {
    if (fmt === 'hcad') {
      if (asText == null) { toast('Lesefehler beim Import'); return; }
      const ok = applyHcadMerge(asText, filename);
      if (ok) toast(`HCAD eingefügt: ${filename}`);
      return;
    }
    if (fmt === 'pdf') {
      if (asBytes == null) { toast('Lesefehler beim PDF-Import'); return; }
      const res = await importPdf(asBytes, filename);
      applyFlatImport(res);
      toast(importToastMessage(res));
      return;
    }
    if (asText == null) { toast('Lesefehler beim Import'); return; }
    const res = fmt === 'dxf' ? importDxf(asText, filename)
              : fmt === 'svg' ? importSvg(asText, filename)
              : importEps(asText, filename);
    applyFlatImport(res);
    toast(importToastMessage(res));
  } catch (err) {
    console.error('[importDrawing]', err);
    toast(`Import-Fehler: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function clearAll(): Promise<void> {
  const ok = await showConfirm({
    title: 'Alle Objekte löschen?',
    message: 'Diese Aktion entfernt alle Features und Variablen. Mit Strg+Z rückgängig.',
    okText: 'Alles löschen',
    danger: true,
  });
  if (!ok) return;
  pushUndo();
  state.parameters = [];
  state.parameterGroups = [];
  state.features = [];
  state.selection.clear();
  ensureAxisFeatures();
  evaluateTimeline();
  // A fresh drawing deserves a fresh Zeichnungs-Nr. — consume the next
  // auto-number and drop it into projectMeta. The title-block dialog and
  // export dialog pre-fill from this field; the user can still override.
  // Title + revision reset so the new drawing isn't accidentally labelled
  // with the old drawing's name; project name + author + company fields
  // stick so the user doesn't have to retype them every "Neu".
  const nextNumber = consumeNextDrawingNumber();
  if (nextNumber) {
    state.projectMeta.drawingNumber = nextNumber;
    state.projectMeta.drawingTitle = '';
    state.projectMeta.revision = '';
    saveProjectMeta(state.projectMeta);
  }
  // Fresh drawing → drop the file binding (it belonged to the previous
  // drawing). setCurrentFilePath(null) already triggers a title refresh,
  // and because we cleared AFTER saveProjectMeta the refresh reads the
  // freshly-incremented drawingNumber (e.g. "002_zeichnung.hcad").
  setCurrentFilePath(null);
  updateStats();
  updateSelStatus();
  render();
}
