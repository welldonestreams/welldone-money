import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import http from 'node:http';

// Regression guard for the DESKTOP serving path: serve.mjs must carry the
// same strict CSP as nginx.conf. The csp-inline-style test greps source
// files; this one actually starts the server and asserts the served headers
// and the /__health nonce the Electron shell relies on.

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, 'scripts', 'serve.mjs')], {
      env: { ...process.env, PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: root,
    });
    let port = null;
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => {
      const m = c.match(/PORT=(\d+)/);
      if (m && !port) {
        port = Number(m[1]);
        resolve({ child, port });
      }
    });
    child.stderr.on('data', (c) => { err += c; });
    child.on('exit', (code) => {
      if (!port) reject(new Error(`server exited ${code}: ${err}`));
    });
  });
}

function get(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    }).on('error', reject);
  });
}

test('serve.mjs serves the strict CSP and identifies itself', async () => {
  const { child, port } = await startServer();
  try {
    const health = await get(port, '/__health');
    assert.equal(health.status, 200);
    assert.equal(health.body.trim(), 'welldone-money-ok');

    const csp = health.headers['content-security-policy'] || '';
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /style-src 'self'/);
    assert.doesNotMatch(csp, /unsafe-inline/);
    assert.match(csp, /object-src 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);

    assert.equal(health.headers['x-content-type-options'], 'nosniff');
    assert.equal(health.headers['x-frame-options'], 'DENY');
    assert.equal(health.headers['referrer-policy'], 'no-referrer');

    const index = await get(port, '/');
    assert.equal(index.status, 200);
    assert.match(index.headers['content-security-policy'] || '', /style-src 'self'/);
  } finally {
    child.kill();
  }
});
