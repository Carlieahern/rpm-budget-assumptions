// ── Local decision storage ────────────────────────────────────────────────────
// Decisions are stored in localStorage keyed by property + budget year.
// No server or SharePoint needed — everything lives in the browser.

let _key = null;
let _cache = {};

function key(property, budgetYear) {
  return `rpm_decisions_${property}_${budgetYear}`;
}

function persist() {
  if (_key) localStorage.setItem(_key, JSON.stringify(_cache));
}

export async function loadDecisions(property, budgetYear) {
  _key = key(property, budgetYear);
  try { _cache = JSON.parse(localStorage.getItem(_key)) || {}; }
  catch { _cache = {}; }
  return { ..._cache };
}

export async function saveDecision(property, program, decision, budgetYear, extra = {}) {
  _cache[program.id] = {
    itemId:         program.id,
    decision,
    optOutApproval: extra.optOutApproval || false,
    notes:          extra.notes || '',
  };
  persist();
  return program.id;
}

export async function deleteDecision(itemId) {
  delete _cache[itemId];
  persist();
}

export async function resetDecisions(property, budgetYear) {
  _cache = {};
  _key = key(property, budgetYear);
  persist();
}

export async function loadPriorYearDecisions(property, budgetYear) {
  try { return JSON.parse(localStorage.getItem(key(property, budgetYear - 1))) || {}; }
  catch { return {}; }
}
