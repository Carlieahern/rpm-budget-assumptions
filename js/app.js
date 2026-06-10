import CONFIG from './config.js';
import { fetchProperties, clearMondayCache } from './monday.js';
import { fetchPrograms, filterBySystem, clearFirebaseCache, fetchLegacyBanner } from './firebase.js';
import { loadDecisions, saveDecision, deleteDecision, resetDecisions, loadPriorYearDecisions } from './sharepoint.js';
import { showScreen, openModal, closeModal, groupStyle, formatCost, formatRate,
         renderSummary, populatePropertySelect } from './ui.js';
import { initAdmin, promptAdminLogin, editProgram, newProgram, isAdminAuthed, openAdmin } from './admin.js';

// ── App State ───────────────────────────────────────────────────────────────
const S = {
  budgetYear:      CONFIG.budgetYear,
  property:        null,
  systemType:      null,
  mode:            'interactive', // 'interactive' | 'info'
  admin:           false,         // inline admin editing enabled in the dashboard
  allPrograms:     [],
  programs:        [],    // filtered by system
  decisions:       {},    // programId → { itemId, decision, optOutApproval, ... }
  priorDecisions:  {},
  unitCount:       0,     // global property unit count, pre-fills all per-unit inputs
  transitionMonth: null,  // 0-11 if site transitioned mid-year; null = established (all year)
  quantities:      {},    // programId → per-card override quantity
  selectedTiers:   {},    // programId → selected tier index for tiered costs (pick-one mode)
  optionQty:       {},    // programId → [qty per option] for additive tiered costs
  compInputs:      {},    // "programId:partIdx" → PM numeric input (per-item qty, % base, formula qty)
  compSel:         {},    // "programId:partIdx" → option selection (index for one, [qty] for multiple)
  partSeparate:    {},    // "programId:partIdx" → bool: this part is billed in its own months
  partMonths:      {},    // "programId:partIdx" → [month indices] when billed separately
  spreadMonthly:   {},    // programId → bool: split the annual evenly across the year in the breakdown
  setupOn:         {},    // programId → include the one-time setup fee?
  setupMonth:      {},    // programId → month index the setup fee is charged
  budgetAmounts:   {},    // programId → manual dollar amount (fallback for complex costs)
  incurMonths:     {},    // programId → [month indices] for as-incurred programs
  currentOptOutId: null,
  viewingPrior:    false,
  search:          '',    // dashboard search filter (department / program name / setup fee name)
};

// "Looking for 2026?" floating box — shown only if admin enabled it
async function applyLegacyBanner() {
  const box = document.getElementById('legacy-box');
  if (!box) return;
  let cfg = null;
  try { cfg = await fetchLegacyBanner(); } catch {}
  if (!cfg || !cfg.show) { box.style.display = 'none'; return; }
  document.getElementById('legacy-box-title').textContent = cfg.title || 'Looking for 2026?';
  const setLink = (id, url) => {
    const a = document.getElementById(id);
    if (url) { a.href = url; a.classList.remove('hidden'); }
    else a.classList.add('hidden');
  };
  setLink('legacy-yardi', cfg.yardi);
  setLink('legacy-onesite', cfg.onesite);
  setLink('legacy-pace', cfg.pace);
  box.style.display = 'flex';
}

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

  applyLegacyBanner();

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
    applyVisiblePrograms();
    S.decisions      = decisions;
    S.priorDecisions = priorDecisions;

    // Load saved input values
    S.unitCount    = parseInt(localStorage.getItem(`rpm_units_${S.property}`)) || 0;
    const savedTrans = localStorage.getItem(`rpm_transition_${S.property}`);
    S.transitionMonth = (savedTrans === null || savedTrans === '') ? null : parseInt(savedTrans);
    try { S.quantities    = JSON.parse(localStorage.getItem(`rpm_qty_${S.property}_${S.budgetYear}`))   || {}; } catch { S.quantities    = {}; }
    try { S.selectedTiers = JSON.parse(localStorage.getItem(`rpm_tiers_${S.property}_${S.budgetYear}`)) || {}; } catch { S.selectedTiers = {}; }
    try { S.optionQty     = JSON.parse(localStorage.getItem(`rpm_optqty_${S.property}_${S.budgetYear}`)) || {}; } catch { S.optionQty     = {}; }
    try { S.compInputs    = JSON.parse(localStorage.getItem(`rpm_compin_${S.property}_${S.budgetYear}`)) || {}; } catch { S.compInputs    = {}; }
    try { S.compSel       = JSON.parse(localStorage.getItem(`rpm_compsel_${S.property}_${S.budgetYear}`)) || {}; } catch { S.compSel       = {}; }
    try { S.partSeparate  = JSON.parse(localStorage.getItem(`rpm_partsep_${S.property}_${S.budgetYear}`)) || {}; } catch { S.partSeparate  = {}; }
    try { S.partMonths    = JSON.parse(localStorage.getItem(`rpm_partmo_${S.property}_${S.budgetYear}`)) || {}; } catch { S.partMonths    = {}; }
    try { S.spreadMonthly = JSON.parse(localStorage.getItem(`rpm_spread_${S.property}_${S.budgetYear}`)) || {}; } catch { S.spreadMonthly = {}; }
    try { S.setupOn       = JSON.parse(localStorage.getItem(`rpm_setupon_${S.property}_${S.budgetYear}`)) || {}; } catch { S.setupOn       = {}; }
    try { S.setupMonth    = JSON.parse(localStorage.getItem(`rpm_setupmonth_${S.property}_${S.budgetYear}`)) || {}; } catch { S.setupMonth    = {}; }
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

// Min/Max note for the Details panel
function minMaxNote(p) {
  if (p.minCost == null && p.maxCost == null) return '';
  const per = p.billingPeriod === 'monthly' ? '/mo' : '/yr';
  const parts = [];
  if (p.minCost != null) parts.push(`Min ${formatCost(p.minCost)}${per}`);
  if (p.maxCost != null) parts.push(`Max ${formatCost(p.maxCost)}${per}`);
  return `<div class="card-prioryear">${parts.join(' · ')}</div>`;
}

