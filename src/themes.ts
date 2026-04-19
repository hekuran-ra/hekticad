// ════════════════════════════════════════════════════════════════
// Themes: 3 Presets + Custom-Color-Overrides
//
// A theme is a partial map of CSS custom properties that override the
// :root defaults in styles.css. `current` composes { preset, overrides }
// so the user can pick a preset as a starting point and then tweak
// individual accent colours on top. Persisted in localStorage.
// ════════════════════════════════════════════════════════════════

import { requestRender } from './render';

export type ThemeVar =
  | '--bg' | '--bg-deep' | '--panel' | '--panel-2' | '--panel-3'
  | '--hair' | '--hair-soft'
  | '--fg' | '--fg-mid' | '--fg-dim' | '--fg-faint'
  | '--accent' | '--guides' | '--draw' | '--modify' | '--sel'
  | '--grid' | '--grid-maj' | '--snap-col';

export type ThemeMap = Partial<Record<ThemeVar, string>>;

export type ThemePresetId = 'dark' | 'light' | 'contrast';

export const PRESETS: Record<ThemePresetId, { label: string; vars: ThemeMap }> = {
  dark: {
    label: 'Graphit',
    vars: {
      '--bg':        '#0b0e13',
      '--bg-deep':   '#05070a',
      '--panel':     '#0f1218',
      '--panel-2':   '#151921',
      '--panel-3':   '#1c2029',
      '--hair':      '#242932',
      '--hair-soft': '#1a1e26',
      '--fg':        '#e6eaf2',
      '--fg-mid':    '#8a92a3',
      '--fg-dim':    '#5a6271',
      '--fg-faint':  '#363c47',
      '--accent':    '#4cc2ff',
      '--guides':    '#2dd4bf',
      '--draw':      '#f5a524',
      '--modify':    '#e05a4a',
      '--sel':       '#4cc2ff',
      '--grid':      '#11151c',
      '--grid-maj':  '#1d232d',
      '--snap-col':  '#2dd4bf',
    },
  },
  light: {
    label: 'Blaupause',
    vars: {
      '--bg':        '#eef2f6',
      '--bg-deep':   '#f8fafc',
      '--panel':     '#ffffff',
      '--panel-2':   '#eef2f6',
      '--panel-3':   '#e0e6ed',
      '--hair':      '#c9d2de',
      '--hair-soft': '#dce3eb',
      '--fg':        '#1a2230',
      '--fg-mid':    '#556175',
      '--fg-dim':    '#8a94a6',
      '--fg-faint':  '#b6bdca',
      '--accent':    '#0077c8',
      '--guides':    '#0d8a76',
      '--draw':      '#b76b00',
      '--modify':    '#b43d2b',
      '--sel':       '#0077c8',
      '--grid':      '#e4ebf3',
      '--grid-maj':  '#cfd8e2',
      '--snap-col':  '#0d8a76',
    },
  },
  contrast: {
    label: 'Hoher Kontrast',
    vars: {
      '--bg':        '#000000',
      '--bg-deep':   '#000000',
      '--panel':     '#05070a',
      '--panel-2':   '#0f141c',
      '--panel-3':   '#1a2029',
      '--hair':      '#3a4452',
      '--hair-soft': '#232b36',
      '--fg':        '#ffffff',
      '--fg-mid':    '#c8d1dd',
      '--fg-dim':    '#8f99a6',
      '--fg-faint':  '#5a6572',
      '--accent':    '#00d4ff',
      '--guides':    '#00ffb3',
      '--draw':      '#ffb020',
      '--modify':    '#ff5a46',
      '--sel':       '#00d4ff',
      '--grid':      '#101820',
      '--grid-maj':  '#2a3542',
      '--snap-col':  '#00ffb3',
    },
  },
};

/** Subset shown in the custom-color panel — the "brand" colors users actually tweak. */
const CUSTOMIZABLE: { key: ThemeVar; label: string }[] = [
  { key: '--accent',   label: 'Akzent' },
  { key: '--draw',     label: 'Zeichnen' },
  { key: '--guides',   label: 'Hilfen' },
  { key: '--modify',   label: 'Ändern' },
  { key: '--fg',       label: 'Text' },
  { key: '--bg',       label: 'Hintergrund' },
  { key: '--panel',    label: 'Panel' },
  { key: '--snap-col', label: 'Snap' },
];

const STORAGE_KEY = 'hekticad.theme.v1';

type Saved = { preset: ThemePresetId; overrides: ThemeMap };

function loadSaved(): Saved {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { preset: 'dark', overrides: {} };
    const parsed = JSON.parse(raw) as Partial<Saved>;
    const preset: ThemePresetId = (parsed.preset && parsed.preset in PRESETS) ? parsed.preset : 'dark';
    const overrides: ThemeMap = (parsed.overrides && typeof parsed.overrides === 'object') ? parsed.overrides : {};
    return { preset, overrides };
  } catch {
    return { preset: 'dark', overrides: {} };
  }
}

function persist(s: Saved): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

let state: Saved = loadSaved();

