/**
 * Export dialog.
 *
 * Flow:
 *   - Header button "Export" (or Cmd/Ctrl+Shift+E) calls `showExportDialog()`
 *   - User picks a format tab (PDF / DXF / EPS / SVG)
 *   - For PDF, extra controls appear: template select, metadata form,
 *     logo upload
 *   - For DXF/EPS/SVG, an info panel replaces the PDF-only controls
 *   - "Exportieren" button routes through `exportDrawing()` in io.ts
 *
 * State model: controlled inputs feed a local `DialogState` object. On
 * commit, the PDF-specific fields get merged into `state.projectMeta` and
 * persisted, so the next export (and next reload) pre-fills the same values.
 *
 * The dialog reuses the `openModal` harness from modal.ts (backdrop / focus
 * restore / Escape / queue). Its own DOM + styles live here + in styles.css
 * under `.hk-export-*`.
 */

import type { ExportFormat, ExportOptions, PdfTemplateId, TitleBlockData } from '../types';
import { openModal } from '../modal';
import { state, saveProjectMeta } from '../state';
import { exportDrawing } from '../io';
import { TEMPLATES } from '../io/templates';
import { showCompanySettings } from './company-settings';
import { toast } from '../ui';

type DialogState = {
  format: ExportFormat;
  template: PdfTemplateId;
  // Per-export fields — editable in this dialog. Company-wide fields
  // (companyAddress, logoDataUrl) are managed via Format → Firmeneinstellungen.
  projectName: string;
  drawingTitle: string;
  drawingNumber: string;
  author: string;
  revision: string;
};

/** Display order — SVG last because it's legacy. */
const FORMAT_TABS: Array<{ id: ExportFormat; label: string }> = [
  { id: 'pdf', label: 'PDF' },
  { id: 'dxf', label: 'DXF' },
  { id: 'eps', label: 'EPS' },
  { id: 'svg', label: 'SVG' },
];

/** Ordered template list for the select. Matches the display order in the dialog spec. */
const TEMPLATE_ORDER: PdfTemplateId[] = [
  'a4-landscape-1to50',
  'a4-landscape-1to100',
  'a4-portrait-fit',
  'a3-landscape-1to50',
  'a3-landscape-1to100',
  'a2-landscape-1to50',
  'custom-1to1',
];

// ────────────────────────────────────────────────────────────────────────────
// Public entry point
// ────────────────────────────────────────────────────────────────────────────

/**
 * Open the export dialog. Resolves when the user either commits an export
 * or dismisses the dialog. The modal harness handles Escape and backdrop
 * click; `exportDrawing` reports its own success/failure via toast.
 */
export async function showExportDialog(): Promise<void> {
  // Seed local dialog state from the persisted project meta.
  const meta = state.projectMeta;
  const ds: DialogState = {
    format: 'pdf',
    template: meta.lastTemplate,
    projectName:    meta.name,
    drawingTitle:   meta.drawingTitle,
    drawingNumber:  meta.drawingNumber,
    author:         meta.author,
    revision:       meta.revision,
  };

  await openModal((close) => buildPanel(ds, close));
}

// ────────────────────────────────────────────────────────────────────────────
// Panel construction
// ────────────────────────────────────────────────────────────────────────────

