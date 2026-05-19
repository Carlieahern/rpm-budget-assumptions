// ── UI helpers ────────────────────────────────────────────────────────────────

// Maps group title → CSS class suffix and display color
const GROUP_MAP = {
  marketing:   { key: 'marketing',  label: 'Marketing' },
  accounting:  { key: 'accounting', label: 'Accounting' },
  technology:  { key: 'technology', label: 'Technology' },
  operations:  { key: 'operations', label: 'Operations' },
  'hr':        { key: 'hr',         label: 'HR & People' },
  'people':    { key: 'hr',         label: 'HR & People' },
  legal:       { key: 'legal',      label: 'Legal' },
  revenue:     { key: 'revenue',    label: 'Revenue Mgmt' },
  training:    { key: 'training',   label: 'Training' },
};

export function groupStyle(groupTitle = '') {
  const key = groupTitle.toLowerCase();
  for (const [match, style] of Object.entries(GROUP_MAP)) {
    if (key.includes(match)) return style;
  }
  return { key: 'default', label: groupTitle || 'General' };
}

export function formatCost(cost) {
  if (!cost) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(cost);
}

// ── Screens ────────────────────────────────────────────────────────────────
export function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id)?.classList.add('active');
}

// ── Modals / Overlays ──────────────────────────────────────────────────────
export function openModal(id)  { document.getElementById(id)?.classList.add('open'); }
export function closeModal(id) { document.getElementById(id)?.classList.remove('open'); }

// ── Required Program Card ─────────────────────────────────────────────────
export function buildRequiredCard(program, decision, priorDecision) {
  const gs = groupStyle(program.group);
  const el = document.createElement('div');
  el.className = 'req-card';
  el.dataset.programId = program.id;

  const isOptedOut   = decision?.decision === 'opted-out';
  const isFollowUp   = decision?.decision === 'needs-followup';
  if (isOptedOut)  el.classList.add('opted-out');
  if (isFollowUp)  el.classList.add('needs-followup');

  const priorChip = priorDecision
    ? `<div class="prior-year-chip was-${priorDecision.decision === 'opted-out' ? 'out' : 'in'}">
         ${priorDecision.decision === 'opted-out' ? '↩ Opted out last year' : '✓ Included last year'}
       </div>`
    : '';

  const footContent = isOptedOut
    ? `<span class="card-status-badge status-opted-out">Opted Out${decision.optOutApproval ? ' ✓' : ''}</span>
       <button class="btn-opt-out btn-undo-optout" data-pid="${program.id}">Undo</button>`
    : isFollowUp
    ? `<span class="card-status-badge status-followup">⚑ Needs Follow-up</span>
       <button class="btn-opt-out btn-opt-out-trigger" data-pid="${program.id}">Opt Out</button>`
    : `<span></span>
       <button class="btn-opt-out btn-opt-out-trigger" data-pid="${program.id}">Opt Out</button>`;

  el.innerHTML = `
    <div class="card-accent accent-${gs.key}"></div>
    <div class="card-body">
      <div class="card-meta">
        <span class="card-group-badge badge-${gs.key}">${gs.label}</span>
        <span class="card-required-badge">Required</span>
      </div>
      <div class="card-name">${program.name}</div>
      <div class="card-desc">${program.description || ''}</div>
      <div class="card-details">
        <div class="card-detail">
          <span class="detail-label">Annual Cost</span>
          <span class="detail-value cost">${formatCost(program.cost)}</span>
        </div>
        <div class="card-detail">
          <span class="detail-label">GL Code</span>
          <span class="detail-value">${program.glCode}</span>
        </div>
      </div>
      ${priorChip}
    </div>
    <div class="card-foot">${footContent}</div>
  `;
  return el;
}

// ── Swipe Card ────────────────────────────────────────────────────────────
export function buildSwipeCard(program, priorDecision) {
  const gs = groupStyle(program.group);
  const el = document.createElement('div');
  el.className = 'swipe-card';
  el.dataset.programId = program.id;

  const priorChip = priorDecision
    ? buildPriorChip(priorDecision.decision)
    : '';

  el.innerHTML = `
    <div class="swipe-overlay swipe-overlay-right">INCLUDE ✓</div>
    <div class="swipe-overlay swipe-overlay-left">SKIP ✕</div>
    <div class="swipe-overlay swipe-overlay-up">PENDING ↑</div>
    <div class="swipe-card-accent accent-${gs.key}"></div>
    <div class="swipe-card-body">
      <div class="swipe-card-header">
        <span class="swipe-group-badge badge-${gs.key}">${gs.label}</span>
      </div>
      <div class="swipe-card-name">${program.name}</div>
      <div class="swipe-card-desc">${program.description || ''}</div>
      <div class="swipe-card-details">
        <div class="swipe-detail">
          <span class="label">Annual Cost</span>
          <span class="value cost">${formatCost(program.cost)}</span>
        </div>
        <div class="swipe-detail">
          <span class="label">GL Code</span>
          <span class="value">${program.glCode}</span>
        </div>
        <div class="swipe-detail">
          <span class="label">System</span>
          <span class="value">${program.systemType === 'All' ? 'All Systems' : program.systemType}</span>
        </div>
      </div>
      ${priorChip}
    </div>
  `;
  return el;
}