/** Write vars onto :root. Overrides win over preset. Canvas re-render picks up --grid, --snap etc. */
function applyTheme(): void {
  const root = document.documentElement;
  const merged: ThemeMap = { ...PRESETS[state.preset].vars, ...state.overrides };
  for (const [k, v] of Object.entries(merged)) {
    if (v) root.style.setProperty(k, v);
  }
  root.classList.toggle('theme-light', state.preset === 'light');
  root.classList.toggle('theme-contrast', state.preset === 'contrast');
  root.classList.toggle('theme-dark', state.preset === 'dark');
  requestRender();
}

function effective(key: ThemeVar): string {
  if (state.overrides[key]) return state.overrides[key]!;
  const p = PRESETS[state.preset].vars[key];
  if (p) return p;
  const cs = getComputedStyle(document.documentElement).getPropertyValue(key).trim();
  return cs || '#000000';
}

function normalizeHex(value: string): string {
  const v = value.trim();
  return /^#[0-9a-f]{6}$/i.test(v) ? v : '#000000';
}

function buildPopoverBody(pop: HTMLElement): void {
  pop.innerHTML = '';

  const presetsRow = document.createElement('div');
  presetsRow.className = 'theme-presets';
  const presetsLabel = document.createElement('div');
  presetsLabel.className = 'theme-section-label';
  presetsLabel.textContent = 'Preset';
  pop.appendChild(presetsLabel);
  pop.appendChild(presetsRow);

  (Object.keys(PRESETS) as ThemePresetId[]).forEach(id => {
    const p = PRESETS[id];
    const btn = document.createElement('button');
    btn.className = 'theme-preset-tile';
    btn.dataset.preset = id;
    if (id === state.preset) btn.classList.add('on');
    btn.innerHTML = `
      <div class="theme-preset-sw">
        <span style="background:${p.vars['--bg'] ?? '#000'}"></span>
        <span style="background:${p.vars['--panel'] ?? '#111'}"></span>
        <span style="background:${p.vars['--accent'] ?? '#4cc2ff'}"></span>
        <span style="background:${p.vars['--guides'] ?? '#2dd4bf'}"></span>
      </div>
      <div class="theme-preset-name">${p.label}</div>
    `;
    btn.onclick = () => {
      state.preset = id;
      persist(state);
      applyTheme();
      buildPopoverBody(pop);
    };
    presetsRow.appendChild(btn);
  });

  const colorsLabel = document.createElement('div');
  colorsLabel.className = 'theme-section-label';
  colorsLabel.textContent = 'Eigene Farben';
  pop.appendChild(colorsLabel);

  const grid = document.createElement('div');
  grid.className = 'theme-color-grid';
  CUSTOMIZABLE.forEach(({ key, label }) => {
    const row = document.createElement('label');
    row.className = 'theme-color-row';
    const lab = document.createElement('span');
    lab.className = 'theme-color-label';
    lab.textContent = label;
    const input = document.createElement('input');
    input.type = 'color';
    input.className = 'theme-color-input';
    input.value = normalizeHex(effective(key));
    input.oninput = () => {
      state.overrides[key] = input.value;
      persist(state);
      applyTheme();
    };
    const reset = document.createElement('button');
    reset.className = 'theme-color-reset';
    reset.type = 'button';
    reset.title = `${label} zurücksetzen`;
    reset.textContent = '↺';
    reset.onclick = (ev) => {
      ev.preventDefault();
      delete state.overrides[key];
      persist(state);
      applyTheme();
      input.value = normalizeHex(effective(key));
    };
    row.appendChild(lab);
    row.appendChild(input);
    row.appendChild(reset);
    grid.appendChild(row);
  });
  pop.appendChild(grid);

  const actions = document.createElement('div');
  actions.className = 'theme-actions';
  const resetAll = document.createElement('button');
  resetAll.className = 'mini-btn';
  resetAll.textContent = 'Alle eigenen Farben zurücksetzen';
  resetAll.onclick = () => {
    state.overrides = {};
    persist(state);
    applyTheme();
    buildPopoverBody(pop);
  };
  actions.appendChild(resetAll);
  pop.appendChild(actions);
}

export function initThemes(): void {
  applyTheme();

  const btn = document.getElementById('btn-theme');
  const pop = document.getElementById('theme-popover');
  if (!btn || !pop) return;

  const open = (): void => {
    buildPopoverBody(pop);
    pop.hidden = false;
    const r = btn.getBoundingClientRect();
    pop.style.top = `${Math.round(r.bottom + 6)}px`;
    pop.style.right = `${Math.max(8, Math.round(window.innerWidth - r.right))}px`;
    btn.classList.add('active');
  };
  const close = (): void => {
    pop.hidden = true;
    btn.classList.remove('active');
  };

  btn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (pop.hidden) open(); else close();
  });
  document.addEventListener('mousedown', (ev) => {
    if (pop.hidden) return;
    const t = ev.target as Node | null;
    if (!t) return;
    if (pop.contains(t) || btn.contains(t)) return;
    close();
  });
  window.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !pop.hidden) close();
  });
}
