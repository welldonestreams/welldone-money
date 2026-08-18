import test from 'node:test';
import assert from 'node:assert/strict';
import { SCHEMA_VERSION } from '../src/demo.js';
import { clearState, loadState, migrateState } from '../src/storage.js';

test('migrates older state without discarding financial data', () => {
  const old = {
    schemaVersion: 1,
    accounts: [{ id: 'account-1', name: 'Demo checking' }],
    benefits: [{ id: 'benefit-1' }],
    transactions: [{ id: 'transaction-1', amount: -5 }],
    imports: [{ filename: 'demo.qfx' }],
    settings: { privacyMode: true },
  };
  const migrated = migrateState(old);
  assert.equal(migrated.schemaVersion, SCHEMA_VERSION);
  assert.equal(migrated.accounts.length, 1);
  assert.equal(migrated.benefits.length, 1);
  assert.equal(migrated.transactions.length, 1);
  assert.equal(migrated.imports.length, 1);
  assert.equal(migrated.settings.privacyMode, true);
});

test('stashes raw state before writing a migrated copy', () => {
  const values = new Map([
    ['finance-hub-state', JSON.stringify({ schemaVersion: 1, accounts: [{ id: 'account-1' }], transactions: [{ id: 'transaction-1' }] })],
  ]);
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  const state = loadState(storage);
  assert.equal(state.accounts.length, 1);
  assert.equal(state.transactions.length, 1);
  assert.equal(JSON.parse(values.get('finance-hub-state')).schemaVersion, SCHEMA_VERSION);
  assert.equal([...values.keys()].some(key => key.startsWith('finance-hub-state.bak.v1.')), true);
});

test('clear removes active state and migration stashes', () => {
  const values = new Map([
    ['finance-hub-state', '{}'],
    ['finance-hub-state.bak.v1.100', '{}'],
    ['unrelated', 'keep'],
  ]);
  const storage = {
    get length() { return values.size; },
    key: index => [...values.keys()][index] ?? null,
    removeItem: key => values.delete(key),
  };
  clearState(storage);
  assert.equal(values.has('finance-hub-state'), false);
  assert.equal(values.has('finance-hub-state.bak.v1.100'), false);
  assert.equal(values.get('unrelated'), 'keep');
});
