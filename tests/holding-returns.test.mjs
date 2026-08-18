import test from 'node:test';
import assert from 'node:assert/strict';
import { holdingReturn } from '../src/finance-model.js';

test('a range return is preferred and reported without a scope label', () => {
  const result = holdingReturn({ returnByRange: { YTD: 13.4 }, costBasis: 100, value: 200 }, 'YTD');
  assert.equal(result.rate, 13.4);
  assert.equal(result.scope, '');
});

test('a Plaid fund with only a basis still reports its total return', () => {
  // Plaid supplies cost_basis and value but no dated performance, which is why
  // every holding row previously read "Not available" for every range.
  const result = holdingReturn({ costBasis: 10548.11, value: 13316.37 }, 'YTD');
  assert.equal(Number(result.rate.toFixed(2)), 26.24);
  assert.equal(result.scope, 'since contributions');
});

test('a loss is reported as a negative return', () => {
  const result = holdingReturn({ costBasis: 1000, value: 750 }, '1M');
  assert.equal(result.rate, -25);
});

test('a fund with no basis reports nothing rather than a fabricated return', () => {
  assert.equal(holdingReturn({ value: 500 }, 'YTD'), null);
  assert.equal(holdingReturn({ costBasis: 0, value: 500 }, 'YTD'), null);
  assert.equal(holdingReturn({ costBasis: 'n/a', value: 500 }, 'YTD'), null);
});
