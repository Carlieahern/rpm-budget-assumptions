// ─── Configuration ───────────────────────────────────────────────────────────
// Fill in these values. API keys and secrets live only in Vercel env vars —
// none of this exposes credentials to the browser.

const CONFIG = {
  // ── Budget cycle ──
  budgetYear: 2026,

  // ── Monday.com board IDs (numeric strings) ──
  monday: {
    propertyBoardId: '9029568429',    // Budget Due Date Tracker board
    programsBoardId: '18405693984',     // Cost Center Assumptions board

    // Column IDs from the programs board
    // Find them in Monday's board settings → "Columns" or via the API explorer
    columns: {
      cost:        'numbers',     // replace with actual column ID
      glCode:      'text',        // replace with actual column ID
      description: 'long_text',   // replace with actual column ID
      required:    'checkbox',    // replace with actual column ID
      systemType:  'status',      // replace — labels: Yardi, OneSite, PaceOneSite
    },
  },

  // ── SharePoint ── (used server-side only via /api/sharepoint)
  sharePoint: {
    siteId:   'YOUR_SITE_ID',     // Graph site ID — run discoverIds() helper once
    listId:   'YOUR_LIST_ID',     // Graph list ID
    listName: 'BudgetAssumptionDecisions',
  },

  // SharePoint list column internal names
  spColumns: {
    property:       'PropertyName',
    programId:      'ProgramID',
    programName:    'ProgramName',
    decision:       'Decision',       // Choice: in | out | pending | opted-out
    budgetYear:     'BudgetYear',     // Number
    optOutApproval: 'OptOutApproval', // Yes/No
    timestamp:      'DecisionDate',   // DateTime
    notes:          'Notes',
  },
};

export default CONFIG;
