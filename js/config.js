// ─── Configuration ───────────────────────────────────────────────────────────
// Fill in these values. API keys and secrets live only in Vercel env vars —
// none of this exposes credentials to the browser.

const CONFIG = {
  // ── Set to true to use dummy data (no API keys needed) ──
  useMockData: false,

  // ── Budget cycle ──
  budgetYear: 2027,

  // ── Firebase Realtime Database ──
  firebase: {
    url: 'https://rpm-site-level-assumptions-default-rtdb.firebaseio.com',
  },

  // ── Monday.com board IDs (numeric strings) — properties only ──
  monday: {
    propertyBoardId: '9029568429',    // Budget Due Date Tracker board
    programsBoardId: '18405693984',     // Cost Center Assumptions board

    // Column IDs from the Budget Assumptions Master List board
    columns: {
      department:    'text_mm1vavj0',   // Department → grouping in app
      elective:      'text_mm1va2vk',   // Elective/Non-Elective → left or right column
      cost:          'text_mm1tbtsq',   // Cost of Program (general rate)
      costBasis:     'text_mm1vy4f4',   // Per Unit/Year, Per Device, Flat Annual, etc.
      billingFreq:   'text_mm1vnhd4',   // Monthly, Annual, etc.
      yardiCost:     'text_mm1t269y',   // Yardi-specific cost
      yardiGL:       'text_mm1thsv9',
      onesiteCost:   'text_mm1t4ka4',   // OneSite-specific cost
      onesiteGL:     'text_mm1t7tb7',
      paceCost:      'text_mm1tj0j6',   // Pace-specific cost
      paceGL:        'text_mm1txpbx',
      description:   'text_mm1tdbd3',   // Program Details/Notes
      programOwner:  'text_mm1tdec',    // Program Owner
      submittedBy:   'text_mm1tvsh0',   // Submitted By (fallback owner)
      priorYearCost: 'text_mm1vrrpj',   // Prior Year Cost
    },
  },
};

export default CONFIG;
