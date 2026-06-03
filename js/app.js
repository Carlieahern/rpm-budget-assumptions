import CONFIG from './config.js';
import { fetchProperties, clearMondayCache } from './monday.js';
import { fetchPrograms, filterBySystem, clearFirebaseCache } from './firebase.js';
import { loadDecisions, saveDecision, deleteDecision, resetDecisions, loadPriorYearDecisions } from './sharepoint.js';
import { showScreen, openModal, closeModal, groupStyle, formatCost,
         renderSummary, populatePropertySelect } from './ui.js';

// ── App State ───────────────────────────────────────────────────────────────
const S = {
  budgetYear:      CONFIG.budgetYear,
  property:        null,
  systemType:      null,
  mode:            'interactive', // 'interactive' | 'info'
  allPrograms:     [],
  programs:        [],    // filtered by system
  decisions:       {},    // programId → { itemId, decision, optOutApproval, ... }
  priorDecisions:  {},
  unitCount:       0,     // global property unit count, pre-fills all per-unit inputs
  quantities:      {},    // programId → per-card override quantity
  selectedTiers:   {},    // programId → selected tier index for tiered costs
  budgetAmounts:   {},    // programId → manual dollar amount (fallback for complex costs)
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

  // Reset selections
  document.getElementById('property-select').value = '';
  document.getElementById('unit-count-row').classList.add('hidden');
  document.querySelectorAll('.system-tile').forEach(b => b.classList.remove('selected'));

  // Mode defaults to interactive
  document.querySelectorAll('.mode-tile').forEach(b => b.classList.remove('selected'));
  document.querySelector('.mode-tile[data-mode="interactive"]').classList.add('selected');
  S.mode = 'interactive';

  // Show full top row (un-skip if previously skipped)
  const topRow = document.getElementById('setup-top-row');
  if (topRow) topRow.style.display = '';

  try {
    const props = await fetchProperties();
    populatePropertySelect(props);
  } catch (e) {
    console.error('Failed to load properties', e);
    document.getElementById('property-select').innerHTML =
      '<option value="">Error loading properties — check config</option>';
  }
}

// ── Setup interactions ────────────────────────────────────────────────────────

// Property dropdown — show unit count when a property is chosen
document.getElementById('property-select').addEventListener('change', e => {
  const row   = document.getElementById('unit-count-row');
  const input = document.getElementById('unit-count-input');
  if (e.target.value) {
    row.classList.remove('hidden');
    const saved = parseInt(localStorage.getItem(`rpm_units_${e.target.value}`)) || 0;
    input.value = saved || '';
  } else {
    row.classList.add('hidden');
  }
});

// Save unit count as typed
document.getElementById('unit-count-input').addEventListener('input', e => {
  const prop = document.getElementById('property-select').value;
  const val  = parseInt(e.target.value) || 0;
  if (prop) localStorage.setItem(`rpm_units_${prop}`, val);
});

// Mode tiles — select but stay on screen
document.querySelectorAll('.mode-tile').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.mode-tile').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    S.mode = btn.dataset.mode;
  });
});

// System tile — launches immediately (only required field)
document.querySelectorAll('.system-tile').forEach(btn => {
  btn.addEventListener('click', async () => {
    document.querySelectorAll('.system-tile').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    S.property   = document.getElementById('property-select').value || null;
    S.systemType = btn.dataset.system;
    await launchMain();
  });
});

// Skip — hides property + mode, lets them just pick a system
document.getElementById('btn-skip').addEventListener('click', () => {
  const topRow = document.getElementById('setup-top-row');
  if (topRow) topRow.style.display = 'none';
  S.property = null;
  S.mode     = 'interactive';
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

    // Load saved input values
    S.unitCount    = parseInt(localStorage.getItem(`rpm_units_${S.property}`)) || 0;
    try { S.quantities    = JSON.parse(localStorage.getItem(`rpm_qty_${S.property}_${S.budgetYear}`))   || {}; } catch { S.quantities    = {}; }
    try { S.selectedTiers = JSON.parse(localStorage.getItem(`rpm_tiers_${S.property}_${S.budgetYear}`)) || {}; } catch { S.selectedTiers = {}; }
    try { S.budgetAmounts = JSON.parse(localStorage.getItem(`rpm_budget_${S.property}_${S.budgetYear}`)) || {}; } catch { S.budgetAmounts = {}; }

    renderMainScreen();
    showScreen('screen-main');
  } catch (e) {
    console.error('Launch error', e);
    alert('Failed to load data: ' + e.message);
    showScreen('screen-setup');
  }
}

