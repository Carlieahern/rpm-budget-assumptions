import CONFIG from './config.js';
import { fetchProperties, fetchPrograms, filterBySystem, clearMondayCache } from './monday.js';
import { loadDecisions, saveDecision, deleteDecision, resetDecisions, loadPriorYearDecisions } from './sharepoint.js';
import { showScreen, openModal, closeModal, groupStyle, formatCost,
         renderSummary, populatePropertySelect } from './ui.js';

// ── App State ───────────────────────────────────────────────────────────────
const S = {
  budgetYear:      CONFIG.budgetYear,
  property:        null,
  systemType:      null,
  unitCount:       0,
  quantities:      {},    // programId → qty (for Per Device, Per Elevator, etc.)
  allPrograms:     [],
  programs:        [],    // filtered by system
  decisions:       {},    // programId → { itemId, decision, optOutApproval, ... }
  priorDecisions:  {},
  currentOptOutId: null,
  viewingPrior:    false,
};

// ── Bootstrap ───────────────────────────────────────────────────────────────
async function boot() {
  showScreen('screen-loading');
  try {
    await loadPropertyScreen();
  } catch (e) {
    console.error('Boot error', e);
    showScreen('screen-setup'); // fallback — show setup even if something throws
  }
}

async function loadPropertyScreen() {
  showScreen('screen-setup');
  document.getElementById('setup-cycle-chip').textContent = `FY ${S.budgetYear}`;
  document.getElementById('step-property').classList.remove('hidden');
  document.getElementById('step-system').classList.add('hidden');

  try {
    const props = await fetchProperties();
    populatePropertySelect(props);
  } catch (e) {
    console.error('Failed to load properties', e);
    document.getElementById('property-select').innerHTML =
      '<option value="">Error loading properties — check config</option>';
  }

}

// ── Entry flow ───────────────────────────────────────────────────────────────
// Property selection
document.getElementById('property-select').addEventListener('change', e => {
  const btn = document.getElementById('btn-property-next');
  btn.disabled = !e.target.value;
});

document.getElementById('btn-property-next').addEventListener('click', () => {
  S.property = document.getElementById('property-select').value;
  if (!S.property) return;
  document.getElementById('step-property').classList.add('hidden');
  document.getElementById('step-system').classList.remove('hidden');
});

// System type selection
document.querySelectorAll('.system-tile').forEach(btn => {
  btn.addEventListener('click', async () => {
    document.querySelectorAll('.system-tile').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    S.systemType = btn.dataset.system;
    await launchMain();
  });
});

// ── Launch main app ───────────────────────────────────────────────────────────
async function launchMain() {
  showScreen('screen-loading');
  try {
    // Fetch everything in parallel
    const [programs, decisions, priorDecisions] = await Promise.all([
      fetchPrograms(),
      loadDecisions(S.property, S.budgetYear),
      loadPriorYearDecisions(S.property, S.budgetYear),
    ]);

    S.allPrograms = programs;
    // Resolve the correct cost + GL for the selected system
    S.programs = filterBySystem(programs, S.systemType).map(p => ({
      ...p,
      cost:   p.costs[S.systemType]   ?? 0,
      glCode: p.glCodes[S.systemType] ?? '—',
    }));
    S.decisions      = decisions;
    S.priorDecisions = priorDecisions;

    // Load saved per-program quantities
    try {
      S.quantities = JSON.parse(localStorage.getItem(
        `rpm_qty_${S.property}_${S.budgetYear}`
      )) || {};
    } catch { S.quantities = {}; }

    renderMainScreen();
    showScreen('screen-main');
  } catch (e) {
    console.error('Launch error', e);
    alert('Failed to load data: ' + e.message);
    showScreen('screen-setup');
  }
}

// ── Unit count & budget total ─────────────────────────────────────────────────
document.getElementById('unit-count').addEventListener('input', e => {
  S.unitCount = parseInt(e.target.value) || 0;
  updateBudgetTotal();
  // Re-render cards so per-unit costs update
  renderMainScreen();
});

// Returns 'unit-year' | 'unit-month' | 'per-other' | 'flat'
function costBasisType(program) {
  const b = (program.costBasis || '').toLowerCase();
  if (b.includes('unit') && b.includes('month')) return 'unit-month';
  if (b.includes('unit'))                         return 'unit-year';
  // Any "Per X" that isn't unit-based
  if (/per\s+\w/i.test(program.costBasis || '') && !b.includes('unit')) return 'per-other';
  return 'flat';
}

