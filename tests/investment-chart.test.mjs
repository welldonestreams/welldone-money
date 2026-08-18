import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { axisLabelIndexes, axisLabelSlots, chartGeometry, seriesForRange, seriesGeometry } from '../src/investment-chart.js';

test('two accounts share one time and value scale so the lines are comparable', () => {
  const { series } = seriesGeometry([
    { label: 'A', points: [{ date: '2026-01-01', value: 0 }, { date: '2026-07-01', value: 100 }] },
    { label: 'B', points: [{ date: '2026-04-01', value: 50 }] },
  ]);
  // B's single point sits mid-domain on both axes, not at an edge of its own.
  assert.equal(series[0].points[0].x, 3);
  assert.equal(series[0].points.at(-1).x, 97);
  const b = series[1].points[0];
  assert.ok(b.x > 40 && b.x < 60, `expected B mid-chart, got x=${b.x}`);
  assert.ok(b.y > series[0].points.at(-1).y && b.y < series[0].points[0].y, 'B should sit between A endpoints');
});

test('a series with one point is kept so its dot still renders', () => {
  const { series } = seriesGeometry([
    { label: 'A', points: [{ date: '2026-01-01', value: 10 }, { date: '2026-02-01', value: 20 }] },
    { label: 'B', points: [{ date: '2026-01-15', value: 15 }] },
  ]);
  assert.equal(series.length, 2);
  assert.equal(series[1].points.length, 1);
});

test('axis dates are the union of all series, positioned on the shared scale', () => {
  const { dates } = seriesGeometry([
    { label: 'A', points: [{ date: '2026-01-01', value: 1 }, { date: '2026-03-01', value: 2 }] },
    { label: 'B', points: [{ date: '2026-02-01', value: 3 }, { date: '2026-03-01', value: 4 }] },
  ]);
  assert.deepEqual(dates.map(d => d.date), ['2026-01-01', '2026-02-01', '2026-03-01']);
  assert.equal(dates[0].x, 3);
  assert.equal(dates.at(-1).x, 97);
  assert.ok(dates[1].x > dates[0].x && dates[1].x < dates[2].x);
});

test('empty and unparseable series do not produce a chart', () => {
  assert.deepEqual(seriesGeometry([]).series, []);
  assert.deepEqual(seriesGeometry([{ label: 'A', points: [{ date: 'nope', value: 1 }] }]).series, []);
});

const app = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
const styles = await readFile(new URL('../styles.css', import.meta.url), 'utf8');

test('horizontal spacing follows elapsed time, not array position', () => {
  // Three points where the second sits one day after the first and the third
  // a further 100 days out. Index-based spacing drew these evenly.
  const { points } = chartGeometry([
    { date: '2026-01-01', value: 100 },
    { date: '2026-01-02', value: 110 },
    { date: '2026-04-12', value: 120 },
  ]);
  const firstGap = points[1].x - points[0].x;
  const secondGap = points[2].x - points[1].x;
  assert.ok(secondGap > firstGap * 50, `expected a far wider second gap, got ${firstGap} then ${secondGap}`);
});

test('the series spans the full plot width regardless of point count', () => {
  for (const count of [2, 5, 40]) {
    const rows = Array.from({ length: count }, (_, index) => ({ date: `2026-01-${String(index + 1).padStart(2, '0')}`, value: index }));
    const { points } = chartGeometry(rows);
    assert.equal(points[0].x, 3);
    assert.equal(points.at(-1).x, 97);
  }
});

test('a flat balance is centred rather than pinned to the floor', () => {
  const { points } = chartGeometry([
    { date: '2026-01-01', value: 5000 },
    { date: '2026-02-01', value: 5000 },
  ]);
  assert.ok(points.every(point => point.y > 40 && point.y < 60), 'flat series should sit mid-plot');
});

test('points sharing one date fall back to even spacing instead of stacking', () => {
  const { points } = chartGeometry([
    { date: '2026-01-01', value: 10 },
    { date: '2026-01-01', value: 20 },
    { date: '2026-01-01', value: 30 },
  ]);
  assert.equal(new Set(points.map(point => point.x)).size, 3);
});

test('range filtering keeps points on or after the cutoff and sorts them', () => {
  const history = [
    { date: '2026-08-01', value: 3 },
    { date: '2024-01-01', value: 1 },
    { date: '2026-07-01', value: 2 },
  ];
  const ytd = seriesForRange(history, 'YTD', new Date('2026-08-15T12:00:00'));
  assert.deepEqual(ytd.map(point => point.date), ['2026-07-01', '2026-08-01']);
  const threeYear = seriesForRange(history, '3Y', new Date('2026-08-15T12:00:00'));
  assert.equal(threeYear.length, 3);
});