// Visible Min/Max line shown on the card face
function minMaxLine(p) {
  if (p.minCost == null && p.maxCost == null) return '';
  const per = p.billingPeriod === 'monthly' ? '/mo' : '/yr';
  const parts = [];
  if (p.minCost != null) parts.push(`Min ${formatCost(p.minCost)}${per}`);
  if (p.maxCost != null) parts.push(`Max ${formatCost(p.maxCost)}${per}`);
  return `<div class="minmax-line">${parts.join(' · ')}</div>`;
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
        tiers: opts.map(o => ({ label: o.label, rate: o.rate, type: o.type })),
        isPerUnit,
        isPerItem,
        additive: !!program.additive,   // true → PM enters a qty per option, costs sum
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

// ── Universal cost builder ─────────────────────────────────────────────────────
// A program's cost = sum of its parts (components). Each part returns a per-billing-
// period amount; resolvedCost annualizes + clamps. PM inputs are keyed "id:idx".
function num(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }

function partPeriodCost(program, part, idx, prefix = '') {
  const key = `${prefix}${program.id}:${idx}`;
  switch (part.kind) {
    case 'flat':
      return num(part.amount);
    case 'perUnit': {
      // Editable box defaults to the property unit count; PM can override (unless locked)
      const count = part.locked ? S.unitCount
                  : (S.compInputs[key] != null ? num(S.compInputs[key]) : S.unitCount);
      return num(part.rate) * count;
    }
    case 'perItem': {
      // The editable box shows the count (defaults to baseQty). Cost = rate × count.
      const count = part.locked ? num(part.baseQty)
                  : (S.compInputs[key] != null ? num(S.compInputs[key]) : num(part.baseQty));
      // Rate may be PM-editable (override stored under ":rate"), else the admin default
      const rOv = S.compInputs[`${key}:rate`];
      const rate = (part.rateEditable && rOv != null && rOv !== '') ? num(rOv) : num(part.rate);
      return rate * count;
    }
    case 'percent': {
      const base = part.locked ? num(part.baseDefault)
                 : (S.compInputs[key] != null ? num(S.compInputs[key]) : num(part.baseDefault));
      return num(part.pct) / 100 * base;
    }
    case 'options': {
      const opts = part.options || [];
      if (part.selectMode === 'multiple') {
        // Each checked option's box is its count (= units when perUnit) × that option's rate
        const qtys = S.compSel[key] || [];
        return opts.reduce((s, o, i) => s + num(o.rate) * (qtys[i] || 0), 0);
      }
      // Pick one: optionally × the editable unit box (defaults to the property unit count)
      const units = (S.compInputs[key] != null && S.compInputs[key] !== '') ? num(S.compInputs[key]) : S.unitCount;
      const sel = S.compSel[key] ?? 0;
      return num(opts[sel]?.rate) * (part.perUnit ? units : 1);
    }
    case 'manual':
      return part.locked ? 0 : num(S.compInputs[key]);
    case 'formula':
      return safeFormula(part.expr, S.unitCount, num(S.compInputs[key]));
    case 'tax':
      return 0;   // tax is computed against the other parts (see sumPartsWithTax)
    default:
      return 0;
  }
}

// Effective tax rate: PM override (editable on the card) falls back to the admin default
function taxPctFor(program, part, idx, prefix = '') {
  const v = S.compInputs[`${prefix}${program.id}:${idx}`];
  return (v != null && v !== '') ? num(v) : num(part.pct);
}

// Sum a parts array, adding any "tax" part as a % of the non-tax (taxable) total.
function sumPartsWithTax(program, parts, prefix = '') {
  let taxable = 0, taxPct = 0;
  (parts || []).forEach((part, i) => {
    if (part.kind === 'tax') taxPct += taxPctFor(program, part, i, prefix);
    else taxable += partPeriodCost(program, part, i, prefix);
  });
  return taxable + taxable * taxPct / 100;
}

function componentPeriodCost(program) {
  return sumPartsWithTax(program, program.components, '');
}

function hasComponents(program) {
  return Array.isArray(program.components) && program.components.length > 0;
}

function hasSetupBuilder(program) {
  return Array.isArray(program.setupComponents) && program.setupComponents.length > 0;
}

// One-time setup fee total — from the setup cost builder, else the legacy flat amount
function setupTotal(program) {
  if (hasSetupBuilder(program)) {
    return sumPartsWithTax(program, program.setupComponents, 'setup:');
  }
  return num(program.setupAmount);
}

function rawResolvedCost(program) {
  // New component model takes precedence when present
  if (hasComponents(program)) {
    const per = componentPeriodCost(program);
    return program.billingPeriod === 'monthly' ? per * 12 : per;
  }

  const info    = parseCostBasisInfo(program);
  const qty     = effectiveQty(program, info) + (program.baseQty || 0);
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
      if (info.additive) {
        const qtys = S.optionQty[program.id] || [];
        const sum  = (info.tiers || []).reduce((s, t, i) => s + (t.rate || 0) * (qtys[i] || 0), 0);
        return program.billingPeriod === 'monthly' ? sum * 12 : sum;
      }
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

// Clamp the annual cost to min/max if set. Min/max are entered per billing period,
// so monthly programs scale the bounds by 12.
function resolvedCost(program) {
  let v = rawResolvedCost(program);
  const mo  = program.billingPeriod === 'monthly';
  const min = program.minCost != null ? (mo ? program.minCost * 12 : program.minCost) : null;
  const max = program.maxCost != null ? (mo ? program.maxCost * 12 : program.maxCost) : null;
  if (min != null && v < min) v = min;
  if (max != null && max > 0 && v > max) v = max;
  return v;
}

// Is the PM's entry below the program's minimum (per billing period)?
function belowMinimum(program) {
  if (program.minCost == null) return false;
  const raw = program.billingPeriod === 'monthly'
    ? rawResolvedMonthlyCost(program)
    : rawResolvedCost(program);
  return raw < program.minCost;
}

// Live-toggle the red minimum warnings across all visible cards
function updateMinNotes() {
  document.querySelectorAll('.prog-card').forEach(card => {
    const note = card.querySelector('.min-note');
    if (!note) return;
    const p = S.programs.find(x => x.id === card.dataset.programId);
    if (!p) return;
    note.style.display = belowMinimum(p) ? 'block' : 'none';
  });
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
  // Per-card override (also how as-incurred programs are set) — only if not locked
  // and only when it actually has months (an empty override must not shadow the admin default)
  if (!program.monthsFixed && S.incurMonths[program.id] && S.incurMonths[program.id].length) {
    return S.incurMonths[program.id].slice().sort((a, b) => a - b);
  }

  const freq = (program.billingFreq || program.billingPeriod || '').toLowerCase();
  const isIncurred = freq.includes('incurred') || freq.includes('implement');
  const followsTransition = /implement|transition|anniversar/i.test(program.billingStart || '');

  // Admin-defined default months take precedence over frequency-derived ones
  let months;
  if (Array.isArray(program.defaultMonths) && program.defaultMonths.length) {
    months = program.defaultMonths.slice();
  } else if (isIncurred) {
    return [];   // as-incurred with no admin default — PM picks from scratch
  } else {
    let start = parseStartMonth(program.billingStart);
    if (followsTransition && S.transitionMonth != null) start = S.transitionMonth;
    months = monthsForFrequency(freq, start);
  }

  // Fixed calendar months: a hit before the transition was missed — drop it.
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
    return activeMonthsFor(program).length || 1;
  }
  return 1; // annual / one-time
}

// Per-program 12-month spend array. Single source of truth — both the annual
// total and the monthly breakdown derive from this, so they can't disagree.
// Each part is charged its per-month "hit" in each of its billing months;
// "billed separately" parts use their own months and are excluded from the default.
function programMonths12(program) {
  const arr = Array(12).fill(0);

  if (!hasComponents(program)) {
    const base = resolvedCost(program);
    const nat  = naturalMonthCount(program);
    if (base && nat > 0) { const per = base / nat; activeMonthsFor(program).forEach(m => arr[m] += per); }
    return arr;
  }

  const mo  = program.billingPeriod === 'monthly';
  const nat = naturalMonthCount(program) || 1;
  const progMonths = activeMonthsFor(program);
  // Months a true-monthly cost recurs in (every month, minus any pre-transition months)
  const monthlyMonths = [0,1,2,3,4,5,6,7,8,9,10,11].filter(m => S.transitionMonth == null || m >= S.transitionMonth);
  let taxPct = 0;
  (program.components || []).forEach((c, i) => {
    if (c.kind === 'tax') { taxPct += taxPctFor(program, c, i, ''); return; }
    const per = partPeriodCost(program, c, i);
    if (!per) return;
    const key = `${program.id}:${i}`;
    // Manual estimate is a MONTHLY amount → bills every month (×12), regardless of program frequency
    const isManual = c.kind === 'manual';
    const hit = (isManual || mo) ? per : per / nat;
    const ms = S.partSeparate[key] ? (S.partMonths[key] || []) : (isManual ? monthlyMonths : progMonths);
    ms.forEach(m => arr[m] += hit);
  });
  // Tax applies on top of each month's taxable spend
  if (taxPct) for (let m = 0; m < 12; m++) arr[m] += arr[m] * taxPct / 100;

  // PM chose to view this split evenly across the year — same annual, spread monthly
  if (S.spreadMonthly[program.id]) {
    const total = arr.reduce((s, v) => s + v, 0);
    const out = Array(12).fill(0);
    if (total && monthlyMonths.length) {
      const each = total / monthlyMonths.length;
      monthlyMonths.forEach(m => out[m] = each);
    }
    return out;
  }
  return arr;
}

// Annual cost = sum of the monthly spend (respects transitions + separate billing).
function proratedAnnual(program) {
  return programMonths12(program).reduce((s, v) => s + v, 0);
}

function getMonthlyBreakdown() {
  const months = Array(12).fill(0);
  S.programs.forEach(p => {
    const dec      = S.decisions[p.id]?.decision;
    const included = p.required
      ? dec !== 'opted-out' && dec !== 'not-applicable'
      : dec === 'in';
    if (!included) return;

    // One-time setup fee lands in its chosen month
    if (S.setupOn[p.id]) {
      const st = setupTotal(p);
      if (st > 0) { const sm = S.setupMonth[p.id] ?? (p.setupMonth ?? 0); months[sm] += st; }
    }

    // Same source of truth as the annual total
    const arr = programMonths12(p);
    for (let m = 0; m < 12; m++) months[m] += arr[m];
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
        <span class="mb-amount">${zero ? '—' : formatCost(val)}</span>
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
  const oldVal = parseFloat(el.textContent.replace(/[^0-9.]/g, '')) || 0;
  if (Math.abs(oldVal - newVal) < 0.005) {
    el.textContent = newVal > 0 ? formatCost(newVal) : '—';   // exact, with cents
    return;
  }
  const duration = 450;
  const start    = performance.now();
  const tick = (now) => {
    const p = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - p, 3); // ease-out cubic
    const cur = oldVal + (newVal - oldVal) * eased;
    // Smooth whole-dollar count during the animation, exact value at the end
    el.textContent = newVal > 0 ? (p >= 1 ? formatCost(newVal) : fmt.format(cur)) : '—';
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// Returns the actual monthly charge for a program (only for monthly-billed items).
// As-incurred, annual, and quarterly items return 0 here — they belong in the annual total only.
function rawResolvedMonthlyCost(program) {
  if (program.billingPeriod !== 'monthly') return 0;
  if (hasComponents(program)) return componentPeriodCost(program);
  const info = parseCostBasisInfo(program);
  const qty  = effectiveQty(program, info) + (program.baseQty || 0);
  switch (info.type) {
    case 'flat':         return info.rate;
    case 'per-unit':
    case 'per-quantity': return info.rate * qty;
    case 'flat-per-unit': return info.baseFee + info.rate * qty;
    case 'tiered': {
      if (info.additive) {
        const qtys = S.optionQty[program.id] || [];
        return (info.tiers || []).reduce((s, t, i) => s + (t.rate || 0) * (qtys[i] || 0), 0);
      }
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

// Clamp monthly to per-period min/max (only for monthly-billed programs).
function resolvedMonthlyCost(program) {
  let v = rawResolvedMonthlyCost(program);
  if (program.billingPeriod === 'monthly') {
    const { minCost: min, maxCost: max } = program;
    if (min != null && v < min) v = min;
    if (max != null && max > 0 && v > max) v = max;
  }
  return v;
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
  S.programs.forEach(p => {
    const dec = S.decisions[p.id]?.decision;
    const included = p.required
      ? dec !== 'opted-out' && dec !== 'not-applicable'
      : dec === 'in';
    if (included) {
      annual += proratedAnnual(p);           // respects transition / active months
      if (S.setupOn[p.id]) annual += setupTotal(p);  // one-time setup fee
    }
  });
  const monthly = annual / 12;               // true average per month — moves with month selection
  animateCost(document.getElementById('budget-total'),  annual);
  animateCost(document.getElementById('monthly-total'), monthly);
  updateMinNotes();
  if (monthlyExpanded) renderMonthlyBreakdown();
}

function renderMainScreen() {
  // With no property selected (system-only browse), the system becomes the big title
  const hasProp = !!S.property;
  document.getElementById('hdr-property').textContent = hasProp ? S.property : S.systemType;
  const sysSpan = document.getElementById('hdr-system');
  sysSpan.textContent = hasProp ? S.systemType : '';
  sysSpan.style.display = hasProp ? '' : 'none';
  if (sysSpan.nextElementSibling) sysSpan.nextElementSibling.style.display = hasProp ? '' : 'none';
  document.getElementById('hdr-year').textContent       = `FY ${S.budgetYear}`;
  document.getElementById('hdr-unit-count').textContent = S.unitCount > 0 ? `${S.unitCount} units` : 'Set units';

  // Mode badge — only visible in info mode
  const modeBadge = document.getElementById('hdr-mode-badge');
  if (modeBadge) {
    modeBadge.textContent = S.mode === 'info' ? 'Info Only' : '';
    modeBadge.className   = `mode-badge${S.mode === 'info' ? ' mode-info' : ''}`;
  }
  const adminBadge = document.getElementById('hdr-admin-badge');
  if (adminBadge) {
    adminBadge.textContent = S.admin ? '✎ Admin Mode' : '';
    adminBadge.className   = `admin-badge${S.admin ? ' on' : ''}`;
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

  // Admin: global "Add Program" bar at the top
  if (S.admin) {
    const bar = document.createElement('div');
    bar.className = 'admin-addbar';
    bar.innerHTML = `<button class="admin-addbar-btn" type="button">+ Add New Program</button>`;
    bar.querySelector('button').addEventListener('click', () => newProgram('', refreshDashboard));
    body.appendChild(bar);
  }

  // Search filter — match on department, program name, or setup fee name
  const q = (S.search || '').trim().toLowerCase();
  const matchesSearch = p => {
    if (!q) return true;
    return (p.group || '').toLowerCase().includes(q)
        || (p.name  || '').toLowerCase().includes(q)
        || (p.setupName || '').toLowerCase().includes(q);
  };
  const visible = S.programs.filter(matchesSearch);

  if (q && !visible.length) {
    body.innerHTML = `<p class="search-empty">No programs match “${S.search.trim()}”.</p>`;
    updateColumnCounts();
    return;
  }

  // Collect departments in the order they first appear
  const deptOrder = [];
  const seen = new Set();
  visible.forEach(p => {
    if (!seen.has(p.group)) { seen.add(p.group); deptOrder.push(p.group); }
  });

  deptOrder.forEach(dept => {
    const nonElective = visible.filter(p => p.group === dept &&  p.required);
    const elective    = visible.filter(p => p.group === dept && !p.required);
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

    // Admin: add-to-department buttons under each column
    if (S.admin) {
      const mkBtn = (label, elective) => {
        const b = document.createElement('button');
        b.className = 'dept-add-btn';
        b.type = 'button';
        b.textContent = label;
        b.addEventListener('click', () => newProgram(dept, refreshDashboard));
        return b;
      };
      leftCol.appendChild(mkBtn('+ Add non-elective'));
      rightCol.appendChild(mkBtn('+ Add elective'));
    }
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

  // Quick-reference lists of what's acknowledged / included
  const ackNames = req.filter(p => S.decisions[p.id]?.decision === 'acknowledged').map(p => p.name);
  const incNames = elec.filter(p => S.decisions[p.id]?.decision === 'in').map(p => p.name);
  const fill = (id, names) => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = names.map(n => `<div class="side-ref-item">${n}</div>`).join('');
  };
  fill('side-nonelective-list', ackNames);
  fill('side-elective-list', incNames);
}

// ── Info-mode card — matches the interactive design, read-only ────────────────
function buildInfoCard(program) {
  const el = document.createElement('div');
  el.className = 'prog-card prog-card-info';
  if (!program.required) el.classList.add('is-elective');   // mirror interactive theme
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

  // Components override hero + subtitle
  if (hasComponents(program)) {
    if (program.costRaw) subtitle = program.costRaw;
    hero = '—';
  }

  // Body — static cost detail
  let bodyHtml = '';
  if (hasComponents(program)) {
    const lines = (program.components || []).map(part => {
      switch (part.kind) {
        case 'flat':    return `<div class="info-tier-row"><span class="tier-label">${part.label || 'Flat fee'}</span><span class="tier-rate">${formatCost(num(part.amount))}</span></div>`;
        case 'perUnit': return `<div class="info-tier-row"><span class="tier-label">${part.label || 'Per unit'}</span><span class="tier-rate">${formatRate(num(part.rate))}/unit</span></div>`;
        case 'perItem': return `<div class="info-tier-row"><span class="tier-label">${part.label || part.itemLabel || 'Per item'}</span><span class="tier-rate">${formatRate(num(part.rate))}/${(part.itemLabel || 'item').toLowerCase()}</span></div>`;
        case 'percent': return `<div class="info-tier-row"><span class="tier-label">${part.label || 'Percentage'}</span><span class="tier-rate">${num(part.pct)}% of ${part.base === 'capex' ? 'CapEx' : 'income'}</span></div>`;
        case 'options': return (part.options || []).map(o => `<div class="info-tier-row"><span class="tier-label">${o.label}</span><span class="tier-rate">${formatRate(num(o.rate))}</span></div>`).join('');
        case 'manual':  return `<div class="info-tier-row"><span class="tier-label">${part.label || 'Estimated amount'}</span><span class="tier-rate">PM estimates</span></div>`;
        case 'tax':     return `<div class="info-tier-row"><span class="tier-label">${part.label || 'Tax'}</span><span class="tier-rate">${num(part.pct)}%</span></div>`;
        case 'tax':     return `<div class="info-tier-row"><span class="tier-label">${part.label || 'Tax'}</span><span class="tier-rate">+${num(part.pct)}%</span></div>`;
        case 'formula': return `<div class="info-tier-row"><span class="tier-label">${part.label || 'Custom'}</span></div>`;
        default: return '';
      }
    }).join('');
    bodyHtml = `<div class="tier-select-label">Cost detail</div><div class="info-tier-list">${lines}</div>`;
  } else if (info.type === 'tiered' && info.tiers?.length) {
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
  if (program.inputNote) bodyHtml += `<div class="input-note">${program.inputNote}</div>`;
  bodyHtml += minMaxLine(program);

  // Billing timing as plain text — "Billed monthly" or the specific months
  const freqStr = (program.billingFreq || program.billingPeriod || '').toLowerCase();
  let monthsHtml = '';
  let timingText = '';
  if (freqStr.includes('monthly')) {
    timingText = 'Billed monthly';
  } else if (freqStr.includes('incurred') || freqStr.includes('implement')) {
    timingText = 'Billed as incurred';
  } else if (/quarter|annual|bi-/.test(freqStr)) {
    const active = activeMonthsFor(program);
    if (active.length) {
      timingText = `Billed in ${active.map(m => MONTH_NAMES[m]).join(', ')}`;
      if (program.monthsFixed) timingText += ' · fixed';
    } else if (freqStr.includes('quarter')) timingText = 'Billed quarterly';
    else if (freqStr.includes('bi-'))       timingText = 'Billed twice a year';
    else                                    timingText = 'Billed annually';
  }
  if (timingText) monthsHtml = `<div class="info-billing-text">${timingText}</div>`;

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
      ${S.admin ? `<button class="card-edit-btn" type="button">✎ Edit</button>` : ''}
    </div>
    <div class="card-details-panel">
      ${resourceLink}
      ${program.description ? `<div class="prog-card-desc">${program.description}</div>` : ''}
      ${program.setupFee ? `<div class="card-setup-fee">Setup: ${program.setupFee}</div>` : ''}
      ${minMaxNote(program)}
      ${program.priorYearNote ? `<div class="card-prioryear">Prior year: ${program.priorYearNote}</div>` : ''}
    </div>
  `;

  el.querySelector('.details-toggle')?.addEventListener('click', e => {
    e.stopPropagation();
    el.classList.toggle('details-open');
  });
  el.querySelector('.card-edit-btn')?.addEventListener('click', e => {
    e.stopPropagation();
    editProgram(program.id, refreshDashboard);
  });

  return el;
}

// "Will be billed separately" control for per-item / options parts
function partSeparateUI(program, i) {
  const key = `${program.id}:${i}`;
  const on  = !!S.partSeparate[key];
  const sel = S.partMonths[key] || [];
  return `
    <label class="sep-bill-toggle">
      <input type="checkbox" class="part-sep-check" data-pid="${program.id}" data-idx="${i}"${on ? ' checked' : ''}>
      Will be billed separately
    </label>
    ${on ? `<div class="incur-label sep-bill-label">Bill this item separately in: <span class="incur-directive">(overrides the default months)</span></div>
      <div class="incur-chips sep-bill-chips">${MONTH_NAMES.map((m, mi) =>
      `<button type="button" class="incur-chip part-sep-chip${sel.includes(mi) ? ' on' : ''}" data-pid="${program.id}" data-idx="${i}" data-month="${mi}">${m}</button>`).join('')}</div>` : ''}`;
}

// Renders the PM-facing inputs for a component-based program.
function buildComponentBody(program, parts = program.components, prefix = '') {
  parts = parts || [];
  const multiParts = parts.length > 1;
  // Separate billing only on the MAIN builder (setup fee has its own month)
  // Separate billing only on the MAIN builder. For options parts it only makes
  // sense in "pick one or more" mode (a single pick has nothing to split off).
  const sepUI = (part, i) => {
    if (prefix !== '' || part.kind === 'tax') return '';
    if (part.kind === 'options') return part.selectMode === 'multiple' ? partSeparateUI(program, i) : '';
    return multiParts ? partSeparateUI(program, i) : '';
  };
  const pfx = `data-prefix="${prefix}"`;
  return parts.map((part, i) => {
    const key = `${prefix}${program.id}:${i}`;
    switch (part.kind) {
      case 'flat':
        return `<div class="comp-line"><span class="comp-label">${part.label || 'Flat fee'}</span><span class="comp-val">${formatCost(num(part.amount))}</span></div>`;
      case 'perUnit': {
        if (part.locked) return `<div class="comp-line"><span class="comp-label">${part.label || 'Per unit'}</span><span class="comp-val">${formatRate(num(part.rate))}/unit × ${S.unitCount} units</span></div>`;
        const v = S.compInputs[key] != null ? num(S.compInputs[key]) : S.unitCount;
        return `<div class="card-calc">
          <span class="calc-rate">${formatRate(num(part.rate))}</span><span class="calc-x">×</span>
          <div class="qty-field"><input class="comp-input" ${pfx} data-pid="${program.id}" data-idx="${i}" type="number" min="0" placeholder="0" value="${v || ''}"></div>
          <span class="qty-label">units</span>
        </div>${sepUI(part, i)}`;
      }
      case 'perItem': {
        const item = (part.itemLabel || 'item');
        if (part.locked) return `<div class="comp-line"><span class="comp-label">${part.label || item}</span><span class="comp-val">${formatRate(num(part.rate))} × ${num(part.baseQty)}</span></div>`;
        const v = S.compInputs[key] != null ? num(S.compInputs[key]) : num(part.baseQty);
        const rOv = S.compInputs[`${key}:rate`];
        const rateVal = (rOv != null && rOv !== '') ? rOv : (part.rate ?? '');
        const rateCell = part.rateEditable
          ? `<span class="qty-label">Cost</span><div class="qty-field"><input class="comp-input" ${pfx} data-pid="${program.id}" data-idx="${i}:rate" type="number" min="0" step="0.01" placeholder="$" value="${rateVal}"></div>`
          : `<span class="calc-rate">${formatRate(num(part.rate))}</span>`;
        return `<div class="card-calc">
          ${rateCell}<span class="calc-x">×</span>
          <div class="qty-field"><input class="comp-input" ${pfx} data-pid="${program.id}" data-idx="${i}" type="number" min="0" placeholder="0" value="${v || ''}"></div>
          <span class="qty-label">${item}</span>
        </div>${sepUI(part, i)}`;
      }
      case 'percent': {
        const baseLabel = part.base === 'capex' ? 'Total CapEx' : 'Total income';
        if (part.locked) return `<div class="comp-line"><span class="comp-label">${part.label || `${num(part.pct)}% of ${baseLabel.toLowerCase()}`}</span></div>`;
        const v = S.compInputs[key] != null ? S.compInputs[key] : (part.baseDefault || '');
        const result = num(part.pct) / 100 * num(v);
        return `<div class="card-calc">
          <span class="calc-rate">${baseLabel}:</span>
          <div class="qty-field"><input class="comp-input" ${pfx} data-pid="${program.id}" data-idx="${i}" type="number" min="0" placeholder="$" value="${v}"></div>
          <span class="calc-x">×</span>
          <span class="calc-rate">${num(part.pct)}%</span>
          ${num(v) > 0 ? `<span class="qty-equals">= <strong>${formatCost(result)}</strong></span>` : ''}
        </div>`;
      }
      case 'options': {
        const opts = part.options || [];
        if (part.selectMode === 'multiple') {
          const qtys = S.compSel[key] || [];
          const orows = opts.map((o, oi) => {
            const on = (qtys[oi] || 0) > 0;
            return `<div class="addrow">
              <label class="addrow-check"><input type="checkbox" class="comp-optchk" ${pfx} data-pid="${program.id}" data-idx="${i}" data-oi="${oi}"${on ? ' checked' : ''}>
                <span class="addrow-label">${o.label} <span class="tier-rate">${formatRate(num(o.rate))}${part.perUnit ? '/unit' : ''}</span></span></label>
              <span class="qty-sep">×</span>
              <div class="qty-field"><input class="comp-optqty" ${pfx} data-pid="${program.id}" data-idx="${i}" data-oi="${oi}" type="number" min="0" value="${qtys[oi] || ''}"${on ? '' : ' disabled'}></div>
              ${part.perUnit ? `<span class="qty-label">units</span>` : ''}
            </div>`;
          }).join('');
          return `<div class="tier-select-label">${part.label || 'Select all that apply'}</div><div class="addrows">${orows}</div>${sepUI(part, i)}`;
        }
        const sel = S.compSel[key] ?? 0;
        const perUnitTag = part.perUnit ? ` <span class="tier-rate">/unit</span>` : '';
        const orows = opts.map((o, oi) => `
          <label class="tier-option${oi === sel ? ' is-selected' : ''}">
            <input type="radio" class="comp-optradio" ${pfx} name="copt_${prefix}${program.id}_${i}" data-pid="${program.id}" data-idx="${i}" data-oi="${oi}"${oi === sel ? ' checked' : ''}>
            <span class="tier-label">${o.label} <span class="tier-rate">(${formatRate(num(o.rate))}${part.perUnit ? '/unit' : ''})</span></span>
          </label>`).join('');
        const units = (S.compInputs[key] != null && S.compInputs[key] !== '') ? S.compInputs[key] : S.unitCount;
        const unitLine = part.perUnit
          ? `<div class="card-calc">
               <span class="calc-rate">${formatRate(num(opts[sel]?.rate))}/unit</span><span class="calc-x">×</span>
               <div class="qty-field"><input class="comp-input" ${pfx} data-pid="${program.id}" data-idx="${i}" type="number" min="0" placeholder="0" value="${units}"></div>
               <span class="qty-label">units</span>
             </div>`
          : '';
        return `<div class="tier-select-label">${part.label || 'Select one'}</div><div class="tier-options">${orows}</div>${unitLine}${sepUI(part, i)}`;
      }
      case 'manual': {
        const v = S.compInputs[key] != null ? S.compInputs[key] : '';
        return `<div class="card-calc">
          <span class="calc-rate">${part.label || 'Estimated amount'}:</span>
          <div class="qty-field"><input class="comp-input" ${pfx} data-pid="${program.id}" data-idx="${i}" type="number" min="0" placeholder="$ / month" value="${v}"></div>
        </div>`;
      }
      case 'tax': {
        // Tax % is editable on the card, defaulting to the admin value
        const pctVal = S.compInputs[key] != null && S.compInputs[key] !== '' ? S.compInputs[key] : (part.pct ?? '');
        const taxable = (parts || []).reduce((s, c2, j) => c2.kind === 'tax' ? s : s + partPeriodCost(program, c2, j, prefix), 0);
        const amt = num(pctVal) / 100 * taxable;
        return `<div class="card-calc">
          <span class="calc-rate">${part.label || 'Tax'}:</span>
          <div class="qty-field"><input class="comp-input" ${pfx} data-pid="${program.id}" data-idx="${i}" type="number" min="0" step="0.01" placeholder="%" value="${pctVal}"></div>
          <span class="calc-x">%</span>
          ${amt > 0 ? `<span class="qty-equals">= <strong>${formatCost(amt)}</strong></span>` : ''}
        </div>`;
      }
      case 'tax': {
        // Tax on the other (non-tax) parts of this builder
        const taxable = parts.reduce((s, c2, j) => c2.kind === 'tax' ? s : s + partPeriodCost(program, c2, j, prefix), 0);
        const amt = num(part.pct) / 100 * taxable;
        return `<div class="comp-line"><span class="comp-label">${part.label || 'Tax'} (${num(part.pct)}%)</span><span class="comp-val">${formatCost(amt)}</span></div>`;
      }
      case 'formula': {
        if (part.locked || !/\bqty\b/.test(part.expr || '')) return '';
        const v = num(S.compInputs[key]);
        return `<div class="card-calc"><span class="calc-rate">${part.label || 'Quantity'}</span>
          <div class="qty-field"><input class="comp-input" ${pfx} data-pid="${program.id}" data-idx="${i}" type="number" min="0" value="${v || ''}"></div></div>`;
      }
      default: return '';
    }
  }).join('');
}

function buildProgramCard(program, decision, priorDecision, isRequired) {
  // In info mode, always use the simplified reference card
  if (S.mode === 'info') return buildInfoCard(program);
  const el = document.createElement('div');
  el.className = 'prog-card';
  if (!isRequired) el.classList.add('is-elective');   // elective = white/copper theme
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
        <span class="flag-chip">⚑ Flagged for follow up</span>
        <button class="btn-card-ghost btn-opt-out-trigger" data-pid="${program.id}">Opt Out</button>
        <button class="btn-card-fill btn-acknowledge" data-pid="${program.id}">Acknowledge</button>`;
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
    subtitle = info.additive ? 'Enter quantities' : (info.isPerUnit ? 'Select tier · per unit' : 'Select one');
  } else if (info.type === 'custom') {
    subtitle = 'Custom calculation';
  }
  // Cost summary (admin-entered) shows under the title when present
  if (program.costRaw) subtitle = program.costRaw;

  // Card body — interactive cost controls
  let bodyHtml = '';

  if (hasComponents(program)) {
    bodyHtml = buildComponentBody(program);
  } else if (info.type === 'per-unit' || info.type === 'per-quantity') {
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

    if (info.additive) {
      // Multi-select: check any options that apply, enter a quantity for each
      const qtys = S.optionQty[program.id] || [];
      const rows = (info.tiers || []).map((t, i) => {
        const on = (qtys[i] || 0) > 0;
        const rowTotal = (t.rate || 0) * (qtys[i] || 0);
        return `
        <div class="addrow">
          <label class="addrow-check">
            <input type="checkbox" class="opt-check" data-pid="${program.id}" data-opt="${i}"${on ? ' checked' : ''}>
            <span class="addrow-label">${t.label} <span class="tier-rate">${formatRate(t.rate)}${perSuffix}</span></span>
          </label>
          <span class="qty-sep">×</span>
          <div class="qty-field">
            <input class="opt-qty-input" data-pid="${program.id}" data-opt="${i}" type="number" min="0" placeholder="0" value="${qtys[i] || ''}"${on ? '' : ' disabled'}>
          </div>
          <span class="addrow-total">${on ? '= ' + formatCost(rowTotal) : ''}</span>
        </div>`;
      }).join('');
      bodyHtml = `
        <div class="tier-select-label">Select all that apply, then enter how many of each</div>
        <div class="addrows">${rows}</div>`;
    } else {
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
    }

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

  // Base/default quantity always included
  if ((program.baseQty || 0) > 0 && ['per-unit', 'per-quantity', 'custom'].includes(info.type)) {
    bodyHtml += `<div class="input-note">Includes ${program.baseQty} by default — enter any additional above.</div>`;
  }
  // Optional clarification note shown by the entry box
  if (program.inputNote) bodyHtml += `<div class="input-note">${program.inputNote}</div>`;

  // Min/Max shown on the card face
  bodyHtml += minMaxLine(program);

  // Minimum-not-met warning (shown until the entry meets the monthly/annual minimum)
  if (program.minCost != null) {
    const per   = program.billingPeriod === 'monthly' ? 'month' : 'year';
    const below = belowMinimum(program);
    bodyHtml += `<div class="min-note"${below ? '' : ' style="display:none"'}>*must meet the minimum requirement of ${formatCost(program.minCost)}/${per}</div>`;
  }

  // Month selection — as-incurred programs pick explicitly (shown in body);
  // every other recurring program gets an adjustable strip inside Details.
  const freqStr      = (program.billingFreq || program.billingPeriod || '').toLowerCase();
  const isAsIncurred = freqStr.includes('incurred') || freqStr.includes('implement');
  const isRecurring  = /monthly|quarter|annual|bi-/.test(freqStr);
  const locked       = !!program.monthsFixed;
  const monthChipStrip = (preset, isLocked) => MONTH_NAMES.map((m, i) =>
    `<button type="button" class="incur-chip${preset.includes(i) ? ' on' : ''}${isLocked ? ' is-static' : ''}" data-month="${i}"${isLocked ? ' disabled' : ''}>${m}</button>`
  ).join('');

  if (isRecurring || isAsIncurred) {
    // If every part is billed separately, the default months no longer apply to
    // anything — hide the strip so it isn't confusingly lit up.
    const allSeparate = hasComponents(program) && program.components.length > 0 &&
      program.components.every((c, i) => S.partSeparate[`${program.id}:${i}`]);
    if (!allSeparate) {
      const anySeparate = hasComponents(program) &&
        program.components.some((c, i) => S.partSeparate[`${program.id}:${i}`]);
      const hasDefaults = Array.isArray(program.defaultMonths) && program.defaultMonths.length;
      const label = (isAsIncurred && !hasDefaults) ? 'Expected in which months?' : 'Default billing months';
      const note = locked ? ' · 🔒 fixed' : (S.transitionMonth != null && !isAsIncurred ? ' · transition applied' : '');
      const directive = locked ? '' : ' <span class="incur-directive">(select applicable months)</span>';
      const sepNote = anySeparate ? ' <span class="incur-directive">(items billed separately are excluded)</span>' : '';
      const spreadOn = !!S.spreadMonthly[program.id];
      // Offer "split evenly" only for lump billing (fewer than 12 active months)
      const lumps = activeMonthsFor(program).length > 0 && activeMonthsFor(program).length < 12;
      const spreadToggle = (lumps || spreadOn)
        ? `<label class="spread-toggle"><input type="checkbox" class="spread-check" data-pid="${program.id}"${spreadOn ? ' checked' : ''}> Split evenly across the year (view monthly)</label>`
        : '';
      bodyHtml += `
        <div class="incur-months">
          <div class="incur-label">${label}${note}${directive}${sepNote}</div>
          <div class="incur-chips${spreadOn ? ' is-dimmed' : ''}">${monthChipStrip(activeMonthsFor(program), locked || spreadOn)}</div>
          ${spreadToggle}
        </div>`;
    }
  }

  // Setup fee — one-time charge with its own cost builder + month, shown in blue
  if (hasSetupBuilder(program) || (program.setupAmount || 0) > 0) {
    const on  = !!S.setupOn[program.id];
    const sm  = S.setupMonth[program.id] ?? (program.setupMonth ?? 0);
    const tot = setupTotal(program);
    const setupBody = hasSetupBuilder(program)
      ? buildComponentBody(program, program.setupComponents, 'setup:')
      : '';
    bodyHtml += `
      <div class="setup-fee-block${on ? ' on' : ''}">
        ${program.setupName ? `<div class="setup-fee-name">${program.setupName}</div>` : ''}
        <label class="setup-fee-head">
          <input type="checkbox" class="setup-include" data-pid="${program.id}"${on ? ' checked' : ''}>
          <span class="setup-fee-amount">Setup fee: ${formatCost(tot)} <span class="setup-once">· one-time</span></span>
        </label>
        ${setupBody ? `<div class="setup-fee-builder">${setupBody}</div>` : ''}
        ${program.setupFee ? `<div class="setup-fee-note">${program.setupFee}</div>` : ''}
        <div class="setup-fee-monthlabel">Charged in:</div>
        <div class="incur-chips">${MONTH_NAMES.map((m, i) => `<button type="button" class="setup-mchip${i === sm ? ' on' : ''}" data-pid="${program.id}" data-month="${i}">${m}</button>`).join('')}</div>
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
      ${S.admin ? `<button class="card-edit-btn" type="button">✎ Edit</button>` : ''}
      <div class="prog-card-action">${actionHtml}</div>
    </div>
    <div class="card-details-panel">
      ${program.priorYearNote ? `<div class="detail-row"><span class="detail-k">Prior year cost:</span> ${program.priorYearNote}</div>` : ''}
      ${program.resourceUrl ? `<div class="detail-row"><span class="detail-k">Program guide:</span> <a class="card-guide-link" href="${program.resourceUrl}" target="_blank" rel="noopener">Open link →</a></div>` : ''}
      ${program.description ? `<div class="detail-row"><span class="detail-k">Details:</span> ${program.description}</div>` : ''}
      ${minMaxNote(program)}
      ${priorChip}
    </div>
  `;

  // Details collapsible
  el.querySelector('.details-toggle')?.addEventListener('click', e => {
    e.stopPropagation();
    el.classList.toggle('details-open');
  });

  // Inline admin edit
  el.querySelector('.card-edit-btn')?.addEventListener('click', e => {
    e.stopPropagation();
    editProgram(program.id, refreshDashboard);
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

  // ── Component (cost-builder) inputs ───────────────────────────────────────
  const persistComp = () => {
    localStorage.setItem(`rpm_compin_${S.property}_${S.budgetYear}`, JSON.stringify(S.compInputs));
    localStorage.setItem(`rpm_compsel_${S.property}_${S.budgetYear}`, JSON.stringify(S.compSel));
  };
  const pfxKey = ds => `${ds.prefix || ''}${program.id}:${ds.idx}`;
  el.querySelectorAll('.comp-input').forEach(inp => {
    inp.addEventListener('input', e => {
      e.stopPropagation();
      S.compInputs[pfxKey(inp.dataset)] = parseFloat(e.target.value) || 0;
      persistComp(); updateBudgetTotal(); refreshHero();
    });
  });
  el.querySelectorAll('.comp-optradio').forEach(r => {
    r.addEventListener('change', e => {
      e.stopPropagation();
      const idx = parseInt(r.dataset.idx);
      S.compSel[pfxKey(r.dataset)] = parseInt(r.dataset.oi);
      persistComp(); updateBudgetTotal();
      // Per-unit options show a rate line that must update with the new selection → re-render
      const parts = r.dataset.prefix === 'setup:' ? (program.setupComponents || []) : (program.components || []);
      const part = parts[idx];
      if (part && part.kind === 'options' && part.perUnit) { refreshCard(program.id); return; }
      el.querySelectorAll(`.comp-optradio[data-prefix="${r.dataset.prefix || ''}"][data-idx="${r.dataset.idx}"]`).forEach(rr =>
        rr.closest('.tier-option').classList.toggle('is-selected', rr === r));
      refreshHero();
    });
  });
  el.querySelectorAll('.comp-optchk').forEach(chk => {
    chk.addEventListener('change', e => {
      e.stopPropagation();
      const key = pfxKey(chk.dataset);
      const oi  = parseInt(chk.dataset.oi);
      const idx = parseInt(chk.dataset.idx);
      const parts = chk.dataset.prefix === 'setup:' ? (program.setupComponents || []) : (program.components || []);
      const dflt  = parts[idx]?.perUnit ? (S.unitCount || 1) : 1;   // per-unit → default the box to unit count
      const arr = S.compSel[key] || [];
      arr[oi] = chk.checked ? (arr[oi] > 0 ? arr[oi] : dflt) : 0;
      S.compSel[key] = arr;
      persistComp(); updateBudgetTotal(); refreshCard(program.id);
    });
  });
  el.querySelectorAll('.comp-optqty').forEach(inp => {
    inp.addEventListener('input', e => {
      e.stopPropagation();
      const key = pfxKey(inp.dataset);
      const arr = S.compSel[key] || [];
      arr[parseInt(inp.dataset.oi)] = parseInt(e.target.value) || 0;
      S.compSel[key] = arr;
      persistComp(); updateBudgetTotal(); refreshHero();
    });
  });

  // "Will be billed separately" — per-part billing months
  const persistParts = () => {
    localStorage.setItem(`rpm_partsep_${S.property}_${S.budgetYear}`, JSON.stringify(S.partSeparate));
    localStorage.setItem(`rpm_partmo_${S.property}_${S.budgetYear}`, JSON.stringify(S.partMonths));
  };
  el.querySelectorAll('.part-sep-check').forEach(chk => {
    chk.addEventListener('change', e => {
      e.stopPropagation();
      S.partSeparate[`${program.id}:${chk.dataset.idx}`] = chk.checked;
      persistParts(); updateBudgetTotal(); refreshCard(program.id);
    });
  });
  el.querySelector('.spread-check')?.addEventListener('change', e => {
    e.stopPropagation();
    S.spreadMonthly[program.id] = e.target.checked;
    localStorage.setItem(`rpm_spread_${S.property}_${S.budgetYear}`, JSON.stringify(S.spreadMonthly));
    updateBudgetTotal();
    refreshCard(program.id);
  });
  el.querySelectorAll('.part-sep-chip').forEach(chip => {
    chip.addEventListener('click', e => {
      e.stopPropagation();
      const key = `${program.id}:${chip.dataset.idx}`;
      const m   = parseInt(chip.dataset.month);
      const arr = S.partMonths[key] || [];
      const idx = arr.indexOf(m);
      if (idx >= 0) arr.splice(idx, 1); else arr.push(m);
      S.partMonths[key] = arr;
      persistParts(); updateBudgetTotal(); refreshCard(program.id);
    });
  });

  // Setup fee include toggle + month
  el.querySelector('.setup-include')?.addEventListener('change', e => {
    e.stopPropagation();
    S.setupOn[program.id] = e.target.checked;
    localStorage.setItem(`rpm_setupon_${S.property}_${S.budgetYear}`, JSON.stringify(S.setupOn));
    updateBudgetTotal();
    refreshCard(program.id);
  });
  el.querySelectorAll('.setup-mchip').forEach(chip => {
    chip.addEventListener('click', e => {
      e.stopPropagation();
      S.setupMonth[program.id] = parseInt(chip.dataset.month);
      localStorage.setItem(`rpm_setupmonth_${S.property}_${S.budgetYear}`, JSON.stringify(S.setupMonth));
      el.querySelectorAll('.setup-mchip').forEach(c => c.classList.toggle('on', c === chip));
      updateBudgetTotal();
    });
  });

  // Month chips (as-incurred body picker + per-card billing-month override)
  el.querySelectorAll('.incur-chip:not(.part-sep-chip)').forEach(chip => {
    chip.addEventListener('click', e => {
      e.stopPropagation();
      const m = parseInt(chip.dataset.month);
      // Seed an override from the current active months the first time it's touched
      let arr = S.incurMonths[program.id];
      if (!arr) arr = activeMonthsFor(program).slice();
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

  // ── Multi-select option checkboxes (additive tiered) ──────────────────────
  el.querySelectorAll('.opt-check').forEach(chk => {
    chk.addEventListener('change', e => {
      e.stopPropagation();
      const i   = parseInt(e.target.dataset.opt);
      const arr = S.optionQty[program.id] || [];
      arr[i] = e.target.checked ? (arr[i] > 0 ? arr[i] : 1) : 0;
      S.optionQty[program.id] = arr;
      localStorage.setItem(`rpm_optqty_${S.property}_${S.budgetYear}`, JSON.stringify(S.optionQty));
      updateBudgetTotal();
      refreshCard(program.id);   // re-render to enable/disable the qty field + totals
    });
  });

  // ── Per-option quantity inputs (additive tiered) ──────────────────────────
  el.querySelectorAll('.opt-qty-input').forEach(inp => {
    inp.addEventListener('input', e => {
      e.stopPropagation();
      const i   = parseInt(e.target.dataset.opt);
      const arr = S.optionQty[program.id] || [];
      arr[i] = parseInt(e.target.value) || 0;
      S.optionQty[program.id] = arr;
      localStorage.setItem(`rpm_optqty_${S.property}_${S.budgetYear}`, JSON.stringify(S.optionQty));
      updateBudgetTotal();
      refreshHero();
      // update this row's inline total
      const row = e.target.closest('.addrow');
      let tot = row?.querySelector('.addrow-total');
      const info2 = parseCostBasisInfo(program);
      const rowTotal = (info2.tiers?.[i]?.rate || 0) * (arr[i] || 0);
      if (arr[i]) {
        if (!tot) { tot = document.createElement('span'); tot.className = 'addrow-total'; row.appendChild(tot); }
        tot.textContent = `= ${formatCost(rowTotal)}`;
      } else if (tot) { tot.remove(); }
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

// Build S.programs from S.allPrograms. Admin mode shows ALL programs (every
// system) so you never have to switch views to edit; PMs see only their system.
function applyVisiblePrograms() {
  const src = S.admin ? S.allPrograms : filterBySystem(S.allPrograms, S.systemType);
  S.programs = src.map(p => ({
    ...p,
    cost:   p.costs[S.systemType]   ?? 0,
    glCode: p.glCodes[S.systemType] ?? '—',
  }));
}

// ── Inline admin mode ─────────────────────────────────────────────────────────
// Re-pull programs from Firebase and re-render the dashboard (after an edit/add).
async function refreshDashboard() {
  clearFirebaseCache();
  try {
    S.allPrograms = await fetchPrograms(true);
    applyVisiblePrograms();
    renderMainScreen();
  } catch (e) { console.error('Refresh failed', e); }
}

function enterAdminMode() {
  S.admin = true;
  applyVisiblePrograms();
  document.getElementById('mi-admin-mode-label').textContent = 'Exit Admin Mode';
  renderMainScreen();
}
function exitAdminMode() {
  S.admin = false;
  applyVisiblePrograms();
  document.getElementById('mi-admin-mode-label').textContent = 'Enter Admin Mode';
  renderMainScreen();
}

// Admin → standalone admin page (program list + cost-builder editor)
document.getElementById('mi-admin-mode').addEventListener('click', () => {
  closeModal('modal-menu');
  if (isAdminAuthed()) openAdmin();
  else promptAdminLogin(openAdmin);
});

document.getElementById('btn-admin-entry').addEventListener('click', () => {
  if (isAdminAuthed()) openAdmin();
  else promptAdminLogin(openAdmin);
});

// ── Dashboard search — filter cards by department, program name, or setup fee name
{
  const searchEl = document.getElementById('card-search');
  if (searchEl) {
    searchEl.addEventListener('input', () => {
      S.search = searchEl.value;
      renderDeptRows();
    });
  }
}

// ── Summary ───────────────────────────────────────────────────────────────────
document.getElementById('btn-view-summary').addEventListener('click', openSummary);

// ── Summary helpers ───────────────────────────────────────────────────────────
function programStatus(p) {
  const dec = S.decisions[p.id]?.decision;
  if (p.required) {
    if (dec === 'acknowledged')   return { label: 'Acknowledged', cls: 'st-ack',     included: true  };
    if (dec === 'opted-out')      return { label: 'Opted Out',    cls: 'st-out',     included: false };
    if (dec === 'needs-followup') return { label: 'Flagged',      cls: 'st-flag',    included: true  };
    if (dec === 'not-applicable') return { label: 'N/A',          cls: 'st-na',      included: false };
    return { label: 'Not yet acknowledged', cls: 'st-pending', included: true };
  }
  if (dec === 'in')  return { label: 'Included', cls: 'st-ack',     included: true  };
  if (dec === 'out') return { label: 'Removed',  cls: 'st-out',     included: false };
  return { label: 'Not selected', cls: 'st-pending', included: false };
}

function summaryCost(p) {
  let c = proratedAnnual(p);
  if (S.setupOn[p.id]) c += setupTotal(p);
  return c;
}

// Human description of what the PM chose
function programChoiceText(p) {
  const parts = [];
  if (hasComponents(p)) {
    (p.components || []).forEach((c, i) => {
      const key = `${p.id}:${i}`;
      if (c.kind === 'perItem' && !c.locked) {
        const q = num(S.compInputs[key]) + (c.baseQty || 0);
        if (q) parts.push(`${q} ${(c.itemLabel || 'item')}${q === 1 ? '' : 's'}`);
      } else if (c.kind === 'options') {
        if (c.selectMode === 'multiple') {
          const qs = S.compSel[key] || [];
          (c.options || []).forEach((o, oi) => { if (qs[oi] > 0) parts.push(`${o.label} ×${qs[oi]}`); });
        } else {
          const sel = S.compSel[key] ?? 0;
          if (c.options?.[sel]) parts.push(c.options[sel].label);
        }
      } else if (c.kind === 'percent' && !c.locked) {
        const b = S.compInputs[key];
        if (b) parts.push(`${num(c.pct)}% of ${formatCost(num(b))}`);
      }
    });
  } else {
    const info = parseCostBasisInfo(p);
    if (info.type === 'per-unit' || info.type === 'per-quantity') {
      const q = effectiveQty(p, info);
      if (q) parts.push(`${q} ${info.plural || 'units'}`);
    } else if (info.type === 'tiered') {
      if (info.additive) {
        const qs = S.optionQty[p.id] || [];
        (info.tiers || []).forEach((t, i) => { if (qs[i] > 0) parts.push(`${t.label} ×${qs[i]}`); });
      } else {
        const ti = S.selectedTiers[p.id] ?? 0;
        if (info.tiers?.[ti]) parts.push(info.tiers[ti].label);
      }
    }
  }
  if (S.setupOn[p.id] && setupTotal(p) > 0) parts.push(`+ setup ${formatCost(setupTotal(p))}`);
  return parts.join(', ');
}

// "All" if every month, else 1-indexed month numbers (e.g. 6,7,8,9,10,11,12)
function monthsBilledText(p) {
  const freq = (p.billingFreq || p.billingPeriod || '').toLowerCase();
  let months;
  if (freq.includes('incurred') || freq.includes('implement')) months = S.incurMonths[p.id] || [];
  else months = activeMonthsFor(p);
  if (!months.length) return '—';
  if (months.length === 12) return 'All';
  return months.slice().sort((a, b) => a - b).map(m => m + 1).join(',');
}

function openSummary() {
  const body = document.getElementById('summary-body');
  const deptOrder = [];
  const seen = new Set();
  S.programs.forEach(p => { if (!seen.has(p.group)) { seen.add(p.group); deptOrder.push(p.group); } });

  let grand = 0;
  let html = `
    <div class="sum-toolbar">
      <div class="sum-grand">Estimated Annual Budget<strong id="sum-grand-val">—</strong></div>
      <button class="btn-export" id="btn-export-csv">⬇ Export to Excel</button>
    </div>`;

  deptOrder.forEach(dept => {
    const progs = S.programs.filter(p => p.group === dept);
    const render = (list, title) => {
      if (!list.length) return '';
      return `<div class="sum-subhead">${title}</div>` + list.map(p => {
        const st = programStatus(p);
        const cost = st.included ? summaryCost(p) : 0;
        const choice = programChoiceText(p);
        return `
          <div class="sum-row">
            <div class="sum-row-main">
              <span class="sum-name">${p.name}</span>
              ${p.costRaw ? `<span class="sum-costraw">${p.costRaw}</span>` : ''}
              ${choice ? `<span class="sum-choice">${choice}</span>` : ''}
              <span class="sum-meta">GL ${p.glCode} · Months billed: ${monthsBilledText(p)}</span>
            </div>
            <span class="sum-badge ${st.cls}">${st.label}</span>
            <span class="sum-cost">${st.included && cost ? formatCost(cost) : (st.included ? '—' : '')}</span>
          </div>`;
      }).join('');
    };
    const ne = progs.filter(p => p.required);
    const el = progs.filter(p => !p.required);
    let deptTotal = 0;
    progs.forEach(p => { const st = programStatus(p); if (st.included) deptTotal += summaryCost(p); });
    grand += deptTotal;
    html += `
      <div class="sum-dept">
        <div class="sum-dept-head"><span class="sum-dept-name">${dept}</span><span class="sum-dept-total">${formatCost(deptTotal)}</span></div>
        ${render(ne, 'Non-Elective')}
        ${render(el, 'Elective')}
      </div>`;
  });

  body.innerHTML = html;
  const gv = document.getElementById('sum-grand-val');
  if (gv) gv.textContent = formatCost(grand);
  document.getElementById('btn-export-csv')?.addEventListener('click', exportSummaryCsv);

  const toggleBtn = document.getElementById('btn-prior-year-toggle');
  if (toggleBtn) toggleBtn.style.display = 'none';
  showScreen('screen-summary');
}

function exportSummaryCsv() {
  const rows = [['Department', 'Program', 'GL', 'Type', 'Status', 'Selection', 'Months billed', 'Cost Summary', 'Annual Cost']];
  S.programs.forEach(p => {
    const st = programStatus(p);
    rows.push([
      p.group, p.name, p.glCode, p.required ? 'Non-elective' : 'Elective', st.label,
      programChoiceText(p), monthsBilledText(p), (p.costRaw || '').replace(/[\r\n]+/g, ' '),
      st.included ? summaryCost(p).toFixed(2) : '',
    ]);
  });
  const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = `${(S.property || 'Budget').replace(/[^a-z0-9]+/gi, '_')}_FY${S.budgetYear}_Assumptions.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
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

// Quick refresh button in the header — pull latest program edits from Firebase
document.getElementById('btn-refresh').addEventListener('click', async () => {
  const btn = document.getElementById('btn-refresh');
  btn.classList.add('spinning');
  clearFirebaseCache();
  try { await launchMain(); } finally { btn.classList.remove('spinning'); }
});

// A program was saved/deleted in admin → silently pull fresh data into the dashboard
window.addEventListener('rpm-programs-changed', async () => {
  if (!S.programs || !S.programs.length) return;   // no dashboard session yet
  try {
    clearFirebaseCache();
    S.allPrograms = await fetchPrograms(true);
    applyVisiblePrograms();
    renderMainScreen();
  } catch (e) { console.error('Auto-refresh failed', e); }
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
    S.optionQty      = {};
    S.compInputs     = {};
    S.compSel        = {};
    S.partSeparate   = {};
    S.partMonths     = {};
    S.spreadMonthly  = {};
    S.setupOn        = {};
    S.setupMonth     = {};
    S.budgetAmounts  = {};
    S.incurMonths    = {};
    localStorage.removeItem(`rpm_qty_${S.property}_${S.budgetYear}`);
    localStorage.removeItem(`rpm_tiers_${S.property}_${S.budgetYear}`);
    localStorage.removeItem(`rpm_optqty_${S.property}_${S.budgetYear}`);
    localStorage.removeItem(`rpm_compin_${S.property}_${S.budgetYear}`);
    localStorage.removeItem(`rpm_compsel_${S.property}_${S.budgetYear}`);
    localStorage.removeItem(`rpm_partsep_${S.property}_${S.budgetYear}`);
    localStorage.removeItem(`rpm_partmo_${S.property}_${S.budgetYear}`);
    localStorage.removeItem(`rpm_spread_${S.property}_${S.budgetYear}`);
    localStorage.removeItem(`rpm_setupon_${S.property}_${S.budgetYear}`);
    localStorage.removeItem(`rpm_setupmonth_${S.property}_${S.budgetYear}`);
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
