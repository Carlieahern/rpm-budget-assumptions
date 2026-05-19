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
  allPrograms:     [],
  programs:        [],    // filtered by system
  decisions:       {},    // programId → { itemId, decision, optOutApproval, ... }
  priorDecisions:  {},
  budgetAmounts:   {},    // programId → dollar amount entered by PM
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

    // Load saved budget amounts
    try {
      S.budgetAmounts = JSON.parse(localStorage.getItem(
        `rpm_budget_${S.property}_${S.budgetYear}`
      )) || {};
    } catch { S.budgetAmounts = {}; }

    renderMainScreen();
    showScreen('screen-main');
  } catch (e) {
    console.error('Launch error', e);
    alert('Failed to load data: ' + e.message);
    showScreen('screen-setup');
  }
}

// ── Budget total ──────────────────────────────────────────────────────────────
function resolvedCost(program) {
  return S.budgetAmounts[program.id] || 0;
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
  renderDeptRows();
  updateBudgetTotal();
}

// ── Department rows (aligned two-column layout) ───────────────────────────────
function renderDeptRows() {
  const body = document.getElementById('programs-body');
  body.innerHTML = '';

  // Collect departments in the order they first appear
  const deptOrder = [];
  const seen = new Set();
  S.programs.forEach(p => {
    if (!seen.has(p.group)) { seen.add(p.group); deptOrder.push(p.group); }
  });

  deptOrder.forEach(dept => {
    const nonElective = S.programs.filter(p => p.group === dept &&  p.required);
    const elective    = S.programs.filter(p => p.group === dept && !p.required);
    if (!nonElective.length && !elective.length) return;

    const gs = groupStyle(dept);
    const rowEl = document.createElement('div');
    rowEl.className = 'dept-row';
    rowEl.innerHTML = `
      <div class="dept-row-hdr dept-hdr-${gs.key}">
        <span>${dept}</span>
        <span class="dept-hdr-count">${nonElective.length + elective.length}</span>
      </div>
      <div class="dept-row-body">
        <div class="dept-col dept-col-left"></div>
        <div class="dept-col dept-col-right"></div>
      </div>
    `;
    body.appendChild(rowEl);

    const leftCol  = rowEl.querySelector('.dept-col-left');
    const rightCol = rowEl.querySelector('.dept-col-right');

    nonElective.forEach(p => leftCol.appendChild(
      buildProgramCard(p, S.decisions[p.id], S.priorDecisions[p.id], true)
    ));
    elective.forEach(p => rightCol.appendChild(
      buildProgramCard(p, S.decisions[p.id], S.priorDecisions[p.id], false)
    ));

    if (!nonElective.length) leftCol.innerHTML  = '<p class="dept-col-empty">No required programs</p>';
    if (!elective.length)    rightCol.innerHTML = '<p class="dept-col-empty">No elective programs</p>';
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

  // Cost display — show raw Monday text + Budget $ input
  const savedAmt   = S.budgetAmounts[program.id];
  const prePopAmt  = savedAmt !== undefined ? savedAmt : '';
  const costRawHtml = (program.costRaw)
    ? `<div class="cost-raw-text">💬 ${program.costRaw}</div>`
    : '';
  const basisTag = program.costBasis
    ? `<span class="cost-basis-tag">${program.costBasis}</span>`
    : '';
  const budgetInputHtml = `
    <div class="budget-input-row">
      <span class="budget-input-label">Budget&nbsp;$</span>
      <input class="budget-input" data-pid="${program.id}" type="number" min="0" step="1"
             placeholder="Enter amount" value="${prePopAmt}">
      ${basisTag}
    </div>`;

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
    ${costRawHtml}
    ${budgetInputHtml}
    <div class="prog-card-meta-row">
      <span class="prog-card-gl">GL ${program.glCode}</span>
      ${billingHtml}
      ${ownerHtml}
      ${priorCostHtml}
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

  // Budget $ input — save amount and update total
  const budgetInput = el.querySelector('.budget-input');
  if (budgetInput) {
    budgetInput.addEventListener('input', e => {
      e.stopPropagation();
      const val = parseFloat(e.target.value);
      if (!isNaN(val) && val >= 0) {
        S.budgetAmounts[program.id] = val;
      } else {
        delete S.budgetAmounts[program.id];
      }
      localStorage.setItem(
        `rpm_budget_${S.property}_${S.budgetYear}`,
        JSON.stringify(S.budgetAmounts)
      );
      updateBudgetTotal();
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
    S.decisions      = {};
    S.budgetAmounts  = {};
    localStorage.removeItem(`rpm_budget_${S.property}_${S.budgetYear}`);
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