// Extract the "X" from "Per X" cost basis
function perOtherLabel(program) {
  const m = (program.costBasis || '').match(/per\s+(.+)/i);
  return m ? m[1].trim() : 'item';
}

function resolvedCost(program) {
  const type = costBasisType(program);
  const rate = program.cost || 0;
  if (type === 'unit-month') return rate * (S.unitCount || 0) * 12;
  if (type === 'unit-year')  return rate * (S.unitCount || 0);
  if (type === 'per-other')  return rate * (S.quantities[program.id] || 0);
  return rate; // flat
}

function updateBudgetTotal() {
  let total = 0;
  S.programs.forEach(p => {
    const dec = S.decisions[p.id]?.decision;
    if (p.required) {
      if (dec !== 'opted-out') total += resolvedCost(p);
    } else {
      if (dec === 'in') total += resolvedCost(p);
    }
  });
  const el = document.getElementById('budget-total');
  if (el) el.textContent = total > 0
    ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(total)
    : '—';
}

function renderMainScreen() {
  document.getElementById('hdr-property').textContent = S.property;
  document.getElementById('hdr-system').textContent   = S.systemType;
  document.getElementById('hdr-year').textContent     = `FY ${S.budgetYear}`;

  const nonElective = S.programs.filter(p => p.required);
  const elective    = S.programs.filter(p => !p.required);

  renderColumn(nonElective, 'non-elective-list', true);
  renderColumn(elective,    'elective-list',     false);
  updateBudgetTotal();
}

// ── Two-column grid ───────────────────────────────────────────────────────────
function renderColumn(programs, containerId, isRequired) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';

  // Group by department
  const groups = {};
  programs.forEach(p => {
    if (!groups[p.group]) groups[p.group] = [];
    groups[p.group].push(p);
  });

  Object.entries(groups).forEach(([dept, deptPrograms]) => {
    const gs = groupStyle(dept);
    const groupEl = document.createElement('div');
    groupEl.className = 'dept-group';

    const hdr = document.createElement('div');
    hdr.className = `dept-group-hdr dept-hdr-${gs.key}`;
    hdr.innerHTML = `<span class="dept-hdr-label">${dept}</span><span class="dept-hdr-count">${deptPrograms.length}</span>`;
    groupEl.appendChild(hdr);

    deptPrograms.forEach(p => {
      const card = buildProgramCard(p, S.decisions[p.id], S.priorDecisions[p.id], isRequired);
      groupEl.appendChild(card);
    });

    container.appendChild(groupEl);
  });

  updateColumnCounts();
}

function updateColumnCounts() {
  const req    = S.programs.filter(p => p.required);
  const elec   = S.programs.filter(p => !p.required);
  const ackCount  = req.filter(p  => S.decisions[p.id]?.decision === 'acknowledged').length;
  const incCount  = elec.filter(p => S.decisions[p.id]?.decision === 'in').length;

  const nonElCount = document.getElementById('col-count-nonelective');
  const elecCount  = document.getElementById('col-count-elective');
  if (nonElCount) nonElCount.textContent = `${ackCount} of ${req.length} Acknowledged`;
  if (elecCount)  elecCount.textContent  = `${incCount} of ${elec.length} Included`;
}

