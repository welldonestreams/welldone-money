import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { createLocalApi } = require('../electron/local-api.cjs');
const { ORIGIN } = require('../electron/app-protocol.cjs');

function makeApi() {
  const dir = mkdtempSync(join(tmpdir(), 'wmd-local-api-'));
  const api = createLocalApi(dir);
  const call = async (path, { method = 'GET', body } = {}) => {
    const init = { method, headers: {} };
    if (body !== undefined) init.body = JSON.stringify(body);
    const request = new Request(`${ORIGIN}${path}`, init);
    return api(request, path);
  };
  return { api, call, dir };
}

test('the desktop local API serves card profiles durably', async () => {
  const { call, dir } = makeApi();
  const empty = await call('/api/card-profiles');
  assert.equal(empty.status, 200);
  assert.deepEqual(await empty.json(), []);

  const put = await call('/api/card-profiles', {
    method: 'PUT',
    body: [{ owner: 'Chance', profile: 'chase-sapphire-preferred', accountId: 'acct-1' }, { junk: true }],
  });
  assert.equal(put.status, 200);
  assert.deepEqual(await put.json(), { ok: true, count: 1 });

  const again = await call('/api/card-profiles');
  assert.deepEqual(await again.json(), [{ owner: 'Chance', profile: 'chase-sapphire-preferred', accountId: 'acct-1' }]);
  assert.ok(existsSync(join(dir, 'card-profiles.json')));
});

test('imports store commits batches, dedupes by signature and bumps revision', async () => {
  const { call } = makeApi();
  const base = await call('/api/imports');
  assert.equal((await base.json()).revision, 0);

  const commit = await call('/api/imports/commit', {
    method: 'POST',
    body: {
      fileHash: 'abc', filename: 'nov.csv', format: 'csv', institution: 'Test Bank', last4: '1234',
      signature: 'sig-1', accountId: 'acct-1', rejected: 2, confidence: 0.9,
      transactions: [
        { signature: 't1', date: '2026-08-01', amount: -10, payee: 'Cafe' },
        { signature: 't2', date: '2026-08-02', amount: -20, payee: 'Shop' },
      ],
    },
  });
  assert.equal(commit.status, 200);
  const after = await (await call('/api/imports')).json();
  assert.equal(after.revision, 1);
  assert.equal(after.transactions.length, 2);
  assert.equal(after.batches.length, 1);

  // same signature again -> deduped
  await call('/api/imports/commit', {
    method: 'POST',
    body: { signature: 'sig-1', transactions: [{ signature: 't1', amount: -10 }] },
  });
  const after2 = await (await call('/api/imports')).json();
  assert.equal(after2.transactions.length, 2, 'duplicate signature must not be stored twice');
  assert.equal(after2.revision, 2);
});

test('imports/accounts appends a statement account and rejects blank names', async () => {
  const { call } = makeApi();
  const ok = await call('/api/imports/accounts', { method: 'POST', body: { name: 'Platinum Card', institution: 'Test', last4: '0001' } });
  assert.equal(ok.status, 201);
  assert.equal((await ok.json()).name, 'Platinum Card');
  const bad = await call('/api/imports/accounts', { method: 'POST', body: { name: '' } });
  assert.equal(bad.status, 400);
});

test('renewals use the shared revision store (create, patch with rev, delete)', async () => {
  const { call } = makeApi();
  const created = await call('/api/renewals', { method: 'POST', body: { name: 'Netflix', price: 15.5, cycle: 'monthly' } });
  assert.equal(created.status, 201);
  const item = await created.json();
  assert.ok(item.id);
  assert.equal(item.rev, 1);

  const list = await (await call('/api/renewals')).json();
  assert.equal(list.length, 1);

  const patched = await call(`/api/renewals/${item.id}`, { method: 'PATCH', body: { rev: 1, price: 18 } });
  assert.equal(patched.status, 200);
  assert.equal((await patched.json()).rev, 2);

  const stale = await call(`/api/renewals/${item.id}`, { method: 'PATCH', body: { rev: 1, price: 99 } });
  assert.equal(stale.status, 409, 'a stale revision must conflict, never overwrite');

  const removed = await call(`/api/renewals/${item.id}`, { method: 'DELETE', body: { rev: 2 } });
  assert.equal(removed.status, 200);
  assert.equal((await (await call('/api/renewals')).json()).length, 0);
});

test('bridge data and Plaid routes are cleanly unavailable in the desktop build', async () => {
  const { call } = makeApi();
  assert.equal((await call('/api/finance/accounts')).status, 404);
  assert.equal((await call('/api/finance/transactions')).status, 404);
  const plaid = await call('/api/plaid/connect/start', { method: 'POST' });
  assert.equal(plaid.status, 503);
  assert.equal((await call('/api/plaid/connect/status/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).status, 404);
  assert.equal((await call('/api/unknown')).status, 404);
});

test('every /api response carries the same security headers', async () => {
  const { call } = makeApi();
  for (const path of ['/api/card-profiles', '/api/imports', '/api/finance/accounts', '/api/nope']) {
    const res = await call(path);
    assert.match(res.headers.get('content-security-policy') || '', /object-src 'none'/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
  }
});

test('a damaged imports.json is preserved before an empty store is returned', async () => {
  const { call, dir } = makeApi();
  const file = join(dir, 'imports.json');
  writeFileSync(file, '{ this is not json', 'utf8');
  const res = await call('/api/imports');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).revision, 0);
  const leftovers = readdirSync(dir).filter(name => name.startsWith('imports.json.corrupt-'));
  assert.equal(leftovers.length, 1, 'the damaged file must be moved aside, not overwritten');
  assert.match(readFileSync(join(dir, leftovers[0]), 'utf8'), /not json/);
});
