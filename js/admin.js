// ── Admin panel ───────────────────────────────────────────────────────────────
// Light-touch gated editor for the Firebase program catalog.
// Login = any name + passcode "Budgets". Edits write straight to Firebase.

import { fetchRawPrograms, saveProgram, deleteProgram } from './firebase.js';
import { showScreen, openModal, closeModal } from './ui.js';

const PASSCODE = 'Budgets';

const COST_BASES = ['Flat Fee', 'Per Unit', 'Per Item', 'Tiered', 'Flat + Per Unit', 'Manual'];
const BILLING    = ['monthly', 'quarterly', 'bi-annual', 'annual', 'as-incurred', 'one-time'];
const TIER_TYPES = ['flat', 'per-unit-month', 'per-unit-year', 'per-item'];
const SYSTEMS    = [['Yardi', 'Yardi'], ['OneSite', 'OneSite'], ['PaceOneSite', 'Pace + OneSite']];
const MONTHS     = ['January','February','March','April','May','June','July','August','September','October','November','December'];

let adminName = '';
let rawCache  = {};        // id → raw program object
let editingId = null;      // null = new program
let form      = {};        // working copy being edited

const money = n => isNaN(n) ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(n);

// ── Boot wiring ────────────────────────────────────────────────────────────────
export function initAdmin() {
  document.getElementById('btn-admin-entry')?.addEventListener('click', () => {
    document.getElementById('admin-login-error').textContent = '';
    document.getElementById('admin-name').value = '';
    document.getElementById('admin-pass').value = '';
    openModal('modal-admin-login');
  });

  document.getElementById('btn-admin-login-cancel')?.addEventListener('click', () => closeModal('modal-admin-login'));
  document.getElementById('btn-admin-login')?.addEventListener('click', tryLogin);
  document.getElementById('admin-pass')?.addEventListener('keydown', e => { if (e.key === 'Enter') tryLogin(); });

  document.getElementById('btn-admin-back')?.addEventListener('click', () => showScreen('screen-setup'));
  document.getElementById('btn-admin-add')?.addEventListener('click', () => openEditor(null));
}

function tryLogin() {
  const name = document.getElementById('admin-name').value.trim();
  const pass = document.getElementById('admin-pass').value;
  if (pass !== PASSCODE) {
    document.getElementById('admin-login-error').textContent = 'Incorrect passcode.';
    return;
  }
  if (!name) {
    document.getElementById('admin-login-error').textContent = 'Please enter your name.';
    return;
  }
  adminName = name;
  closeModal('modal-admin-login');
  openAdmin();
}

// ── Program list ─────────────────────────────────────────────────────────────
async function openAdmin() {
  showScreen('screen-admin');
  document.getElementById('admin-user-note').textContent = `Signed in as ${adminName} · changes save to Firebase for everyone`;
  await renderList();
}

async function renderList() {
  const list = document.getElementById('admin-list');
  list.innerHTML = '<p class="admin-loading">Loading programs…</p>';
  try {
    rawCache = await fetchRawPrograms();
  } catch (e) {
    list.innerHTML = `<p class="admin-loading">Error loading: ${e.message}</p>`;
    return;
  }

  const entries = Object.entries(rawCache);
  // Group by department
  const byDept = {};
  entries.forEach(([id, p]) => {
    const d = p.department || 'Other';
    (byDept[d] = byDept[d] || []).push([id, p]);
  });

  const depts = Object.keys(byDept).sort();
  list.innerHTML = depts.map(dept => `
    <div class="admin-dept">
      <div class="admin-dept-title">${dept} <span class="admin-dept-count">${byDept[dept].length}</span></div>
      ${byDept[dept]
        .sort((a, b) => (a[1].name || '').localeCompare(b[1].name || ''))
        .map(([id, p]) => `
        <div class="admin-row" data-id="${id}">
          <div class="admin-row-main">
            <div class="admin-row-name">${p.name || '(unnamed)'}</div>
            <div class="admin-row-meta">${p.costBasis || 'Manual'} · ${p.elective === false ? 'Non-elective' : 'Elective'} · ${p.billingPeriod || '—'}</div>
          </div>
          <button class="btn-admin-edit" data-id="${id}">Edit</button>
        </div>`).join('')}
    </div>`).join('');

  list.querySelectorAll('.btn-admin-edit').forEach(btn =>
    btn.addEventListener('click', () => openEditor(btn.dataset.id)));
}

// ── Editor ─────────────────────────────────────────────────────────────────────
function blankProgram() {
  return {
    name: '', department: '', elective: true, costBasis: 'Flat Fee',
    rate: '', itemLabel: '', baseFee: '', options: [],
    billingPeriod: 'monthly', billingStart: 'January',
    systems: ['Yardi', 'OneSite', 'PaceOneSite'],
    setupFee: '', costRaw: '', description: '', resourceUrl: '',
    yardiGL: '', onesiteGL: '', paceGL: '', owner: '',
  };
}

