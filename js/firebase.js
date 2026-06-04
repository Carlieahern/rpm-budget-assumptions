import CONFIG from './config.js';
import { MOCK_PROGRAMS } from './mockData.js';

// ── Cache ─────────────────────────────────────────────────────────────────────
// Programs update once a year — cache for 24 hours so the app opens instantly.
const CACHE_KEY = 'rpm_firebase_programs';
const CACHE_TTL = 24 * 60 * 60 * 1000;

function cacheGet() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const { data, ts } = JSON.parse(raw);
    if (Date.now() - ts > CACHE_TTL) return null;
    return data;
  } catch { return null; }
}

function cacheSet(data) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ data, ts: Date.now() }));
  } catch { /* storage full — ignore */ }
}

export function clearFirebaseCache() {
  localStorage.removeItem(CACHE_KEY);
}

// ── Fetch programs from Firebase ───────────────────────────────────────────────
export async function fetchPrograms(forceRefresh = false) {
  if (CONFIG.useMockData) return MOCK_PROGRAMS;

  if (!forceRefresh) {
    const cached = cacheGet();
    if (cached) return cached;
  }

  const res = await fetch(`${CONFIG.firebase.url}/programs.json`);
  if (!res.ok) throw new Error(`Firebase error: ${res.status}`);
  const raw = await res.json();
  if (!raw) return [];

  const programs = Object.entries(raw).map(([id, p]) => {
    const rate = p.rate ?? 0;

    // GL codes keyed by system
    const glCodes = {
      Yardi:       p.yardiGL    || '—',
      OneSite:     p.onesiteGL  || '—',
      PaceOneSite: p.paceGL     || '—',
    };

    // Which PMS systems this program applies to (defaults to all three).
    const systems = (Array.isArray(p.systems) && p.systems.length)
      ? p.systems
      : ['Yardi', 'OneSite', 'PaceOneSite'];

    const costs = {
      Yardi:       systems.includes('Yardi')       ? rate : 0,
      OneSite:     systems.includes('OneSite')     ? rate : 0,
      PaceOneSite: systems.includes('PaceOneSite') ? rate : 0,
    };

    return {
      id,
      name:          p.name          || '',
      group:         p.department    || 'General',
      required:      p.elective === false,
      costBasis:     p.costBasis     || 'Manual',
      customFormula: p.customFormula || null,
      rate:          rate,
      systems,
      billingPeriod: p.billingPeriod || 'annual',
      itemLabel:     p.itemLabel     || null,
      baseFee:       p.baseFee       ?? null,
      options:       p.options       || [],
      additive:      !!p.additive,
      defaultMonths: Array.isArray(p.defaultMonths) ? p.defaultMonths : null,
      monthsFixed:   !!p.monthsFixed,
      setupFee:      p.setupFee      || null,
      costRaw:       p.costRaw       || '',
      description:   p.description   || '',
      resourceUrl:   p.resourceUrl   || null,
      costs,
      glCodes,
      billingFreq:   p.billingPeriod || '',
      billingStart:  p.billingStart  || null,
      programOwner:  p.owner         || '',
      priorYearCost: p.priorYearCost ?? 0,
      priorYearNote: p.priorYearNote || null,
    };
  });

  // Sort by department then name for consistent ordering
  programs.sort((a, b) =>
    a.group.localeCompare(b.group) || a.name.localeCompare(b.name)
  );

  cacheSet(programs);
  return programs;
}

// ── Admin: raw read / write to Firebase ────────────────────────────────────────
// Returns the raw program objects (not the app-shaped version) keyed by id.
export async function fetchRawPrograms() {
  const res = await fetch(`${CONFIG.firebase.url}/programs.json`);
  if (!res.ok) throw new Error(`Firebase error: ${res.status}`);
  return (await res.json()) || {};
}

export async function saveProgram(id, data) {
  const res = await fetch(`${CONFIG.firebase.url}/programs/${id}.json`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Save failed: ${res.status}`);
  clearFirebaseCache();
  return true;
}

export async function deleteProgram(id) {
  const res = await fetch(`${CONFIG.firebase.url}/programs/${id}.json`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
  clearFirebaseCache();
  return true;
}

// Admin-added custom cost-basis type names (shared across all admins).
export async function fetchCostBasisTypes() {
  try {
    const res = await fetch(`${CONFIG.firebase.url}/meta/costBasisTypes.json`);
    if (!res.ok) return [];
    return (await res.json()) || [];
  } catch { return []; }
}

export async function addCostBasisType(name) {
  const current = await fetchCostBasisTypes();
  if (current.includes(name)) return current;
  const updated = [...current, name];
  await fetch(`${CONFIG.firebase.url}/meta/costBasisTypes.json`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(updated),
  });
  return updated;
}

// ── Filter programs by selected system type ────────────────────────────────────
// Programs with no cost (Manual) are shown for every system.
// Programs with a cost only show for systems where it's non-zero.
export function filterBySystem(programs, selectedSystem) {
  return programs.filter(p => {
    if (Array.isArray(p.systems) && p.systems.length) return p.systems.includes(selectedSystem);
    return true; // no restriction set → applies to all systems
  });
}
