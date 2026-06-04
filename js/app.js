import CONFIG from './config.js';
import { fetchProperties, clearMondayCache } from './monday.js';
import { fetchPrograms, filterBySystem, clearFirebaseCache } from './firebase.js';
import { loadDecisions, saveDecision, deleteDecision, resetDecisions, loadPriorYearDecisions } from './sharepoint.js';
import { showScreen, openModal, closeModal, groupStyle, formatCost, formatRate,
         renderSummary, populatePropertySelect } from './ui.js';
import { initAdmin } from './admin.js';

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
  transitionMonth: null,  // 0-11 if site transitioned mid-year; null = established (all year)
  quantities:      {},    // programId → per-card override quantity
  selectedTiers:   {},    // programId → selected tier index for tiered costs
  budgetAmounts:   {},    // programId → manual dollar amount (fallback for complex costs)
  incurMonths:     {},    // programId → [month indices] for as-incurred programs
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
    const savedTrans = localStorage.getItem(`rpm_transition_${e.target.value}`);
    document.getElementById('transition-select').value = (savedTrans === null) ? '' : savedTrans;
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

// Save transition month on change
document.getElementById('transition-select').addEventListener('change', e => {
  const prop = document.getElementById('property-select').value;
  if (prop) localStorage.setItem(`rpm_transition_${prop}`, e.target.value);
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
    const savedTrans = localStorage.getItem(`rpm_transition_${S.property}`);
    S.transitionMonth = (savedTrans === null || savedTrans === '') ? null : parseInt(savedTrans);
    try { S.quantities    = JSON.parse(localStorage.getItem(`rpm_qty_${S.property}_${S.budgetYear}`))   || {}; } catch { S.quantities    = {}; }
    try { S.selectedTiers = JSON.parse(localStorage.getItem(`rpm_tiers_${S.property}_${S.budgetYear}`)) || {}; } catch { S.selectedTiers = {}; }
    try { S.budgetAmounts = JSON.parse(localStorage.getItem(`rpm_budget_${S.property}_${S.budgetYear}`)) || {}; } catch { S.budgetAmounts = {}; }
    try { S.incurMonths   = JSON.parse(localStorage.getItem(`rpm_incur_${S.property}_${S.budgetYear}`))  || {}; } catch { S.incurMonths   = {}; }

    renderMainScreen();
    showScreen('screen-main');
  } catch (e) {
    console.error('Launch error', e);
    alert('Failed to load data: ' + e.message);
    showScreen('screen-setup');
  }
}

// ── Safe formula evaluator ────────────────────────────────────────────────────
// Only digits, math operators, parentheses, and the variables `units` and `qty`
// are allowed. Anything else → returns 0 (no arbitrary code execution).
function safeFormula(formula, units, qty) {
  if (!formula) return 0;
  const cleaned = String(formula).replace(/\bunits\b/g, '(U)').replace(/\bqty\b/g, '(Q)');
  if (/[^0-9+\-*/().\sUQ]/.test(cleaned)) return 0;       // whitelist only
  try {
    const fn = new Function('U', 'Q', `"use strict"; return (${cleaned});`);
    const v = fn(units || 0, qty || 0);
    return (typeof v === 'number' && isFinite(v)) ? v : 0;
  } catch { return 0; }
}

