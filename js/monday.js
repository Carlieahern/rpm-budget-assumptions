import CONFIG from './config.js';
import { MOCK_PROPERTIES, MOCK_PROGRAMS } from './mockData.js';

// All Monday.com calls are proxied through /api/monday to keep the API key server-side.

// ── Local cache ───────────────────────────────────────────────────────────────
// Programs rarely change (updated ~once a year), properties change occasionally.
// Cache them in localStorage so the app opens instantly on repeat visits.

const CACHE_TTL = {
  properties: 60 * 60 * 1000,        // 1 hour
  programs:   24 * 60 * 60 * 1000,   // 24 hours
};

function cacheGet(key) {
  try {
    const raw = localStorage.getItem(`rpm_monday_${key}`);
    if (!raw) return null;
    const { data, ts } = JSON.parse(raw);
    if (Date.now() - ts > CACHE_TTL[key]) return null;  // expired
    return data;
  } catch { return null; }
}

function cacheSet(key, data) {
  try {
    localStorage.setItem(`rpm_monday_${key}`, JSON.stringify({ data, ts: Date.now() }));
  } catch { /* storage full — ignore */ }
}

export function clearMondayCache() {
  localStorage.removeItem('rpm_monday_properties');
  localStorage.removeItem('rpm_monday_programs');
}

// ─────────────────────────────────────────────────────────────────────────────

async function query(gqlQuery, variables = {}) {
  const res = await fetch('/api/monday', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: gqlQuery, variables }),
  });
  if (!res.ok) throw new Error(`Monday API error: ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error(json.errors[0].message);
  return json.data;
}

// ── Fetch property names from the Budget Due Date Tracker board ──
export async function fetchProperties(forceRefresh = false) {
  if (CONFIG.useMockData) return MOCK_PROPERTIES;
  if (!forceRefresh) {
    const cached = cacheGet('properties');
    if (cached) return cached;
  }

  const data = await query(`
    query ($boardId: ID!) {
      boards(ids: [$boardId]) {
        items_page(limit: 500) {
          items { id name }
        }
      }
    }
  `, { boardId: CONFIG.monday.propertyBoardId });

  const result = data.boards[0].items_page.items.map(i => ({ id: i.id, name: i.name }));
  cacheSet('properties', result);
  return result;
}

// ── Fetch all programs from the cost center assumptions board ──
export async function fetchPrograms(forceRefresh = false) {
  if (CONFIG.useMockData) return MOCK_PROGRAMS;
  if (!forceRefresh) {
    const cached = cacheGet('programs');
    if (cached) return cached;
  }
  const { columns } = CONFIG.monday;
  const data = await query(`
    query ($boardId: ID!) {
      boards(ids: [$boardId]) {
        groups { id title }
        items_page(limit: 500) {
          items {
            id
            name
            group { id title }
            column_values {
              id
              text
              ... on NumbersValue   { number }
              ... on CheckboxValue  { checked }
              ... on StatusValue    { label }
              ... on LongTextValue  { text }
            }
          }
        }
      }
    }
  `, { boardId: CONFIG.monday.programsBoardId });

  const board = data.boards[0];

  const parseCost = val => {
    if (!val?.text) return 0;
    const n = parseFloat(val.text.replace(/[^0-9.]/g, ''));
    return isNaN(n) ? 0 : n;
  };

  const result = board.items_page.items.map(item => {
    const colMap = {};
    item.column_values.forEach(cv => { colMap[cv.id] = cv; });

    const electiveRaw = colMap[columns.elective]?.text || '';
    const isRequired  = /non.?elective/i.test(electiveRaw);

    const costs = {
      Yardi:       parseCost(colMap[columns.yardiCost]),
      OneSite:     parseCost(colMap[columns.onesiteCost]),
      PaceOneSite: parseCost(colMap[columns.paceCost]),
    };

    const glCodes = {
      Yardi:       colMap[columns.yardiGL]?.text   || '—',
      OneSite:     colMap[columns.onesiteGL]?.text  || '—',
      PaceOneSite: colMap[columns.paceGL]?.text     || '—',
    };

    return {
      id:          item.id,
      name:        item.name,
      group:       item.group.title,
      groupId:     item.group.id,
      costs,       // resolved per-system in app.js
      glCodes,     // resolved per-system in app.js
      description: colMap[columns.description]?.text || '',
      required:    isRequired,
      costBasis:   colMap[columns.costBasis]?.text  || '',
      billingFreq: colMap[columns.billingFreq]?.text || '',
    };
  });

  cacheSet('programs', result);
  return result;
}

// ── Filter programs by selected system type ──
// A program applies if it has a non-zero cost for the selected system.
// If ALL system costs are 0, show for every system (applies universally).
export function filterBySystem(programs, selectedSystem) {
  return programs.filter(p => {
    const hasAnyCost = Object.values(p.costs).some(c => c > 0);
    if (!hasAnyCost) return true;           // no costs set — show everywhere
    return p.costs[selectedSystem] > 0;
  });
}