function openEditor(id) {
  editingId = id;
  form = id
    ? { ...blankProgram(), ...structuredClone(rawCache[id]) }
    : blankProgram();
  if (!Array.isArray(form.options)) form.options = [];
  buildEditor();
  openModal('modal-admin-editor');
}

function deptOptions(selected) {
  const depts = [...new Set(Object.values(rawCache).map(p => p.department).filter(Boolean))].sort();
  return depts.map(d => `<option value="${d}"${d === selected ? ' selected' : ''}>${d}</option>`).join('');
}

function buildEditor() {
  const body = document.getElementById('admin-editor-body');
  const cb = form.costBasis;

  const showRate    = ['Flat Fee', 'Per Unit', 'Per Item', 'Flat + Per Unit'].includes(cb);
  const showItem    = cb === 'Per Item';
  const showBase    = cb === 'Flat + Per Unit';
  const showTiers   = cb === 'Tiered';

  body.innerHTML = `
    <div class="admin-editor-head">
      <h3>${editingId ? 'Edit Program' : 'New Program'}</h3>
      <button class="admin-editor-close" id="ae-close">✕</button>
    </div>

    <div class="ae-grid">
      <label class="ae-field ae-wide">
        <span>Program name</span>
        <input id="ae-name" type="text" value="${esc(form.name)}" placeholder="e.g. Elevator Management Services">
      </label>

      <label class="ae-field">
        <span>Department</span>
        <input id="ae-department" list="ae-dept-list" type="text" value="${esc(form.department)}" placeholder="Department">
        <datalist id="ae-dept-list">${deptOptions(form.department)}</datalist>
      </label>

      <label class="ae-field">
        <span>Type</span>
        <select id="ae-elective">
          <option value="false"${form.elective === false ? ' selected' : ''}>Non-elective (required)</option>
          <option value="true"${form.elective !== false ? ' selected' : ''}>Elective</option>
        </select>
      </label>

      <label class="ae-field">
        <span>Cost basis</span>
        <select id="ae-costBasis">
          ${COST_BASES.map(c => `<option value="${c}"${c === cb ? ' selected' : ''}>${c}</option>`).join('')}
        </select>
      </label>

      <label class="ae-field">
        <span>Billing frequency</span>
        <select id="ae-billingPeriod">
          ${BILLING.map(b => `<option value="${b}"${b === form.billingPeriod ? ' selected' : ''}>${b}</option>`).join('')}
        </select>
      </label>

      ${showRate ? `
      <label class="ae-field">
        <span>Rate ($)</span>
        <input id="ae-rate" type="number" step="0.01" min="0" value="${esc(form.rate)}" placeholder="0.00">
      </label>` : ''}

      ${showItem ? `
      <label class="ae-field">
        <span>Item label (what's counted)</span>
        <input id="ae-itemLabel" type="text" value="${esc(form.itemLabel)}" placeholder="e.g. Elevator, Device, Account">
      </label>` : ''}

      ${showBase ? `
      <label class="ae-field">
        <span>Base fee ($)</span>
        <input id="ae-baseFee" type="number" step="0.01" min="0" value="${esc(form.baseFee)}" placeholder="0.00">
      </label>` : ''}

      ${form.billingPeriod !== 'monthly' && form.billingPeriod !== 'as-incurred' ? `
      <label class="ae-field">
        <span>Bills in month</span>
        <select id="ae-billingStart">
          <option value="When Implemented"${/implement|transition|anniversar/i.test(form.billingStart || '') ? ' selected' : ''}>Follows transition (when implemented)</option>
          ${MONTHS.map(m => `<option value="${m}"${(form.billingStart || '').toLowerCase().includes(m.toLowerCase()) ? ' selected' : ''}>${m} (fixed — missed if transition is later)</option>`).join('')}
        </select>
      </label>` : ''}

      <label class="ae-field ae-wide">
        <span>Applies to systems</span>
        <div class="ae-systems">
          ${SYSTEMS.map(([val, label]) => `
            <label class="ae-sys-chip${(form.systems || []).includes(val) ? ' on' : ''}">
              <input type="checkbox" class="ae-sys" value="${val}"${(form.systems || []).includes(val) ? ' checked' : ''}> ${label}
            </label>`).join('')}
        </div>
      </label>

      <label class="ae-field ae-wide">
        <span>Cost summary (shown on the card)</span>
        <input id="ae-costRaw" type="text" value="${esc(form.costRaw)}" placeholder="e.g. $20 per elevator / month">
      </label>
    </div>

    ${showTiers ? `
    <div class="ae-tiers">
      <div class="ae-tiers-head"><span>Options / Tiers</span><button class="ae-tier-add" id="ae-tier-add">+ Add option</button></div>
      ${(form.options || []).map((o, i) => `
        <div class="ae-tier-row" data-i="${i}">
          <input class="ae-tier-label" data-i="${i}" type="text" value="${esc(o.label)}" placeholder="Label (e.g. Basic)">
          <input class="ae-tier-rate" data-i="${i}" type="number" step="0.01" value="${esc(o.rate)}" placeholder="Rate">
          <select class="ae-tier-type" data-i="${i}">
            ${TIER_TYPES.map(t => `<option value="${t}"${t === o.type ? ' selected' : ''}>${t}</option>`).join('')}
          </select>
          <button class="ae-tier-del" data-i="${i}">✕</button>
        </div>`).join('')}
    </div>` : ''}

    <details class="ae-more">
      <summary>GL codes, owner, links & details</summary>
      <div class="ae-grid">
        <label class="ae-field"><span>Yardi GL</span><input id="ae-yardiGL" type="text" value="${esc(form.yardiGL)}"></label>
        <label class="ae-field"><span>OneSite GL</span><input id="ae-onesiteGL" type="text" value="${esc(form.onesiteGL)}"></label>
        <label class="ae-field"><span>Pace GL</span><input id="ae-paceGL" type="text" value="${esc(form.paceGL)}"></label>
        <label class="ae-field"><span>Program owner</span><input id="ae-owner" type="text" value="${esc(form.owner)}"></label>
        <label class="ae-field ae-wide"><span>Setup fee (description)</span><input id="ae-setupFee" type="text" value="${esc(form.setupFee)}" placeholder="e.g. $750 flat fee at implementation"></label>
        <label class="ae-field ae-wide"><span>Program guide URL</span><input id="ae-resourceUrl" type="text" value="${esc(form.resourceUrl)}" placeholder="https://…"></label>
        <label class="ae-field ae-wide"><span>Description</span><textarea id="ae-description" rows="2">${esc(form.description)}</textarea></label>
      </div>
    </details>

    <div class="ae-preview" id="ae-preview"></div>

    <div class="ae-actions">
      ${editingId ? '<button class="btn-danger ae-delete" id="ae-delete">Delete</button>' : '<span></span>'}
      <div class="ae-actions-right">
        <button class="btn-ghost" id="ae-cancel">Cancel</button>
        <button class="btn-primary" id="ae-save">${editingId ? 'Save changes' : 'Create program'}</button>
      </div>
    </div>
  `;

  wireEditor();
  updatePreview();
}

function wireEditor() {
  const bind = (id, key, transform = v => v) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', e => { form[key] = transform(e.target.value); updatePreview(); });
  };
  bind('ae-name', 'name');
  bind('ae-department', 'department');
  bind('ae-rate', 'rate');
  bind('ae-itemLabel', 'itemLabel');
  bind('ae-baseFee', 'baseFee');
  bind('ae-billingStart', 'billingStart');
  bind('ae-costRaw', 'costRaw');
  bind('ae-yardiGL', 'yardiGL');
  bind('ae-onesiteGL', 'onesiteGL');
  bind('ae-paceGL', 'paceGL');
  bind('ae-owner', 'owner');
  bind('ae-setupFee', 'setupFee');
  bind('ae-resourceUrl', 'resourceUrl');
  bind('ae-description', 'description');

  document.getElementById('ae-elective').addEventListener('change', e => { form.elective = e.target.value === 'true'; });
  document.getElementById('ae-billingPeriod').addEventListener('change', e => { form.billingPeriod = e.target.value; buildEditor(); });
  document.getElementById('ae-costBasis').addEventListener('change', e => { form.costBasis = e.target.value; buildEditor(); });
  document.getElementById('ae-billingStart')?.addEventListener('change', e => { form.billingStart = e.target.value; updatePreview(); });

  // Systems checkboxes
  document.querySelectorAll('.ae-sys').forEach(cb => cb.addEventListener('change', () => {
    form.systems = [...document.querySelectorAll('.ae-sys')].filter(x => x.checked).map(x => x.value);
    document.querySelectorAll('.ae-sys-chip').forEach(ch =>
      ch.classList.toggle('on', ch.querySelector('.ae-sys').checked));
  }));

  // Tier repeater
  document.getElementById('ae-tier-add')?.addEventListener('click', () => {
    form.options.push({ label: '', rate: '', type: 'flat' });
    buildEditor();
  });
  document.querySelectorAll('.ae-tier-del').forEach(b =>
    b.addEventListener('click', () => { form.options.splice(+b.dataset.i, 1); buildEditor(); }));
  document.querySelectorAll('.ae-tier-label').forEach(el =>
    el.addEventListener('input', e => { form.options[+el.dataset.i].label = e.target.value; }));
  document.querySelectorAll('.ae-tier-rate').forEach(el =>
    el.addEventListener('input', e => { form.options[+el.dataset.i].rate = e.target.value; updatePreview(); }));
  document.querySelectorAll('.ae-tier-type').forEach(el =>
    el.addEventListener('change', e => { form.options[+el.dataset.i].type = e.target.value; updatePreview(); }));

  document.getElementById('ae-close').addEventListener('click', () => closeModal('modal-admin-editor'));
  document.getElementById('ae-cancel').addEventListener('click', () => closeModal('modal-admin-editor'));
  document.getElementById('ae-save').addEventListener('click', save);
  document.getElementById('ae-delete')?.addEventListener('click', removeProgram);
}

