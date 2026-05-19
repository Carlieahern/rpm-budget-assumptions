import CONFIG from './config.js';
import { fetchProperties, fetchPrograms, filterBySystem, clearMondayCache } from './monday.js';
import { loadDecisions, saveDecision, deleteDecision, resetDecisions, loadPriorYearDecisions } from './sharepoint.js';
import { SwipeCard } from './swipe.js';
import { showScreen, openModal, closeModal, groupStyle,
         buildRequiredCard, buildSwipeCard, buildPendingChip,
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
  pendingIds:      new Set(),
  swipeQueue:      [],    // non-required programs not yet decided
  swipeIndex:      0,
  currentOptOutId: null,
  viewingPrior:    false,
  activeSwiper:    null,
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

    S.allPrograms    = programs;
    S.programs       = filterBySystem(programs, S.systemType);
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
  // Header
  document.getElementById('hdr-property').textContent = S.property;
  document.getElementById('hdr-system').textContent   = S.systemType;
  document.getElementById('hdr-year').textContent     = `FY ${S.budgetYear}`;

  const req    = S.programs.filter(p => p.required);
  const nonReq = S.programs.filter(p => !p.required);

  document.getElementById('pip-required').textContent    = req.length;
  document.getElementById('pip-nonrequired').textContent = nonReq.length;

  renderRequiredTab(req);
  renderSwipeDeck(nonReq);
}

// ── Required Tab ──────────────────────────────────────────────────────────────
function renderRequiredTab(programs) {
  const grid = document.getElementById('required-grid');
  grid.innerHTML = '';
  programs.forEach(p => {
    const card = buildRequiredCard(p, S.decisions[p.id], S.priorDecisions[p.id]);
    card.addEventListener('click', e => {
      const trigger = e.target.closest('.btn-opt-out-trigger');
      const undo    = e.target.closest('.btn-undo-optout');
      if (trigger) openOptOutModal(p.id);
      if (undo)    undoOptOut(p.id);
    });
    grid.appendChild(card);
  });
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
  refreshRequiredCard(programId);
}

async function undoOptOut(programId) {
  const existing = S.decisions[programId];
  if (!existing) return;
  await deleteDecision(existing.itemId);
  delete S.decisions[programId];
  refreshRequiredCard(programId);
}

function refreshRequiredCard(programId) {
  const program = S.programs.find(p => p.id === programId);
  if (!program) return;
  const old = document.querySelector(`.req-card[data-program-id="${programId}"]`);
  if (!old) return;
  const newCard = buildRequiredCard(program, S.decisions[programId], S.priorDecisions[programId]);
  newCard.addEventListener('click', e => {
    if (e.target.closest('.btn-opt-out-trigger')) openOptOutModal(programId);
    if (e.target.closest('.btn-undo-optout'))    undoOptOut(programId);
  });
  old.replaceWith(newCard);
}

// ── Swipe Deck ────────────────────────────────────────────────────────────────
function renderSwipeDeck(programs) {
  // Queue = programs with no final decision (pending is in queue too, via chips)
  S.swipeQueue = programs.filter(p => {
    const d = S.decisions[p.id]?.decision;
    return !d || d === 'pending'; // unswiped OR previously pending
  });
  S.swipeIndex = 0;

  renderPendingTray();
  renderCardStack();
  updateDeckProgress();
}

