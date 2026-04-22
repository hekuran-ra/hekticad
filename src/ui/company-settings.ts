/**
 * Firmeneinstellungen — project-wide company defaults.
 *
 * Fields live on `state.projectMeta` (persisted in localStorage). This modal
 * is the single place to edit them. The export dialog reads them but no
 * longer lets the user edit the logo/address inline — keeping the company
 * identity separate from per-export drawing metadata makes the export
 * dialog noticeably leaner.
 *
 * Fields:
 *   - Firmenlogo (upload / remove) — saved as data-URL
 *   - Firmenadresse — 3-line textarea
 *   - Standard-Autor — pre-filled into the export dialog's Autor field
 *
 * All changes commit together on OK. Cancel discards everything, even a
 * just-uploaded logo (kept local to `dsLocal` until commit).
 */

import { openModal } from '../modal';
import { state, saveProjectMeta } from '../state';
import { pickAndNormaliseLogo } from './logo-manager';
import { toast } from '../ui';

type LocalState = {
  logoDataUrl: string;
  companyAddress: string;
  defaultAuthor: string;
};

export async function showCompanySettings(): Promise<void> {
  // Copy the current meta so Cancel really discards. We don't commit to
  // state.projectMeta until OK.
  const meta = state.projectMeta;
  const dsLocal: LocalState = {
    logoDataUrl:    meta.logoDataUrl,
    companyAddress: meta.companyAddress,
    defaultAuthor:  meta.author,
  };

  const result = await openModal((close) => buildPanel(dsLocal, close));
  if (result !== 'ok') return;

  state.projectMeta.logoDataUrl    = dsLocal.logoDataUrl;
  state.projectMeta.companyAddress = dsLocal.companyAddress;
  state.projectMeta.author         = dsLocal.defaultAuthor;
  saveProjectMeta(state.projectMeta);
  toast('Firmeneinstellungen gespeichert');
}

function buildPanel(
  ds: LocalState,
  close: (reason: 'ok' | 'cancel') => void,
): HTMLElement {
  const panel = document.createElement('div');
  panel.classList.add('hk-modal-company');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-labelledby', 'hk-company-title');

  // ── Header ──
  const head = document.createElement('div');
  head.className = 'hk-modal-head';
  const title = document.createElement('div');
  title.className = 'hk-modal-title';
  title.id = 'hk-company-title';
  title.textContent = 'Firmeneinstellungen';
  head.appendChild(title);
  const msg = document.createElement('div');
  msg.className = 'hk-modal-msg';
  msg.textContent = 'Logo, Adresse und Standard-Autor werden in den Titelblock jedes Exports übernommen.';
  head.appendChild(msg);
  panel.appendChild(head);

  // ── Body ──
  const body = document.createElement('div');
  body.className = 'hk-modal-body hk-export-body';

  // Logo section
  body.appendChild(sectionLabel('Firmenlogo'));

  const logoArea = document.createElement('div');
  logoArea.className = 'hk-export-logo';

  const preview = document.createElement('div');
  preview.className = 'hk-export-logo-preview';

  const uploadBtn = document.createElement('button');
  uploadBtn.type = 'button';
  uploadBtn.className = 'hk-modal-btn hk-modal-btn-secondary';
  uploadBtn.textContent = 'Logo ändern';

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'hk-modal-btn hk-modal-btn-secondary';
  removeBtn.textContent = 'Entfernen';

  const renderLogo = (): void => {
    preview.innerHTML = '';
    if (ds.logoDataUrl) {
      const img = document.createElement('img');
      img.src = ds.logoDataUrl;
      img.alt = 'Logo';
      preview.appendChild(img);
      removeBtn.disabled = false;
    } else {
      const empty = document.createElement('span');
      empty.className = 'hk-export-logo-empty';
      empty.textContent = 'kein Logo';
      preview.appendChild(empty);
      removeBtn.disabled = true;
    }
  };

  uploadBtn.addEventListener('click', async () => {
    try {
      const next = await pickAndNormaliseLogo();
      if (next) {
        ds.logoDataUrl = next;
        renderLogo();
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      toast(`Logo-Upload: ${errMsg}`);
    }
  });
  removeBtn.addEventListener('click', () => {
    ds.logoDataUrl = '';
    renderLogo();
  });

  const btnStack = document.createElement('div');
  btnStack.className = 'hk-export-logo-btns';
  btnStack.append(uploadBtn, removeBtn);
  logoArea.append(preview, btnStack);
  body.appendChild(logoArea);

  renderLogo();

  // Address section
  body.appendChild(sectionLabel('Firmenadresse'));
  const addr = document.createElement('textarea');
  addr.className = 'hk-modal-input';
  addr.rows = 3;
  addr.placeholder = 'Firma\nStraße Nr.\nPLZ Ort';
  addr.value = ds.companyAddress;
  addr.addEventListener('input', () => { ds.companyAddress = addr.value; });
  body.appendChild(addr);

  // Default author section
  body.appendChild(sectionLabel('Standard-Autor'));
  const author = document.createElement('input');
  author.type = 'text';
  author.className = 'hk-modal-input';
  author.placeholder = 'Vor- und Nachname';
  author.value = ds.defaultAuthor;
  author.addEventListener('input', () => { ds.defaultAuthor = author.value; });
  body.appendChild(author);

  panel.appendChild(body);

  // ── Footer ──
  const actions = document.createElement('div');
  actions.className = 'hk-modal-actions';
  const cancel = mkBtn('Abbrechen', 'secondary', () => close('cancel'));
  const ok = mkBtn('Speichern', 'primary', () => close('ok'));
  actions.append(cancel, ok);
  panel.appendChild(actions);

  // Enter in the author input commits. Textarea keeps plain-Enter for newline.
  author.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      ev.stopPropagation();
      close('ok');
    }
  });

  queueMicrotask(() => {
    (ds.logoDataUrl ? addr : uploadBtn).focus();
  });

  return panel;
}

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