// ── Cost basis intelligence ───────────────────────────────────────────────────
// Reads clean structured fields from Firebase — no text parsing needed.
function parseCostBasisInfo(program) {
  const basis  = program.costBasis    || 'Manual';
  const rate   = program.rate         ?? 0;
  const period = program.billingPeriod === 'monthly' ? 'month' : 'year';

  // A custom formula overrides everything — it powers "Custom Formula" and any
  // admin-added cost-basis type.
  if (program.customFormula) {
    return { type: 'custom', formula: program.customFormula, usesQty: /\bqty\b/.test(program.customFormula), period };
  }

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

function customResult(program, info) {
  const qty = (program.id in S.quantities) ? S.quantities[program.id] : 0;
  return safeFormula(info.formula, S.unitCount, qty);
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

    case 'custom': {
      const r = customResult(program, info);
      return info.period === 'month' ? r * 12 : r;
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

// ── Active months: the one mechanism that drives every total ──────────────────
// Returns the list of month indices (0-11) a program's cost actually lands in,
// after applying billing frequency, the property transition month, and any
// per-card override the PM has set.
function monthsForFrequency(freq, start) {
  if (freq.includes('monthly'))                                    return [0,1,2,3,4,5,6,7,8,9,10,11];
  if (freq.includes('quarterly'))                                  return [0,1,2,3].map(i => (start + i*3) % 12);
  if (freq.includes('bi-annual') || freq.includes('bi-annu'))      return [start % 12, (start + 6) % 12];
  if (freq.includes('annual'))                                     return [start % 12];
  return [];
}

function defaultMonthsFor(program) {
  const freq = (program.billingFreq || program.billingPeriod || '').toLowerCase();
  if (freq.includes('incurred')) return [];   // PM picks explicitly
  return monthsForFrequency(freq, parseStartMonth(program.billingStart)).sort((a, b) => a - b);
}

function activeMonthsFor(program) {
  // Explicit per-card override (also how as-incurred programs are set)
  if (S.incurMonths[program.id]) return S.incurMonths[program.id].slice().sort((a, b) => a - b);

  const freq = (program.billingFreq || program.billingPeriod || '').toLowerCase();
  if (freq.includes('incurred')) return [];

  // Does this item follow the property's transition (e.g. "When Implemented"),
  // or is it pinned to a fixed calendar month (e.g. Annual Awards every December)?
  const followsTransition = /implement|transition|anniversar/i.test(program.billingStart || '');
  let start = parseStartMonth(program.billingStart);
  if (followsTransition && S.transitionMonth != null) start = S.transitionMonth;

  let months = monthsForFrequency(freq, start);

  // Fixed calendar months: if a hit falls before the transition, the site
  // missed it this year — drop it (don't shift it forward).
  if (!followsTransition && S.transitionMonth != null) {
    months = months.filter(m => m >= S.transitionMonth);
  }
  return months.sort((a, b) => a - b);
}

// How many billing hits a full year would have — used to prorate.
function naturalMonthCount(program) {
  const freq = (program.billingFreq || program.billingPeriod || '').toLowerCase();
  if (freq.includes('monthly'))   return 12;
  if (freq.includes('quarterly')) return 4;
  if (freq.includes('bi'))        return 2;
  if (freq.includes('incurred') || freq.includes('implement')) {
    return (S.incurMonths[program.id] || []).length || 1;
  }
  return 1; // annual / one-time
}

// Annual cost after proration for active months (transitions, partial years).
function proratedAnnual(program) {
  const base = resolvedCost(program);
  if (!base) return 0;
  const nat = naturalMonthCount(program);
  if (nat <= 0) return base;
  return base * (activeMonthsFor(program).length / nat);
}

function getMonthlyBreakdown() {
  const months = Array(12).fill(0);
  S.programs.forEach(p => {
    const dec      = S.decisions[p.id]?.decision;
    const included = p.required
      ? dec !== 'opted-out' && dec !== 'not-applicable'
      : dec === 'in';
    if (!included) return;

    const base = resolvedCost(p);
    if (!base) return;
    const nat = naturalMonthCount(p);
    if (nat <= 0) return;
    const per = base / nat;                  // amount per billing hit
    activeMonthsFor(p).forEach(m => months[m] += per);
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
    case 'custom': return customResult(program, info);
    default: return 0;
  }
}

// The big number shown at the top-right of each card.
// Monthly-billed programs show their monthly figure; everything else shows annual.
function heroCost(program) {
  const isMonthly = program.billingPeriod === 'monthly';
  const v = isMonthly ? resolvedMonthlyCost(program) : resolvedCost(program);
  return v > 0 ? formatCost(v) : '—';
}
function heroSuffix(program) {
  return program.billingPeriod === 'monthly' ? '/mo' : '/yr';
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
      annual  += proratedAnnual(p);          // respects transition / active months
      monthly += resolvedMonthlyCost(p);     // steady monthly run-rate (per active month)
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

// ── Info-mode card — matches the interactive design, read-only ────────────────
function buildInfoCard(program) {
  const el = document.createElement('div');
  el.className = 'prog-card prog-card-info';
  el.dataset.programId = program.id;

  const info   = parseCostBasisInfo(program);
  const mo     = program.billingPeriod === 'monthly';
  const suffix = mo ? '/mo' : '/yr';

  // Subtitle (rate basis)
  let subtitle = '';
  if (info.type === 'per-unit' || info.type === 'per-quantity') subtitle = `${formatRate(info.rate)} / ${info.label.toLowerCase()}`;
  else if (info.type === 'flat')          subtitle = 'Flat fee';
  else if (info.type === 'flat-per-unit') subtitle = `${formatRate(info.baseFee)} base + ${formatRate(info.rate)} / unit`;
  else if (info.type === 'tiered')        subtitle = info.isPerUnit ? 'Tiered · per unit' : 'Options';

  // Hero — headline figure (rate-based, no PM input in info mode)
  let hero = '';
  if (info.type === 'flat')                                   hero = formatCost(info.rate);
  else if (info.type === 'per-unit' || info.type === 'per-quantity') hero = formatRate(info.rate);
  else if (info.type === 'flat-per-unit')                     hero = formatRate(info.rate);
  else if (info.type === 'tiered' && info.tiers?.length)      hero = 'from ' + formatRate(Math.min(...info.tiers.map(t => t.rate)));
  else                                                        hero = '—';

  // Body — static cost detail
  let bodyHtml = '';
  if (info.type === 'tiered' && info.tiers?.length) {
    const perSuffix = info.isPerUnit ? (info.period === 'month' ? '/unit/mo' : '/unit/yr')
                    : (info.tiers[0]?.type === 'per-item' ? `/${(program.itemLabel || 'item').toLowerCase()}` : suffix);
    bodyHtml = `
      <div class="tier-select-label">Options</div>
      <div class="info-tier-list">
        ${info.tiers.map(t => `<div class="info-tier-row"><span class="tier-label">${t.label}</span><span class="tier-rate">${formatRate(t.rate)}${perSuffix}</span></div>`).join('')}
      </div>`;
  } else if (info.type === 'per-item') {
    bodyHtml = `<div class="info-cost-manual">${formatRate(info.rate)} per ${(program.itemLabel || 'item').toLowerCase()}</div>`;
  } else if (info.type === 'manual') {
    bodyHtml = `<div class="info-cost-manual">${program.costRaw || 'See program details'}</div>`;
  }

  // Static billing-month chips (non-interactive)
  const freqStr     = (program.billingFreq || program.billingPeriod || '').toLowerCase();
  const isRecurring = /monthly|quarter|annual|bi-/.test(freqStr);
  let monthsHtml = '';
  if (isRecurring) {
    const active = activeMonthsFor(program);
    monthsHtml = `
      <div class="incur-months">
        <div class="incur-label">Billing months</div>
        <div class="incur-chips">${MONTH_NAMES.map((m, i) => `<span class="incur-chip${active.includes(i) ? ' on' : ''} is-static">${m}</span>`).join('')}</div>
      </div>`;
  }

  const resourceLink = program.resourceUrl
    ? `<a class="card-guide-link" href="${program.resourceUrl}" target="_blank" rel="noopener">Click here for the program guide →</a>`
    : `<a class="card-guide-link is-placeholder" href="#" onclick="return false;">Program guide coming soon</a>`;

  el.innerHTML = `
    <div class="card-head">
      <div class="card-head-main">
        <h3 class="prog-card-name">${program.name}</h3>
        ${program.programOwner ? `<div class="card-owner">${program.programOwner}</div>` : ''}
        ${subtitle ? `<div class="card-rate-basis">${subtitle}</div>` : ''}
      </div>
      <div class="card-head-side">
        <div class="card-gl">GL: ${program.glCode}</div>
        ${program.billingFreq ? `<div class="card-billing">${program.billingFreq}</div>` : ''}
        <div class="card-cost-hero"><span class="cost-hero-num">${hero}</span><span class="cost-hero-period">${info.type === 'flat' ? suffix : ''}</span></div>
      </div>
    </div>
    ${(bodyHtml || monthsHtml) ? '<div class="card-divider"></div>' : ''}
    ${bodyHtml}
    ${monthsHtml}
    <div class="card-foot">
      <button class="details-toggle" type="button">▾ Details</button>
    </div>
    <div class="card-details-panel">
      ${resourceLink}
      ${program.description ? `<div class="prog-card-desc">${program.description}</div>` : ''}
      ${program.setupFee ? `<div class="card-setup-fee">Setup: ${program.setupFee}</div>` : ''}
      ${program.priorYearNote ? `<div class="card-prioryear">Prior year: ${program.priorYearNote}</div>` : ''}
    </div>
  `;

  el.querySelector('.details-toggle')?.addEventListener('click', e => {
    e.stopPropagation();
    el.classList.toggle('details-open');
  });

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
    ? `<a class="card-guide-link" href="${program.resourceUrl}" target="_blank" rel="noopener">Click here for the program guide →</a>`
    : `<a class="card-guide-link is-placeholder" href="#" onclick="return false;">Program guide coming soon</a>`;

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
        <span class="card-status-badge status-followup">⚑ Follow-up</span>
        <button class="btn-card-ghost btn-opt-out-trigger" data-pid="${program.id}">Opt Out</button>`;
    } else if (dec === 'acknowledged') {
      actionHtml = `
        <span class="card-status-badge status-acknowledged">✓ Acknowledged</span>
        <button class="btn-card-ghost btn-undo-acknowledge" data-pid="${program.id}">Undo</button>`;
    } else {
      actionHtml = `
        <button class="btn-card-ghost btn-opt-out-trigger" data-pid="${program.id}">Opt Out</button>
        <button class="btn-card-fill btn-acknowledge" data-pid="${program.id}">Acknowledge</button>`;
    }
  } else {
    // Three-state toggle: Include / Remove / (neither = pending)
    const inSel  = dec === 'in';
    const outSel = dec === 'out';
    actionHtml = `
      <button class="btn-card-ghost btn-exclude${outSel ? ' is-on-out' : ''}" data-pid="${program.id}">${outSel ? '✓ Removed' : 'Remove'}</button>
      <button class="btn-card-fill btn-include${inSel ? ' is-on' : ''}" data-pid="${program.id}">${inSel ? '✓ Included' : 'Include'}</button>`;
  }

  const excludedOverlay = (!isRequired && dec === 'out')
    ? `<div class="excluded-overlay">Not Including</div>` : '';

  // ── Cost descriptor ───────────────────────────────────────────────────────
  const info    = parseCostBasisInfo(program);
  const qty     = effectiveQty(program, info);
  const tierIdx = S.selectedTiers[program.id] ?? 0;

  // Subtitle line under the program name — the rate basis
  let subtitle = '';
  if (info.type === 'per-unit' || info.type === 'per-quantity') {
    subtitle = `${formatRate(info.rate)} / ${info.label.toLowerCase()}`;
  } else if (info.type === 'flat') {
    subtitle = 'Flat fee';
  } else if (info.type === 'flat-per-unit') {
    subtitle = `${formatRate(info.baseFee)} base + ${formatRate(info.rate)} / unit`;
  } else if (info.type === 'tiered') {
    subtitle = info.isPerUnit ? 'Select tier · per unit' : 'Select one';
  } else if (info.type === 'custom') {
    subtitle = 'Custom calculation';
  }

  // Card body — interactive cost controls
  let bodyHtml = '';

  if (info.type === 'per-unit' || info.type === 'per-quantity') {
    bodyHtml = `
      <div class="card-calc">
        <span class="calc-rate">${formatRate(info.rate)}</span>
        <span class="calc-x">×</span>
        <div class="qty-field">
          <input class="qty-input" data-pid="${program.id}" type="number" min="0" placeholder="0" value="${qty || ''}">
        </div>
        <span class="qty-label">${info.plural}</span>
      </div>`;

  } else if (info.type === 'tiered') {
    const perSuffix = info.isPerUnit
      ? (info.period === 'month' ? '/unit/mo' : '/unit/yr')
      : (program.billingPeriod === 'monthly' ? '/mo' : '/yr');
    const tiersHtml = (info.tiers || []).map((t, i) => `
      <label class="tier-option${i === tierIdx ? ' is-selected' : ''}">
        <input type="radio" class="tier-radio" name="tier_${program.id}" data-pid="${program.id}" data-tier="${i}"${i === tierIdx ? ' checked' : ''}>
        <span class="tier-label">${t.label} <span class="tier-rate">(${formatRate(t.rate)}${perSuffix})</span></span>
      </label>`).join('');
    const qtyField = info.isPerUnit ? `
      <div class="card-calc">
        <span class="calc-x">×</span>
        <div class="qty-field">
          <input class="qty-input" data-pid="${program.id}" type="number" min="0" placeholder="0" value="${qty || ''}">
        </div>
        <span class="qty-label">Units</span>
      </div>` : '';
    bodyHtml = `
      <div class="tier-select-label">${info.isPerUnit ? 'Select a tier' : 'Select one'}</div>
      <div class="tier-options">${tiersHtml}</div>
      ${qtyField}`;

  } else if (info.type === 'flat-per-unit') {
    bodyHtml = `
      <div class="card-calc">
        <span class="calc-rate">${formatRate(info.baseFee)} base</span>
        <span class="calc-x">+</span>
        <span class="calc-rate">${formatRate(info.rate)}/unit</span>
        <span class="calc-x">×</span>
        <div class="qty-field">
          <input class="qty-input" data-pid="${program.id}" type="number" min="0" placeholder="0" value="${qty || ''}">
        </div>
        <span class="qty-label">Units</span>
      </div>`;

  } else if (info.type === 'custom') {
    bodyHtml = info.usesQty ? `
      <div class="card-calc">
        <span class="calc-rate">How many?</span>
        <div class="qty-field">
          <input class="qty-input" data-pid="${program.id}" type="number" min="0" placeholder="0" value="${qty || ''}">
        </div>
      </div>` : '';

  } else if (info.type === 'manual') {
    const savedAmt = S.budgetAmounts[program.id];
    bodyHtml = `
      <div class="card-calc">
        <span class="budget-input-label">Budget&nbsp;$</span>
        <input class="budget-input" data-pid="${program.id}" type="number" min="0" step="1"
               placeholder="Enter amount" value="${savedAmt !== undefined ? savedAmt : ''}">
      </div>`;
  }

  // Month selection — as-incurred programs pick explicitly (shown in body);
  // every other recurring program gets an adjustable strip inside Details.
  const freqStr      = (program.billingFreq || program.billingPeriod || '').toLowerCase();
  const isAsIncurred = freqStr.includes('incurred') || freqStr.includes('implement');
  const isRecurring  = /monthly|quarter|annual|bi-/.test(freqStr);
  const monthChipStrip = (preset) => MONTH_NAMES.map((m, i) =>
    `<button type="button" class="incur-chip${preset.includes(i) ? ' on' : ''}" data-month="${i}">${m}</button>`
  ).join('');

  if (isAsIncurred) {
    bodyHtml += `
      <div class="incur-months">
        <div class="incur-label">Expected in which months?</div>
        <div class="incur-chips">${monthChipStrip(S.incurMonths[program.id] || [])}</div>
      </div>`;
  } else if (isRecurring) {
    bodyHtml += `
      <div class="incur-months">
        <div class="incur-label">Billing months${S.transitionMonth != null ? ' · transition applied' : ''}</div>
        <div class="incur-chips">${monthChipStrip(activeMonthsFor(program))}</div>
      </div>`;
  }

  const dnaCorner = isRequired ? `
    <label class="dna-corner" title="Does not apply to this property">
      <input type="checkbox" class="dna-check" data-pid="${program.id}"${dec === 'not-applicable' ? ' checked' : ''}>
      <span>Does not apply<br>to this property</span>
    </label>` : '';

  const heroV = heroCost(program);

  el.innerHTML = `
    ${excludedOverlay}
    <div class="card-head">
      <div class="card-head-main">
        <h3 class="prog-card-name">${program.name}</h3>
        ${program.programOwner ? `<div class="card-owner">${program.programOwner}</div>` : ''}
        ${subtitle ? `<div class="card-rate-basis">${subtitle}</div>` : ''}
      </div>
      <div class="card-head-side">
        ${dnaCorner}
        <div class="card-gl">GL: ${program.glCode}</div>
        ${program.billingFreq ? `<div class="card-billing">${program.billingFreq}</div>` : ''}
        <div class="card-cost-hero">
          <span class="cost-hero-num">${heroV}</span><span class="cost-hero-period">${heroSuffix(program)}</span>
        </div>
      </div>
    </div>
    ${bodyHtml ? '<div class="card-divider"></div>' : ''}
    ${bodyHtml}
    <div class="card-foot">
      <button class="details-toggle" type="button">▾ Details</button>
      <div class="prog-card-action">${actionHtml}</div>
    </div>
    <div class="card-details-panel">
      ${resourceLink}
      ${program.description ? `<div class="prog-card-desc">${program.description}</div>` : ''}
      ${program.setupFee ? `<div class="card-setup-fee">Setup: ${program.setupFee}</div>` : ''}
      ${program.priorYearNote ? `<div class="card-prioryear">Prior year: ${program.priorYearNote}</div>` : ''}
      ${priorChip}
    </div>
  `;

  // Details collapsible
  el.querySelector('.details-toggle')?.addEventListener('click', e => {
    e.stopPropagation();
    el.classList.toggle('details-open');
  });

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
  const refreshHero = () => {
    const heroEl = el.querySelector('.cost-hero-num');
    if (heroEl) heroEl.textContent = heroCost(program);
  };

  // Month chips (as-incurred body picker + per-card billing-month override)
  el.querySelectorAll('.incur-chip').forEach(chip => {
    chip.addEventListener('click', e => {
      e.stopPropagation();
      const m = parseInt(chip.dataset.month);
      // Seed an override from the current active months the first time it's touched
      let arr = S.incurMonths[program.id];
      if (!arr) arr = isAsIncurred ? [] : activeMonthsFor(program).slice();
      const idx = arr.indexOf(m);
      if (idx >= 0) arr.splice(idx, 1); else arr.push(m);
      S.incurMonths[program.id] = arr;
      localStorage.setItem(`rpm_incur_${S.property}_${S.budgetYear}`, JSON.stringify(S.incurMonths));
      chip.classList.toggle('on');
      updateBudgetTotal();
    });
  });

  const qtyInput = el.querySelector('.qty-input');
  if (qtyInput) {
    qtyInput.addEventListener('input', e => {
      e.stopPropagation();
      S.quantities[program.id] = parseInt(e.target.value) || 0;
      localStorage.setItem(`rpm_qty_${S.property}_${S.budgetYear}`, JSON.stringify(S.quantities));
      updateBudgetTotal();
      refreshHero();
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
      refreshHero();
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
      refreshHero();
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

// ── Elective actions (three-state toggle) ─────────────────────────────────────
async function clearDecision(programId) {
  const existing = S.decisions[programId];
  if (existing) { try { await deleteDecision(existing.itemId); } catch {} }
  delete S.decisions[programId];
  refreshCard(programId);
  updateColumnCounts();
  updateBudgetTotal();
}

async function handleElectiveInclude(programId) {
  // Clicking the active "Included" returns it to pending
  if (S.decisions[programId]?.decision === 'in') await clearDecision(programId);
  else await setDecision(programId, 'in');
}

async function handleElectiveExclude(programId) {
  if (S.decisions[programId]?.decision === 'out') await clearDecision(programId);
  else await setDecision(programId, 'out');
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
  document.getElementById('units-modal-transition').value  = S.transitionMonth == null ? '' : String(S.transitionMonth);
  openModal('modal-units');
});

document.getElementById('btn-units-save').addEventListener('click', () => {
  const val = parseInt(document.getElementById('units-modal-input').value) || 0;
  S.unitCount = val;
  localStorage.setItem(`rpm_units_${S.property}`, val);

  const tVal = document.getElementById('units-modal-transition').value;
  S.transitionMonth = tVal === '' ? null : parseInt(tVal);
  localStorage.setItem(`rpm_transition_${S.property}`, tVal);

  closeModal('modal-units');
  document.getElementById('hdr-unit-count').textContent = val > 0 ? `${val} units` : 'Set units';
  // Re-render all cards so per-unit + month calculations update
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
    S.incurMonths    = {};
    localStorage.removeItem(`rpm_qty_${S.property}_${S.budgetYear}`);
    localStorage.removeItem(`rpm_tiers_${S.property}_${S.budgetYear}`);
    localStorage.removeItem(`rpm_budget_${S.property}_${S.budgetYear}`);
    localStorage.removeItem(`rpm_incur_${S.property}_${S.budgetYear}`);
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
initAdmin();
boot();
