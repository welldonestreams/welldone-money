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

test('opaque account keys disambiguate duplicate display names', () => {
  const mapped = mapBridgeData({
    accounts: { accounts: [
      { account_key: 'one', account: 'Rewards', type: 'credit' },
      { account_key: 'two', account: 'Rewards', type: 'credit' },
    ] },
    transactions: { transactions: [
      { account_key: 'one', account: 'Rewards', transaction_key: 't1', date: '2026-08-15', amount: 4 },
      { account: 'Rewards', transaction_key: 'ambiguous', date: '2026-08-14', amount: 5 },
    ] },
    summary: {},
  });
  assert.equal(mapped.transactions[0].accountId, mapped.accounts[0].id);
  assert.equal(mapped.transactions[1].accountId, '');
});

test('missing financial values stay null and partial sync is visible', () => {
  const mapped = mapBridgeData({
    accounts: { accounts: [{ account_key: 'one', account: 'Checking', balance: null }] },
    transactions: { transactions: [{ account_key: 'one', transaction_key: 't1', amount: null }] },
    holdings: { holdings: [{ account_key: 'one', value: null, quantity: null, price: null }] },
    summary: { last_successful_sync: '2026-08-22T12:00:00Z', accounts_with_errors: 1 },
  });
  assert.equal(mapped.accounts[0].currentBalance, null);
  assert.equal(mapped.transactions[0].amount, null);
  assert.equal(mapped.holdings[0].value, null);
  assert.equal(mapped.sync.status, 'partial');
});

test('transaction loading paginates and records a failed account without inventing an empty success', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async value => {
    const url = String(value);
    if (url.endsWith('/accounts')) return new Response(JSON.stringify({ accounts: [{ account_key: 'ok', account: 'Same' }, { account_key: 'bad', account: 'Same' }] }));
    if (url.includes('/transactions?') && url.includes('account_key=ok')) return new Response(JSON.stringify({ transactions: [] }));
    if (url.includes('/transactions?') && url.includes('account_key=bad')) return new Response('{}', { status: 502 });
    return new Response('{}');
  };
  try {
    const loaded = await loadBridgeData();
    assert.deepEqual(loaded._successfulTransactionAccounts, ['ok']);
    assert.deepEqual(loaded._transactionFailures, ['bad']);
  } finally { globalThis.fetch = originalFetch; }
});
