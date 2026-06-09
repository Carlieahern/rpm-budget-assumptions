// ── Admin panel ───────────────────────────────────────────────────────────────
// Light-touch gated editor for the Firebase program catalog.
// Login = any name + passcode "Budgets". Edits write straight to Firebase.

import { fetchRawPrograms, saveProgram, deleteProgram, fetchCostBasisTypes, addCostBasisType } from './firebase.js';
import { showScreen, openModal, closeModal } from './ui.js';

const PASSCODE = 'Budgets';

const STRUCTURED_BASES = ['Flat Fee', 'Per Unit', 'Per Item', 'Tiered', 'Flat + Per Unit', 'Manual'];
const BASIS_LABELS = { 'Tiered': 'Options / Packages' };   // display label overrides
const basisLabel = (c) => BASIS_LABELS[c] || c;
let extraTypes = [];   // admin-added cost-basis type names (formula-driven)
const ADD_NEW = '➕ Add new type…';
// True when this cost basis uses a custom formula (Custom Formula or any added type)
const isFormulaType = (cb) => cb === 'Custom Formula' || (!STRUCTURED_BASES.includes(cb) && cb !== ADD_NEW);
const BILLING    = ['monthly', 'quarterly', 'bi-annual', 'annual', 'as-incurred', 'one-time'];
const TIER_TYPES = ['flat', 'per-unit-month', 'per-unit-year', 'per-item'];
const SYSTEMS    = [['Yardi', 'Yardi'], ['OneSite', 'OneSite'], ['PaceOneSite', 'Pace + OneSite']];
const MONTHS     = ['January','February','March','April','May','June','July','August','September','October','November','December'];

let adminName     = '';
let rawCache      = {};    // id → raw program object
let editingId     = null;  // null = new program
let form          = {};    // working copy being edited
let afterSave     = null;  // callback run after a save/delete (varies by entry point)
let loginCallback = null;  // run after a successful login (inline mode)
let adminAuthed   = false;

export function isAdminAuthed() { return adminAuthed; }
export function adminUserName()  { return adminName; }

const money = n => isNaN(n) ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(n);

// ── Boot wiring ────────────────────────────────────────────────────────────────
export function initAdmin() {
  // The setup-screen "Admin" link is wired by app.js to enter inline admin mode.
  document.getElementById('btn-admin-login-cancel')?.addEventListener('click', () => closeModal('modal-admin-login'));
  document.getElementById('btn-admin-login')?.addEventListener('click', tryLogin);
  document.getElementById('admin-pass')?.addEventListener('keydown', e => { if (e.key === 'Enter') tryLogin(); });

  document.getElementById('btn-admin-back')?.addEventListener('click', () => showScreen('screen-setup'));
  document.getElementById('btn-admin-add')?.addEventListener('click', () => { afterSave = renderList; openEditor(null); });

  // Import
  document.getElementById('btn-admin-import')?.addEventListener('click', openImport);
  document.getElementById('imp-close')?.addEventListener('click', () => closeModal('modal-import'));
  document.getElementById('imp-cancel')?.addEventListener('click', () => closeModal('modal-import'));
  document.getElementById('imp-file')?.addEventListener('change', handleImportFile);
  document.getElementById('imp-parse-paste')?.addEventListener('click', () => {
    ingestImport(parseTable(document.getElementById('imp-paste').value || ''));
  });
  document.getElementById('imp-commit')?.addEventListener('click', commitImport);
  document.getElementById('imp-template')?.addEventListener('click', downloadImportTemplate);
  document.getElementById('imp-export')?.addEventListener('click', exportProgramsCsv);
  document.getElementById('imp-guide-toggle')?.addEventListener('click', () => {
    const g = document.getElementById('imp-guide');
    g.style.display = g.style.display === 'none' ? 'block' : 'none';
  });
}

// Open the login modal; on success run cb (used for inline dashboard admin mode)
export function promptAdminLogin(cb) {
  loginCallback = cb || null;
  document.getElementById('admin-login-error').textContent = '';
  document.getElementById('admin-name').value = adminName || '';
  document.getElementById('admin-pass').value = '';
  openModal('modal-admin-login');
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
  adminAuthed = true;
  closeModal('modal-admin-login');
  try { fetchCostBasisTypes().then(t => extraTypes = t || []).catch(() => {}); } catch {}
  if (loginCallback) { const cb = loginCallback; loginCallback = null; cb(); }
  else openAdmin();
}

// ── Inline editing (from the live dashboard) ──────────────────────────────────
export async function editProgram(id, onDone) {
  try { rawCache = await fetchRawPrograms(); } catch {}
  try { if (!extraTypes.length) extraTypes = await fetchCostBasisTypes(); } catch {}
  afterSave = onDone;
  openEditor(id);
}

export async function newProgram(dept, onDone) {
  try { rawCache = await fetchRawPrograms(); } catch {}
  try { if (!extraTypes.length) extraTypes = await fetchCostBasisTypes(); } catch {}
  afterSave = onDone;
  openEditor(null);
  if (dept) {
    form.department = dept;
    const f = document.getElementById('ae-department');
    if (f) f.value = dept;
  }
}

// ── Program list ─────────────────────────────────────────────────────────────
export async function openAdmin() {
  showScreen('screen-admin');
  document.getElementById('admin-user-note').textContent = `Signed in as ${adminName} · changes save to Firebase for everyone`;
  try { extraTypes = await fetchCostBasisTypes(); } catch { extraTypes = []; }
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
    btn.addEventListener('click', () => { afterSave = renderList; openEditor(btn.dataset.id); }));
}

