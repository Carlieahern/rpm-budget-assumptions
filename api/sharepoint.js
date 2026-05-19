// Vercel serverless function — all SharePoint / Microsoft Graph calls.
// Uses the OAuth 2.0 client credentials flow (app-only, no user sign-in).
// Required env vars (set in Vercel dashboard):
//   AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET,
//   SHAREPOINT_SITE_ID, SHAREPOINT_LIST_ID

const GRAPH = 'https://graph.microsoft.com/v1.0';

// ── Token cache (in-memory per function instance) ──
let _tokenCache = null;

async function getToken() {
  const now = Date.now();
  if (_tokenCache && _tokenCache.expiresAt > now + 60_000) return _tokenCache.token;

  const { AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET } = process.env;
  if (!AZURE_TENANT_ID || !AZURE_CLIENT_ID || !AZURE_CLIENT_SECRET) {
    throw new Error('Missing Azure credentials in environment variables');
  }

  const params = new URLSearchParams({
    grant_type:    'client_credentials',
    client_id:     AZURE_CLIENT_ID,
    client_secret: AZURE_CLIENT_SECRET,
    scope:         'https://graph.microsoft.com/.default',
  });

  const res = await fetch(
    `https://login.microsoftonline.com/${AZURE_TENANT_ID}/oauth2/v2.0/token`,
    { method: 'POST', body: params }
  );

  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error_description || 'Token request failed');
  }

  const json = await res.json();
  _tokenCache = { token: json.access_token, expiresAt: now + json.expires_in * 1000 };
  return _tokenCache.token;
}

async function graph(method, path, body) {
  const token = await getToken();
  const res = await fetch(`${GRAPH}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const json = await res.json();
  if (!res.ok) throw new Error(json.error?.message || `Graph ${res.status}`);
  return json;
}

// ── Column names (mirror js/config.js spColumns) ──
const C = {
  property:       'PropertyName',
  programId:      'ProgramID',
  programName:    'ProgramName',
  decision:       'Decision',
  budgetYear:     'BudgetYear',
  optOutApproval: 'OptOutApproval',
  timestamp:      'DecisionDate',
  notes:          'Notes',
};

function listBase() {
  const siteId = process.env.SHAREPOINT_SITE_ID;
  const listId = process.env.SHAREPOINT_LIST_ID;
  if (!siteId || !listId) throw new Error('Missing SHAREPOINT_SITE_ID or SHAREPOINT_LIST_ID');
  return `/sites/${siteId}/lists/${listId}`;
}

async function fetchDecisions(property, budgetYear) {
  const safe = property.replace(/'/g, "''");
  const filter = encodeURIComponent(
    `fields/${C.property} eq '${safe}' and fields/${C.budgetYear} eq ${budgetYear}`
  );
  const data = await graph('GET', `${listBase()}/items?$filter=${filter}&$expand=fields&$top=500`);
  const decisions = {};
  for (const item of (data?.value || [])) {
    const f = item.fields;
    decisions[f[C.programId]] = {
      itemId:         item.id,
      decision:       f[C.decision],
      optOutApproval: f[C.optOutApproval] || false,
      timestamp:      f[C.timestamp],
      notes:          f[C.notes] || '',
    };
  }
  return decisions;
}

// ── Handler ──────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST')    { res.status(405).json({ error: 'Method not allowed' }); return; }

  const { action, property, budgetYear, program, decision,
          optOutApproval, notes, itemId } = req.body;

  try {
    switch (action) {

      case 'load': {
        const decisions = await fetchDecisions(property, budgetYear);
        res.json({ decisions });
        break;
      }

      case 'save': {
        const fields = {
          [C.property]:       property,
          [C.programId]:      program.id,
          [C.programName]:    program.name,
          [C.decision]:       decision,
          [C.budgetYear]:     budgetYear,
          [C.optOutApproval]: optOutApproval || false,
          [C.timestamp]:      new Date().toISOString(),
          [C.notes]:          notes || '',
        };
        if (itemId) {
          await graph('PATCH', `${listBase()}/items/${itemId}`, { fields });
          res.json({ itemId });
        } else {
          const result = await graph('POST', `${listBase()}/items`, { fields });
          res.json({ itemId: result.id });
        }
        break;
      }

      case 'delete': {
        await graph('DELETE', `${listBase()}/items/${itemId}`);
        res.json({ ok: true });
        break;
      }

      case 'reset': {
        const existing = await fetchDecisions(property, budgetYear);
        await Promise.all(
          Object.values(existing).map(d => graph('DELETE', `${listBase()}/items/${d.itemId}`))
        );
        res.json({ ok: true, deleted: Object.keys(existing).length });
        break;
      }

      // One-time helper: logs siteId + listId to Vercel function logs
      case 'discover': {
        const { hostname, sitePath, listName } = req.body;
        const siteData = await graph('GET', `/sites/${hostname}:${sitePath}`);
        const listsData = await graph('GET',
          `/sites/${siteData.id}/lists?$filter=displayName eq '${listName}'`);
        res.json({ siteId: siteData.id, listId: listsData.value[0]?.id });
        break;
      }

      default:
        res.status(400).json({ error: `Unknown action: ${action}` });
    }
  } catch (err) {
    console.error('[sharepoint]', err);
    res.status(500).json({ error: err.message });
  }
}
