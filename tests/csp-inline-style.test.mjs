import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Regression guard for a whole-dashboard rendering failure.
//
// The app is served with `style-src 'self'` and no 'unsafe-inline', so the
// browser drops a style="" attribute out of injected markup before layout
// runs. Four charts flattened at once and each failure looked like its own
// bug: the six-month flow bars collapsed to zero height, every "spending by
// category" track filled its whole rail so all categories looked equal, the
// investment axis stacked every date label at the plot's left edge, and the
// plotted dots fell back to their static position.
//
// Nothing in the browser reports this, so the invariant is pinned here: the
// CSP stays strict, no source emits a style attribute, and the CSSOM path that
// replaces it keeps existing. CSP does not gate CSSOM writes.

const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

const app = read('src/app.js');
const renewals = read('src/renewals.js');
const html = read('index.html');

test('every served CSP keeps style-src strict', () => {
  for (const name of ['nginx.conf', '_headers', 'scripts/adapter.mjs', 'scripts/serve.mjs']) {
    const source = read(name);
    assert.match(source, /style-src 'self'/, `${name} should declare style-src 'self'`);
    assert.doesNotMatch(source, /style-src[^;"\n]*'unsafe-inline'/, `${name} must not relax style-src to fix a layout bug`);
  }
});

test('no source emits a style attribute the CSP would strip', () => {
  for (const [name, source] of [['src/app.js', app], ['src/renewals.js', renewals], ['index.html', html]]) {
    assert.doesNotMatch(source, /style=["']/, `${name} must express dynamic sizes as data-css, not an inline style attribute`);
  }
});

test('applyDataCss writes the declarations through CSSOM', () => {
  assert.match(app, /function applyDataCss/);
  assert.match(app, /querySelectorAll\('\[data-css\]'\)/);
  assert.match(app, /node\.style\.setProperty/);
});

test('each chart that sizes itself at runtime uses data-css', () => {
  assert.match(app, /class="bar bar--in" data-css="height:/, 'flow chart bars');
  assert.match(app, /class="category-track"><span data-css="width:/, 'spending category bars');
  assert.match(app, /class="investment-dot" data-css="left:/, 'investment plot dots');
  assert.match(app, /<span data-css="left:\$\{[A-Za-z]+\[index\]\.x\}%">/, 'investment axis labels');
});

test('the views that re-render on their own re-apply data-css', () => {
  // renderTransactions and renderInvestments are called outside render() by the
  // search box and the range buttons, so each needs its own apply pass.
  assert.match(app, /applyDataCss\(\$\('#view-transactions'\)\)/);
  assert.match(app, /applyDataCss\(\$\('#view-investments'\)\)/);
});