// ── Editor ─────────────────────────────────────────────────────────────────────
function blankProgram() {
  return {
    name: '', department: '', elective: true, costBasis: 'Flat Fee',
    rate: '', itemLabel: '', baseFee: '', baseQty: '', minCost: '', maxCost: '', options: [], additive: false, customFormula: '',
    billingPeriod: 'monthly', billingStart: 'January',
    defaultMonths: [], monthsFixed: false,
    systems: ['Yardi', 'OneSite', 'PaceOneSite'],
    setupFee: '', setupAmount: '', setupMonth: 0, setupComponents: [], priorYearNote: '', inputNote: '', costRaw: '', description: '', resourceUrl: '',
    yardiGL: '', onesiteGL: '', paceGL: '', owner: '',
  };
}

function openEditor(id) {
  editingId = id;
  form = id
    ? { ...blankProgram(), ...structuredClone(rawCache[id]) }
    : blankProgram();
  if (!Array.isArray(form.options)) form.options = [];
  // Migrate legacy programs into cost parts so they're editable in the builder
  if (!Array.isArray(form.components) || !form.components.length) {
    form.components = deriveComponents(form);
  }
  // Migrate a legacy flat setup amount into a setup cost part
  if (!Array.isArray(form.setupComponents)) form.setupComponents = [];
  if (!form.setupComponents.length && cleanNum(form.setupAmount)) {
    form.setupComponents = [{ kind: 'flat', label: 'Setup fee', amount: cleanNum(form.setupAmount) }];
  }
  buildEditor();
  openModal('modal-admin-editor');
}

function deptOptions(selected) {
  const depts = [...new Set(Object.values(rawCache).map(p => p.department).filter(Boolean))].sort();
  return depts.map(d => `<option value="${d}"${d === selected ? ' selected' : ''}>${d}</option>`).join('');
}

// ── Cost builder parts ────────────────────────────────────────────────────────
const PART_KINDS = [
  ['flat',    'Flat amount'],
  ['perUnit', 'Per unit (× property units)'],
  ['perItem', 'Per item (× a count)'],
  ['percent', '% of income / CapEx'],
  ['options', 'Options (pick one or multiple)'],
  ['formula', 'Custom formula'],
];

// Derive a starter set of parts from a legacy program so editing migrates it.
function deriveComponents(p) {
  if (Array.isArray(p.components) && p.components.length) return structuredClone(p.components);
  const rate = parseFloat(p.rate) || 0;
  switch (p.costBasis) {
    case 'Flat Fee':        return [{ kind: 'flat', label: '', amount: rate }];
    case 'Per Unit':        return [{ kind: 'perUnit', label: '', rate, baseQty: p.baseQty || 0 }];
    case 'Per Item':        return [{ kind: 'perItem', label: '', itemLabel: p.itemLabel || 'item', rate, baseQty: p.baseQty || 0 }];
    case 'Flat + Per Unit': return [{ kind: 'flat', label: 'Base fee', amount: parseFloat(p.baseFee) || 0 }, { kind: 'perUnit', label: '', rate }];
    case 'Tiered':          return [{ kind: 'options', label: '', selectMode: p.additive ? 'multiple' : 'one', options: (p.options || []).map(o => ({ label: o.label, rate: o.rate })) }];
    case 'Manual':          return [];
    default:                return p.customFormula ? [{ kind: 'formula', label: '', expr: p.customFormula }] : [];
  }
}

function partFields(part, i) {
  const L = (label, html) => `<label class="ae-field"><span>${label}</span>${html}</label>`;
  switch (part.kind) {
    case 'flat':
      return L('Label (optional)', `<input class="ae-pf" data-i="${i}" data-k="label" type="text" value="${esc(part.label)}" placeholder="e.g. Base fee">`) +
             L('Amount ($)', `<input class="ae-pf" data-i="${i}" data-k="amount" type="number" step="0.01" value="${esc(part.amount)}" placeholder="0.00">`);
    case 'perUnit':
      return L('Label (optional)', `<input class="ae-pf" data-i="${i}" data-k="label" type="text" value="${esc(part.label)}" placeholder="e.g. License">`) +
             L('Rate per unit ($)', `<input class="ae-pf" data-i="${i}" data-k="rate" type="number" step="0.01" value="${esc(part.rate)}" placeholder="0.00">`);
    case 'perItem':
      return L("What's counted?", `<input class="ae-pf" data-i="${i}" data-k="itemLabel" type="text" value="${esc(part.itemLabel)}" placeholder="e.g. Elevator, Associate">`) +
             L(`Rate per ${(part.itemLabel || 'item').toLowerCase()} ($)`, `<input class="ae-pf" data-i="${i}" data-k="rate" type="number" step="0.01" value="${esc(part.rate)}" placeholder="0.00">`) +
             L('Default / included qty', `<input class="ae-pf" data-i="${i}" data-k="baseQty" type="number" step="1" value="${esc(part.baseQty)}" placeholder="0">`);
    case 'percent':
      return L('Label (optional)', `<input class="ae-pf" data-i="${i}" data-k="label" type="text" value="${esc(part.label)}" placeholder="e.g. Oversight">`) +
             L('Percentage (%)', `<input class="ae-pf" data-i="${i}" data-k="pct" type="number" step="0.01" value="${esc(part.pct)}" placeholder="e.g. 1.25">`) +
             L('Of', `<select class="ae-pf" data-i="${i}" data-k="base"><option value="income"${part.base !== 'capex' ? ' selected' : ''}>Total income</option><option value="capex"${part.base === 'capex' ? ' selected' : ''}>CapEx</option></select>`);
    case 'options': {
      const opts = part.options || [];
      const rows = opts.map((o, oi) => `
        <div class="ae-popt" data-i="${i}" data-oi="${oi}">
          <input class="ae-pf-opt" data-i="${i}" data-oi="${oi}" data-k="label" type="text" value="${esc(o.label)}" placeholder="Option label">
          <input class="ae-pf-opt" data-i="${i}" data-oi="${oi}" data-k="rate" type="number" step="0.01" value="${esc(o.rate)}" placeholder="Rate">
          <button class="ae-popt-del" data-i="${i}" data-oi="${oi}">✕</button>
        </div>`).join('');
      return L('Label (optional)', `<input class="ae-pf" data-i="${i}" data-k="label" type="text" value="${esc(part.label)}" placeholder="e.g. Select a package">`) +
             L('How does the PM choose?', `<select class="ae-pf" data-i="${i}" data-k="selectMode"><option value="one"${part.selectMode !== 'multiple' ? ' selected' : ''}>Pick just one</option><option value="multiple"${part.selectMode === 'multiple' ? ' selected' : ''}>Pick one or more (with quantities)</option></select>`) +
             `<div class="ae-field ae-wide"><span>Options</span><div class="ae-popts">${rows}</div><button class="ae-popt-add" data-i="${i}">+ Add option</button></div>`;
    }
    case 'formula':
      return L('Label (optional)', `<input class="ae-pf" data-i="${i}" data-k="label" type="text" value="${esc(part.label)}" placeholder="e.g. Custom">`) +
             `<label class="ae-field ae-wide"><span>Formula <span class="label-soft">— use <code>units</code> &amp; <code>qty</code></span></span><input class="ae-pf" data-i="${i}" data-k="expr" type="text" value="${esc(part.expr)}" placeholder="e.g. 40 + 12 * (qty - 1)"></label>`;
    default:
      return '';
  }
}

