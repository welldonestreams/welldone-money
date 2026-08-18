// Geometry helpers for the Investments history chart.
//
// This lives outside app.js so the scale maths can be unit tested. The chart
// previously placed points by array index, which drew a one-day gap and a
// six-month gap at the same width, and drew its axis labels with a separate
// flexbox pass that had no relationship to the plotted coordinates.
//
// Everything here returns percentages of the plot box so the SVG line and the
// HTML dots and labels layered over it can share one coordinate space.

const PAD_X = 3;
const PAD_TOP = 8;
const PAD_BOTTOM = 8;
const MAX_AXIS_LABELS = 6;
// Minimum horizontal distance between two axis labels, as a percentage of the
// plot width. Roughly the width of a "Jan 31" label on a narrow panel.
const MIN_LABEL_GAP = 11;

export const PLOT_BASELINE = 100;

function round(value) {
  return Math.round(value * 100) / 100;
}

export function parseChartDate(value) {
  const date = new Date(`${String(value || '').slice(0, 10)}T12:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function rangeCutoff(range, asOf) {
  const cutoff = new Date(asOf);
  if (range === '1W') cutoff.setDate(cutoff.getDate() - 7);
  else if (range === '1M') cutoff.setMonth(cutoff.getMonth() - 1);
  else if (range === 'YTD') cutoff.setMonth(0, 1);
  else cutoff.setFullYear(cutoff.getFullYear() - 3);
  return cutoff;
}

export function seriesForRange(history, range, asOf) {
  const cutoff = rangeCutoff(range, asOf);
  return (Array.isArray(history) ? history : [])
    .filter(point => {
      const date = parseChartDate(point?.date);
      return date !== null && date >= cutoff;
    })
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

// Maps each point to an {x, y} percentage. x tracks elapsed time between the
// first and last point, so irregular statement dates render at their real
// spacing.
export function chartGeometry(points) {
  const rows = Array.isArray(points) ? points : [];
  if (!rows.length) return { points: [], minValue: 0, maxValue: 0 };

  const values = rows.map(point => {
    const number = Number(point?.value);
    return Number.isFinite(number) ? number : 0;
  });
  const times = rows.map(point => parseChartDate(point?.date)?.getTime() ?? 0);
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const valueSpan = maxValue - minValue;
  const timeSpan = times.at(-1) - times[0];
  const width = 100 - PAD_X * 2;
  const height = 100 - PAD_TOP - PAD_BOTTOM;

  const plotted = rows.map((point, index) => {
    // Every point sharing one date leaves no span to divide by; fall back to
    // even spacing rather than stacking them all on the left edge.
    const xFraction = timeSpan > 0
      ? (times[index] - times[0]) / timeSpan
      : (rows.length === 1 ? 0.5 : index / (rows.length - 1));
    // A flat balance has no vertical span. Centre it instead of pinning the
    // whole series to the floor of the plot.
    const yFraction = valueSpan > 0 ? (values[index] - minValue) / valueSpan : 0.5;
    return {
      date: point?.date,
      value: values[index],
      x: round(PAD_X + xFraction * width),
      y: round(PLOT_BASELINE - PAD_BOTTOM - yFraction * height),
    };
  });

  return { points: plotted, minValue, maxValue };
}

// Plots several accounts on one shared domain, so two lines drawn on the same
// chart are directly comparable. Each series keeps its own points; the time and
// value scales are computed across all of them together.
//
// Series with a single point still get a dot, because one statement is real
// information even though it cannot be drawn as a line.
export function seriesGeometry(seriesList) {
  const lists = (Array.isArray(seriesList) ? seriesList : [])
    .map(entry => ({
      label: entry?.label || '',
      points: (Array.isArray(entry?.points) ? entry.points : [])
        .filter(point => parseChartDate(point?.date) !== null)
        .sort((a, b) => String(a.date).localeCompare(String(b.date))),
    }))
    .filter(entry => entry.points.length > 0);
  if (!lists.length) return { series: [], minValue: 0, maxValue: 0, dates: [] };

  const allValues = lists.flatMap(entry => entry.points.map(point => {
    const number = Number(point?.value);
    return Number.isFinite(number) ? number : 0;
  }));
  const allTimes = lists.flatMap(entry => entry.points.map(point => parseChartDate(point.date).getTime()));
  const minValue = Math.min(...allValues);
  const maxValue = Math.max(...allValues);
  const minTime = Math.min(...allTimes);
  const maxTime = Math.max(...allTimes);
  const valueSpan = maxValue - minValue;
  const timeSpan = maxTime - minTime;
  const width = 100 - PAD_X * 2;
  const height = 100 - PAD_TOP - PAD_BOTTOM;

  const series = lists.map(entry => ({
    label: entry.label,
    points: entry.points.map((point, index) => {
      const time = parseChartDate(point.date).getTime();
      const value = Number.isFinite(Number(point.value)) ? Number(point.value) : 0;
      const xFraction = timeSpan > 0
        ? (time - minTime) / timeSpan
        : (entry.points.length === 1 ? 0.5 : index / (entry.points.length - 1));
      const yFraction = valueSpan > 0 ? (value - minValue) / valueSpan : 0.5;
      return {
        date: point.date,
        value,
        x: round(PAD_X + xFraction * width),
        y: round(PLOT_BASELINE - PAD_BOTTOM - yFraction * height),
      };
    }),
  }));

  // One axis for the whole chart: the union of every series' dates, each placed
  // on the same time scale as the lines, so a label always sits under the
  // moment it names.
  const dates = [...new Set(lists.flatMap(entry => entry.points.map(point => point.date)))]
    .sort()
    .map((date, index, all) => {
      const time = parseChartDate(date).getTime();
      const xFraction = timeSpan > 0
        ? (time - minTime) / timeSpan
        : (all.length === 1 ? 0.5 : index / (all.length - 1));
      return { date, x: round(PAD_X + xFraction * width) };
    });
  return { series, minValue, maxValue, dates };
}

// Thins axis labels so a long series does not overprint itself. The first and
// last points are always kept so the range endpoints stay readable.
export function axisLabelIndexes(count, max = MAX_AXIS_LABELS) {
  if (!Number.isFinite(count) || count <= 0) return [];
  if (count <= max) return Array.from({ length: count }, (_, index) => index);
  const step = (count - 1) / (max - 1);
  const picked = new Set([0, count - 1]);
  for (let index = 0; index < max; index += 1) picked.add(Math.round(index * step));
  return [...picked].sort((a, b) => a - b);
}

// Picking every Nth date by index says nothing about where those dates land.
// Two series whose statement dates sit a day or two apart produce neighbouring
// entries at almost the same x, and the labels overprint. Thin by actual
// horizontal distance instead, keeping both endpoints.
export function axisLabelSlots(dates, minGap = MIN_LABEL_GAP, max = MAX_AXIS_LABELS) {
  const rows = Array.isArray(dates) ? dates : [];
  if (rows.length <= 1) return rows.map((_, index) => index);

  const last = rows.length - 1;
  const candidates = axisLabelIndexes(rows.length, max);
  // The first label anchors the axis and is always kept.
  const kept = [0];
  for (const index of candidates) {
    if (index === 0 || index === last) continue;
    if (rows[index].x - rows[kept[kept.length - 1]].x >= minGap) kept.push(index);
  }
  // Drop anything the final label would sit on top of, but never the anchor.
  while (kept.length > 1 && rows[last].x - rows[kept[kept.length - 1]].x < minGap) kept.pop();
  // When every date falls inside one label's width there is no room for a
  // second. The range selector above the chart already names the window, so
  // showing one anchor beats printing two labels over each other.
  if (rows[last].x - rows[kept[kept.length - 1]].x >= minGap) kept.push(last);
  return kept;
}