// ── Cost basis intelligence ───────────────────────────────────────────────────
// Reads clean structured fields from Firebase — no text parsing needed.
function parseCostBasisInfo(program) {
  const basis  = program.costBasis    || 'Manual';
  const rate   = program.rate         ?? 0;
  const period = program.billingPeriod === 'monthly' ? 'month' : 'year';

  switch (basis) {

    case 'Flat Fee':
      return { type: 'flat', rate };

    case 'Per Unit': {
      return { type: 'per-unit', label: 'Unit', plural: 'Units', period, rate };
    }

    case 'Per Item': {
      const label  = program.itemLabel || 'Item';
      const plural = label.endsWith('s') ? label : label + 's';
      return { type: 'per-quantity', label, plural, period, rate };
    }

    case 'Tiered': {
      const opts      = program.options || [];
      const firstType = opts[0]?.type || 'flat';
      const isPerUnit = firstType === 'per-unit-month' || firstType === 'per-unit-year';
      const isPerItem = firstType === 'per-item';
      const tierPeriod = firstType === 'per-unit-month' ? 'month' : 'year';
      return {
        type: 'tiered',
        tiers: opts.map(o => ({ label: o.label, rate: o.rate })),
        isPerUnit,
        isPerItem,
        itemLabel: program.itemLabel || null,
        period: isPerUnit ? tierPeriod : period,
        rate: opts[0]?.rate ?? rate,
      };
    }

    case 'Flat + Per Unit': {
      return {
        type:    'flat-per-unit',
        baseFee: program.baseFee ?? 0,
        rate,
        period,
      };
    }

    default: // 'Manual' or anything unrecognised
      return { type: 'manual', rate };
  }
}

// Returns the effective quantity for a program:
// uses per-card override if set, otherwise falls back to global unit count for per-unit programs.
function effectiveQty(program, info) {
  if (program.id in S.quantities) return S.quantities[program.id];
  if (info.type === 'per-unit') return S.unitCount;
  return 0;
}

function resolvedCost(program) {
  const info    = parseCostBasisInfo(program);
  const qty     = effectiveQty(program, info);
  const tierIdx = S.selectedTiers[program.id] ?? 0;

  switch (info.type) {
    case 'flat':
      return info.rate;

    case 'per-unit':
    case 'per-quantity':
      return info.period === 'month' ? info.rate * qty * 12 : info.rate * qty;

    case 'flat-per-unit': {
      const perUnitTotal = info.period === 'month'
        ? info.rate * qty * 12
        : info.rate * qty;
      return info.baseFee + perUnitTotal;
    }

    case 'tiered': {
      const tierRate = info.tiers?.[tierIdx]?.rate || 0;
      if (info.isPerUnit) {
        return info.period === 'month' ? tierRate * qty * 12 : tierRate * qty;
      }
      if (info.isPerItem) {
        return tierRate * qty;
      }
      return tierRate;
    }

    default:
      return S.budgetAmounts[program.id] || 0;
  }
}

// ── Monthly breakdown ─────────────────────────────────────────────────────────
const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function parseStartMonth(billingStart) {
  if (!billingStart) return 0;
  const s = billingStart.toLowerCase();
  const map = { january:0, february:1, march:2, april:3, may:4, june:5,
                july:6, august:7, september:8, october:9, november:10, december:11 };
  for (const [name, idx] of Object.entries(map)) {
    if (s.includes(name)) return idx;
  }
  return 0;
}