function partRow(part, i, arr = 'components') {
  const showLock = ['perItem', 'percent', 'formula'].includes(part.kind);
  return `
    <div class="ae-part" data-arr="${arr}" data-i="${i}">
      <div class="ae-part-head">
        <select class="ae-part-kind" data-i="${i}">
          ${PART_KINDS.map(([v, label]) => `<option value="${v}"${part.kind === v ? ' selected' : ''}>${label}</option>`).join('')}
        </select>
        ${showLock ? `<label class="ae-part-lock"><input type="checkbox" class="ae-part-locked" data-i="${i}"${part.locked ? ' checked' : ''}> PM can't edit</label>` : '<span></span>'}
        <button class="ae-part-del" data-i="${i}" title="Remove part">✕</button>
      </div>
      <div class="ae-part-fields">${partFields(part, i)}</div>
    </div>`;
}

function buildEditor() {
  const body = document.getElementById('admin-editor-body');
  const cb = form.costBasis;

  const showRate    = ['Flat Fee', 'Per Unit', 'Per Item', 'Flat + Per Unit'].includes(cb);
  const showItem    = cb === 'Per Item';
  const showBase    = cb === 'Flat + Per Unit';
  const showTiers   = cb === 'Tiered';
  const showFormula = isFormulaType(cb);

  // Context-aware label so it's obvious where the cost goes
  const rateLabel = cb === 'Per Unit'        ? 'Rate per unit ($)'
                  : cb === 'Per Item'        ? `Rate per ${(form.itemLabel || 'item').toLowerCase()} ($)`
                  : cb === 'Flat + Per Unit' ? 'Per-unit rate ($)'
                  : 'Amount ($)';

  // Cost-basis dropdown: structured types + Custom Formula + admin-added types + "Add new"
  const basisOptions = [...STRUCTURED_BASES, 'Custom Formula', ...extraTypes, ADD_NEW];

  const per = form.billingPeriod === 'monthly' ? '$/mo' : '$/yr';
  const parts = form.components || [];

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
      <label class="ae-field ae-wide">
        <span>Program owner <span class="label-soft">— shown under the title</span></span>
        <input id="ae-owner" type="text" value="${esc(form.owner)}" placeholder="e.g. Kim Polly">
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
        <span>Cost basis / category</span>
        <select id="ae-costBasis">
          ${basisOptions.map(c => `<option value="${c}"${c === cb ? ' selected' : ''}>${basisLabel(c)}</option>`).join('')}
        </select>
      </label>
      <label class="ae-field">
        <span>Billing frequency</span>
        <select id="ae-billingPeriod">
          ${BILLING.map(b => `<option value="${b}"${b === form.billingPeriod ? ' selected' : ''}>${b}</option>`).join('')}
        </select>
      </label>
    </div>

    <div class="ae-section">
      <div class="ae-section-label">Systems & GL codes</div>
      <div class="ae-systems">
        ${SYSTEMS.map(([val, label]) => `
          <label class="ae-sys-chip${(form.systems || []).includes(val) ? ' on' : ''}">
            <input type="checkbox" class="ae-sys" value="${val}"${(form.systems || []).includes(val) ? ' checked' : ''}> ${label}
          </label>`).join('')}
      </div>
      <div class="ae-grid">
        <label class="ae-field"><span>Yardi GL</span><input id="ae-yardiGL" type="text" value="${esc(form.yardiGL)}"></label>
        <label class="ae-field"><span>OneSite GL</span><input id="ae-onesiteGL" type="text" value="${esc(form.onesiteGL)}"></label>
        <label class="ae-field"><span>Pace GL</span><input id="ae-paceGL" type="text" value="${esc(form.paceGL)}"></label>
      </div>
    </div>

    <label class="ae-field ae-wide">
      <span>Cost summary <span class="label-soft">— shows under the program title</span></span>
      <textarea id="ae-costRaw" rows="2" placeholder="e.g. $20 per elevator / month">${esc(form.costRaw)}</textarea>
    </label>

    <div class="ae-tiers ae-builder">
      <div class="ae-tiers-head"><span>Cost builder — stack the parts</span><button class="ae-tier-add ae-part-add" data-arr="components">+ Add part</button></div>
      <p class="label-soft" style="margin:0 0 12px;">Parts add together. Each can be locked so PMs can't change it.</p>
      ${parts.length ? parts.map((p, i) => partRow(p, i, 'components')).join('') : '<p class="label-soft">No parts yet — add one to define the cost.</p>'}
    </div>

    <div class="ae-grid">
      <label class="ae-field">
        <span>Minimum (${per}) <span class="label-soft">— optional</span></span>
        <input id="ae-minCost" type="number" step="0.01" min="0" value="${esc(form.minCost)}" placeholder="no minimum">
      </label>
      <label class="ae-field">
        <span>Maximum (${per}) <span class="label-soft">— optional</span></span>
        <input id="ae-maxCost" type="number" step="0.01" min="0" value="${esc(form.maxCost)}" placeholder="no maximum">
      </label>
    </div>

    ${form.billingPeriod !== 'monthly' && form.billingPeriod !== 'as-incurred' ? `
    <div class="ae-field ae-wide">
      <span>Default billing months</span>
      <label class="ae-follows">
        <input type="checkbox" id="ae-followsTransition"${/implement|transition|anniversar/i.test(form.billingStart || '') ? ' checked' : ''}>
        Follows transition date (bills at go-live, no fixed month)
      </label>
      <div class="ae-month-chips" id="ae-month-chips">
        ${MONTHS.map((m, i) => `<button type="button" class="ae-mchip${(form.defaultMonths || []).includes(i) ? ' on' : ''}" data-m="${i}">${m.slice(0,3)}</button>`).join('')}
      </div>
      <label class="ae-follows">
        <input type="checkbox" id="ae-monthsFixed"${form.monthsFixed ? ' checked' : ''}>
        Fixed — PMs can't change these months
      </label>
    </div>` : ''}

    <div class="ae-section">
      <label class="ae-follows ae-setup-toggle"><input type="checkbox" id="ae-has-setup"${(form.setupComponents && form.setupComponents.length) ? ' checked' : ''}> This program has a setup / one-time fee</label>
      ${(form.setupComponents && form.setupComponents.length) ? `
        <div class="ae-tiers ae-builder ae-setup-builder">
          <div class="ae-tiers-head"><span>Setup fee builder</span><button class="ae-tier-add ae-part-add" data-arr="setupComponents">+ Add part</button></div>
          <p class="label-soft" style="margin:0 0 12px;">Built the same way as the cost — parts add together. Charged once.</p>
          ${form.setupComponents.map((p, i) => partRow(p, i, 'setupComponents')).join('')}
          <label class="ae-field" style="margin-top:10px;"><span>Default setup month</span><select id="ae-setupMonth">${MONTHS.map((m, i) => `<option value="${i}"${(form.setupMonth ?? 0) == i ? ' selected' : ''}>${m}</option>`).join('')}</select></label>
        </div>` : ''}
    </div>

    <details class="ae-more" open>
      <summary>Notes, links & details</summary>
      <div class="ae-grid">
        <label class="ae-field ae-wide"><span>Setup fee note (optional)</span><input id="ae-setupFee" type="text" value="${esc(form.setupFee)}" placeholder="e.g. includes iPad & install"></label>
        <label class="ae-field ae-wide"><span>Prior year cost note</span><input id="ae-priorYearNote" type="text" value="${esc(form.priorYearNote)}" placeholder="e.g. Up from $1.50/unit last year"></label>
        <label class="ae-field ae-wide"><span>Clarification note (shown by the entry box)</span><input id="ae-inputNote" type="text" value="${esc(form.inputNote)}" placeholder="e.g. *Check with your local housing authority"></label>
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
  bind('ae-minCost', 'minCost');
  bind('ae-maxCost', 'maxCost');
  bind('ae-costRaw', 'costRaw');
  bind('ae-yardiGL', 'yardiGL');
  bind('ae-onesiteGL', 'onesiteGL');
  bind('ae-paceGL', 'paceGL');
  bind('ae-owner', 'owner');
  bind('ae-setupFee', 'setupFee');
  bind('ae-priorYearNote', 'priorYearNote');
  bind('ae-inputNote', 'inputNote');
  bind('ae-resourceUrl', 'resourceUrl');
  bind('ae-description', 'description');
  bind('ae-customFormula', 'customFormula');

  document.getElementById('ae-elective').addEventListener('change', e => { form.elective = e.target.value === 'true'; });
  document.getElementById('ae-billingPeriod').addEventListener('change', e => { form.billingPeriod = e.target.value; buildEditor(); });
  document.getElementById('ae-costBasis').addEventListener('change', async e => {
    if (e.target.value === ADD_NEW) {
      const name = (prompt('Name the new cost basis type:') || '').trim();
      if (name && !STRUCTURED_BASES.includes(name) && name !== 'Custom Formula' && !extraTypes.includes(name)) {
        try { extraTypes = await addCostBasisType(name); } catch {}
        form.costBasis = name;
      } // else fall back to current
      buildEditor();
      return;
    }
    form.costBasis = e.target.value;
    buildEditor();
  });
  // Default billing months
  document.getElementById('ae-followsTransition')?.addEventListener('change', e => {
    if (e.target.checked) { form.billingStart = 'When Implemented'; form.defaultMonths = []; }
    else { form.billingStart = ''; }
    buildEditor();
  });
  document.querySelectorAll('.ae-mchip').forEach(chip => chip.addEventListener('click', () => {
    const m = +chip.dataset.m;
    const arr = form.defaultMonths || [];
    const idx = arr.indexOf(m);
    if (idx >= 0) arr.splice(idx, 1); else arr.push(m);
    form.defaultMonths = arr;
    if (arr.length) { form.billingStart = ''; const ft = document.getElementById('ae-followsTransition'); if (ft) ft.checked = false; }
    chip.classList.toggle('on');
  }));
  document.getElementById('ae-monthsFixed')?.addEventListener('change', e => { form.monthsFixed = e.target.checked; });

  // Systems checkboxes
  document.querySelectorAll('.ae-sys').forEach(cb => cb.addEventListener('change', () => {
    form.systems = [...document.querySelectorAll('.ae-sys')].filter(x => x.checked).map(x => x.value);
    document.querySelectorAll('.ae-sys-chip').forEach(ch =>
      ch.classList.toggle('on', ch.querySelector('.ae-sys').checked));
  }));

  // ── Cost builders (main + setup), parameterized by data-arr ──
  if (!Array.isArray(form.components)) form.components = [];
  if (!Array.isArray(form.setupComponents)) form.setupComponents = [];
  const arrOf = el => (el.closest('.ae-part')?.dataset.arr) || 'components';

  // Setup-fee toggle
  document.getElementById('ae-has-setup')?.addEventListener('change', e => {
    if (e.target.checked) { if (!form.setupComponents.length) form.setupComponents = [{ kind: 'flat', label: '', amount: '' }]; }
    else { form.setupComponents = []; }
    buildEditor();
  });
  document.getElementById('ae-setupMonth')?.addEventListener('change', e => { form.setupMonth = parseInt(e.target.value); });

  document.querySelectorAll('.ae-part-add').forEach(b =>
    b.addEventListener('click', () => {
      const arr = b.dataset.arr || 'components';
      (form[arr] = form[arr] || []).push({ kind: 'flat', label: '', amount: '' });
      buildEditor();
    }));
  document.querySelectorAll('.ae-part-kind').forEach(sel =>
    sel.addEventListener('change', e => {
      const arr = arrOf(sel), i = +sel.dataset.i, k = e.target.value;
      form[arr][i] = { kind: k, label: form[arr][i].label || '',
        ...(k === 'options' ? { selectMode: 'one', options: [{ label: '', rate: '' }] } : {}),
        ...(k === 'perItem' ? { itemLabel: 'item' } : {}) };
      buildEditor();
    }));
  document.querySelectorAll('.ae-part-del').forEach(b =>
    b.addEventListener('click', () => { form[arrOf(b)].splice(+b.dataset.i, 1); buildEditor(); }));
  document.querySelectorAll('.ae-part-locked').forEach(c =>
    c.addEventListener('change', e => { form[arrOf(c)][+c.dataset.i].locked = e.target.checked; }));
  document.querySelectorAll('.ae-pf').forEach(el =>
    el.addEventListener('input', e => {
      const arr = arrOf(el), i = +el.dataset.i, k = el.dataset.k;
      form[arr][i][k] = e.target.value;
      if (k === 'selectMode' || k === 'base') { buildEditor(); return; }
      if (k === 'itemLabel') {
        const span = el.closest('.ae-part')?.querySelector('.ae-pf[data-k="rate"]')?.closest('.ae-field')?.querySelector('span');
        if (span) span.textContent = `Rate per ${(e.target.value || 'item').toLowerCase()} ($)`;
      }
      updatePreview();
    }));
  document.querySelectorAll('.ae-popt-add').forEach(b =>
    b.addEventListener('click', () => {
      const arr = arrOf(b), i = +b.dataset.i;
      (form[arr][i].options = form[arr][i].options || []).push({ label: '', rate: '' });
      buildEditor();
    }));
  document.querySelectorAll('.ae-popt-del').forEach(b =>
    b.addEventListener('click', () => {
      form[arrOf(b)][+b.dataset.i].options.splice(+b.dataset.oi, 1);
      buildEditor();
    }));
  document.querySelectorAll('.ae-pf-opt').forEach(el =>
    el.addEventListener('input', e => {
      form[arrOf(el)][+el.dataset.i].options[+el.dataset.oi][el.dataset.k] = e.target.value;
      updatePreview();
    }));

  document.getElementById('ae-close').addEventListener('click', () => closeModal('modal-admin-editor'));
  document.getElementById('ae-cancel').addEventListener('click', () => closeModal('modal-admin-editor'));
  document.getElementById('ae-save').addEventListener('click', save);
  document.getElementById('ae-delete')?.addEventListener('click', removeProgram);
}

function num(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }

// ── Live preview from the cost parts (sample: 100 units, PM inputs at 0) ────────
function updatePreview() {
  const el = document.getElementById('ae-preview');
  if (!el) return;
  const parts = form.components || [];
  if (!parts.length) {
    el.innerHTML = `<span class="ae-preview-label">Preview</span> Add a cost part to define the cost.`;
    return;
  }
  const units = 100;
  const mo = form.billingPeriod === 'monthly';
  let per = 0, bad = false;
  parts.forEach(p => {
    switch (p.kind) {
      case 'flat':    per += num(p.amount); break;
      case 'perUnit': per += num(p.rate) * units; break;
      case 'perItem': per += num(p.rate) * num(p.baseQty); break;
      case 'percent': break; // base entered by PM
      case 'options': per += num((p.options || [])[0]?.rate); break;
      case 'formula': { const r = evalFormula(p.expr, units, 0); if (r === null) bad = true; else per += r; break; }
    }
  });
  const annual = mo ? per * 12 : per;
  el.innerHTML = bad
    ? `<span class="ae-preview-label">Preview</span> ⚠️ a formula is invalid.`
    : `<span class="ae-preview-label">Preview · 100 units, PM inputs 0</span> ${money(per)}${mo ? '/mo → ' + money(annual) + '/yr' : '/yr'}`;
}

// Mirror of the app's safe evaluator — returns null on invalid input.
function evalFormula(formula, units, qty) {
  if (!formula) return 0;
  const cleaned = String(formula).replace(/\bunits\b/g, '(U)').replace(/\bqty\b/g, '(Q)');
  if (/[^0-9+\-*/().\sUQ]/.test(cleaned)) return null;
  try {
    const v = new Function('U', 'Q', `"use strict"; return (${cleaned});`)(units || 0, qty || 0);
    return (typeof v === 'number' && isFinite(v)) ? v : null;
  } catch { return null; }
}

// ── Save / delete ────────────────────────────────────────────────────────────
function slugify(name) {
  return (name || 'program').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'program';
}

function cleanNum(v) { const n = parseFloat(v); return isNaN(n) ? null : n; }

// Normalize a parts array (used for both the cost builder and the setup builder)
function cleanParts(arr) {
  return (arr || []).map(p => {
    const c = { kind: p.kind, label: p.label || '' };
    if (p.locked) c.locked = true;
    switch (p.kind) {
      case 'flat':    c.amount = cleanNum(p.amount) || 0; break;
      case 'perUnit': c.rate = cleanNum(p.rate) || 0; if (cleanNum(p.baseQty)) c.baseQty = cleanNum(p.baseQty); break;
      case 'perItem': c.rate = cleanNum(p.rate) || 0; c.itemLabel = p.itemLabel || 'item'; if (cleanNum(p.baseQty)) c.baseQty = cleanNum(p.baseQty); break;
      case 'percent': c.pct = cleanNum(p.pct) || 0; c.base = p.base || 'income'; if (cleanNum(p.baseDefault)) c.baseDefault = cleanNum(p.baseDefault); break;
      case 'options': c.selectMode = p.selectMode === 'multiple' ? 'multiple' : 'one';
                      c.options = (p.options || []).filter(o => o.label || o.rate).map(o => ({ label: o.label || '', rate: cleanNum(o.rate) || 0 })); break;
      case 'formula': c.expr = p.expr || ''; break;
    }
    return c;
  }).filter(c => c.kind);
}

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
    baseQty: cleanNum(form.baseQty) || 0,
    minCost: cleanNum(form.minCost),
    maxCost: cleanNum(form.maxCost),
    components: cleanParts(form.components),
    setupComponents: cleanParts(form.setupComponents),
    options: (form.costBasis === 'Tiered')
      ? form.options.filter(o => o.label).map(o => ({ label: o.label, rate: cleanNum(o.rate) || 0, type: o.type || 'flat' }))
      : [],
    additive: form.costBasis === 'Tiered' ? !!form.additive : false,
    customFormula: isFormulaType(form.costBasis) ? (form.customFormula || null) : null,
    billingPeriod: form.billingPeriod,
    billingStart: form.billingStart || null,
    defaultMonths: (Array.isArray(form.defaultMonths) && form.defaultMonths.length) ? form.defaultMonths.slice().sort((a, b) => a - b) : null,
    monthsFixed: !!form.monthsFixed,
    systems: (Array.isArray(form.systems) && form.systems.length) ? form.systems : ['Yardi', 'OneSite', 'PaceOneSite'],
    setupFee: form.setupFee || null,
    setupMonth: Number.isInteger(form.setupMonth) ? form.setupMonth : 0,
    priorYearNote: form.priorYearNote || null,
    inputNote: form.inputNote || null,
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
    if (afterSave) await afterSave();
    window.dispatchEvent(new CustomEvent('rpm-programs-changed'));
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
    if (afterSave) await afterSave();
    window.dispatchEvent(new CustomEvent('rpm-programs-changed'));
  } catch (e) {
    alert('Delete failed: ' + e.message);
  }
}

function esc(v) {
  if (v == null) return '';
  return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Import ──────────────────────────────────────────────────────────────────────
let importRows = [];

const IMPORT_HEADERS = ['Department', 'Cost Name', 'Program Owner', 'Elective/Non-elective', '2027 Cost', 'Cost Basis', 'Setup Fee', 'Billing Frequency', 'Billing Start', 'Min', 'Max', 'Yardi GL', 'Onesite GL', 'Pace GL', 'Prior Year Cost', 'Details'];

function downloadImportTemplate() {
  const examples = [
    ['Technology', 'Computer Support', 'mariana.estrada@rpmliving.com', 'Non-elective', '$1.50', 'Per Unit', '', 'Monthly', 'January', '250', '500', '50560007', '52240', '80211000', 'No change from prior year', 'Includes Yardi maintenance fee'],
    ['Procurement', 'Elevator Management Services', 'shone.richardson@rpmliving.com', 'Non-elective', '$20', 'Per Elevator', '', 'Monthly', 'January', '', '', '52150004', '57540', '60410000', 'New program for 2027', 'Standardized elevator maintenance program'],
    ['Marketing & Sales', 'Digital Advertising: SEO', 'sam.winn@rpmliving.com', 'Elective', 'Lite $100 / Standard $800 / Premium $1300', 'Tiered', '', 'Monthly', 'January', '', '', '51000000', '51150', '', 'Up from $750 last year', 'Tiered SEO packages — build options in editor'],
  ];
  const rows = [IMPORT_HEADERS, ...examples];
  const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'Budget_Assumptions_Import_Template.csv';
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

// Derive a Cost Basis label + cost text from a program (for export round-trip)
function basisFromProgram(p) {
  if (p.costBasis) return p.costBasis;
  const c = (p.components || [])[0];
  if (!c) return 'Manual';
  if (c.kind === 'flat')    return 'Flat Fee';
  if (c.kind === 'perUnit') return 'Per Unit';
  if (c.kind === 'perItem') return 'Per ' + (c.itemLabel || 'Item');
  if (c.kind === 'percent') return '% of ' + (c.base === 'capex' ? 'CapEx' : 'Income');
  if (c.kind === 'options') return 'Tiered';
  return 'Manual';
}
function costTextFromProgram(p) {
  if (p.costRaw) return p.costRaw;
  const c = (p.components || [])[0];
  if (!c) return '';
  if (c.kind === 'flat')    return '$' + (c.amount ?? 0);
  if (c.kind === 'perUnit' || c.kind === 'perItem') return '$' + (c.rate ?? 0);
  if (c.kind === 'percent') return (c.pct ?? 0) + '%';
  if (c.kind === 'options') return (c.options || []).map(o => `${o.label} $${o.rate}`).join(' / ');
  return '';
}

// Setup fee for export — a single flat amount round-trips; richer builders export a note
function setupTextFromProgram(p) {
  const sc = p.setupComponents;
  if (Array.isArray(sc) && sc.length) {
    if (sc.length === 1 && sc[0].kind === 'flat') return '$' + (sc[0].amount ?? 0);
    return p.setupFee || (sc.map(c => c.label || c.kind).join(' + ') + ' (edit in app)');
  }
  if (p.setupAmount) return '$' + p.setupAmount;
  return p.setupFee || '';
}

async function exportProgramsCsv() {
  let existing = {};
  try { existing = await fetchRawPrograms(); } catch (e) { alert('Could not load programs: ' + e.message); return; }
  const list = Object.values(existing).filter(Boolean)
    .sort((a, b) => (a.department || '').localeCompare(b.department || '') || (a.name || '').localeCompare(b.name || ''));
  const rows = [IMPORT_HEADERS];
  list.forEach(p => {
    rows.push([
      p.department || '', p.name || '', p.owner || '',
      p.elective === false ? 'Non-elective' : 'Elective',
      costTextFromProgram(p), basisFromProgram(p),
      setupTextFromProgram(p), p.billingPeriod || '', p.billingStart || '',
      p.minCost ?? '', p.maxCost ?? '',
      p.yardiGL || '', p.onesiteGL || '', p.paceGL || '',
      p.priorYearNote || '', p.description || '',
    ]);
  });
  const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `RPM_Programs_Export_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

function openImport() {
  importRows = [];
  document.getElementById('imp-file-name').textContent = '';
  document.getElementById('imp-status').textContent = '';
  document.getElementById('imp-preview').innerHTML = '';
  document.getElementById('imp-paste').value = '';
  document.getElementById('imp-file').value = '';
  document.getElementById('imp-commit').disabled = true;
  openModal('modal-import');
}

async function handleImportFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  document.getElementById('imp-file-name').textContent = file.name;
  document.getElementById('imp-status').textContent = 'Reading file…';
  try {
    let rows;
    if (/\.(xlsx|xls)$/i.test(file.name)) {
      const XLSX = await import('https://cdn.sheetjs.com/xlsx-0.20.2/package/xlsx.mjs');
      const wb   = XLSX.read(await file.arrayBuffer(), { type: 'array' });
      const ws   = wb.Sheets[wb.SheetNames[0]];
      rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: '' }).map(r => r.map(c => String(c)));
    } else {
      rows = parseTable(await file.text());
    }
    ingestImport(rows);
  } catch (err) {
    document.getElementById('imp-status').textContent = 'Could not read file: ' + err.message;
  }
}

