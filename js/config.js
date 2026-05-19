// ─── Configuration ───────────────────────────────────────────────────────────
// Fill in these values. API keys and secrets live only in Vercel env vars —
// none of this exposes credentials to the browser.

const CONFIG = {
  // ── Set to true to use dummy data (no API keys needed) ──
  useMockData: true,

  // ── Budget cycle ──
  budgetYear: 2026,

  // ── Monday.com board IDs (numeric strings) ──
  monday: {
    propertyBoardId: '9029568429',    // Budget Due Date Tracker board
    programsBoardId: '18405693984',     // Cost Center Assumptions board

    // Column IDs from the programs board
    columns: {
      elective:    'text_mm1va2vk',   // "Elective/Non-Elective" — Non-Elective = required
      description: 'text_mm1tdbd3',   // Program Details/Notes
      yardiCost:   'text_mm1t269y',
      yardiGL:     'text_mm1thsv9',
      onesiteCost: 'text_mm1t4ka4',
      onesiteGL:   'text_mm1t7tb7',
      paceCost:    'text_mm1tj0j6',
      paceGL:      'text_mm1txpbx',
      costBasis:   'text_mm1vy4f4',
      billingFreq: 'text_mm1vnhd4',
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