function getMonthlyBreakdown() {
  const months = Array(12).fill(0);

  S.programs.forEach(p => {
    const dec      = S.decisions[p.id]?.decision;
    const included = p.required
      ? dec !== 'opted-out' && dec !== 'not-applicable'
      : dec === 'in';
    if (!included) return;

    const annual = resolvedCost(p);
    if (!annual) return;

    const freq  = (p.billingFreq || p.billingPeriod || '').toLowerCase();
    const start = parseStartMonth(p.billingStart);

    if (freq.includes('monthly')) {
      const mo = annual / 12;
      for (let i = 0; i < 12; i++) months[i] += mo;
    } else if (freq.includes('quarterly')) {
      const hit = annual / 4;
      for (let i = 0; i < 4; i++) months[(start + i * 3) % 12] += hit;
    } else if (freq.includes('bi-annual') || freq.includes('bi-annu')) {
      const hit = annual / 2;
      months[start % 12] += hit;
      months[(start + 6) % 12] += hit;
    } else if (freq.includes('annual')) {
      months[start % 12] += annual;
    }
    // as-incurred / when-implemented: excluded
  });

  return months;
}

let monthlyExpanded = false;

function renderMonthlyBreakdown() {
  const container = document.getElementById('monthly-breakdown');
  const hint      = document.getElementById('monthly-expand-hint');
  if (!container) return;

  if (!monthlyExpanded) {
    container.innerHTML = '';
    container.classList.remove('open');
    if (hint) hint.textContent = '↓ Monthly view';
    return;
  }

  if (hint) hint.textContent = '↑ Collapse';
  const data   = getMonthlyBreakdown();
  const max    = Math.max(...data, 1);
  const fmtMo  = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

  container.innerHTML = data.map((val, i) => {
    const pct  = Math.round((val / max) * 100);
    const zero = val < 1;
    return `
      <div class="mb-row${zero ? ' mb-row-zero' : ''}">
        <span class="mb-month">${MONTH_NAMES[i]}</span>
        <div class="mb-bar-track">
          <div class="mb-bar" style="width:${zero ? 0 : Math.max(pct, 4)}%"></div>
        </div>
        <span class="mb-amount">${zero ? '—' : fmtMo.format(val)}</span>
      </div>`;
  }).join('');

  container.classList.add('open');
}

document.getElementById('btn-monthly-expand')?.addEventListener('click', () => {
  monthlyExpanded = !monthlyExpanded;
  renderMonthlyBreakdown();
});

// ── Animated number counter ───────────────────────────────────────────────────
const fmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

