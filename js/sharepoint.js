// All SharePoint operations are proxied through /api/sharepoint (server-side).
// No user auth required — the Vercel function uses app-only credentials.

async function spFetch(action, body = {}) {
  const res = await fetch('/api/sharepoint', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...body }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `SharePoint API error ${res.status}`);
  }
  return res.json();
}

export async function loadDecisions(property, budgetYear) {
  const data = await spFetch('load', { property, budgetYear });
  return data.decisions || {};
}

export async function saveDecision(property, program, decision, budgetYear, extra = {}) {
  const data = await spFetch('save', {
    property,
    program: { id: program.id, name: program.name },
    decision,
    budgetYear,
    optOutApproval: extra.optOutApproval || false,
    notes: extra.notes || '',
    itemId: extra.itemId || null,
  });
  return data.itemId;
}

export async function deleteDecision(itemId) {
  await spFetch('delete', { itemId });
}

export async function resetDecisions(property, budgetYear) {
  await spFetch('reset', { property, budgetYear });
}

export async function loadPriorYearDecisions(property, budgetYear) {
  return loadDecisions(property, budgetYear - 1);
}
