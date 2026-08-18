import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const app = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');

test('every primary navigation target has a matching view', () => {
  const views = new Set([...html.matchAll(/id="view-([a-z-]+)"/g)].map(match => match[1]));
  const targets = [...html.matchAll(/data-view="([a-z-]+)"/g)].map(match => match[1]);
  for (const target of targets) assert.ok(views.has(target), `missing view for ${target}`);
});

test('Renewals is a first-class navigation destination and Debt is not in the sidebar', () => {
  assert.match(html, /data-view="renewals"/);
  assert.match(html, /id="view-renewals"/);
  assert.doesNotMatch(html, /data-view="debt"/);
  assert.doesNotMatch(html, /id="view-debt"/);
  assert.doesNotMatch(app, /renderDebt/);
  assert.doesNotMatch(html, /class="nav-child"/);
});

test('dashboard jumps only target real views', () => {
  const views = new Set([...html.matchAll(/id="view-([a-z-]+)"/g)].map(match => match[1]));
  const jumps = [...html.matchAll(/data-jump="([a-z-]+)"/g)].map(match => match[1]);
  for (const target of jumps) assert.ok(views.has(target), `broken jump target ${target}`);
});

test('accounts and settings expose the authenticated Plaid linking controls and separate counts', () => {
  assert.match(html, /class="primary link-plaid"/);
  assert.match(html, /id="plaid-item-coverage"/);
  assert.match(html, /id="plaid-account-coverage"/);
  assert.match(app, /\/api\/plaid\/connect\/start/);
});

test('cash-flow detail lives with Transactions and account tiles accept statement drops', () => {
  assert.doesNotMatch(html, /data-view="cashflow"/);
  assert.doesNotMatch(html, /id="view-cashflow"/);
  assert.match(html, /id="transaction-flow-chart"/);
  assert.match(app, /data-account-drop/);
  assert.match(app, /account-file-input/);
});

test('card connections are a first-class view', () => {
  assert.match(html, /id="card-profile-links"/);
});
