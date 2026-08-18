import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Number(null) is 0 and passes Number.isFinite, so a "did we actually read
// this?" guard written against an absent key is defeated by a stored null: a
// field the source failed on renders as a confident 0.00 rather than an em
// dash. These guards are asserted against the app source so they cannot be
// quietly removed while fixing a layout bug.

const app = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');

test('only locally owned accounts offer a Remove button', () => {
  // Server-rebuilt rows reappear on the next refresh, so offering to delete
  // them promises something the client cannot deliver. One shared predicate
  // gates the button and the refresh filter so the two cannot drift apart.
  assert.match(app, /const SERVER_OWNED_PREFIXES = \['bridge-acct-', 'statement-acct-', 'private-investment-'\]/);
  assert.match(app, /isServerOwned\(account\.id\) \? '' :/, 'the Remove button must be gated on isServerOwned');
  assert.match(app, /filter\(item => !isServerOwned\(item\.id\)\)/, 'refreshBridge must use the same predicate');
  // The old hand-rolled triple check must be gone, or the two can diverge.
  assert.doesNotMatch(app, /startsWith\('statement-acct-'\) && !String\(item\.id \|\| ''\)\.startsWith\('private-investment-'\)/);
});