// ── Live preview at a sample size ──────────────────────────────────────────────
function updatePreview() {
  const el = document.getElementById('ae-preview');
  if (!el) return;
  const units = 100;
  const rate  = parseFloat(form.rate) || 0;
  const base  = parseFloat(form.baseFee) || 0;
  const mo    = form.billingPeriod === 'monthly';
  let annual = 0, note = '';

  switch (form.costBasis) {
    case 'Flat Fee':
      annual = mo ? rate * 12 : rate;
      note = `${money(rate)} ${mo ? '/mo → ' + money(annual) + '/yr' : '/yr'}`;
      break;
    case 'Per Unit':
      annual = mo ? rate * units * 12 : rate * units;
      note = `${money(rate)}/unit${mo ? '/mo' : '/yr'} × ${units} units → ${money(annual)}/yr`;
      break;
    case 'Per Item':
      note = `${money(rate)} per ${form.itemLabel || 'item'}${mo ? '/mo' : '/yr'} (× count entered by PM)`;
      break;
    case 'Flat + Per Unit': {
      const pu = mo ? rate * units * 12 : rate * units;
      annual = base + pu;
      note = `${money(base)} base + ${money(rate)}/unit × ${units} → ${money(annual)}/yr`;
      break;
    }
    case 'Tiered': {
      const first = form.options[0] || {};
      note = `${form.options.length} option(s). First: ${first.label || '—'} @ ${money(parseFloat(first.rate) || 0)}`;
      break;
    }
    default:
      note = 'Manual — PM enters the dollar amount.';
  }
  el.innerHTML = `<span class="ae-preview-label">Preview (at ${units} units)</span> ${note}`;
}

