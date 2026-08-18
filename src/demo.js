export const SCHEMA_VERSION = 5;

export function freshState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    accounts: [],
    cardProfiles: [],
    benefits: [],
    transactions: [],
    recurring: [],
    holdings: [],
    funds: [],
    liabilities: [],
    renewalsTracker: [],
    investmentHistory: [],
    investmentSeries: [],
    investmentMeta: {},
    imports: [],
    importMappings: {},
    importRevision: 0,
    sync: { status: 'local', lastSuccessfulSync: '', coverageStart: '', coverageEnd: '', accountsIncluded: 0, accountsWithErrors: 0 },
    settings: { privacyMode: false, samplePreview: true },
  };
}

export function sampleState() {
  const today = new Date();
  const date = daysAgo => new Date(today.getTime() - daysAgo * 86400000).toISOString().slice(0, 10);
  return {
    schemaVersion: SCHEMA_VERSION,
    accounts: [
      { id: 'sample-checking', name: 'Everyday Checking', institution: 'Sample Community Bank', kind: 'checking', currentBalance: 8462.18, balanceAsOf: date(0) },
      { id: 'sample-savings', name: 'Emergency Savings', institution: 'Sample Community Bank', kind: 'savings', currentBalance: 24180.00, balanceAsOf: date(0) },
      { id: 'sample-investment', name: 'Long-term Investing', institution: 'Sample Brokerage', kind: 'investment', currentBalance: 68240.55, balanceAsOf: date(1) },
      { id: 'sample-card', name: 'Everyday Rewards', institution: 'Sample Card', kind: 'credit', currentBalance: 1278.42, statementBalance: 1042.16, minimumDue: 40, dueDate: date(-9), balanceAsOf: date(0) },
    ],
    cardProfiles: [],
    transactions: [
      { id: 'sample-t1', accountId: 'sample-checking', date: date(1), payee: 'Neighborhood Market', category: 'Groceries', amount: -86.42 },
      { id: 'sample-t2', accountId: 'sample-checking', date: date(2), payee: 'Payroll', category: 'Income', amount: 2840.00 },
      { id: 'sample-t3', accountId: 'sample-card', date: date(3), payee: 'Electric Utility', category: 'Utilities', amount: -124.19 },
      { id: 'sample-t4', accountId: 'sample-card', date: date(5), payee: 'Fuel Station', category: 'Transportation', amount: -61.08 },
      { id: 'sample-t5', accountId: 'sample-checking', date: date(8), payee: 'Apartment Rent', category: 'Housing', amount: -1650.00 },
      { id: 'sample-t6', accountId: 'sample-card', date: date(10), payee: 'Coffee Shop', category: 'Dining', amount: -18.75 },
    ],
    recurring: [
      { id: 'sample-r1', name: 'Apartment Rent', category: 'Housing', amount: 1650, cadence: 'monthly', nextDate: date(-12), kind: 'outflow' },
      { id: 'sample-r2', name: 'Internet', category: 'Utilities', amount: 69.99, cadence: 'monthly', nextDate: date(-5), kind: 'outflow' },
      { id: 'sample-r3', name: 'Music subscription', category: 'Subscriptions', amount: 11.99, cadence: 'monthly', nextDate: date(-3), kind: 'outflow' },
      { id: 'sample-r4', name: 'Payroll', category: 'Income', amount: 2840, cadence: 'biweekly', nextDate: date(-7), kind: 'inflow' },
    ],
    holdings: [
      { id: 'sample-h1', accountId: 'sample-investment', ticker: 'TOTAL', name: 'Total Market Fund', value: 46200.20, costBasis: 38950.00 },
      { id: 'sample-h2', accountId: 'sample-investment', ticker: 'INTL', name: 'International Fund', value: 14780.35, costBasis: 13240.00 },
      { id: 'sample-h3', accountId: 'sample-investment', ticker: 'BOND', name: 'Bond Fund', value: 7260.00, costBasis: 7100.00 },
    ],
    funds: [
      { id: 'sample-f1', accountId: 'sample-investment', ticker: 'LCAP', name: 'Large Cap Index Fund', invested: 18000, value: 19450, asOf: date(0), returns: { '1w': 1.2, '1m': 3.4, ytd: 12.6, '3y': 41.8 } },
      { id: 'sample-f2', accountId: 'sample-investment', ticker: 'SCAP', name: 'Small Cap Index Fund', invested: 6000, value: 6300, asOf: date(0), returns: { '1w': 0.8, '1m': 2.1, ytd: 9.4, '3y': 18.2 } },
    ],
    liabilities: [
      { id: 'sample-l1', accountId: 'sample-card', name: 'Everyday Rewards', balance: 1278.42, minimumPayment: 40, dueDate: date(-9), apr: 19.99 },
    ],
    renewalsTracker: [],
    investmentHistory: [],
    investmentMeta: {},
    benefits: [
      { id: 'sample-b1', accountId: 'sample-card', name: 'Annual travel credit', amount: 100, usedAmount: 35, cadence: 'annual', periodEnd: `${today.getFullYear()}-12-31` },
    ],
    imports: [],
    importMappings: {},
    importRevision: 0,
    sync: { status: 'healthy', lastSuccessfulSync: new Date().toISOString(), coverageStart: date(365), coverageEnd: date(0), accountsIncluded: 4, accountsWithErrors: 0 },
    settings: { privacyMode: false, samplePreview: true },
  };
}