function buildPriorChip(decision) {
  const map = { in: 'was-in', out: 'was-out', pending: 'was-pending', 'opted-out': 'was-out' };
  const cls = map[decision] || 'was-pending';
  const labels = { in: '✓ Included last year', out: '✕ Skipped last year', pending: '? Pending last year', 'opted-out': '↩ Opted out last year' };
  return `<div class="prior-year-chip ${cls}">${labels[decision] || ''}</div>`;
}

// ── Pending chip ──────────────────────────────────────────────────────────
export function buildPendingChip(program) {
  const el = document.createElement('button');
  el.className = 'pending-chip';
  el.dataset.programId = program.id;
  el.innerHTML = `<span class="chip-dot"></span>${program.name}`;
  return el;
}

// ── Summary ───────────────────────────────────────────────────────────────
export function renderSummary(programs, decisions, priorDecisions, budgetYear, viewingPrior) {
  const body = document.getElementById('summary-body');
  if (!body) return;

  const decided = programs.filter(p => decisions[p.id]);
  const inList  = decided.filter(p => decisions[p.id]?.decision === 'in');
  const outList = decided.filter(p => decisions[p.id]?.decision === 'out');
  const pendList= decided.filter(p => decisions[p.id]?.decision === 'pending');
  const optList = programs.filter(p => decisions[p.id]?.decision === 'opted-out');
  const reqIn   = programs.filter(p => p.required && decisions[p.id]?.decision !== 'opted-out');

  const totalCost = [...reqIn, ...inList].reduce((s, p) => s + (p.cost || 0), 0);

  const priorBanner = viewingPrior
    ? `<div class="prior-year-banner">📅 Comparing with ${budgetYear - 1} decisions</div>`
    : '';

  body.innerHTML = `
    ${priorBanner}
    <div class="summary-stat-row">
      <div class="summary-stat">
        <div class="stat-num">${reqIn.length + inList.length}</div>
        <div class="stat-label">Programs In</div>
      </div>
      <div class="summary-stat">
        <div class="stat-num">${outList.length}</div>
        <div class="stat-label">Skipped</div>
      </div>
      <div class="summary-stat">
        <div class="stat-num">${formatCost(totalCost)}</div>
        <div class="stat-label">Est. Budget</div>
      </div>
    </div>
    ${renderSummarySection('Required Programs', reqIn, decisions, priorDecisions, 'required')}
    ${optList.length ? renderSummarySection('Opted Out', optList, decisions, priorDecisions, 'opted-out') : ''}
    ${inList.length  ? renderSummarySection('Included', inList, decisions, priorDecisions, 'in') : ''}
    ${outList.length ? renderSummarySection('Skipped', outList, decisions, priorDecisions, 'out') : ''}
    ${pendList.length? renderSummarySection('Still Pending', pendList, decisions, priorDecisions, 'pending') : ''}
  `;
}

function renderSummarySection(title, programs, decisions, priorDecisions, defaultDecision) {
  if (!programs.length) return '';
  const rows = programs.map(p => {
    const d = decisions[p.id]?.decision || defaultDecision;
    const prior = priorDecisions[p.id]?.decision;
    const priorNote = prior && prior !== d
      ? `<span style="font-size:10px;color:var(--text3);margin-left:6px">was ${prior}</span>`
      : '';
    return `
      <div class="summary-row">
        <div>
          <div class="summary-row-name">${p.name}</div>
          <div class="summary-row-gl">GL ${p.glCode} · ${formatCost(p.cost)}</div>
        </div>
        <div style="display:flex;align-items:center;gap:4px">
          ${priorNote}
          <span class="decision-badge decision-${d}">${d}</span>
        </div>
      </div>
    `;
  }).join('');
  return `
    <div class="summary-section">
      <div class="summary-section-title">${title} (${programs.length})</div>
      ${rows}
    </div>
  `;
}

// ── Property dropdown ─────────────────────────────────────────────────────
export function populatePropertySelect(properties) {
  const sel = document.getElementById('property-select');
  sel.innerHTML = '<option value="">Select a property…</option>' +
    properties.map(p => `<option value="${p.name}">${p.name}</option>`).join('');
}
