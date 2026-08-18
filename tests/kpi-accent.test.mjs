import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const app = read('src/app.js');
const styles = read('styles.css');

// A KPI tile's accent is applied as `kpi--<accent>`, and the stylesheet sets
// --accent only for the names it defines. An undefined name fails silently and
// in the worst possible direction: `.kpi::before` falls back to
// `var(--accent, var(--green))` and paints the tile GREEN, while `.kpi>small`
// resolves `var(--accent)` to nothing and inherits muted grey.
//
// That is invisible in review and invisible in the browser until the branch
// fires. The Leave balance tile shipped with 'amber', which does not exist, so
// the "days at risk" warning would have rendered as the safe state on the one
// day it mattered. An earlier version of the same view used 'green' and
// 'amber' for the same reason. Three occurrences is enough to pin it.

const definedAccents = new Set([...styles.matchAll(/\.kpi--([a-z]+)\s*\{/g)].map(match => match[1]));

// Scoped to the arrays that are actually rendered by kpiCard. Scanning the
// whole file instead picks up any lowercase string before a bracket, such as
// ['savings', ..., 'other'] or the ['dragenter', 'dragover'] listener list.
function kpiBlocks() {
  return [...app.matchAll(/=\s*\[(.*?)\]\s*\.map\(kpiCard\)/gs)].map(match => match[1]);
}

function usedAccents() {
  const used = new Set();
  for (const block of kpiBlocks()) {
    // The accent is the last element of each tuple: `..., 'gold'],`. The
    // negative lookahead skips arrays that are being called rather than
    // closing a tuple, such as ['checking', 'savings'].includes(...) inside a
    // tile's own detail string.
    for (const match of block.matchAll(/,\s*'([a-z]+)'\s*\](?!\s*\.)/g)) used.add(match[1]);
    // ...or the branches of a ternary in that position.
    for (const match of block.matchAll(/\?\s*'([a-z]+)'\s*:\s*'([a-z]+)'\s*\](?!\s*\.)/g)) {
      used.add(match[1]);
      used.add(match[2]);
    }
  }
  return used;
}

test('the stylesheet defines the accents it is expected to', () => {
  for (const accent of ['mint', 'gold', 'blue', 'violet', 'red']) {
    assert.ok(definedAccents.has(accent), `styles.css should define .kpi--${accent}`);
  }
});

test('every KPI accent used in app.js resolves to a real class', () => {
  const used = usedAccents();
  assert.ok(kpiBlocks().length >= 4, 'expected to find the kpiCard-rendered arrays');
  assert.ok(used.size > 0, 'expected to find KPI accents in app.js');
  const undefinedAccents = [...used].filter(accent => !definedAccents.has(accent));
  assert.deepEqual(
    undefinedAccents,
    [],
    `these accents have no .kpi--<name> rule, so the tile silently renders green: ${undefinedAccents.join(', ')}`,
  );
});