test('unparseable dates are dropped rather than plotted at epoch zero', () => {
  const series = seriesForRange([{ date: 'not-a-date', value: 5 }, { date: '2026-08-01', value: 6 }], '3Y', new Date('2026-08-15T12:00:00'));
  assert.deepEqual(series.map(point => point.date), ['2026-08-01']);
});

test('interleaved series dates never produce overlapping labels', () => {
  // Two accounts whose statements land a day or two apart. Index-based
  // thinning could pick both members of a pair, printing them on top of
  // each other.
  const a = Array.from({ length: 14 }, (_, i) => ({ date: `2026-${String(i + 1).padStart(2, '0')}-01`.replace(/-(\d\d)-/, (m, mm) => `-${String(Math.min(12, +mm)).padStart(2, '0')}-`), value: i }));
  const b = a.map(p => ({ date: p.date.replace(/-01$/, '-03'), value: p.value + 1 }));
  const { dates } = seriesGeometry([{ label: 'A', points: a }, { label: 'B', points: b }]);
  const slots = axisLabelSlots(dates);
  const xs = slots.map(i => dates[i].x);
  for (let i = 1; i < xs.length; i += 1) {
    assert.ok(xs[i] - xs[i - 1] >= 11, `labels ${xs[i - 1]} and ${xs[i]} are too close`);
  }
  assert.equal(slots.at(-1), dates.length - 1, 'the final date must always be labelled');
});

test('a tightly clustered axis collapses to just the endpoints', () => {
  // Every date inside a few days: nothing between the ends can be labelled.
  const dates = Array.from({ length: 8 }, (_, i) => ({ date: `2026-07-${String(i + 1).padStart(2, '0')}`, x: 3 + i * 0.6 }));
  // No room for a second label; the anchor is kept and the crowded end dropped.
  assert.deepEqual(axisLabelSlots(dates), [0]);
});

test('a well-spread axis still gets its full set of labels', () => {
  const dates = Array.from({ length: 6 }, (_, i) => ({ date: `2026-0${i + 1}-01`, x: 3 + i * 18.8 }));
  assert.deepEqual(axisLabelSlots(dates), [0, 1, 2, 3, 4, 5]);
});

test('axis labels thin out but always keep both endpoints', () => {
  assert.deepEqual(axisLabelIndexes(4), [0, 1, 2, 3]);
  const thinned = axisLabelIndexes(40);
  assert.ok(thinned.length <= 6, `expected at most 6 labels, got ${thinned.length}`);
  assert.equal(thinned[0], 0);
  assert.equal(thinned.at(-1), 39);
});

test('the plot declares a non-uniform aspect so it fills the panel width', () => {
  // Without preserveAspectRatio="none" a 100x100 viewBox in a 210px-tall box
  // renders 210px wide and centred, leaving dots and axis labels on different
  // horizontal scales.
  assert.match(app, /viewBox="0 0 100 100" preserveAspectRatio="none"/);
  assert.match(app, /vector-effect="non-scaling-stroke"/);
  assert.match(styles, /\.investment-plot\{position:relative/);
});

test('axis labels are anchored to plotted coordinates, not spread by flexbox', () => {
  assert.match(app, /investment-axis">\$\{axis\}/);
  // The label's left offset must come from a computed x, whatever the source
  // array is called; the old bug was flexbox positioning with no x at all.
  // The offset must come from a computed x. Don't couple to the helper's name;
  // the original bug was flexbox positioning with no x involved at all.
  assert.match(app, /`<span data-css="left:\$\{[A-Za-z]+\[index\]\.x\}%">/);
  assert.doesNotMatch(styles, /\.investment-axis\{display:flex/);
});

test('each plotted point gets its own dot element', () => {
  assert.match(app, /class="investment-dot" data-css="left:\$\{point\.x\}%;top:\$\{point\.y\}%/);
  assert.match(styles, /\.investment-dot\{position:absolute/);
  // Tick-mark paths inside a non-uniformly scaled SVG were the previous
  // approach; dots must be HTML so they stay circular.
  assert.doesNotMatch(app, /d="M\$\{x\} \$\{y\} l0 3\.2"/);
});

test('the chart states which accounts it covers and excludes', () => {
  assert.match(app, /function investmentCoverage/);
  assert.match(app, /no dated history, so/);
  assert.match(app, /Portfolio total is/);
});