function animateCost(el, newVal) {
  if (!el) return;
  const oldText = el.textContent.replace(/[^0-9.]/g, '');
  const oldVal  = parseFloat(oldText) || 0;
  if (Math.round(oldVal) === Math.round(newVal)) {
    el.textContent = newVal > 0 ? fmt.format(newVal) : '—';
    return;
  }
  const duration = 450;
  const start    = performance.now();
  const tick = (now) => {
    const p = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - p, 3); // ease-out cubic
    const cur = oldVal + (newVal - oldVal) * eased;
    el.textContent = newVal > 0 ? fmt.format(cur) : '—';
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// Returns the actual monthly charge for a program (only for monthly-billed items).
// As-incurred, annual, and quarterly items return 0 here — they belong in the annual total only.
function resolvedMonthlyCost(program) {
  if (program.billingPeriod !== 'monthly') return 0;
  const info = parseCostBasisInfo(program);
  const qty  = effectiveQty(program, info);
  switch (info.type) {
    case 'flat':         return info.rate;
    case 'per-unit':
    case 'per-quantity': return info.rate * qty;
    case 'flat-per-unit': return info.baseFee + info.rate * qty;
    case 'tiered': {
      const tierIdx  = S.selectedTiers[program.id] ?? 0;
      const tierRate = info.tiers?.[tierIdx]?.rate || 0;
      if (info.isPerUnit) return tierRate * qty;
      if (info.isPerItem) return tierRate * qty;
      return tierRate;
    }
    default: return 0;
  }
}

function updateBudgetTotal() {
  let annual = 0;
  let monthly = 0;
  S.programs.forEach(p => {
    const dec = S.decisions[p.id]?.decision;
    const included = p.required
      ? dec !== 'opted-out' && dec !== 'not-applicable'
      : dec === 'in';
    if (included) {
      annual  += resolvedCost(p);
      monthly += resolvedMonthlyCost(p);
    }
  });
  animateCost(document.getElementById('budget-total'),  annual);
  animateCost(document.getElementById('monthly-total'), monthly);
  if (monthlyExpanded) renderMonthlyBreakdown();
}

function renderMainScreen() {
  document.getElementById('hdr-property').textContent   = S.property;
  document.getElementById('hdr-system').textContent     = S.systemType;
  document.getElementById('hdr-year').textContent       = `FY ${S.budgetYear}`;
  document.getElementById('hdr-unit-count').textContent = S.unitCount > 0 ? `${S.unitCount} units` : 'Set units';

  // Mode badge — only visible in info mode
  const modeBadge = document.getElementById('hdr-mode-badge');
  if (modeBadge) {
    modeBadge.textContent = S.mode === 'info' ? 'Info Only' : '';
    modeBadge.className   = `mode-badge${S.mode === 'info' ? ' mode-info' : ''}`;
  }

  // Hide side panels + budget total in info mode (no selections = no totals)
  const sideLeft  = document.querySelector('.side-left');
  const sideRight = document.querySelector('.side-right');
  if (sideLeft)  sideLeft.style.visibility  = S.mode === 'info' ? 'hidden' : 'visible';
  if (sideRight) sideRight.style.visibility = S.mode === 'info' ? 'hidden' : 'visible';

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
        <div class="dept-hdr-left">
          <div class="dept-hdr-text">${dept}</div>
          <div class="dept-hdr-bar"></div>
        </div>
        <div class="dept-hdr-count">${nonElective.length + elective.length}</div>
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
  const req      = S.programs.filter(p =>  p.required && S.decisions[p.id]?.decision !== 'not-applicable');
  const elec     = S.programs.filter(p => !p.required);
  const ackCount = req.filter(p  => S.decisions[p.id]?.decision === 'acknowledged').length;
  const incCount = elec.filter(p => S.decisions[p.id]?.decision === 'in').length;
  const naCount  = S.programs.filter(p => p.required && S.decisions[p.id]?.decision === 'not-applicable').length;

  // Side panel stat values
  const sideNE = document.getElementById('side-nonelective-count');
  const sideEl = document.getElementById('side-elective-count');
  if (sideNE) sideNE.textContent = `${ackCount} of ${req.length}`;
  if (sideEl) sideEl.textContent = `${incCount} of ${elec.length}`;
}

// ── Info-mode card (no inputs, no actions — reference only) ──────────────────
function buildInfoCard(program) {
  const el = document.createElement('div');
  el.className = 'prog-card prog-card-info';
  el.dataset.programId = program.id;

  const info = parseCostBasisInfo(program);

  // Build a clean cost display based on type
  let costHtml = '';
  if (info.type === 'flat') {
    costHtml = `<div class="info-cost-value">${formatCost(info.rate)}<span class="info-cost-period"> / year</span></div>`;
  } else if (info.type === 'per-unit' || info.type === 'per-quantity') {
    const per = info.period === 'month' ? '/mo' : '/yr';
    costHtml = `<div class="info-cost-value">${formatCost(info.rate)}<span class="info-cost-period"> / ${info.label.toLowerCase()}${per}</span></div>`;
  } else if (info.type === 'flat-per-unit') {
    costHtml = `
      <div class="info-cost-value">${formatCost(info.baseFee)}<span class="info-cost-period"> base</span></div>
      <div class="info-cost-value">+ ${formatCost(info.rate)}<span class="info-cost-period"> / unit / yr</span></div>`;
  } else if (info.type === 'tiered' && info.tiers?.length) {
    costHtml = info.tiers.map(t => {
      const typeLabel = t.type === 'per-unit-month' ? '/unit/mo'
                      : t.type === 'per-unit-year'  ? '/unit/yr'
                      : t.type === 'per-item'        ? `/${(program.itemLabel || 'item').toLowerCase()}`
                      : '/yr';
      return `<div class="info-tier-row"><span class="info-tier-label">${t.label}</span><span class="info-tier-rate">${formatCost(t.rate)}<span class="info-cost-period">${typeLabel}</span></span></div>`;
    }).join('');
  } else {
    costHtml = program.costRaw
      ? `<div class="info-cost-manual">${program.costRaw}</div>`
      : `<div class="info-cost-manual">See program details</div>`;
  }

  el.innerHTML = `
    <div class="prog-card-top">
      <div class="prog-card-name">${program.name}</div>
    </div>
    <div class="info-cost-block">${costHtml}</div>
    ${program.description ? `<div class="prog-card-desc">${program.description}</div>` : ''}
    <div class="prog-card-meta-row">
      <span class="prog-card-gl">GL ${program.glCode}</span>
      ${program.billingFreq ? `<span class="prog-card-billing">${program.billingFreq}</span>` : ''}
      ${program.programOwner ? `<span class="prog-card-owner">${program.programOwner}</span>` : ''}
      ${program.setupFee ? `<span class="info-setup-fee">Setup: ${program.setupFee}</span>` : ''}
    </div>
  `;
  return el;
}

function buildProgramCard(program, decision, priorDecision, isRequired) {
  // In info mode, always use the simplified reference card
  if (S.mode === 'info') return buildInfoCard(program);
  const el = document.createElement('div');
  el.className = 'prog-card';
  el.dataset.programId = program.id;

  const dec = decision?.decision;
  if (dec === 'opted-out')      el.classList.add('is-opted-out');
  if (dec === 'needs-followup') el.classList.add('is-followup');
  if (dec === 'acknowledged')   el.classList.add('is-acknowledged');
  if (dec === 'not-applicable') el.classList.add('is-not-applicable');
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
    if (dec === 'not-applicable') {
      actionHtml = `<span class="card-status-badge status-not-applicable">Does Not Apply</span>`;
    } else if (dec === 'opted-out') {
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

  // ── Smart cost interaction ────────────────────────────────────────────────
  const info     = parseCostBasisInfo(program);
  const qty      = effectiveQty(program, info);
  const tierIdx  = S.selectedTiers[program.id] ?? 0;
  const total    = resolvedCost(program);
  const totalStr = total > 0 ? formatCost(total) + '/yr' : '';

  // Raw Monday description — always shown for context
  const costRawHtml = program.costRaw
    ? `<div class="cost-raw-text">${program.costRaw}</div>`
    : '';

  let costInteractionHtml = '';

  if (info.type === 'flat') {
    costInteractionHtml = `
      <div class="cost-interaction">
        <span class="cost-parsed-rate">${formatCost(info.rate)}</span>
        <span class="cost-basis-tag">Flat</span>
      </div>`;

  } else if (info.type === 'per-unit' || info.type === 'per-quantity') {
    const period = info.period === 'month' ? '/mo' : '/yr';
    costInteractionHtml = `
      <div class="cost-interaction">
        <div class="qty-calc-row">
          <span class="cost-parsed-rate">${formatCost(info.rate)}<span class="cost-basis-tag">/${info.label.toLowerCase()}${period}</span></span>
          <span class="qty-sep">×</span>
          <div class="qty-field">
            <input class="qty-input" data-pid="${program.id}" type="number" min="0" placeholder="0" value="${qty || ''}">
            <span class="qty-label">${info.plural}</span>
          </div>
          ${qty > 0 ? `<span class="qty-equals">= <strong>${totalStr}</strong></span>` : ''}
        </div>
      </div>`;

  } else if (info.type === 'tiered') {
    const tiersHtml = (info.tiers || []).map((t, i) => `
      <label class="tier-option${i === tierIdx ? ' is-selected' : ''}">
        <input type="radio" class="tier-radio" name="tier_${program.id}" data-pid="${program.id}" data-tier="${i}"${i === tierIdx ? ' checked' : ''}>
        <span class="tier-label">${t.label}</span>
        <span class="tier-rate">${formatCost(t.rate)}${info.isPerUnit ? (info.period === 'month' ? '/unit/mo' : '/unit/yr') : '/yr'}</span>
      </label>`).join('');
    const qtySection = info.isPerUnit ? `
      <div class="qty-calc-row">
        <span class="qty-sep">×</span>
        <div class="qty-field">
          <input class="qty-input" data-pid="${program.id}" type="number" min="0" placeholder="0" value="${qty || ''}">
          <span class="qty-label">Units</span>
        </div>
        ${qty > 0 ? `<span class="qty-equals">= <strong>${totalStr}</strong></span>` : ''}
      </div>` : (total > 0 ? `<div class="qty-calc-row"><span class="qty-equals"><strong>${totalStr}</strong></span></div>` : '');
    costInteractionHtml = `
      <div class="cost-interaction tiered">
        <div class="tier-options">${tiersHtml}</div>
        ${qtySection}
      </div>`;

  } else if (info.type === 'flat-per-unit') {
    const period      = info.period === 'month' ? '/mo' : '/yr';
    const perUnitLine = info.period === 'month'
      ? `${formatCost(info.rate)}/unit/mo`
      : `${formatCost(info.rate)}/unit/yr`;
    const perUnitTotal = info.period === 'month'
      ? info.rate * qty * 12
      : info.rate * qty;
    costInteractionHtml = `
      <div class="cost-interaction flat-per-unit">
        <div class="flat-per-unit-row">
          <span class="fpu-label">Base fee</span>
          <span class="fpu-value">${formatCost(info.baseFee)}</span>
        </div>
        <div class="flat-per-unit-row">
          <span class="fpu-label">${perUnitLine}</span>
          <span class="qty-sep">×</span>
          <div class="qty-field">
            <input class="qty-input" data-pid="${program.id}" type="number" min="0" placeholder="0" value="${qty || ''}">
            <span class="qty-label">Units</span>
          </div>
          ${qty > 0 ? `<span class="fpu-value">${formatCost(perUnitTotal)}</span>` : ''}
        </div>
        ${qty > 0 ? `<div class="fpu-total-row"><span class="fpu-total-label">Total</span><span class="fpu-total-value"><strong>${formatCost(info.baseFee + perUnitTotal)}/yr</strong></span></div>` : ''}
      </div>`;

  } else {
    // Manual — PM enters dollar amount
    const savedAmt = S.budgetAmounts[program.id];
    costInteractionHtml = `
      <div class="cost-interaction manual">
        <div class="budget-input-row">
          <span class="budget-input-label">Budget&nbsp;$</span>
          <input class="budget-input" data-pid="${program.id}" type="number" min="0" step="1"
                 placeholder="Enter amount" value="${savedAmt !== undefined ? savedAmt : ''}">
          ${program.costRaw ? `<span class="cost-basis-tag" title="${program.costRaw}">ⓘ</span>` : ''}
        </div>
      </div>`;
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

  const dnaHtml = isRequired ? `
    <label class="dna-row">
      <input type="checkbox" class="dna-check" data-pid="${program.id}"${dec === 'not-applicable' ? ' checked' : ''}>
      <span class="dna-text">Does Not Apply to This Property</span>
    </label>` : '';

  el.innerHTML = `
    ${excludedOverlay}
    <div class="prog-card-top">
      <div class="prog-card-name">${program.name}</div>
      <div class="prog-card-action">${actionHtml}</div>
    </div>
    ${costRawHtml}
    ${costInteractionHtml}
    <div class="prog-card-meta-row">
      <span class="prog-card-gl">GL ${program.glCode}</span>
      ${billingHtml}
      ${ownerHtml}
      ${priorCostHtml}
      ${resourceLink}
    </div>
    ${program.description ? `<div class="prog-card-desc">${program.description}</div>` : ''}
    ${priorChip}
    ${dnaHtml}
  `;

  el.addEventListener('click', e => {
    if (e.target.closest('.btn-opt-out-trigger'))  openOptOutModal(program.id);
    if (e.target.closest('.btn-undo-optout'))      undoOptOut(program.id);
    if (e.target.closest('.btn-acknowledge'))      handleAcknowledge(program.id);
    if (e.target.closest('.btn-undo-acknowledge')) handleUndoAcknowledge(program.id);
    if (e.target.closest('.btn-include'))          handleElectiveInclude(program.id);
    if (e.target.closest('.btn-exclude'))          handleElectiveExclude(program.id);
  });

  // Does Not Apply checkbox
  const dnaCheck = el.querySelector('.dna-check');
  if (dnaCheck) {
    dnaCheck.addEventListener('change', async e => {
      e.stopPropagation();
      if (e.target.checked) {
        await setDecision(program.id, 'not-applicable');
      } else {
        const existing = S.decisions[program.id];
        if (existing) { try { await deleteDecision(existing.itemId); } catch {} }
        delete S.decisions[program.id];
        refreshCard(program.id);
        updateColumnCounts();
      }
    });
  }

  // ── Quantity input (per-unit / per-quantity / tiered with units) ─────────────
  const qtyInput = el.querySelector('.qty-input');
  if (qtyInput) {
    qtyInput.addEventListener('input', e => {
      e.stopPropagation();
      S.quantities[program.id] = parseInt(e.target.value) || 0;
      localStorage.setItem(`rpm_qty_${S.property}_${S.budgetYear}`, JSON.stringify(S.quantities));
      updateBudgetTotal();
      const t      = resolvedCost(program);
      const eqEl   = el.querySelector('.qty-equals');
      const hasQty = S.quantities[program.id] > 0;
      if (eqEl) {
        eqEl.innerHTML = hasQty ? `= <strong>${formatCost(t)}/yr</strong>` : '';
      } else if (hasQty) {
        const field = el.querySelector('.qty-field');
        if (field) { const s = document.createElement('span'); s.className = 'qty-equals'; s.innerHTML = `= <strong>${formatCost(t)}/yr</strong>`; field.after(s); }
      }
    });
  }

  // ── Tier radio buttons ────────────────────────────────────────────────────
  el.querySelectorAll('.tier-radio').forEach(radio => {
    radio.addEventListener('change', e => {
      e.stopPropagation();
      S.selectedTiers[program.id] = parseInt(e.target.dataset.tier);
      localStorage.setItem(`rpm_tiers_${S.property}_${S.budgetYear}`, JSON.stringify(S.selectedTiers));
      updateBudgetTotal();
      el.querySelectorAll('.tier-option').forEach((opt, i) =>
        opt.classList.toggle('is-selected', i === S.selectedTiers[program.id])
      );
      const t = resolvedCost(program);
      const eqEl = el.querySelector('.qty-equals');
      if (eqEl) eqEl.innerHTML = t > 0 ? `= <strong>${formatCost(t)}/yr</strong>` : '';
    });
  });

  // ── Manual budget input (complex / fallback costs) ────────────────────────
  const budgetInput = el.querySelector('.budget-input');
  if (budgetInput) {
    budgetInput.addEventListener('input', e => {
      e.stopPropagation();
      const val = parseFloat(e.target.value);
      if (!isNaN(val) && val >= 0) { S.budgetAmounts[program.id] = val; }
      else { delete S.budgetAmounts[program.id]; }
      localStorage.setItem(`rpm_budget_${S.property}_${S.budgetYear}`, JSON.stringify(S.budgetAmounts));
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

// ── Unit count edit (header badge → modal) ────────────────────────────────────
document.getElementById('btn-edit-units').addEventListener('click', () => {
  document.getElementById('units-modal-prop').textContent  = S.property || 'this property';
  document.getElementById('units-modal-input').value       = S.unitCount || '';
  openModal('modal-units');
});

document.getElementById('btn-units-save').addEventListener('click', () => {
  const val = parseInt(document.getElementById('units-modal-input').value) || 0;
  S.unitCount = val;
  localStorage.setItem(`rpm_units_${S.property}`, val);
  closeModal('modal-units');
  document.getElementById('hdr-unit-count').textContent = val > 0 ? `${val} units` : 'Set units';
  // Re-render all cards so per-unit calculations update
  renderDeptRows();
  updateBudgetTotal();
});

document.getElementById('btn-units-cancel').addEventListener('click', () => closeModal('modal-units'));

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
  clearFirebaseCache();
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
    S.quantities     = {};   // per-card overrides cleared; S.unitCount preserved
    S.selectedTiers  = {};
    S.budgetAmounts  = {};
    localStorage.removeItem(`rpm_qty_${S.property}_${S.budgetYear}`);
    localStorage.removeItem(`rpm_tiers_${S.property}_${S.budgetYear}`);
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
