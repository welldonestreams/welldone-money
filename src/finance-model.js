import { statementCreditOffsetCategory, transactionFlags } from './transaction-kind.js';

export function financeSummary(source) {
  const accounts = source.accounts || [];
  const assets = accounts
    .filter(account => ['checking', 'savings', 'investment'].includes(account.kind))
    .reduce((sum, account) => sum + numeric(account.currentBalance), 0);
  const debt = (source.liabilities || []).length
    ? source.liabilities.reduce((sum, item) => sum + Math.max(0, numeric(item.balance)), 0)
    : accounts.filter(account => account.kind === 'credit').reduce((sum, account) => sum + Math.max(0, numeric(account.currentBalance)), 0);
  const cash = accounts
    .filter(account => ['checking', 'savings'].includes(account.kind))
    .reduce((sum, account) => sum + numeric(account.currentBalance), 0);
  const investments = accounts
    .filter(account => account.kind === 'investment')
    .reduce((sum, account) => sum + numeric(account.currentBalance), 0);
  return { assets, debt, cash, investments, netWorth: assets - debt };
}

export function transactionFlow(transactions, startDate = '') {
  const result = (transactions || []).reduce((result, transaction) => {
    if (startDate && transaction.date < startDate) return result;
    const amount = numeric(transaction.amount);
    const flags = transactionFlags(transaction);
    const transfer = String(transaction.category || '').toLowerCase() === 'transfer';
    if (flags.isPayment || (transfer && !transaction.isIncome && !flags.isPaycheck)) return result;
    if (amount > 0 && (flags.isStatementCredit || transaction.accountKind === 'credit')) result.statementCredits += amount;
    else if (amount > 0 && (transaction.isIncome || flags.isPaycheck || String(transaction.category || '').toLowerCase() === 'income' || !transfer)) result.inflow += amount;
    if (amount < 0) result.outflow += Math.abs(amount);
    return result;
  }, { inflow: 0, outflow: 0, statementCredits: 0 });
  return { inflow: moneyValue(result.inflow), outflow: moneyValue(Math.max(0, result.outflow - result.statementCredits)) };
}

export function spendingByCategory(transactions, startDate = '') {
  const totals = new Map();
  for (const transaction of transactions || []) {
    if (startDate && transaction.date < startDate) continue;
    const amount = numeric(transaction.amount);
    const flags = transactionFlags(transaction);
    const category = flags.isStatementCredit ? statementCreditOffsetCategory(transaction) : (transaction.category || 'Uncategorized');
    if (flags.isPayment || (category.toLowerCase() === 'transfer' && !transaction.isIncome && !flags.isPaycheck)) continue;
    if (amount < 0) totals.set(category, (totals.get(category) || 0) + Math.abs(amount));
    if (amount > 0 && (flags.isStatementCredit || transaction.accountKind === 'credit')) totals.set(category, (totals.get(category) || 0) - amount);
  }
  return [...totals.entries()].map(([category, amount]) => ({ category, amount: moneyValue(Math.max(0, amount)) })).filter(item => item.amount > 0).sort((a, b) => b.amount - a.amount);
}

export function monthlyFlow(transactions, months = 6, now = new Date()) {
  const buckets = [];
  for (let offset = months - 1; offset >= 0; offset -= 1) {
    const date = new Date(now.getFullYear(), now.getMonth() - offset, 1);
    buckets.push({ key: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`, label: date.toLocaleDateString('en-US', { month: 'short' }), inflow: 0, outflow: 0 });
  }
  const index = new Map(buckets.map(bucket => [bucket.key, bucket]));
  for (const transaction of transactions || []) {
    const bucket = index.get(String(transaction.date || '').slice(0, 7));
    const flags = transactionFlags(transaction);
    const transfer = String(transaction.category || '').toLowerCase() === 'transfer';
    if (!bucket || flags.isPayment || (transfer && !transaction.isIncome && !flags.isPaycheck)) continue;
    const amount = numeric(transaction.amount);
    if (amount > 0 && (flags.isStatementCredit || transaction.accountKind === 'credit')) bucket.outflow -= amount;
    else if (amount > 0 && (transaction.isIncome || flags.isPaycheck || String(transaction.category || '').toLowerCase() === 'income' || !transfer)) bucket.inflow += amount;
    if (amount < 0) bucket.outflow += Math.abs(amount);
  }
  buckets.forEach(bucket => { bucket.inflow = moneyValue(bucket.inflow); bucket.outflow = moneyValue(Math.max(0, bucket.outflow)); });
  return buckets;
}

// Investment KPI totals.
//
// investmentMeta comes from the private statement file and describes only the
// funds in that file. Preferring it over the holdings sums, as this previously
// did, printed a whole-portfolio "Current value" beside a statement-only
// "Contributed" and a gain computed from neither of the two numbers on screen.
//
// Contributions and gain are therefore taken from the holdings that actually
// report a cost basis, and gain compares those holdings against their own
// value so the subtraction is like for like. Statement metadata is used only
// when no holding reports a basis at all.
export function investmentTotals(holdings, meta = {}) {
  const rows = Array.isArray(holdings) ? holdings : [];
  const withBasis = rows.filter(item => item?.costBasis != null && Number.isFinite(Number(item.costBasis)));
  const totalValue = moneyValue(rows.reduce((sum, item) => sum + numeric(item?.value), 0));
  const basis = moneyValue(withBasis.reduce((sum, item) => sum + numeric(item.costBasis), 0));
  const basisValue = moneyValue(withBasis.reduce((sum, item) => sum + numeric(item.value), 0));
  const metaContributions = Number(meta?.totalContributions);
  const metaGain = Number(meta?.totalGain);
  const covered = withBasis.length > 0;
  return {
    totalValue,
    fundCount: rows.length,
    contributed: covered ? basis : (Number.isFinite(metaContributions) ? moneyValue(metaContributions) : 0),
    gain: covered ? moneyValue(basisValue - basis) : (Number.isFinite(metaGain) ? moneyValue(metaGain) : 0),
    reportingCount: withBasis.length,
    // True when some funds report a basis and others do not, so the gain covers
    // less than the headline value and the UI must say so.
    partial: covered && withBasis.length < rows.length,
    fromStatementOnly: !covered,
  };
}

// Plaid reports a cost basis and a current value for a connected fund but no
// dated performance, so every holding row printed "Not available" in the
// return column for each range. A basis and a value are enough to state a real
// total return, which carries its own scope label so it is never read as the
// selected 1W/1M/YTD/3Y figure.
export function holdingReturn(item, range) {
  const ranged = Number(item?.returnByRange?.[range]);
  if (Number.isFinite(ranged)) return { rate: ranged, scope: '' };
  const basis = Number(item?.costBasis);
  const value = Number(item?.value);
  if (!Number.isFinite(basis) || !Number.isFinite(value) || basis <= 0) return null;
  return { rate: (value - basis) / basis * 100, scope: 'since contributions' };
}

function numeric(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function moneyValue(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}
