import test from 'node:test';
import assert from 'node:assert/strict';
import { matchStatement, semanticTransactionMatch, stableAccountId, statementSignature } from '../src/import-intelligence.js';

const accounts = [
  { id: 'checking', name: 'Checking', institution: 'Example Credit Union', last4: '4422', kind: 'checking' },
  { id: 'savings', name: 'Share Savings', institution: 'Example Credit Union', last4: '4422', kind: 'savings' },
  { id: 'rewards', name: 'Rewards Card', institution: 'Example Card Bank', last4: '77123', kind: 'credit' },
];
const transaction = (accountId, date, amount, payee) => ({ accountId, date, amount, payee });

test('stable account ids do not depend on array order', () => {
  const account = { account: 'Checking', institution: 'Example CU', last4: '1234', type: 'depository', subtype: 'checking' };
  assert.equal(stableAccountId(account), stableAccountId({ ...account }));
});

test('unique suffix is accepted automatically', () => {
  const statement = { filename: 'card.csv', format: 'CARD_CSV', institution: 'Example Card Bank', last4: '77123', transactions: [] };
  const result = matchStatement(statement, accounts, []);
  assert.equal(result.status, 'auto');
  assert.equal(result.accountId, 'rewards');
});

test('ambiguous suffix requires confirmation instead of choosing the first account', () => {
  const statement = { filename: 'export.ofx', format: 'OFX', institution: 'Example Credit Union', last4: '4422', transactions: [] };
  const result = matchStatement(statement, accounts, []);
  assert.equal(result.status, 'confirm');
  assert.equal(result.accountId, '');
});

test('Plaid overlap resolves an otherwise ambiguous suffix', () => {
  const statement = { filename: 'export.ofx', format: 'OFX', institution: 'Example Credit Union', last4: '4422', transactions: [
    transaction('', '2026-07-20', -12.34, 'Coffee Shop'),
    transaction('', '2026-07-21', -45.67, 'Neighborhood Market'),
    transaction('', '2026-07-22', 1000, 'Payroll Deposit'),
  ] };
  const plaid = statement.transactions.map(item => ({ ...item, accountId: 'checking' }));
  const result = matchStatement(statement, accounts, plaid);
  assert.equal(result.status, 'auto');
  assert.equal(result.accountId, 'checking');
});

test('OFX account type resolves a suffix shared by checking, savings, and credit', () => {
  const statement = { filename: 'export.ofx', format: 'OFX', institution: 'Example Credit Union', last4: '4422', accountKind: 'checking', transactions: [] };
  const result = matchStatement(statement, accounts, []);
  assert.equal(result.status, 'auto');
  assert.equal(result.accountId, 'checking');
});

test('a card payment overlap does not misclassify a credit statement as checking', () => {
  const statement = { filename: 'capital-one.qfx', format: 'OFX', institution: 'Issuer', last4: '9911', accountKind: 'credit', transactions: [transaction('', '2026-07-20', 100, 'Payment')] };
  const plaid = [transaction('checking', '2026-07-20', 100, 'Payment')];
  const result = matchStatement(statement, accounts, plaid);
  assert.equal(result.status, 'manual');
  assert.notEqual(result.suggestedAccountId, 'checking');
});

test('remembered confirmation wins on the next statement', () => {
  const statement = { filename: 'export.ofx', format: 'OFX', institution: 'Example Credit Union', last4: '4422', transactions: [] };
  const result = matchStatement(statement, accounts, [], { [statementSignature(statement)]: { accountId: 'savings' } });
  assert.equal(result.status, 'auto');
  assert.equal(result.accountId, 'savings');
});

test('semantic duplicate requires same date amount and similar merchant', () => {
  assert.equal(semanticTransactionMatch(transaction('', '2026-07-20', -12.34, 'COFFEE SHOP #123'), transaction('', '2026-07-20', -12.34, 'Coffee Shop')), true);
  assert.equal(semanticTransactionMatch(transaction('', '2026-07-20', -12.34, 'Coffee Shop'), transaction('', '2026-07-21', -12.34, 'Coffee Shop')), false);
});