// ── Save / delete ────────────────────────────────────────────────────────────
function slugify(name) {
  return (name || 'program').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'program';
}

function cleanNum(v) { const n = parseFloat(v); return isNaN(n) ? null : n; }

async function save() {
  if (!form.name.trim()) { alert('Program name is required.'); return; }

  const data = {
    name: form.name.trim(),
    department: form.department.trim() || 'Other',
    elective: form.elective === true,
    costBasis: form.costBasis,
    rate: cleanNum(form.rate),
    itemLabel: form.itemLabel || null,
    baseFee: cleanNum(form.baseFee),
    options: (form.costBasis === 'Tiered')
      ? form.options.filter(o => o.label).map(o => ({ label: o.label, rate: cleanNum(o.rate) || 0, type: o.type || 'flat' }))
      : [],
    billingPeriod: form.billingPeriod,
    billingStart: form.billingStart || null,
    systems: (Array.isArray(form.systems) && form.systems.length) ? form.systems : ['Yardi', 'OneSite', 'PaceOneSite'],
    setupFee: form.setupFee || null,
    costRaw: form.costRaw || null,
    description: form.description || null,
    resourceUrl: form.resourceUrl || null,
    yardiGL: form.yardiGL || null,
    onesiteGL: form.onesiteGL || null,
    paceGL: form.paceGL || null,
    owner: form.owner || null,
    lastEditedBy: adminName,
    lastEditedAt: new Date().toISOString(),
  };

  let id = editingId;
  if (!id) {
    id = slugify(form.name);
    let n = 2;
    while (rawCache[id]) { id = `${slugify(form.name)}-${n++}`; }
  }

  const btn = document.getElementById('ae-save');
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    await saveProgram(id, data);
    closeModal('modal-admin-editor');
    await renderList();
  } catch (e) {
    alert('Save failed: ' + e.message);
    btn.disabled = false; btn.textContent = editingId ? 'Save changes' : 'Create program';
  }
}

async function removeProgram() {
  if (!editingId) return;
  if (!confirm(`Delete "${form.name}"? This removes it for everyone and cannot be undone.`)) return;
  try {
    await deleteProgram(editingId);
    closeModal('modal-admin-editor');
    await renderList();
  } catch (e) {
    alert('Delete failed: ' + e.message);
  }
}

function esc(v) {
  if (v == null) return '';
  return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
