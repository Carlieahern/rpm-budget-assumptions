import CONFIG from './config.js';

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

  const result = board.items_page.items.map(item => {
    const colMap = {};
    item.column_values.forEach(cv => { colMap[cv.id] = cv; });

    const costVal = colMap[columns.cost];
    const cost = costVal?.number ?? parseFloat(costVal?.text?.replace(/[^0-9.]/g, '')) ?? 0;

    const requiredVal = colMap[columns.required];
    const isRequired = requiredVal?.checked === true
      || requiredVal?.text?.toLowerCase() === 'yes'
      || requiredVal?.label?.toLowerCase() === 'required';

    const systemVal = colMap[columns.systemType];
    const systemRaw = systemVal?.label || systemVal?.text || '';
    // Normalize to one of: Yardi | OneSite | PaceOneSite | All
    let systemType = 'All';
    if (/yardi/i.test(systemRaw))            systemType = 'Yardi';
    else if (/pace/i.test(systemRaw))        systemType = 'PaceOneSite';
    else if (/onesite/i.test(systemRaw))     systemType = 'OneSite';

    return {
      id:          item.id,
      name:        item.name,
      group:       item.group.title,
      groupId:     item.group.id,
      cost,
      glCode:      colMap[columns.glCode]?.text || '—',
      description: colMap[columns.description]?.text || '',
      required:    isRequired,
      systemType,  // 'Yardi' | 'OneSite' | 'PaceOneSite' | 'All'
    };
  });

  cacheSet('programs', result);
  return result;
}

// ── Filter programs by selected system type ──
// A program applies if its systemType is 'All' or matches the selected system.
// PaceOneSite properties see both OneSite and PaceOneSite programs.
export function filterBySystem(programs, selectedSystem) {
  return programs.filter(p => {
    if (p.systemType === 'All') return true;
    if (p.systemType === selectedSystem) return true;
    if (selectedSystem === 'PaceOneSite' && p.systemType === 'OneSite') return true;
    return false;
  });
}