function buildProgramCard(program, decision, priorDecision, isRequired) {
  const el = document.createElement('div');
  el.className = 'prog-card';
  el.dataset.programId = program.id;

  const dec = decision?.decision;
  if (dec === 'opted-out')      el.classList.add('is-opted-out');
  if (dec === 'needs-followup') el.classList.add('is-followup');
  if (dec === 'acknowledged')   el.classList.add('is-acknowledged');
  if (dec === 'in')             el.classList.add('is-included');
  if (dec === 'out')            el.classList.add('is-excluded');

  const priorChip = priorDecision
    ? `<div class="prior-year-chip was-${['opted-out','out'].includes(priorDecision.decision) ? 'out' : 'in'}">
         ${{ 'out': '✕ Skipped last year', 'opted-out': '↩ Opted out last year', 'in': '✓ Included last year', 'acknowledged': '✓ Acknowledged last year' }[priorDecision.decision] || ''}
       </div>`
    : '';

  const resourceLink = program.resourceUrl
    ? `<a class="prog-card-resource" href="${program.resourceUrl}" target="_blank" rel="noopener">📖 Learn More</a>`
    : `<a class="prog-card-resource prog-card-resource-placeholder" href="#" onclick="return false;">📖 Learn More</a>`;

  let actionHtml;
  if (isRequired) {
    if (dec === 'opted-out') {
      actionHtml = `
        <span class="card-status-badge status-opted-out">Opted Out${decision.optOutApproval ? ' ✓' : ''}</span>
        <button class="btn-card-ghost btn-undo-optout" data-pid="${program.id}">Undo</button>`;
    } else if (dec === 'needs-followup') {
      actionHtml = `
        <span class="card-status-badge status-followup">⚑ Follow-up Needed</span>
        <button class="btn-card-ghost btn-opt-out-trigger" data-pid="${program.id}">Opt Out</button>`;
    } else if (dec === 'acknowledged') {
      actionHtml = `
        <span class="card-status-badge status-acknowledged">✓ Acknowledged</span>
        <button class="btn-card-ghost btn-undo-acknowledge" data-pid="${program.id}">Undo</button>
        <button class="btn-card-ghost btn-opt-out-trigger" data-pid="${program.id}">Opt Out</button>`;
    } else {
      actionHtml = `
        <button class="btn-card-ghost btn-opt-out-trigger" data-pid="${program.id}">Opt Out</button>
        <button class="btn-card-acknowledge btn-acknowledge" data-pid="${program.id}">Acknowledge</button>`;
    }
  } else {
    if (dec === 'in') {
      actionHtml = `
        <button class="btn-card-include is-included btn-include" data-pid="${program.id}">✓ Included</button>
        <button class="btn-card-exclude btn-exclude" data-pid="${program.id}" title="Don't include">✕</button>`;
    } else if (dec === 'out') {
      actionHtml = `<button class="btn-card-include btn-include" data-pid="${program.id}">Include</button>`;
    } else {
      actionHtml = `
        <button class="btn-card-include btn-include" data-pid="${program.id}">Include</button>
        <button class="btn-card-exclude btn-exclude" data-pid="${program.id}">Don't Include</button>`;
    }
  }

  const excludedOverlay = (!isRequired && dec === 'out')
    ? `<div class="excluded-overlay">Not Including</div>` : '';

  // Build cost display based on basis type
  const basisType = costBasisType(program);
  const thingName = perOtherLabel(program);
  const qty       = S.quantities[program.id] || 0;
  const total     = resolvedCost(program);
  const rateStr   = formatCost(program.cost);
  const totalStr  = total > 0 ? formatCost(total) : '—';

  let costHtml;
  if (basisType === 'unit-year' || basisType === 'unit-month') {
    const period = basisType === 'unit-month' ? '/unit/mo' : '/unit/yr';
    costHtml = `
      <span class="prog-card-cost">${rateStr}<span class="cost-basis-tag">${period}</span></span>
      ${S.unitCount > 0
        ? `<span class="cost-calc">× ${S.unitCount} units = <strong>${totalStr}</strong></span>`
        : `<span class="cost-calc-hint">Enter units above ↑</span>`}`;
  } else if (basisType === 'per-other') {
    costHtml = `
      <span class="prog-card-cost">${rateStr}<span class="cost-basis-tag">/${thingName.toLowerCase()}</span></span>
      <span class="cost-calc">×
        <input class="qty-input" data-pid="${program.id}" type="number" min="0" placeholder="0" value="${qty || ''}">
        <span class="qty-label">${thingName}</span>
        ${qty > 0 ? `= <strong>${totalStr}</strong>` : ''}
      </span>`;
  } else {
    costHtml = `<span class="prog-card-cost">${rateStr}</span>`;
  }

  const priorCostHtml = program.priorYearCost
    ? `<span class="prog-card-prior-cost">Prior year: ${formatCost(program.priorYearCost)}</span>`
    : '';

  const ownerHtml = program.programOwner
    ? `<span class="prog-card-owner">Owner: ${program.programOwner}</span>`
    : '';

  const billingHtml = program.billingFreq
    ? `<span class="prog-card-billing">${program.billingFreq}</span>`
    : '';

  el.innerHTML = `
    ${excludedOverlay}
    <div class="prog-card-top">
      <div class="prog-card-name">${program.name}</div>
      <div class="prog-card-action">${actionHtml}</div>
    </div>
    <div class="prog-card-cost-row">
      ${costHtml}
      ${priorCostHtml}
    </div>
    <div class="prog-card-meta-row">
      <span class="prog-card-gl">GL ${program.glCode}</span>
      ${billingHtml}
      ${ownerHtml}
      ${resourceLink}
    </div>
    ${program.description ? `<div class="prog-card-desc">${program.description}</div>` : ''}
    ${priorChip}
  `;

  el.addEventListener('click', e => {
    if (e.target.closest('.btn-opt-out-trigger'))  openOptOutModal(program.id);
    if (e.target.closest('.btn-undo-optout'))      undoOptOut(program.id);
    if (e.target.closest('.btn-acknowledge'))      handleAcknowledge(program.id);
    if (e.target.closest('.btn-undo-acknowledge')) handleUndoAcknowledge(program.id);
    if (e.target.closest('.btn-include'))          handleElectiveInclude(program.id);
    if (e.target.closest('.btn-exclude'))          handleElectiveExclude(program.id);
  });

  // Per-program quantity input
  const qtyInput = el.querySelector('.qty-input');
  if (qtyInput) {
    qtyInput.addEventListener('input', e => {
      e.stopPropagation();
      S.quantities[program.id] = parseInt(e.target.value) || 0;
      localStorage.setItem(
        `rpm_qty_${S.property}_${S.budgetYear}`,
        JSON.stringify(S.quantities)
      );
      updateBudgetTotal();
      // Update the cost calculation display without full re-render
      const calcEl = el.querySelector('.cost-calc');
      if (calcEl) {
        const n = S.quantities[program.id] || 0;
        const t = resolvedCost(program);
        calcEl.innerHTML = `× <input class="qty-input" data-pid="${program.id}" type="number" min="0" placeholder="0" value="${n || ''}"> <span class="qty-label">${thingName}</span> ${n > 0 ? `= <strong>${formatCost(t)}</strong>` : ''}`;
        // Re-attach listener on new input
        const newInput = calcEl.querySelector('.qty-input');
        if (newInput) newInput.addEventListener('input', qtyInput.oninput = e => {
          S.quantities[program.id] = parseInt(e.target.value) || 0;
          localStorage.setItem(`rpm_qty_${S.property}_${S.budgetYear}`, JSON.stringify(S.quantities));
          updateBudgetTotal();
        });
      }
    });
  }

  return el;
}