// Delimited parser — auto-detects tab vs comma, handles quoted fields
function parseTable(text) {
  text = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!text.trim()) return [];
  const firstLine = text.split('\n')[0];
  const delim = (firstLine.split('\t').length > firstLine.split(',').length) ? '\t' : ',';
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
      else f += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f.length || row.length) { row.push(f); rows.push(row); }
  return rows.filter(r => r.some(x => String(x).trim() !== ''));
}

const impNum = t => { const m = String(t).match(/[\d,]+\.?\d*/); return m ? parseFloat(m[0].replace(/,/g, '')) : null; };
const impDollar = t => { const m = String(t).match(/\$?\s*([\d,]+\.?\d*)/); return m ? parseFloat(m[1].replace(/,/g, '')) : 0; };
const impCap = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;

function impBilling(t) {
  t = (t || '').toLowerCase();
  if (t.includes('month')) return 'monthly';
  if (t.includes('quarter')) return 'quarterly';
  if (t.includes('bi')) return 'bi-annual';
  if (t.includes('annual') || t.includes('year')) return 'annual';
  if (t.includes('incur') || t.includes('implement') || t.includes('request') || t.includes('as ')) return 'as-incurred';
  if (t.includes('one')) return 'one-time';
  return 'monthly';
}

function impStarter(basis, costText) {
  const b = (basis || '').toLowerCase();
  const rate = impDollar(costText);
  if (b.includes('flat')) return [{ kind: 'flat', label: '', amount: rate }];
  if (b.includes('%') || b.includes('percent')) return [{ kind: 'percent', label: '', pct: impNum(costText) || 0, base: b.includes('capex') ? 'capex' : 'income' }];
  const per = b.match(/per\s+(.+)/);
  if (per) {
    const thing = per[1].replace(/\/.*/, '').trim();
    if (thing === 'unit' || thing === 'units') return [{ kind: 'perUnit', label: '', rate }];
    return [{ kind: 'perItem', label: '', itemLabel: impCap(thing), rate }];
  }
  return []; // manual — admin builds; original text kept as cost summary
}