function renderCardStack() {
  const stack = document.getElementById('card-stack');
  if (S.activeSwiper) { S.activeSwiper.destroy(); S.activeSwiper = null; }
  stack.innerHTML = '';

  const remaining = S.swipeQueue.slice(S.swipeIndex);

  if (remaining.length === 0) {
    showDeckDone();
    return;
  }

  document.getElementById('deck-wrap').style.display = '';
  document.getElementById('deck-done').classList.add('hidden');

  // Render top 3 cards (deepest first so top card is last/on top in DOM)
  const visible = remaining.slice(0, 3);
  visible.slice().reverse().forEach((program, revIdx) => {
    const depth = visible.length - 1 - revIdx;
    const card  = buildSwipeCard(program, S.priorDecisions[program.id]);
    card.dataset.depth = depth;
    stack.appendChild(card);

    if (depth === 0) {
      S.activeSwiper = new SwipeCard(card, {
        onRight: () => onSwipeDecision(program, 'in'),
        onLeft:  () => onSwipeDecision(program, 'out'),
        onUp:    () => onSwipeDecision(program, 'pending'),
        onDrag:  ({ dx }) => updateDirLabels(dx),
      });
    }
  });
}

function updateDirLabels(dx) {
  const skipEl    = document.getElementById('dir-skip');
  const includeEl = document.getElementById('dir-include');
  skipEl.classList.toggle('visible',    dx < -60);
  includeEl.classList.toggle('visible', dx > 60);
}

async function onSwipeDecision(program, decision) {
  updateDirLabels(0);

  // Save to SharePoint
  try {
    const existing = S.decisions[program.id];
    const itemId = await saveDecision(S.property, program, decision, S.budgetYear, {
      itemId: existing?.itemId,
    });
    S.decisions[program.id] = { ...(existing || {}), itemId, decision };
  } catch (e) {
    console.error('Failed to save decision', e);
  }

  if (decision === 'pending') {
    S.pendingIds.add(program.id);
    renderPendingTray();
    // Move past this card in queue
    S.swipeIndex++;
  } else {
    // Remove from pending if it was there
    S.pendingIds.delete(program.id);
    renderPendingTray();
    S.swipeIndex++;
  }

  updateDeckProgress();
  // Brief delay to let fly-out finish before re-rendering stack
  setTimeout(renderCardStack, 360);
}

function updateDeckProgress() {
  const total     = S.swipeQueue.length;
  const remaining = total - S.swipeIndex;
  const el = document.getElementById('deck-progress');
  if (remaining > 0) {
    el.textContent = `${total - remaining + 1} of ${total}`;
  } else {
    el.textContent = '';
  }
}

function showDeckDone() {
  document.getElementById('deck-wrap').style.display = 'none';
  document.getElementById('deck-done').classList.remove('hidden');
}

// ── Pending tray ──────────────────────────────────────────────────────────────
function renderPendingTray() {
  const tray  = document.getElementById('pending-tray');
  const chips = document.getElementById('pending-chips');
  const badge = document.getElementById('pending-badge');

  if (S.pendingIds.size === 0) {
    tray.classList.add('hidden');
    return;
  }

  tray.classList.remove('hidden');
  badge.textContent = S.pendingIds.size;
  chips.innerHTML = '';

  S.pendingIds.forEach(id => {
    const program = S.programs.find(p => p.id === id);
    if (!program) return;
    const chip = buildPendingChip(program);
    chip.addEventListener('click', () => returnPendingToTop(id));
    chips.appendChild(chip);
  });
}

function returnPendingToTop(programId) {
  // Remove from pending and re-insert at front of swipe queue
  S.pendingIds.delete(programId);
  const idx = S.swipeQueue.findIndex(p => p.id === programId);
  if (idx !== -1) S.swipeQueue.splice(idx, 1);
  const program = S.programs.find(p => p.id === programId);
  if (program) S.swipeQueue.splice(S.swipeIndex, 0, program);
  delete S.decisions[programId]; // treat as fresh
  renderPendingTray();
  renderCardStack();
  updateDeckProgress();
}

document.getElementById('pending-tray-toggle').addEventListener('click', () => {
  document.getElementById('pending-tray').classList.toggle('open');
});

// ── Tabs ──────────────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`panel-${btn.dataset.tab}`).classList.add('active');
  });
});

document.getElementById('btn-go-swipe').addEventListener('click', () => {
  document.querySelector('[data-tab="nonrequired"]').click();
});

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
