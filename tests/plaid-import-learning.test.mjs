import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPlaidMerchantModel,
  enrichStatementTransaction,
  friendlyPlaidCategory,
  normalizePlaidTransactions,
  plaidCoverageByAccount,
  reconcileImportedTransactions,
} from '../scripts/plaid-import-learning.mjs';

test('formats Plaid personal-finance categories for people', () => {
  assert.equal(friendlyPlaidCategory('FOOD_AND_DRINK'), 'Food & drink');
  assert.equal(friendlyPlaidCategory('TRANSFER_OUT'), 'Transfer');
  assert.equal(friendlyPlaidCategory('custom_value'), 'Custom Value');
});

test('learns canonical merchants and categories from Plaid history', () => {
  const accountByName = new Map([['Checking', 'acct-1']]);
  const plaid = normalizePlaidTransactions([
    { account: 'Checking', date: '2026-08-01', amount: -12.5, merchant: 'Coffee Shop', pfc_primary: 'FOOD_AND_DRINK', pfc_detailed: 'FOOD_AND_DRINK_COFFEE' },
    { account: 'Checking', date: '2026-07-01', amount: -9.5, merchant: 'Coffee Shop', pfc_primary: 'FOOD_AND_DRINK', pfc_detailed: 'FOOD_AND_DRINK_COFFEE' },
  ], accountByName);
  assert.deepEqual(plaid.map(item => item.amount), [12.5, 9.5]);
  const model = buildPlaidMerchantModel(plaid);
  const learned = enrichStatementTransaction({ payee: 'COFFEE SHOP #12345', category: '', date: '2025-01-01', amount: -7 }, 'acct-1', model);
  assert.equal(learned.payee, 'Coffee Shop');
  assert.equal(learned.category, 'Food & drink');
  assert.equal(learned.categorySource, 'plaid_merchant');
  assert.equal(learned.statementPayee, 'COFFEE SHOP #12345');
  assert.equal(learned.plaidReferenceCount, 2);
});

test('uses Plaid coverage as the seamless boundary and keeps older history', () => {
  const plaid = [
    { accountId: 'acct-1', date: '2026-05-12', amount: -10, payee: 'Market', merchantKey: 'market', category: 'Shopping', categoryDetail: '' },
    { accountId: 'acct-1', date: '2026-08-12', amount: -12, payee: 'Market', merchantKey: 'market', category: 'Shopping', categoryDetail: '' },
  ];
  const coverage = plaidCoverageByAccount(plaid);
  assert.deepEqual(coverage.get('acct-1'), { start: '2026-05-12', end: '2026-08-12', count: 2 });
  const result = reconcileImportedTransactions([
    { id: 'old', accountId: 'acct-1', date: '2026-05-11', payee: 'MARKET 4444', category: '', amount: -5 },
    { id: 'boundary', accountId: 'acct-1', date: '2026-05-12', payee: 'Different text', category: '', amount: -10 },
    { id: 'recent', accountId: 'acct-1', date: '2026-06-01', payee: 'Another row', category: '', amount: -3 },
    { id: 'statement-only', accountId: 'statement-acct-1', date: '2026-08-01', payee: 'MARKET', category: '', amount: -8 },
  ], plaid);
  assert.deepEqual(result.superseded.map(item => item.id), ['boundary', 'recent']);
  assert.deepEqual(result.transactions.map(item => item.id), ['old', 'statement-only']);
  assert.equal(result.transactions[0].category, 'Shopping');
  assert.equal(result.transactions[1].category, 'Shopping');
});
