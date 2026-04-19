import type { Entity, Feature, Layer, Parameter } from './types';
import { state } from './state';
import { render } from './render';
import { renderLayers, toast, updateSelStatus, updateStats } from './ui';
import { drawingBounds } from './view';
import { ensureAxisFeatures, evaluateTimeline } from './features';
import { pushUndo, resetHistory } from './undo';

type SaveFormat = {
  entities: Entity[];
  layers?: Layer[];
  nextId?: number;
  parameters?: Parameter[];
  features?: Feature[];
};

export function saveJson(): void {
  const data: SaveFormat = {
    entities: state.entities,
    layers: state.layers,
    nextId: state.nextId,
    parameters: state.parameters,
    features: state.features,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'zeichnung.hekticad.json';
  a.click();
  URL.revokeObjectURL(a.href);
}

export function loadJson(): void {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = '.json';
  inp.onchange = () => {
    const f = inp.files?.[0];
    if (!f) return;
    f.text().then(t => {
      try {
        const data = JSON.parse(t) as SaveFormat;
        if (data.layers) state.layers = data.layers;
        state.nextId = data.nextId ?? 1;
        state.parameters = data.parameters ?? [];
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
        renderLayers();
        updateStats();
        updateSelStatus();
        render();
        toast('Geladen');
      } catch {
        toast('Fehler beim Laden');
      }
    });
  };
  inp.click();
}

export function exportSvg(): void {
  const b = drawingBounds();
  if (!b) { toast('Nichts zu exportieren'); return; }
  const pad = 10;
  const w = b.maxX - b.minX + pad * 2;
  const h = b.maxY - b.minY + pad * 2;
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${b.minX - pad} ${-(b.maxY + pad)} ${w} ${h}">\n`;
  for (const e of state.entities) {
    const L = state.layers[e.layer];
    if (!L || !L.visible) continue;
    const color = L.color;
    const dash = L.style === 'dash' ? ' stroke-dasharray="3 2"' : '';
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
  const blob = new Blob([svg], { type: 'image/svg+xml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'zeichnung.svg';
  a.click();
  URL.revokeObjectURL(a.href);
}

export function clearAll(): void {
  if (!confirm('Alle Objekte löschen?')) return;
  pushUndo();
  state.parameters = [];
  state.features = [];
  state.selection.clear();
  ensureAxisFeatures();
  evaluateTimeline();
  updateStats();
  updateSelStatus();
  render();
}
