// Author: Jiajun (Carson) Chen
// email: jic4015@med.cornell.edu
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {annualChanges, changeChart, oddsRatioChart} from '../comparisons.js';

const annual = (year, rate) => ({
  year,
  quarter: null,
  period: String(year),
  telehealthPct: rate,
});
const attributes = (tag) =>
  Object.fromEntries(
    [...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map((match) => [
      match[1],
      match[2],
    ]),
  );
const tags = (html, className) =>
  [...html.matchAll(new RegExp(`<[^>]+class="${className}"[^>]*>`, 'g'))].map(
    (match) => attributes(match[0]),
  );
const nearly = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test('annual changes use published annual percentages, preserve missing records and never substitute quarters', () => {
  const data = {
    states: [
      {
        name: 'A',
        abbr: 'AA',
        annual: [annual(2020, 30), annual(2024, 20)],
        quarterly: [{year: 2024, quarter: 1, telehealthPct: 99}],
      },
      {name: 'B', abbr: 'BB', annual: [annual(2020, 0), annual(2024, 3.2)]},
      {
        name: 'C',
        abbr: 'CC',
        annual: [annual(2020, 12)],
        quarterly: [{year: 2024, quarter: 1, telehealthPct: 40}],
      },
      {
        name: 'D',
        abbr: 'DD',
        annual: [
          annual(2020, 25),
          {year: 2024, quarter: 1, period: '2024 Q1', telehealthPct: 28},
        ],
      },
    ],
  };
  const before = JSON.stringify(data);
  const rows = annualChanges(data, '2020', '2024');
  assert.equal(rows.length, 4);
  assert.equal(rows[0].change, -10);
  nearly(rows[1].change, 3.2);
  assert.equal(rows[1].fromRate, 0);
  assert.equal(rows[2].toRate, null);
  assert.equal(rows[2].change, null);
  assert.equal(rows[3].change, null);
  assert.deepEqual([rows[0].fromYear, rows[0].toYear], [2020, 2024]);
  assert.equal(JSON.stringify(data), before);
});
test('annual comparison rejects ambiguous years and invalid rates without making a numerical estimate', () => {
  for (const years of [
    [2024, 2020],
    [2024, 2024],
    ['2024 Q1', 2025],
    [null, 2025],
    [2020.5, 2025],
  ]) {
    assert.throws(() => annualChanges({states: []}, ...years), RangeError);
  }
  const data = {
    states: [
      {
        name: 'A',
        abbr: 'A',
        annual: [annual(2020, 10), annual(2024, 20), annual(2024, 21)],
      },
      {name: 'B', abbr: 'B', annual: [annual(2020, null), annual(2024, 101)]},
    ],
  };
  assert.deepEqual(
    annualChanges(data, 2020, 2024).map((row) => row.change),
    [null, null],
  );
});
test('shipped CMS annual comparisons reconcile every state and cannot use new quarterly-only periods', async () => {
  const data = JSON.parse(
    await readFile(new URL('../data/cms.json', import.meta.url), 'utf8'),
  );
  const changes = annualChanges(data, 2020, 2025);
  assert.equal(changes.length, 51);
  changes.forEach((row, index) => {
    const source = data.states[index];
    nearly(
      row.change,
      source.annual.find((v) => v.year === 2025).telehealthPct -
        source.annual.find((v) => v.year === 2020).telehealthPct,
    );
  });
  assert.ok(
    annualChanges(data, 2025, 2026).every(
      (row) => row.toRate === null && row.change === null,
    ),
  );
});
test('change chart bars share a true zero and encode direction, zero and missing values correctly', () => {
  const rows = [
    {
      name: 'Increase',
      abbr: 'UP',
      fromYear: 2020,
      toYear: 2024,
      fromRate: 0,
      toRate: 10,
      change: 10,
    },
    {
      name: 'Decrease',
      abbr: 'DN',
      fromYear: 2020,
      toYear: 2024,
      fromRate: 10,
      toRate: 5,
      change: -5,
    },
    {name: 'Same', abbr: 'EQ', fromRate: 3, toRate: 3, change: 0},
    {name: 'Missing', abbr: 'NA', fromRate: null, toRate: 10, change: null},
  ];
  const html = changeChart(rows, {selected: 'UP'});
  const zero = Number(tags(html, 'change-zero')[0].x1);
  const bars = tags(html, 'change-bar');
  assert.equal(bars.length, 2);
  nearly(Number(bars[0].x), zero);
  nearly(Number(bars[1].x) + Number(bars[1].width), zero);
  nearly(Number(bars[0].width), Number(bars[1].width) * 2);
  assert.equal(tags(html, 'change-zero-point').length, 1);
  assert.equal(tags(html, 'change-selection').length, 1);
  assert.equal([...html.matchAll(/role="button"/g)].length, 4);
  assert.match(html, /data-state="UP"/);
  assert.match(html, />0\.00%<\/text>/);
  assert.ok(!/NaN|Infinity/.test(html));
});
test('odds ratios use log geometry, include intervals fully, and center the equal-odds reference', () => {
  const rows = [
    {label: 'Lower', odds_ratio: 0.5, ci_low: 0.25, ci_high: 1},
    {label: 'Higher', odds_ratio: 2, ci_low: 1, ci_high: 4},
  ];
  const html = oddsRatioChart(rows, {referenceLabel: 'Any private coverage'});
  const points = tags(html, 'odds-point');
  const intervals = tags(html, 'odds-interval');
  const reference = Number(tags(html, 'odds-reference')[0].x1);
  nearly(reference - Number(points[0].cx), Number(points[1].cx) - reference);
  for (let i = 0; i < 2; i++) {
    assert.ok(
      Number(intervals[i].x1) <= Number(points[i].cx) &&
        Number(points[i].cx) <= Number(intervals[i].x2),
    );
    assert.ok(Number(intervals[i].x1) >= 425 && Number(intervals[i].x2) <= 900);
  }
  assert.match(html, /log scale/);
  assert.match(html, /Reference: Any private coverage/);
});
test('odds plots avoid invalid confidence intervals and escape source labels', () => {
  const rows = [
    {label: 'Valid <script>', odds_ratio: 1, ci_low: 0.8, ci_high: 1.2},
    {label: 'Zero', odds_ratio: 0, ci_low: 0, ci_high: 1},
    {label: 'Reversed', odds_ratio: 2, ci_low: 3, ci_high: 1},
    {label: 'Infinite', odds_ratio: 2, ci_low: 1, ci_high: Infinity},
    {label: 'Outside', odds_ratio: 5, ci_low: 1, ci_high: 3},
  ];
  const html = oddsRatioChart(rows, {title: '<img>', referenceLabel: 'A & B'});
  assert.equal(tags(html, 'odds-point').length, 1);
  assert.equal(tags(html, 'odds-interval').length, 1);
  assert.match(html, /Valid &lt;script&gt;/);
  assert.match(html, /A &amp; B/);
  assert.ok(!html.includes('<img>'));
  assert.equal([...html.matchAll(/Not estimated/g)].length, 4);
  assert.ok(!/="(?:NaN|Infinity|-Infinity)"/.test(html));
  assert.match(oddsRatioChart(rows.slice(1)), /unavailable/);
});
test('wide positive intervals still produce finite, contained logarithmic geometry', () => {
  const html = oddsRatioChart([
    {
      label: 'Wide',
      odds_ratio: 1,
      ci_low: Number.MIN_VALUE,
      ci_high: Number.MAX_VALUE,
    },
  ]);
  const interval = tags(html, 'odds-interval')[0];
  assert.ok(Number(interval.x1) >= 425 && Number(interval.x2) <= 900);
  assert.ok(!/NaN|Infinity/.test(html));
});

test('near-null odds ratios retain precision and a meaningful log-axis range', () => {
  const html = oddsRatioChart([
    {
      label: 'Age, per additional year',
      odds_ratio: 0.9969247463,
      ci_low: 0.9949578321,
      ci_high: 0.9988955488,
    },
  ]);
  assert.match(html, /0\.9969 \(0\.9950–0\.9989\)/);
  const interval = tags(html, 'odds-interval')[0];
  assert.ok(Number(interval.x2) - Number(interval.x1) > 100);
  const tickLabels = [
    ...html.matchAll(
      /class="chart-tick" x="[^"]+" y="[^"]+" text-anchor="middle">([^<]+)<\/text>/g,
    ),
  ].map((match) => match[1]);
  assert.equal(new Set(tickLabels).size, 5);
  assert.ok(
    tickLabels.some((value) => Number(value) < 1) &&
      tickLabels.some((value) => Number(value) > 1),
  );
});