function refreshCard(programId) {
  const program = S.programs.find(p => p.id === programId);
  if (!program) return;
  const old = document.querySelector(`.prog-card[data-program-id="${programId}"]`);
  if (!old) return;
  const newCard = buildProgramCard(program, S.decisions[programId], S.priorDecisions[programId], program.required);
  old.replaceWith(newCard);
  updateColumnCounts();
  updateBudgetTotal();
}

// ── Elective actions ──────────────────────────────────────────────────────────
async function handleElectiveInclude(programId) {
  await setDecision(programId, 'in');
}

async function handleElectiveExclude(programId) {
  await setDecision(programId, 'out');
}

// ── Acknowledge actions ───────────────────────────────────────────────────────
async function handleAcknowledge(programId) {
  await setDecision(programId, 'acknowledged');
}

async function handleUndoAcknowledge(programId) {
  const existing = S.decisions[programId];
  if (!existing) return;
  try { await deleteDecision(existing.itemId); } catch (e) { console.error(e); }
  delete S.decisions[programId];
  refreshCard(programId);
  updateColumnCounts();
}

// ── Shared decision saver ────────────────────────────────────────────────────
async function setDecision(programId, newDec) {
  const program  = S.programs.find(p => p.id === programId);
  if (!program) return;
  const existing = S.decisions[programId];
  try {
    const itemId = await saveDecision(S.property, program, newDec, S.budgetYear, {
      itemId: existing?.itemId,
    });
    S.decisions[programId] = { ...(existing || {}), itemId, decision: newDec };
  } catch (e) {
    console.error('Failed to save decision', e);
  }
  refreshCard(programId);
  updateColumnCounts();
}

function openOptOutModal(programId) {
  S.currentOptOutId = programId;
  openModal('modal-optout');
}

