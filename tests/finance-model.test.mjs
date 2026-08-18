import test from 'node:test';
import assert from 'node:assert/strict';
import { financeSummary, investmentTotals, monthlyFlow, spendingByCategory, transactionFlow } from '../src/finance-model.js';

// Mirrors the live SHAPE with invented figures: connected holdings that report
// a basis, one that does not, and statement funds whose value has collapsed
// onto a single fund. STATEMENT_META describes only the four statement funds.
const MIXED_HOLDINGS = [
  { id: 'bridge-hold-1', value: 2000, costBasis: 1500 },
  { id: 'bridge-hold-2', value: 1000, costBasis: 900 },
  { id: 'bridge-hold-3', value: 500, costBasis: 400 },
  { id: 'bridge-hold-4', value: 300, costBasis: 200 },
  { id: 'bridge-hold-5', value: 50, costBasis: null },
  { id: 'private-investment-1', value: 800, costBasis: 300 },
  { id: 'private-investment-2', value: 0, costBasis: 200 },
  { id: 'private-investment-3', value: 0, costBasis: 100 },
  { id: 'private-investment-4', value: 0, costBasis: 150 },
];
const STATEMENT_META = { totalContributions: 750, totalGain: 500 };

test('investment totals do not mix a whole-portfolio value with statement-only contributions', () => {
  const totals = investmentTotals(MIXED_HOLDINGS, STATEMENT_META);
  assert.equal(totals.totalValue, 4650);
  // Statement metadata described 4 of 9 funds; it must not stand in for all of them.
  assert.notEqual(totals.contributed, STATEMENT_META.totalContributions);
  assert.equal(totals.contributed, 3750);
  assert.equal(totals.fundCount, 9);
});

test('gain compares reporting funds against their own value, not the headline total', () => {
  const totals = investmentTotals(MIXED_HOLDINGS, STATEMENT_META);
  // 4600 of value across the 8 funds reporting a basis, less 3750 of basis.
  // Note this is NOT totalValue - contributed, which would credit the
  // basis-less holding's whole value as gain.
  assert.equal(totals.gain, 850);
  assert.notEqual(totals.gain, STATEMENT_META.totalGain);
  assert.equal(totals.reportingCount, 8);
  assert.equal(totals.partial, true);
});

test('statement metadata is still used when no holding reports a basis', () => {
  const totals = investmentTotals([{ id: 'a', value: 1200, costBasis: null }], STATEMENT_META);
  assert.equal(totals.contributed, 750);
  assert.equal(totals.gain, 500);
  assert.equal(totals.fromStatementOnly, true);
});

test('fully reported holdings are not flagged partial', () => {
  const totals = investmentTotals([{ id: 'a', value: 150, costBasis: 100 }], {});
  assert.equal(totals.partial, false);
  assert.equal(totals.gain, 50);
});

test('empty holdings do not produce NaN totals', () => {
  const totals = investmentTotals([], {});
  assert.equal(totals.totalValue, 0);
  assert.equal(totals.contributed, 0);
  assert.equal(totals.gain, 0);
});

test('finance summary keeps assets, debt, and net worth separate', () => {
  const result = financeSummary({ accounts: [
    { kind: 'checking', currentBalance: 1000 },
    { kind: 'investment', currentBalance: 5000 },
    { kind: 'credit', currentBalance: 400 },
  ], liabilities: [{ balance: 400 }] });
  assert.deepEqual(result, { assets: 6000, debt: 400, cash: 1000, investments: 5000, netWorth: 5600 });
});

test('transaction flow excludes transfers', () => {
  const result = transactionFlow([
    { date: '2026-08-01', amount: 2000, category: 'Income' },
    { date: '2026-08-02', amount: -200, category: 'Groceries' },
    { date: '2026-08-03', amount: -500, category: 'Transfer' },
  ], '2026-08-01');
  assert.deepEqual(result, { inflow: 2000, outflow: 200 });
});

