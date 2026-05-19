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
  // ── Technology (Non-Elective) ──
  {
    id: 'p1', name: 'Entrata Property Management', group: 'Technology', groupId: 'g1',
    costs: { Yardi: 120, OneSite: 100, PaceOneSite: 100 },
    glCodes: { Yardi: '7210', OneSite: '7210', PaceOneSite: '7210' },
    description: 'Core property management platform license.',
    resourceUrl: '#', required: true,
    costBasis: 'Per Unit/Year', billingFreq: 'Monthly',
    programOwner: 'Sarah Johnson', priorYearCost: 110,
  },
  {
    id: 'p2', name: 'Yardi Voyager License', group: 'Technology', groupId: 'g1',
    costs: { Yardi: 18000, OneSite: 0, PaceOneSite: 0 },
    glCodes: { Yardi: '7211', OneSite: '—', PaceOneSite: '—' },
    description: 'Annual Yardi Voyager platform fee.',
    resourceUrl: '#', required: true,
    costBasis: 'Flat Annual', billingFreq: 'Annual',
    programOwner: 'Sarah Johnson', priorYearCost: 17500,
  },
  {
    id: 'p3', name: 'RealPage OneSite License', group: 'Technology', groupId: 'g1',
    costs: { Yardi: 0, OneSite: 16800, PaceOneSite: 16800 },
    glCodes: { Yardi: '—', OneSite: '7212', PaceOneSite: '7212' },
    description: 'Annual RealPage OneSite platform fee.',
    resourceUrl: '#', required: true,
    costBasis: 'Flat Annual', billingFreq: 'Annual',
    programOwner: 'Sarah Johnson', priorYearCost: 16200,
  },
  // ── Technology (Elective) ──
  {
    id: 'p4', name: 'SmartRent Smart Home', group: 'Technology', groupId: 'g1',
    costs: { Yardi: 80, OneSite: 80, PaceOneSite: 80 },
    glCodes: { Yardi: '7220', OneSite: '7220', PaceOneSite: '7220' },
    description: 'Smart lock and thermostat management platform per unit per month.',
    resourceUrl: '#', required: false,
    costBasis: 'Per Unit/Month', billingFreq: 'Monthly',
    programOwner: 'Mike Torres', priorYearCost: 75,
  },
  {
    id: 'p5', name: 'ButterflyMX Video Intercom', group: 'Technology', groupId: 'g1',
    costs: { Yardi: 500, OneSite: 500, PaceOneSite: 500 },
    glCodes: { Yardi: '7221', OneSite: '7221', PaceOneSite: '7221' },
    description: 'Cloud-based video intercom and access control per device annually.',
    resourceUrl: '#', required: false,
    costBasis: 'Per Device', billingFreq: 'Annual',
    programOwner: 'Mike Torres', priorYearCost: 0,
  },
  {
    id: 'p6', name: 'Elevator Monitoring Service', group: 'Technology', groupId: 'g1',
    costs: { Yardi: 1200, OneSite: 1200, PaceOneSite: 1200 },
    glCodes: { Yardi: '7222', OneSite: '7222', PaceOneSite: '7222' },
    description: 'Annual elevator remote monitoring and alert system.',
    resourceUrl: '#', required: false,
    costBasis: 'Per Elevator', billingFreq: 'Annual',
    programOwner: 'Mike Torres', priorYearCost: 1100,
  },

  // ── Marketing (Non-Elective) ──
  {
    id: 'p7', name: 'ILS Listing Package', group: 'Marketing', groupId: 'g2',
    costs: { Yardi: 7200, OneSite: 7200, PaceOneSite: 7200 },
    glCodes: { Yardi: '6110', OneSite: '6110', PaceOneSite: '6110' },
    description: 'Apartments.com and Zillow listing subscriptions.',
    resourceUrl: '#', required: true,
    costBasis: 'Flat Annual', billingFreq: 'Monthly',
    programOwner: 'Lisa Park', priorYearCost: 6800,
  },
  // ── Marketing (Elective) ──
  {
    id: 'p8', name: 'Reputation.com Review Management', group: 'Marketing', groupId: 'g2',
    costs: { Yardi: 5400, OneSite: 5400, PaceOneSite: 5400 },
    glCodes: { Yardi: '6120', OneSite: '6120', PaceOneSite: '6120' },
    description: 'Online reputation monitoring and review response platform.',
    resourceUrl: '#', required: false,
    costBasis: 'Flat Annual', billingFreq: 'Monthly',
    programOwner: 'Lisa Park', priorYearCost: 5200,
  },
  {
    id: 'p9', name: 'Parking Space Management', group: 'Marketing', groupId: 'g2',
    costs: { Yardi: 120, OneSite: 120, PaceOneSite: 120 },
    glCodes: { Yardi: '6121', OneSite: '6121', PaceOneSite: '6121' },
    description: 'Resident parking assignment and enforcement platform.',
    resourceUrl: '#', required: false,
    costBasis: 'Per Parking Space', billingFreq: 'Annual',
    programOwner: 'Lisa Park', priorYearCost: 0,
  },

  // ── Accounting (Non-Elective) ──
  {
    id: 'p10', name: 'Vendor Payment Processing', group: 'Accounting', groupId: 'g3',
    costs: { Yardi: 2400, OneSite: 2400, PaceOneSite: 2400 },
    glCodes: { Yardi: '7410', OneSite: '7410', PaceOneSite: '7410' },
    description: 'ACH and check processing fees for vendor payments.',
    resourceUrl: '#', required: true,
    costBasis: 'Flat Annual', billingFreq: 'Monthly',
    programOwner: 'Tom Rivera', priorYearCost: 2200,
  },
  // ── Accounting (Elective) ──
  {
    id: 'p11', name: 'Docuware Document Management', group: 'Accounting', groupId: 'g3',
    costs: { Yardi: 3000, OneSite: 3000, PaceOneSite: 3000 },
    glCodes: { Yardi: '7420', OneSite: '7420', PaceOneSite: '7420' },
    description: 'Digital document storage and workflow automation.',
    resourceUrl: '#', required: false,
    costBasis: 'Flat Annual', billingFreq: 'Monthly',
    programOwner: 'Tom Rivera', priorYearCost: 2900,
  },

  // ── Operations (Elective) ──
  {
    id: 'p12', name: 'Lessen Maintenance Platform', group: 'Operations', groupId: 'g4',
    costs: { Yardi: 50, OneSite: 50, PaceOneSite: 50 },
    glCodes: { Yardi: '7310', OneSite: '7310', PaceOneSite: '7310' },
    description: 'Work order management and vendor dispatch platform.',
    resourceUrl: '#', required: false,
    costBasis: 'Per Unit/Year', billingFreq: 'Monthly',
    programOwner: 'Dana Wei', priorYearCost: 48,
  },
  {
    id: 'p13', name: 'Package Locker System', group: 'Operations', groupId: 'g4',
    costs: { Yardi: 35, OneSite: 35, PaceOneSite: 35 },
    glCodes: { Yardi: '7311', OneSite: '7311', PaceOneSite: '7311' },
    description: 'Smart package locker annual software and monitoring fee.',
    resourceUrl: '#', required: false,
    costBasis: 'Per Locker', billingFreq: 'Annual',
    programOwner: 'Dana Wei', priorYearCost: 0,
  },
];
