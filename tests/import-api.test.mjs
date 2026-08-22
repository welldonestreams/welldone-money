import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stableAccountId } from '../src/import-intelligence.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function freePort() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('authenticated import API deduplicates exact Plaid matches without dropping gaps inside its date range', async t => {
  const root = await mkdtemp(join(tmpdir(), 'wmd-import-api-'));
  const dataDir = join(root, 'data');
  const staticDir = join(root, 'www');
  await mkdir(dataDir);
  await mkdir(staticDir);
  await writeFile(join(staticDir, 'index.html'), '<h1>test</h1>');
  const bridgeAccount = { account: 'Checking', institution: 'Example CU', last4: '1234', type: 'depository', subtype: 'checking' };
  const destination = stableAccountId(bridgeAccount);
  const bridge = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/admin/connect/start?mode=banking&days_requested=730' && req.method === 'POST') {
      assert.equal(req.headers['x-admin-token'], 'test-admin-token');
      return res.end(JSON.stringify({ session_id: 'a'.repeat(32), link_url: 'https://secure.plaid.com/link/test' }));
    }
    if (req.url === `/admin/connect/status/${'a'.repeat(32)}`) {
      assert.equal(req.headers['x-admin-token'], 'test-admin-token');
      return res.end(JSON.stringify({ status: 'completed', item_id: 'private-provider-id' }));
    }
    if (req.url === '/v1/finance/accounts') return res.end(JSON.stringify({ accounts: [bridgeAccount] }));
    if (req.url.startsWith('/v1/finance/transactions?')) {
      const query = new URL(req.url, 'http://bridge.test').searchParams;
      if (query.get('account') === 'Checking' && query.get('offset') === '0') return res.end(JSON.stringify({ transactions: [{ account: 'Checking', date: '2026-07-20', amount: 12.34, merchant: 'Coffee Shop', pfc_primary: 'FOOD_AND_DRINK', pfc_detailed: 'FOOD_AND_DRINK_COFFEE' }] }));
    }
    res.statusCode = 404; res.end('{}');
  });
  const bridgePort = await freePort();
  await new Promise(resolve => bridge.listen(bridgePort, '127.0.0.1', resolve));
  const port = await freePort();
  const adapter = spawn(process.execPath, ['scripts/adapter.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), PIN: '7391', STATIC_ROOT: staticDir, DATA_DIR: dataDir, BRIDGE_BASE: `http://127.0.0.1:${bridgePort}`, BRIDGE_READ_TOKEN: 'test-token', BRIDGE_ADMIN_TOKEN: 'test-admin-token' },
    stdio: 'ignore',
  });
  t.after(async () => {
    adapter.kill();
    bridge.close();
    await rm(root, { recursive: true, force: true });
  });
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { const response = await fetch(`http://127.0.0.1:${port}/login`); if (response.ok) { ready = true; break; } } catch {}
    await delay(25);
  }
  assert.equal(ready, true);
  const login = await fetch(`http://127.0.0.1:${port}/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'p=7391' });
  assert.equal(login.status, 302);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const unauthLink = await fetch(`http://127.0.0.1:${port}/api/plaid/connect/start`, { method: 'POST' });
  assert.equal(unauthLink.status, 401);
  const link = await fetch(`http://127.0.0.1:${port}/api/plaid/connect/start`, { method: 'POST', headers: { cookie } });
  assert.equal(link.status, 200);
  assert.deepEqual(await link.json(), { sessionId: 'a'.repeat(32), linkUrl: 'https://secure.plaid.com/link/test' });
  const status = await fetch(`http://127.0.0.1:${port}/api/plaid/connect/status/${'a'.repeat(32)}`, { headers: { cookie } });
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), { status: 'completed' });
  const payload = {
    fileHash: 'a'.repeat(64), filename: 'statement.qfx', format: 'OFX', institution: 'Example CU', last4: '1234',
    signature: 'ofx|1234|example cu', accountId: destination, rejected: 0, confidence: 99,
    transactions: [
      { id: 'overlap', date: '2026-07-20', amount: -12.34, payee: 'COFFEE SHOP' },
      { id: 'plaid-gap', date: '2026-07-21', amount: -20.00, payee: 'Missing from Plaid' },
      { id: 'older-coffee', date: '2026-06-02', amount: -8.75, payee: 'COFFEE SHOP #9999' },
      { id: 'older', date: '2026-06-01', amount: -45.67, payee: 'Old Grocery' },
    ],
  };
  const send = () => fetch(`http://127.0.0.1:${port}/api/imports/commit`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  const first = await send();
  assert.equal(first.status, 200);
  const firstResult = await first.json();
  assert.equal(firstResult.accepted, 3);
  assert.equal(firstResult.duplicates, 1);
  assert.equal(firstResult.plaidCovered, 0);
  const storeResponse = await fetch(`http://127.0.0.1:${port}/api/imports`, { headers: { cookie } });
  const store = await storeResponse.json();
  assert.equal(store.batches.length, 1);
  assert.equal(store.batches[0].accepted, 3);
  assert.equal(store.batches[0].duplicates, 1);
  assert.equal(store.batches[0].plaidCovered, 0);
  assert.equal(store.transactions.length, 3);
  assert.equal(store.transactions.find(item => item.sourceId === 'older-coffee').category, 'Food & drink');
  assert.equal(store.transactions.find(item => item.sourceId === 'older-coffee').payee, 'Coffee Shop');
  assert.equal(store.mappings[payload.signature].accountId, destination);
  const second = await send();
  const replay = await second.json();
  assert.equal(replay.alreadyImported, true);
  const createAccount = () => fetch(`http://127.0.0.1:${port}/api/imports/accounts`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ institution: 'Example Card Bank', name: 'Legacy Rewards', last4: '7788', kind: 'credit' }) });
  const created = await (await createAccount()).json();
  assert.equal(created.created, true);
  assert.match(created.account.id, /^statement-acct-/);
  const repeated = await (await createAccount()).json();
  assert.equal(repeated.created, false);
  const disk = JSON.parse(await readFile(join(dataDir, 'imports.json'), 'utf8'));
  assert.equal(disk.batches.length, 1);
  assert.equal(disk.transactions.length, 3);
  assert.equal(disk.accounts.length, 1);
  await writeFile(join(dataDir, 'imports.json'), '{broken');
  const corruptRead = await fetch(`http://127.0.0.1:${port}/api/imports`, { headers: { cookie } });
  assert.equal(corruptRead.status, 503);
  const corruptWrite = await send();
  assert.equal(corruptWrite.status, 503);
  assert.equal(await readFile(join(dataDir, 'imports.json'), 'utf8'), '{broken');
});