test('payroll deposits count as income even when Plaid tags them transfers', () => {
  const result = transactionFlow([
    { date: '2026-08-01', amount: 3000, category: 'Transfer', payee: 'EMPLOYER PAYROLL', rawName: 'AUTOMATIC DEPOSIT EMPLOYER PAYROLL DIRECT DEPOSIT' },
    { date: '2026-08-15', amount: -120, category: 'Transfer', payee: 'Zelle to savings' },
  ], '2026-08-01');
  assert.deepEqual(result, { inflow: 3000, outflow: 0 }, 'a payroll deposit must count as inflow; plain transfers stay excluded');
});

test('direct-deposit prefix counts as paycheck', () => {
  const result = transactionFlow([
    { date: '2026-08-01', amount: 2850, category: 'Transfer', payee: 'DD/ US TREASURY 310' },
  ], '2026-08-01');
  assert.deepEqual(result, { inflow: 2850, outflow: 0 });
});

test('card payments are ignored and statement credits reduce spending instead of becoming income', () => {
  const result = transactionFlow([
    { date: '2026-08-01', amount: -136.35, category: 'Food & drink' },
    { date: '2026-08-02', amount: 100, category: 'Food & drink', isStatementCredit: true },
    { date: '2026-08-03', amount: 500, category: 'Loan payments', isPayment: true },
  ]);
  assert.deepEqual(result, { inflow: 0, outflow: 36.35 });
});

test('spending categories exclude payments and net issuer credits against spending', () => {
  const result = spendingByCategory([
    { date: '2026-08-01', amount: -136.35, category: 'Food & drink' },
    { date: '2026-08-01', amount: 100, category: 'Other', rawName: 'Platinum Resy Credit' },
    { date: '2026-08-02', amount: -80, category: 'Groceries' },
    { date: '2026-08-03', amount: 100, category: 'Refund' },
    { date: '2026-08-04', amount: 500, category: 'Income', payee: 'MOBILE PAYMENT - THANK YOU' },
  ]);
  assert.deepEqual(result, [{ category: 'Groceries', amount: 80 }, { category: 'Food & drink', amount: 36.35 }]);
});

test('legacy statement rows derive payment and credit flags from their descriptions', () => {
  const rows = [
    { date: '2026-08-01', amount: 500, category: 'Income', payee: 'MOBILE PAYMENT - THANK YOU' },
    { date: '2026-08-02', amount: 25, category: 'Entertainment', statementPayee: 'Platinum Digital Entertainment Credit' },
    { date: '2026-08-03', amount: -40, category: 'Entertainment', payee: 'Streaming service' },
  ];
  assert.deepEqual(transactionFlow(rows), { inflow: 0, outflow: 15 });
  assert.equal(monthlyFlow(rows, 1, new Date('2026-08-14T12:00:00Z'))[0].outflow, 15);
});

test('monthly flow creates stable empty buckets', () => {
  const result = monthlyFlow([{ date: '2026-08-03', amount: -50, category: 'Dining' }], 2, new Date('2026-08-14T12:00:00Z'));
  assert.deepEqual(result.map(item => [item.key, item.outflow]), [['2026-07', 0], ['2026-08', 50]]);
});

test('private paycheck rules can promote selected transfers while card refunds offset spending', () => {
  const rows = [
    { date: '2026-08-01', amount: 1500, category: 'Income', isIncome: true },
    { date: '2026-08-02', amount: 7, category: 'Food & drink', accountKind: 'credit' },
    { date: '2026-08-03', amount: -20, category: 'Food & drink', accountKind: 'credit' },
    { date: '2026-08-04', amount: 400, category: 'Transfer' },
  ];
  assert.deepEqual(transactionFlow(rows), { inflow: 1500, outflow: 13 });
  assert.deepEqual(spendingByCategory(rows), [{ category: 'Food & drink', amount: 13 }]);
});