function mapImportRows(rows) {
  if (rows.length < 2) return [];
  const H = rows[0].map(h => (h || '').trim().toLowerCase());
  const col = (...keys) => H.findIndex(h => keys.some(k => h.includes(k)));
  const idx = {
    dept:    col('department'),
    name:    H.findIndex(h => h.includes('name')),
    owner:   col('owner'),
    elect:   col('elect'),
    basis:   col('basis'),
    cost:    H.findIndex(h => h.includes('cost') && !h.includes('basis') && !h.includes('setup') && !h.includes('name') && !h.includes('prior')),
    setup:   col('setup'),
    billing: col('billing frequency', 'frequency'),
    start:   col('start'),
    min:     H.findIndex(h => h === 'min' || (h.includes('min') && !h.includes('admin'))),
    max:     H.findIndex(h => h === 'max' || h.includes('max')),
    yardi:   col('yardi'),
    onesite: col('onesite'),
    pace:    col('pace'),
    prior:   col('prior'),
    details: col('details', 'description'),
  };
  const g = (r, i) => (i >= 0 && r[i] != null) ? String(r[i]).trim() : '';
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const name = g(r, idx.name);
    if (!name) continue;
    const basis = g(r, idx.basis);
    const costText = g(r, idx.cost);
    const comps = impStarter(basis, costText);
    out.push({
      name,
      department: g(r, idx.dept) || 'Other',
      owner: g(r, idx.owner) || null,
      elective: !/non/i.test(g(r, idx.elect)),
      costBasis: basis || 'Manual',
      costRaw: costText || null,
      components: comps,
      billingPeriod: impBilling(g(r, idx.billing)),
      billingStart: g(r, idx.start) || null,
      minCost: impNum(g(r, idx.min)),
      maxCost: impNum(g(r, idx.max)),
      setupFee: g(r, idx.setup) || null,
      yardiGL: g(r, idx.yardi) || null,
      onesiteGL: g(r, idx.onesite) || null,
      paceGL: g(r, idx.pace) || null,
      priorYearNote: g(r, idx.prior) || null,
      description: g(r, idx.details) || null,
      setupComponents: impNum(g(r, idx.setup)) ? [{ kind: 'flat', label: 'Setup fee', amount: impNum(g(r, idx.setup)) }] : [],
    });
  }
  return out;
}

