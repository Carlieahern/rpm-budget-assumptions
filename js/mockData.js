// ── Mock data for layout testing ─────────────────────────────────────────────
// Set CONFIG.useMockData = true in config.js to use this instead of live APIs.

export const MOCK_PROPERTIES = [
  { id: '1', name: 'Alexan Fitzroy' },
  { id: '2', name: 'Broadstone Oak Creek' },
  { id: '3', name: 'Camden Heights' },
  { id: '4', name: 'Domain at Midtown Park' },
  { id: '5', name: 'Elan City Lights' },
];

export const MOCK_PROGRAMS = [
  // ── Technology (required) ──
  {
    id: 'p1', name: 'Entrata Property Management', group: 'Technology', groupId: 'g1',
    costs: { Yardi: 14400, OneSite: 12000, PaceOneSite: 12000 },
    glCodes: { Yardi: '7210', OneSite: '7210', PaceOneSite: '7210' },
    description: 'Core property management platform license.',
    required: true, costBasis: 'Per Unit/Year', billingFreq: 'Monthly',
  },
  {
    id: 'p2', name: 'Yardi Voyager License', group: 'Technology', groupId: 'g1',
    costs: { Yardi: 18000, OneSite: 0, PaceOneSite: 0 },
    glCodes: { Yardi: '7211', OneSite: '—', PaceOneSite: '—' },
    description: 'Annual Yardi Voyager platform fee.',
    required: true, costBasis: 'Flat Annual', billingFreq: 'Annual',
  },
  {
    id: 'p3', name: 'RealPage OneSite License', group: 'Technology', groupId: 'g1',
    costs: { Yardi: 0, OneSite: 16800, PaceOneSite: 16800 },
    glCodes: { Yardi: '—', OneSite: '7212', PaceOneSite: '7212' },
    description: 'Annual RealPage OneSite platform fee.',
    required: true, costBasis: 'Flat Annual', billingFreq: 'Annual',
  },
  // ── Technology (non-required) ──
  {
    id: 'p4', name: 'SmartRent Smart Home', group: 'Technology', groupId: 'g1',
    costs: { Yardi: 9600, OneSite: 9600, PaceOneSite: 9600 },
    glCodes: { Yardi: '7220', OneSite: '7220', PaceOneSite: '7220' },
    description: 'Smart lock and thermostat management platform.',
    required: false, costBasis: 'Per Unit/Month', billingFreq: 'Monthly',
  },
  {
    id: 'p5', name: 'ButterflyMX Video Intercom', group: 'Technology', groupId: 'g1',
    costs: { Yardi: 4800, OneSite: 4800, PaceOneSite: 4800 },
    glCodes: { Yardi: '7221', OneSite: '7221', PaceOneSite: '7221' },
    description: 'Cloud-based video intercom and access control.',
    required: false, costBasis: 'Flat Annual', billingFreq: 'Monthly',
  },
  {
    id: 'p6', name: 'Parking Management Software', group: 'Technology', groupId: 'g1',
    costs: { Yardi: 3600, OneSite: 3600, PaceOneSite: 3600 },
    glCodes: { Yardi: '7222', OneSite: '7222', PaceOneSite: '7222' },
    description: 'Resident and guest parking enforcement platform.',
    required: false, costBasis: 'Flat Annual', billingFreq: 'Monthly',
  },

  // ── Marketing (required) ──
  {
    id: 'p7', name: 'ILS Listing Package', group: 'Marketing', groupId: 'g2',
    costs: { Yardi: 7200, OneSite: 7200, PaceOneSite: 7200 },
    glCodes: { Yardi: '6110', OneSite: '6110', PaceOneSite: '6110' },
    description: 'Apartments.com and Zillow listing subscriptions.',
    required: true, costBasis: 'Flat Annual', billingFreq: 'Monthly',
  },
  // ── Marketing (non-required) ──
  {
    id: 'p8', name: 'Reputation.com Review Management', group: 'Marketing', groupId: 'g2',
    costs: { Yardi: 5400, OneSite: 5400, PaceOneSite: 5400 },
    glCodes: { Yardi: '6120', OneSite: '6120', PaceOneSite: '6120' },
    description: 'Online reputation monitoring and review response platform.',
    required: false, costBasis: 'Flat Annual', billingFreq: 'Monthly',
  },
  {
    id: 'p9', name: 'Social Media Management', group: 'Marketing', groupId: 'g2',
    costs: { Yardi: 4800, OneSite: 4800, PaceOneSite: 4800 },
    glCodes: { Yardi: '6121', OneSite: '6121', PaceOneSite: '6121' },
    description: 'Managed social media content and posting.',
    required: false, costBasis: 'Flat Annual', billingFreq: 'Monthly',
  },

  // ── Accounting (required) ──
  {
    id: 'p10', name: 'Vendor Payment Processing', group: 'Accounting', groupId: 'g3',
    costs: { Yardi: 2400, OneSite: 2400, PaceOneSite: 2400 },
    glCodes: { Yardi: '7410', OneSite: '7410', PaceOneSite: '7410' },
    description: 'ACH and check processing fees for vendor payments.',
    required: true, costBasis: 'Flat Annual', billingFreq: 'Monthly',
  },
  // ── Accounting (non-required) ──
  {
    id: 'p11', name: 'Docuware Document Management', group: 'Accounting', groupId: 'g3',
    costs: { Yardi: 3000, OneSite: 3000, PaceOneSite: 3000 },
    glCodes: { Yardi: '7420', OneSite: '7420', PaceOneSite: '7420' },
    description: 'Digital document storage and workflow automation.',
    required: false, costBasis: 'Flat Annual', billingFreq: 'Monthly',
  },

  // ── Operations (non-required) ──
  {
    id: 'p12', name: 'Lessen Maintenance Platform', group: 'Operations', groupId: 'g4',
    costs: { Yardi: 6000, OneSite: 6000, PaceOneSite: 6000 },
    glCodes: { Yardi: '7310', OneSite: '7310', PaceOneSite: '7310' },
    description: 'Work order management and vendor dispatch platform.',
    required: false, costBasis: 'Per Unit/Year', billingFreq: 'Monthly',
  },
  {
    id: 'p13', name: 'Package Locker System', group: 'Operations', groupId: 'g4',
    costs: { Yardi: 4200, OneSite: 4200, PaceOneSite: 4200 },
    glCodes: { Yardi: '7311', OneSite: '7311', PaceOneSite: '7311' },
    description: 'Smart package locker annual software and monitoring fee.',
    required: false, costBasis: 'Flat Annual', billingFreq: 'Monthly',
  },
];
