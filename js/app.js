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

  // Show tutorial on first visit — wait for screen transition + any async errors to settle
  setTimeout(maybeShowTutorial, 600);
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

    // Rebuild pending set from saved decisions
    S.pendingIds = new Set(
      Object.entries(S.decisions)
        .filter(([, d]) => d.decision === 'pending')
        .map(([id]) => id)
    );

    renderMainScreen();
    showScreen('screen-main');
  } catch (e) {
    console.error('Launch error', e);
    alert('Failed to load data: ' + e.message);
    showScreen('screen-setup');
  }
}

function renderMainScreen() {
  document.getElementById('hdr-property').textContent = S.property;
  document.getElementById('hdr-system').textContent   = S.systemType;
  document.getElementById('hdr-year').textContent     = `FY ${S.budgetYear}`;

  const nonElective = S.programs.filter(p => p.required);
  const elective    = S.programs.filter(p => !p.required);

  renderColumn(nonElective, 'non-elective-list', true);
  renderColumn(elective,    'elective-list',     false);
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
    const groupEl = document.createElement('div');
    groupEl.className = 'dept-group';
    groupEl.innerHTML = `<div class="dept-group-hdr">${dept}</div>`;

    deptPrograms.forEach(p => {
      const card = buildProgramCard(p, S.decisions[p.id], S.priorDecisions[p.id], isRequired);
      groupEl.appendChild(card);
    });

    container.appendChild(groupEl);
  });
}

function buildProgramCard(program, decision, priorDecision, isRequired) {
  const gs = groupStyle(program.group);
  const el = document.createElement('div');
  el.className = 'prog-card';
  el.dataset.programId = program.id;

  const dec = decision?.decision;
  if (dec === 'opted-out')      el.classList.add('is-opted-out');
  if (dec === 'needs-followup') el.classList.add('is-followup');
  if (dec === 'in')             el.classList.add('is-included');

  const priorChip = priorDecision
    ? `<div class="prior-year-chip was-${priorDecision.decision === 'opted-out' || priorDecision.decision === 'out' ? 'out' : 'in'}">
         ${priorDecision.decision === 'out' ? '✕ Skipped last year'
           : priorDecision.decision === 'opted-out' ? '↩ Opted out last year'
           : '✓ Included last year'}
       </div>`
    : '';

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
    } else {
      actionHtml = `<button class="btn-card-ghost btn-opt-out-trigger" data-pid="${program.id}">Opt Out</button>`;
    }
  } else {
    if (dec === 'in') {
      actionHtml = `<button class="btn-card-include is-included btn-elective-toggle" data-pid="${program.id}">✓ Included</button>`;
    } else {
      actionHtml = `<button class="btn-card-include btn-elective-toggle" data-pid="${program.id}">Include</button>`;
    }
  }

  el.innerHTML = `
    <div class="prog-card-top">
      <div class="prog-card-name">${program.name}</div>
      <div class="prog-card-action">${actionHtml}</div>
    </div>
    <div class="prog-card-details">
      <span class="prog-card-cost">${formatCost(program.cost)}</span>
      <span class="prog-card-gl">GL ${program.glCode}</span>
    </div>
    ${program.description ? `<div class="prog-card-desc">${program.description}</div>` : ''}
    ${priorChip}
  `;

  el.addEventListener('click', e => {
    if (e.target.closest('.btn-opt-out-trigger')) openOptOutModal(program.id);
    if (e.target.closest('.btn-undo-optout'))     undoOptOut(program.id);
    if (e.target.closest('.btn-elective-toggle')) handleElectiveToggle(program.id);
  });

  return el;
}

function refreshCard(programId) {
  const program = S.programs.find(p => p.id === programId);
  if (!program) return;
  const old = document.querySelector(`.prog-card[data-program-id="${programId}"]`);
  if (!old) return;
  const newCard = buildProgramCard(program, S.decisions[programId], S.priorDecisions[programId], program.required);
  old.replaceWith(newCard);
}

// ── Elective toggle ──────────────────────────────────────────────────────────
async function handleElectiveToggle(programId) {
  const program  = S.programs.find(p => p.id === programId);
  if (!program) return;
  const existing = S.decisions[programId];
  const newDec   = existing?.decision === 'in' ? 'out' : 'in';

  try {
    const itemId = await saveDecision(S.property, program, newDec, S.budgetYear, {
      itemId: existing?.itemId,
    });
    S.decisions[programId] = { ...(existing || {}), itemId, decision: newDec };
  } catch (e) {
    console.error('Failed to save decision', e);
  }
  refreshCard(programId);
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
    S.decisions = {};
    S.pendingIds.clear();
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

// ── Tutorial ──────────────────────────────────────────────────────────────────
const TUTORIAL_KEY = 'rpm_tutorial_seen';
const TOTAL_STEPS  = 6;
let tutStep = 0;

function showTutorial() {
  tutStep = 0;
  updateTutStep();
  openModal('modal-tutorial');
}

function updateTutStep() {
  document.querySelectorAll('.tut-step').forEach((el, i) => {
    el.classList.toggle('active', i === tutStep);
  });
  document.querySelectorAll('.tut-dot').forEach((dot, i) => {
    dot.classList.toggle('active', i === tutStep);
  });
  const nextBtn = document.getElementById('tut-next');
  const isLast  = tutStep === TOTAL_STEPS - 1;
  nextBtn.textContent  = isLast ? 'Got it!' : 'Next →';
  nextBtn.classList.toggle('last', isLast);
  document.getElementById('tut-skip').style.visibility = isLast ? 'hidden' : 'visible';
}

document.getElementById('tut-next').addEventListener('click', () => {
  if (tutStep < TOTAL_STEPS - 1) {
    tutStep++;
    updateTutStep();
  } else {
    localStorage.setItem(TUTORIAL_KEY, '1');
    closeModal('modal-tutorial');
  }
});

document.getElementById('tut-skip').addEventListener('click', () => {
  localStorage.setItem(TUTORIAL_KEY, '1');
  closeModal('modal-tutorial');
});

// "How to Use" in menu
document.getElementById('mi-refresh-data').insertAdjacentHTML('beforebegin', '');

document.getElementById('mi-how-to-use').addEventListener('click', () => {
  closeModal('modal-menu');
  showTutorial();
});

function maybeShowTutorial() {
  if (!localStorage.getItem(TUTORIAL_KEY)) showTutorial();
}

// ── Start ─────────────────────────────────────────────────────────────────────
boot();