async function handleOptOut(hasApproval) {
  const programId = S.currentOptOutId;
  closeModal('modal-optout');
  if (!programId) return;

  const program = S.programs.find(p => p.id === programId);
  if (!program) return;

  const decision   = hasApproval ? 'opted-out' : 'needs-followup';
  const existing   = S.decisions[programId];
  const itemId = await saveDecision(S.property, program, decision, S.budgetYear, {
    optOutApproval: hasApproval,
    itemId: existing?.itemId,
  });

  S.decisions[programId] = { ...(existing || {}), itemId, decision, optOutApproval: hasApproval };
  refreshCard(programId);
}

async function undoOptOut(programId) {
  const existing = S.decisions[programId];
  if (!existing) return;
  await deleteDecision(existing.itemId);
  delete S.decisions[programId];
  refreshCard(programId);
}

// ── Summary ───────────────────────────────────────────────────────────────────
document.getElementById('btn-view-summary').addEventListener('click', openSummary);

function openSummary() {
  renderSummary(S.programs, S.decisions, S.priorDecisions, S.budgetYear, S.viewingPrior);
  const toggleBtn = document.getElementById('btn-prior-year-toggle');
  toggleBtn.textContent = S.viewingPrior
    ? `Show ${S.budgetYear}`
    : `Show ${S.budgetYear - 1}`;
  showScreen('screen-summary');
}

document.getElementById('btn-summary-back').addEventListener('click', () => showScreen('screen-main'));

document.getElementById('btn-prior-year-toggle').addEventListener('click', () => {
  S.viewingPrior = !S.viewingPrior;
  openSummary();
});

// ── Opt-out modal ──────────────────────────────────────────────────────────────
document.getElementById('optout-yes').addEventListener('click',    () => handleOptOut(true));
document.getElementById('optout-no').addEventListener('click',     () => handleOptOut(false));
document.getElementById('optout-cancel').addEventListener('click', () => closeModal('modal-optout'));

// ── Menu ─────────────────────────────────────────────────────────────────────
document.getElementById('btn-menu').addEventListener('click', () => {
  document.getElementById('menu-ctx-property').textContent = S.property || '—';
  document.getElementById('menu-ctx-meta').textContent =
    `${S.systemType} · FY ${S.budgetYear}`;
  document.getElementById('mi-prior-year-label').textContent =
    S.viewingPrior ? `Hide ${S.budgetYear - 1} Comparison` : `Compare with ${S.budgetYear - 1}`;
  openModal('modal-menu');
});

document.getElementById('menu-close').addEventListener('click',    () => closeModal('modal-menu'));
document.getElementById('mi-refresh-data').addEventListener('click', async () => {
  closeModal('modal-menu');
  clearMondayCache();
  showScreen('screen-loading');
  await launchMain(); // re-fetches everything fresh
});

document.getElementById('mi-change-property').addEventListener('click', () => {
  closeModal('modal-menu');
  loadPropertyScreen();
});
document.getElementById('mi-logout').addEventListener('click', () => {
  closeModal('modal-menu');
  // Return to the RPM Budget Hub
  window.location.href = '../';
});

document.getElementById('mi-prior-year').addEventListener('click', () => {
  closeModal('modal-menu');
  S.viewingPrior = !S.viewingPrior;
  // Re-render cards with prior year indicators
  renderMainScreen();
});

document.getElementById('mi-reset').addEventListener('click', () => {
  closeModal('modal-menu');
  document.getElementById('reset-prop-name').textContent = S.property;
  document.getElementById('reset-year-label').textContent = `FY ${S.budgetYear}`;
  openModal('modal-reset');
});

// ── Reset ─────────────────────────────────────────────────────────────────────
document.getElementById('btn-confirm-reset').addEventListener('click', async () => {
  closeModal('modal-reset');
  showScreen('screen-loading');
  try {
    await resetDecisions(S.property, S.budgetYear);
    S.decisions  = {};
    S.quantities = {};
    renderMainScreen();
    showScreen('screen-main');
  } catch (e) {
    alert('Reset failed: ' + e.message);
    showScreen('screen-main');
  }
});

document.getElementById('btn-cancel-reset').addEventListener('click', () => closeModal('modal-reset'));

// ── Close overlays on backdrop click ──────────────────────────────────────────
document.querySelectorAll('.overlay').forEach(overlay => {
  overlay.addEventListener('click', e => {
    if (e.target === overlay) overlay.classList.remove('open');
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
boot();