function ingestImport(rows) {
  importRows = mapImportRows(rows);
  const status  = document.getElementById('imp-status');
  const preview = document.getElementById('imp-preview');
  const commit  = document.getElementById('imp-commit');
  if (!importRows.length) {
    status.textContent = 'No programs found. Make sure the header row is included (Department, Cost Name, Cost Basis, …).';
    preview.innerHTML = '';
    commit.disabled = true;
    return;
  }
  status.textContent = `${importRows.length} program(s) ready to import.`;
  commit.disabled = false;
  preview.innerHTML = `<table class="imp-table">
    <thead><tr><th>Program</th><th>Dept</th><th>Cost basis → part</th><th>Billing</th></tr></thead>
    <tbody>${importRows.map(p => `<tr>
      <td>${esc(p.name)}</td><td>${esc(p.department)}</td>
      <td>${esc(p.costBasis)} → ${p.components.length ? p.components[0].kind : 'manual'}</td>
      <td>${esc(p.billingPeriod)}</td></tr>`).join('')}</tbody></table>`;
}

async function commitImport() {
  const overwrite = document.getElementById('imp-overwrite').checked;
  const commit = document.getElementById('imp-commit');
  commit.disabled = true; commit.textContent = 'Importing…';
  let existing = {};
  try { existing = await fetchRawPrograms(); } catch {}
  const slugs  = new Set(Object.keys(existing));
  // Match existing programs by NAME (not id) so seed/custom ids don't cause duplicates
  const byName = {};
  Object.entries(existing).forEach(([id, p]) => { if (p && p.name) byName[p.name.trim().toLowerCase()] = id; });

  let added = 0, updated = 0, skipped = 0;
  for (const p of importRows) {
    const nameKey = p.name.trim().toLowerCase();
    const existingId = byName[nameKey];
    let id, isUpdate = false;
    if (existingId) {
      if (!overwrite) { skipped++; continue; }
      id = existingId; isUpdate = true;          // update in place — preserves its current id
    } else {
      id = slugify(p.name);
      let base = id, k = 2; while (slugs.has(id)) id = `${base}-${k++}`;
    }
    // When updating, keep the existing program's fields we don't import (don't wipe them)
    const prev = isUpdate ? (existing[id] || {}) : {};
    // If the cost basis + cost text are unchanged, keep the existing (possibly multi-part)
    // components instead of flattening them to the single starter part.
    const costUnchanged = isUpdate &&
      (prev.costBasis || '') === (p.costBasis || '') &&
      (prev.costRaw || '')   === (p.costRaw || '');
    const comps = (costUnchanged && Array.isArray(prev.components) && prev.components.length)
      ? prev.components : p.components;
    const data = {
      ...prev,
      ...p,
      components: comps,
      rate: comps?.[0]?.rate ?? null,
      itemLabel: comps?.find(c => c.kind === 'perItem')?.itemLabel || null,
      baseFee: null, baseQty: 0, options: [], additive: false, customFormula: null,
      setupComponents: (p.setupComponents && p.setupComponents.length) ? p.setupComponents : (prev.setupComponents || []),
      setupAmount: 0, setupMonth: prev.setupMonth ?? 0,
      defaultMonths: prev.defaultMonths ?? null, monthsFixed: prev.monthsFixed ?? false,
      systems: prev.systems || ['Yardi', 'OneSite', 'PaceOneSite'],
      inputNote: prev.inputNote ?? null, resourceUrl: prev.resourceUrl ?? null,
      priorYearNote: p.priorYearNote || prev.priorYearNote || null,
      lastEditedBy: adminName || 'Import', lastEditedAt: new Date().toISOString(),
    };
    try {
      await saveProgram(id, data);
      slugs.add(id); byName[nameKey] = id;
      if (isUpdate) updated++; else added++;
    } catch (e) { console.error('Import save failed for', p.name, e); }
  }
  commit.textContent = 'Import';
  closeModal('modal-import');
  if (afterSave) await afterSave();
  window.dispatchEvent(new CustomEvent('rpm-programs-changed'));
  alert(`Import complete — ${added} added, ${updated} updated${skipped ? `, ${skipped} skipped` : ''}.`);
}
