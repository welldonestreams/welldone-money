import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The desktop bundle is served by the app:// handler, not by an HTTP server,
// so this asserts the real responses it returns: the headers a browser will
// actually receive, and that nothing outside the bundle can be read through it.
const require = createRequire(import.meta.url);
const { ORIGIN, CSP, createHandler } = require('../electron/app-protocol.cjs');

const root = fileURLToPath(new URL('..', import.meta.url));
const handle = createHandler(root);
const get = path => handle({ url: `${ORIGIN}${path}` });

test('the bundle root serves index.html', async () => {
  const res = await get('/');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.match(await res.text(), /<title>/i);
});

test('every response carries the same strict CSP as nginx.conf', async () => {
  for (const path of ['/', '/index.html', '/src/app.js', '/does-not-exist']) {
    const res = await get(path);
    const csp = res.headers.get('content-security-policy') || '';
    assert.equal(csp, CSP, `${path} must carry the shared policy`);
    assert.match(csp, /style-src 'self'/);
    assert.doesNotMatch(csp, /unsafe-inline/);
    assert.match(csp, /object-src 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  }
});

test('an adapter call with no local answer 404s instead of throwing', async () => {
  // The frontend fetches /api/finance/* from the hosted adapter. Inside the
  // bundle there is nothing to serve, and the caller's "bridge unreachable"
  // path only runs if this returns cleanly.
  const res = await get('/api/finance/accounts');
  assert.equal(res.status, 404);
});

test('a directory is not served', async () => {
  assert.equal((await get('/src')).status, 404);
});

test('percent-encoded traversal cannot escape the bundle', async () => {
  // new URL() collapses a literal ../, so the encoded form is the one that
  // reaches decodeURIComponent still able to walk upwards.
  const outside = mkdtempSync(join(tmpdir(), 'wdm-'));
  mkdirSync(join(outside, 'bundle'));
  mkdirSync(join(outside, 'bundle-old'));
  writeFileSync(join(outside, 'bundle-old', 'secret.txt'), 'private');
  writeFileSync(join(outside, 'sibling.txt'), 'private');
  const scoped = createHandler(join(outside, 'bundle'));

  const up = await scoped({ url: `${ORIGIN}/%2e%2e%2fsibling.txt` });
  assert.equal(up.status, 404, 'must not read above the bundle root');

  // A sibling directory sharing the root's name prefix must not pass a plain
  // startsWith containment check.
  const sibling = await scoped({ url: `${ORIGIN}/%2e%2e%2fbundle-old%2fsecret.txt` });
  assert.equal(sibling.status, 404, 'a name-prefixed sibling is still outside');
});
