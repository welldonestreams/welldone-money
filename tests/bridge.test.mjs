import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPrivateIncomeRules, loadBridgeData, mapBridgeData } from '../src/bridge.js';

test('maps recurring bridge direction to the field consumed by the dashboard', () => {
  const mapped = mapBridgeData({
    accounts: { accounts: [{ account: 'Checking', type: 'depository', subtype: 'checking' }] },
    recurring: { recurring: [
      { account: 'Checking', description: 'Payroll', flow: 'in', amount: 1000 },
      { account: 'Checking', description: 'Rent', flow: 'out', amount: 500 },
    ] },
    summary: {},
  });
  assert.deepEqual(mapped.recurring.map(item => item.kind), ['inflow', 'outflow']);
});

test('private income rules only promote positive matching deposits', () => {
  const rows = applyPrivateIncomeRules([
    { amount: 1500, rawName: 'ZELLE OWNER PAY', category: 'Transfer' },
    { amount: -50, rawName: 'ZELLE OWNER PAY', category: 'Transfer' },
  ], [{ contains: 'zelle owner' }]);
  assert.equal(rows[0].isIncome, true);
  assert.equal(rows[0].category, 'Income');
  assert.equal(rows[1].isIncome, undefined);
});

test('maps Plaid Item and financial-account counts separately', () => {
  const mapped = mapBridgeData({
    accounts: { accounts: [{ account: 'Checking', type: 'depository', subtype: 'checking' }] },
    status: { items_tracked: 3, accounts_connected: 6 },
    summary: {},
  });
  assert.equal(mapped.sync.itemsTracked, 3);
  assert.equal(mapped.sync.accountsConnected, 6);
});

test('converts Plaid signs and categories to the dashboard ledger convention', () => {
  const mapped = mapBridgeData({
    accounts: { accounts: [{ account: 'Card', type: 'credit', subtype: 'credit card' }] },
    transactions: { transactions: [
      { account: 'Card', date: '2026-08-15', merchant: 'Cafe', amount: 25, pfc_primary: 'FOOD_AND_DRINK' },
      { account: 'Card', date: '2026-08-14', name: 'Refund', amount: -5, pfc_primary: 'GENERAL_MERCHANDISE' },
    ] },
    summary: {},
  });
  assert.deepEqual(mapped.transactions.map(item => item.amount), [-25, 5]);
  assert.deepEqual(mapped.transactions.map(item => item.category), ['Food & drink', 'Shopping']);
});

test('preserves raw issuer descriptors and classifies payments and perk credits', () => {
  const mapped = mapBridgeData({
    accounts: { accounts: [{ account: 'Platinum', type: 'credit', subtype: 'credit card' }] },
    transactions: { transactions: [
      { account: 'Platinum', date: '2026-08-15', merchant: 'Walmart', name: 'Platinum Walmart+ Credit', amount: -14.03, pfc_primary: 'GENERAL_MERCHANDISE' },
      { account: 'Platinum', date: '2026-08-14', name: 'Mobile Payment', amount: -100, pfc_primary: 'LOAN_PAYMENTS' },
    ] },
    summary: {},
  });
  assert.equal(mapped.transactions[0].payee, 'Walmart');
  assert.equal(mapped.transactions[0].rawName, 'Platinum Walmart+ Credit');
  assert.equal(mapped.transactions[0].isStatementCredit, true);
  assert.equal(mapped.transactions[1].isPayment, true);
});

test('duplicate account names never misroute transactions to the wrong account', () => {
  const mapped = mapBridgeData({
    accounts: { accounts: [
      { account: 'Platinum Card', institution: 'Bank A', type: 'credit', subtype: 'credit card', balance: 100 },
      { account: 'Platinum Card', institution: 'Bank B', type: 'credit', subtype: 'credit card', balance: 200 },
    ] },
    transactions: { transactions: [
      { account: 'Platinum Card', date: '2026-08-15', merchant: 'Cafe', amount: 25 },
      { account: 'Platinum Card', date: '2026-08-14', merchant: 'Shop', amount: 50 },
    ] },
    summary: {},
  });
  // The ambiguous alias must not collapse into a single account id: every
  // transaction keeps its display name and links to NO accountId rather than
  // silently attaching to the last "Platinum Card".
  assert.equal(mapped.accounts.length, 2);
  assert.ok(mapped.accounts.every(account => account.id), 'accounts keep stable ids');
  assert.ok(mapped.transactions.every(tx => tx.accountId === ''), 'ambiguous alias must not be guessed');
  assert.ok(mapped.transactions.every(tx => tx.accountName === 'Platinum Card'), 'display label is preserved');
});

test('missing balances stay null instead of being fabricated as zero', () => {
  const mapped = mapBridgeData({
    accounts: { accounts: [{ account: 'Checking', type: 'depository', subtype: 'checking' }] },
    holdings: { holdings: [{ account: 'Checking', ticker: 'VTI' }] },
    liabilities: { liabilities: [{ account: 'Checking', type: 'loan' }] },
    summary: {},
  });
  assert.equal(mapped.accounts[0].currentBalance, null);
  assert.equal(mapped.holdings[0].value, null);
  assert.equal(mapped.holdings[0].quantity, null);
  assert.equal(mapped.liabilities[0].balance, null);
});

test('a failed transactions fetch yields null, never an empty list', async () => {
  // The partial-outage guard: refreshBridge must be able to tell "no data"
  // apart from "genuinely no transactions", or a bridge hiccup would erase
  // the dashboard's real history with an empty result.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/api/finance/transactions')) return { ok: false, status: 502 };
    return { ok: true, json: async () => ({ accounts: [] }) };
  };
  try {
    const d = await loadBridgeData();
    assert.equal(d.transactions, null, 'failed transactions fetch must be null');
    assert.notEqual(d.accounts, null, 'other sections still load');
  } finally {
    globalThis.fetch = realFetch;
  }
});