function buildPanel(ds: DialogState, close: (reason: 'ok' | 'cancel') => void): HTMLElement {
  const panel = document.createElement('div');
  panel.classList.add('hk-modal-export');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-labelledby', 'hk-export-title');

  // ── Header ──
  const head = document.createElement('div');
  head.className = 'hk-modal-head';
  const title = document.createElement('div');
  title.className = 'hk-modal-title';
  title.id = 'hk-export-title';
  title.textContent = 'Zeichnung exportieren';
  head.appendChild(title);
  panel.appendChild(head);

  // ── Body: tabs + dynamic section ──
  const body = document.createElement('div');
  body.className = 'hk-modal-body hk-export-body';

  // Format tabs
  const tabs = document.createElement('div');
  tabs.className = 'hk-export-tabs';
  const tabButtons: HTMLButtonElement[] = [];
  for (const t of FORMAT_TABS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'hk-export-tab';
    btn.textContent = t.label;
    btn.dataset.fmt = t.id;
    btn.addEventListener('click', () => {
      if (ds.format === t.id) return;
      ds.format = t.id;
      syncTabs();
      renderDynamic();
    });
    tabs.appendChild(btn);
    tabButtons.push(btn);
  }
  const syncTabs = (): void => {
    for (const b of tabButtons) {
      b.classList.toggle('active', b.dataset.fmt === ds.format);
    }
  };
  syncTabs();
  body.appendChild(tabs);

  // Dynamic section — swapped based on format
  const dynamic = document.createElement('div');
  dynamic.className = 'hk-export-dynamic';
  body.appendChild(dynamic);

  const renderDynamic = (): void => {
    dynamic.innerHTML = '';
    if (ds.format === 'pdf') {
      dynamic.appendChild(buildPdfControls(ds));
    } else {
      dynamic.appendChild(buildInfoPanel(ds.format));
    }
  };
  renderDynamic();

  panel.appendChild(body);

  // ── Footer: Cancel + Export ──
  const actions = document.createElement('div');
  actions.className = 'hk-modal-actions';
  const cancel = mkBtn('Abbrechen', 'secondary', () => close('cancel'));
  const submit = mkBtn('Exportieren', 'primary', async () => {
    submit.disabled = true;
    submit.textContent = 'Exportiere …';
    try {
      await commitExport(ds);
      close('ok');
    } catch (err) {
      submit.disabled = false;
      submit.textContent = 'Exportieren';
      console.error('[exportDialog]', err);
      toast(`Export fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  actions.append(cancel, submit);
  panel.appendChild(actions);

  // Submit on Enter anywhere except textareas (where Enter is a newline).
  panel.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    const target = ev.target as HTMLElement;
    if (target && target.tagName === 'TEXTAREA') return;
    ev.preventDefault();
    submit.click();
  });

  queueMicrotask(() => {
    // Focus the first tab so keyboard users have a sensible start.
    tabButtons[0].focus();
  });

  return panel;
}

// ────────────────────────────────────────────────────────────────────────────
// PDF-only controls: template select + metadata form + logo
// ────────────────────────────────────────────────────────────────────────────

function buildPdfControls(ds: DialogState): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'hk-export-pdf';

  // Template select
  wrap.appendChild(sectionLabel('Vorlage'));
  const tplSelect = document.createElement('select');
  tplSelect.className = 'hk-modal-input hk-export-select';
  for (const id of TEMPLATE_ORDER) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = TEMPLATES[id].label;
    if (id === ds.template) opt.selected = true;
    tplSelect.appendChild(opt);
  }
  tplSelect.addEventListener('change', () => {
    ds.template = tplSelect.value as PdfTemplateId;
  });
  wrap.appendChild(tplSelect);

  // Metadata form
  wrap.appendChild(sectionLabel('Metadaten'));
  const form = document.createElement('div');
  form.className = 'hk-export-form';

  const mkField = (label: string, key: keyof DialogState, placeholder?: string): void => {
    const row = document.createElement('label');
    row.className = 'hk-export-row';
    const labelEl = document.createElement('span');
    labelEl.className = 'hk-export-field-label';
    labelEl.textContent = label;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'hk-modal-input';
    input.value = String(ds[key] ?? '');
    if (placeholder) input.placeholder = placeholder;
    input.addEventListener('input', () => {
      // Type-wise, only string-valued keys call this. Cast is safe.
      (ds as Record<string, unknown>)[key] = input.value;
    });
    row.append(labelEl, input);
    form.appendChild(row);
  };

  mkField('Projekt',          'projectName',   'z.B. Einfamilienhaus Bergweg 3');
  mkField('Zeichnungstitel',  'drawingTitle',  'z.B. Grundriss EG');
  mkField('Zeichnungs-Nr.',   'drawingNumber', '001');
  mkField('Autor',            'author',        'Vor- und Nachname');
  mkField('Revision',         'revision',      'A');

  wrap.appendChild(form);

  // Company-wide fields (logo, Firmenadresse) are managed outside this dialog.
  // Show a small summary + a shortcut into the Firmeneinstellungen modal so
  // users know where to go when the title block is missing their logo.
  wrap.appendChild(sectionLabel('Firmendaten'));
  const companyRow = document.createElement('div');
  companyRow.className = 'hk-export-company-row';

  const summary = document.createElement('div');
  summary.className = 'hk-export-company-summary';
  const refreshSummary = (): void => {
    const meta = state.projectMeta;
    const bits: string[] = [];
    bits.push(meta.logoDataUrl ? 'Logo ✓' : 'kein Logo');
    bits.push(meta.companyAddress.trim() ? 'Adresse ✓' : 'keine Adresse');
    summary.textContent = bits.join(' · ');
  };
  refreshSummary();

  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'hk-modal-btn hk-modal-btn-secondary';
  editBtn.textContent = 'Bearbeiten…';
  editBtn.addEventListener('click', async () => {
    await showCompanySettings();
    refreshSummary();
  });

  companyRow.append(summary, editBtn);
  wrap.appendChild(companyRow);

  return wrap;
}

// ────────────────────────────────────────────────────────────────────────────
// Info panels for non-PDF formats
// ────────────────────────────────────────────────────────────────────────────

function buildInfoPanel(fmt: Exclude<ExportFormat, 'pdf'>): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'hk-export-info';
  const lines = infoLinesFor(fmt);
  for (const line of lines) {
    const p = document.createElement('div');
    p.className = 'hk-export-info-line';
    p.textContent = line;
    wrap.appendChild(p);
  }
  return wrap;
}

function infoLinesFor(fmt: Exclude<ExportFormat, 'pdf'>): string[] {
  switch (fmt) {
    case 'dxf':
      return [
        'DXF wird 1:1 in Weltkoordinaten (mm) exportiert.',
        'Kein Titelblock, keine Skala, keine Vorlage.',
        'Einheiten-Flag: Millimeter ($INSUNITS = 4) — öffnet in LibreCAD, QCAD, AutoCAD.',
      ];
    case 'eps':
      return [
        'EPS wird 1:1 in Weltkoordinaten (mm) exportiert (PostScript Level 2).',
        'Kein Titelblock, keine Skala. Text und Bemaßungen werden übersprungen.',
        'Öffnet in Adobe Illustrator, Inkscape, Ghostscript.',
      ];
    case 'svg':
      return [
        'SVG wird 1:1 in Weltkoordinaten (mm) exportiert.',
        'Kein Titelblock, keine Skala, keine Vorlage.',
        'Layer-Farben werden übernommen — öffnet in jedem Browser und Inkscape.',
      ];
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Commit — persist project meta, trigger export
// ────────────────────────────────────────────────────────────────────────────

async function commitExport(ds: DialogState): Promise<void> {
  // Persist per-export fields so the dialog remembers what the user typed.
  // Company-wide fields (logoDataUrl, companyAddress) are NOT touched here —
  // they're owned by the Firmeneinstellungen modal.
  state.projectMeta.name           = ds.projectName;
  state.projectMeta.drawingTitle   = ds.drawingTitle;
  state.projectMeta.drawingNumber  = ds.drawingNumber;
  state.projectMeta.author         = ds.author;
  state.projectMeta.revision       = ds.revision;
  state.projectMeta.lastTemplate   = ds.template;
  saveProjectMeta(state.projectMeta);

  const opts = buildExportOptions(ds);
  await exportDrawing(opts);
}

function buildExportOptions(ds: DialogState): ExportOptions {
  switch (ds.format) {
    case 'pdf': {
      // Company-wide fields come straight from projectMeta, not from `ds`.
      const meta = state.projectMeta;
      const titleBlock: TitleBlockData = {
        projectName:    ds.projectName,
        drawingTitle:   ds.drawingTitle,
        drawingNumber:  ds.drawingNumber,
        author:         ds.author,
        revision:       ds.revision,
        companyAddress: meta.companyAddress,
        logoDataUrl:    meta.logoDataUrl,
        // `format`, `scale`, `date` are filled by the PDF exporter from the
        // resolved template unless the caller sets them — we leave them blank.
      };
      return { format: 'pdf', template: ds.template, titleBlock };
    }
    case 'dxf': return { format: 'dxf' };
    case 'eps': return { format: 'eps' };
    case 'svg': return { format: 'svg' };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// DOM helpers (local to this module)
// ────────────────────────────────────────────────────────────────────────────

function sectionLabel(text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'hk-export-section-label';
  el.textContent = text;
  return el;
}

function mkBtn(label: string, variant: 'primary' | 'secondary', onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `hk-modal-btn hk-modal-btn-${variant}`;
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}
