// Author: Jiajun (Carson) Chen
// email: jic4015@med.cornell.edu
/**
 * @fileoverview Dashboard state, accessible interactions, and aggregate-data rendering.
 * Verified CMS/ACS, NHIS, and MEPS data remain separate analytical populations.
 * Only descriptive CMS views may read liveCms; all models use verified data.
 */
import {
  escapeHtml as esc,
  number,
  percent,
  dollars,
  compact,
  ci,
  csv,
  colorFor,
  lineChart,
  scatterChart,
  dotChart,
} from './charts.js';
import {fetchCmsUpdates} from './cms-live.js';
import {annualChanges, changeChart, oddsRatioChart} from './comparisons.js';
const $ = (id) => document.getElementById(id);
// UI selections are separate from source data; changing a filter never rewrites a dataset.
const state = {
  view: 'states',
  period: '2024',
  selected: 'US',
  display: 'map',
  nhisGroup: 'insurance',
  insurance: 'All',
  payment: 'total',
  changeFrom: 2020,
  changeTo: 2025,
  changeScope: 'largest',
  modelGroup: 'Insurance',
};
let cms;
let nhis;
let meps;
let liveCms = null;
let cmsRefreshPending = false;
// Only descriptive CMS views can use session data. Models explicitly read the verified snapshot.
const activeCms = () => liveCms?.data || cms;
const positions = {
  AK: [1, 1],
  ME: [12, 1],
  VT: [11, 2],
  NH: [12, 2],
  WA: [2, 3],
  ID: [3, 3],
  MT: [4, 3],
  ND: [5, 3],
  MN: [6, 3],
  IL: [7, 3],
  WI: [8, 3],
  MI: [9, 3],
  NY: [10, 3],
  MA: [11, 3],
  RI: [12, 3],
  OR: [2, 4],
  NV: [3, 4],
  WY: [4, 4],
  SD: [5, 4],
  IA: [6, 4],
  IN: [7, 4],
  OH: [8, 4],
  PA: [9, 4],
  NJ: [10, 4],
  CT: [11, 4],
  CA: [2, 5],
  UT: [3, 5],
  CO: [4, 5],
  NE: [5, 5],
  MO: [6, 5],
  KY: [7, 5],
  WV: [8, 5],
  VA: [9, 5],
  MD: [10, 5],
  DE: [11, 5],
  AZ: [3, 6],
  NM: [4, 6],
  KS: [5, 6],
  AR: [6, 6],
  TN: [7, 6],
  NC: [8, 6],
  SC: [9, 6],
  DC: [10, 6],
  OK: [5, 7],
  LA: [6, 7],
  MS: [7, 7],
  AL: [8, 7],
  GA: [9, 7],
  HI: [2, 8],
  TX: [5, 8],
  FL: [10, 8],
};
const heroes = {
  states: [
    '01 / Geography & connectivity',
    'Telehealth, across states',
    'Compare state telehealth rates, trends, broadband access, and income.',
  ],
  people: [
    '02 / Population & access',
    'Who uses telehealth?',
    'Compare telehealth use across adult population groups.',
  ],
  visits: [
    '03 / Modality & payments',
    'Visits, coverage & payments',
    'Compare visit types and payments across insurance groups.',
  ],
  quality: [
    '04 / Data & methods',
    'Data & methods',
    'Understand the populations, measures, exclusions, and uncertainty behind every view in this dashboard.',
  ],
};
/**
 * Builds a summary card from trusted or already escaped HTML fragments.
 * @param {string} label Measure and population label.
 * @param {string} value Formatted estimate or missing-value label.
 * @param {string} sub Denominator or source context.
 * @return {string} Card markup. Callers escape any source-supplied text.
 */
function metric(label, value, sub) {
  return `<div class="metric"><div class="metric-label">${label}</div><div class="metric-value">${value}</div><div class="metric-sub">${sub}</div></div>`;
}
/**
 * Builds a table while preserving caller-provided markup such as flags.
 * @param {!Array<string>} headers Trusted or escaped column labels.
 * @param {!Array<!Array<string>>} rows Trusted or escaped cell fragments.
 * @param {{numeric: !Array<number>, selectedRow: number}=} options
 *     Zero-based numeric columns and selected row; -1 selects no row.
 * @return {string} Table markup with header semantics and numeric alignment.
 */
function table(headers, rows, {numeric = [], selectedRow = -1} = {}) {
  const cellClass = (i) => (numeric.includes(i) ? ' class="numeric"' : '');
  return `<table><thead><tr>${headers.map((h, i) => `<th scope="col"${cellClass(i)}>${h}</th>`).join('')}</tr></thead><tbody>${rows.map((r, rowIndex) => `<tr${rowIndex === selectedRow ? ' class="selected-row"' : ''}>${r.map((c, i) => `<td${cellClass(i)}>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}
/**
 * Chooses the higher-contrast text color from actual tile luminance.
 * @param {string} background Six-digit hex or rgb() color from colorFor.
 * @return {string} White or deep-ink CSS color; hue alone does not decide contrast.
 */
function tileTextColor(background) {
  const rgb = background.startsWith('#')
    ? [1, 3, 5].map((i) => parseInt(background.slice(i, i + 2), 16))
    : background.match(/\d+/g).map(Number);
  const luminance = (channels) =>
    channels
      .map((v) => v / 255)
      .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
      .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
  const light = luminance(rgb);
  const deepInk = luminance([3, 6, 7]);
  return 1.05 / (light + 0.05) >= (light + 0.05) / (deepInk + 0.05)
    ? '#ffffff'
    : '#030607';
}
/**
 * Reads the active annual or quarterly record without combining periods.
 * @param {!Object} s Geography with annual and quarterly arrays.
 * @return {(!Object|undefined)} Selected record, or undefined if unavailable.
 */
function currentSeries(s) {
  return [...s.annual, ...s.quarterly].find((r) => r.period === state.period);
}
/**
 * Resolves the selected geography from one consistent CMS data edition.
 * @return {!Object} National record with display identity, or selected state.
 */
function currentState() {
  const data = activeCms();
  return state.selected === 'US'
    ? {...data.national, name: 'United States', abbr: 'US'}
    : data.states.find((s) => s.abbr === state.selected);
}
/**
 * Synchronizes map, table, selector, and charts after a valid selection.
 * @param {string} abbr US or a state/DC abbreviation in the verified allowlist.
 */
function selectState(abbr) {
  if (abbr !== 'US' && !cms.states.some((s) => s.abbr === abbr)) {
    return;
  }
  state.selected = abbr;
  $('cms-state').value = abbr;
  renderCms();
}
// Render the map, table, counts, and time series from one consistent active CMS version.
/**
 * Renders descriptive CMS panels from the current session edition.
 * The period-specific map scale is recomputed after every selection. Associated
 * ACS and model panels deliberately read the verified 2024 snapshot separately.
 */
function renderCms() {
  const data = activeCms();
  const s = currentState();
  const r = currentSeries(s);
  const national = currentSeries(data.national);
  const rows = data.states.map((s) => ({...s, ...currentSeries(s)}));
  $('cms-metrics').innerHTML =
    metric(
      `${esc(s.name)} · telehealth use`,
      percent(r?.telehealthPct),
      `${esc(state.period)} · Medicare Part B fee-for-service`,
    ) +
    metric(
      'Telehealth users',
      compact(r?.telehealthUsers),
      `${number(r?.telehealthUsers)} beneficiaries`,
    ) +
    metric(
      'Eligible service users',
      compact(r?.eligibleUsers),
      'Denominator for the displayed rate',
    );
  const vals = rows.map((s) => s.telehealthPct).filter(Number.isFinite);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  $('map-min').textContent = percent(min);
  $('map-max').textContent = percent(max);
  $('state-map').innerHTML = rows
    .map((s) => {
      const pos = positions[s.abbr];
      const tileColor = colorFor(s.telehealthPct, min, max);
      return `<button class="state-tile ${s.abbr === state.selected ? 'selected' : ''}" style="--col:${pos[0]};--row:${pos[1]};--tile-color:${tileColor};--tile-text:${tileTextColor(tileColor)}" data-state="${s.abbr}" aria-label="${esc(s.name)}, ${percent(s.telehealthPct)} telehealth use" aria-pressed="${s.abbr === state.selected}"><span>${s.abbr}</span><small>${Number.isFinite(s.telehealthPct) ? number(s.telehealthPct, 1) : '—'}</small></button>`;
    })
    .join('');
  const a = s.acs2024;
  const diff = r?.telehealthPct - national?.telehealthPct;
  $('state-detail').innerHTML =
    `<div class="state-code">${state.selected === 'US' ? 'National benchmark' : s.abbr + ' / Selected state'}</div><h3 class="state-name">${esc(s.name)}</h3><div class="big-rate">${percent(r?.telehealthPct)}</div><div class="rate-label">telehealth use · ${esc(state.period)}</div><div class="difference">${state.selected === 'US' ? 'Published CMS national aggregate' : `${number(Math.abs(diff), 1)} pp ${diff >= 0 ? 'above' : 'below'} national`}</div><dl><dt>Telehealth users</dt><dd>${number(r?.telehealthUsers)}</dd><dt>Eligible service users</dt><dd>${number(r?.eligibleUsers)}</dd>${a ? `<dt>Broadband · 2024</dt><dd>${percent(a.broadbandPct)}</dd><dt>90% margin of error</dt><dd>±${number(a.broadbandMoe90, 2)} pp</dd><dt>Median income · 2024</dt><dd>${dollars(a.medianIncome)}</dd><dt>90% margin of error</dt><dd>±${dollars(a.incomeMoe90)}</dd>` : '<dt>State coverage</dt><dd>50 states + D.C.</dd>'}</dl>`;
  const rankedRows = rows.toSorted(
    (a, b) => (b.telehealthPct ?? -1) - (a.telehealthPct ?? -1),
  );
  $('cms-table-wrap').innerHTML = table(
    ['State', 'Telehealth use', 'Users', 'Eligible service users'],
    rankedRows.map((s) => [
      `<button data-state="${s.abbr}" aria-pressed="${s.abbr === state.selected}">${esc(s.name)}</button>`,
      percent(s.telehealthPct),
      number(s.telehealthUsers),
      number(s.eligibleUsers),
    ]),
    {
      numeric: [1, 2, 3],
      selectedRow: rankedRows.findIndex((s) => s.abbr === state.selected),
    },
  );
  $('cms-source').innerHTML =
    `Source: <a href="https://data.cms.gov/summary-statistics-on-use-and-payments/medicare-medicaid-service-type-reports/medicare-telehealth-trends" target="_blank" rel="noreferrer">CMS Medicare Telehealth Trends</a> · ${esc(state.period)} · ${rows.filter((s) => Number.isFinite(s.telehealthPct)).length}/51 state/DC rates available. Published national aggregate may include other geographies. Preliminary claims data; no sampling confidence intervals supplied. Map colors rescale within the selected period. ${liveCms ? `Live API data fetched ${esc(formatCheckedAt(liveCms.checkedAt))}; not revalidated.` : `Verified snapshot retrieved ${esc(cms.accessDate)}.`}`;
  const series = [
    {
      label: 'United States',
      color: 'var(--comparison)',
      values: data.national.quarterly.map((r) => ({
        period: r.period,
        value: r.telehealthPct,
      })),
    },
  ];
  if (state.selected !== 'US') {
    series.push({
      label: s.name,
      color: 'var(--series)',
      values: s.quarterly.map((r) => ({
        period: r.period,
        value: r.telehealthPct,
      })),
    });
  } else {
    series[0].color = 'var(--series)';
  }
  $('trend-legend').innerHTML = series
    .map(
      (s) =>
        `<span><i style="background:${s.color}"></i>${esc(s.label)}</span>`,
    )
    .join('');
  $('trend-chart').innerHTML = lineChart(series, {
    title: `Quarterly telehealth use in ${s.name}, ${data.national.quarterly[0].period}–${data.national.quarterly.at(-1).period}`,
  });
  renderScatter();
  renderCmsModel();
  renderAnnualChanges();
  renderEdition();
}
/**
 * Renders matched 2024 CMS–ACS values and verified correlations.
 * Reading cms here is intentional: mixing a revised live outcome with an older
 * ACS/model validation would imply an analytical update that has not occurred.
 */
function renderScatter() {
  const income = $('acs-measure').value === 'income';
  const points = cms.states.map((s) => ({
    name: s.name,
    abbr: s.abbr,
    x: income ? s.acs2024?.medianIncome : s.acs2024?.broadbandPct,
    y: s.annual.find((r) => r.year === 2024)?.telehealthPct,
  }));
  $('scatter-chart').innerHTML = scatterChart(points, {
    selected: state.selected,
    xKey: income ? 'income' : 'broadbandPct',
    xlabel: income
      ? 'Median household income (2024 dollars)'
      : 'Households with broadband (%)',
  });
  const r = income
    ? cms.associations.incomePearsonR
    : cms.associations.broadbandPearsonR;
  $('scatter-caption').innerHTML =
    `<strong>Verified 2024 snapshot · 50 states + D.C. · Pearson r = ${number(r, 2)}.</strong> Y-axis: annual CMS telehealth use. ACS broadband includes cellular subscriptions. State-level association does not establish individual access or causation. ACS sampling error is not shown in the plot.`;
}
const nhisDisplayNotes = {
  insurance:
    'Insurance is grouped as any private coverage, public or other coverage without private, or uninsured. Adults with both private and other coverage are included in the private group.',
  age: 'Age is measured at interview. The source groups ages 85 and older together.',
  education:
    'Groups reflect the highest reported level of educational attainment.',
  internet:
    'This measure describes Internet access, not the household broadband subscription measure used in the state comparison.',
  health: 'Groups reflect self-rated health at interview.',
};
// NHIS groups use their own valid-response denominators and survey-weighted intervals.
/**
 * Renders available-case adult estimates for the selected grouping.
 * Each grouping has its own denominator; changing a grouping does not refit the
 * complete-case association model or pool observations with other sources.
 */
function renderNhis() {
  const n = nhis.overall;
  const rows = nhis.groups[state.nhisGroup];
  $('nhis-metrics').innerHTML =
    metric(
      'Adults reporting telehealth use',
      percent(n.estimate),
      `95% confidence interval ${ci(n.ci_low, n.ci_high)}`,
    ) +
    metric(
      'Valid telehealth responses',
      number(n.n),
      `${number(nhis.quality.raw_n)} adults in the source file`,
    ) +
    metric(
      'Telehealth nonresponse',
      `${number(nhis.quality.missing_outcome_percent, 2)}%`,
      `${number(nhis.quality.missing_outcome_n)} refused, unknown, or not ascertained`,
    );
  $('nhis-chart').innerHTML = dotChart(rows, {
    compact: false,
    title: `Survey-weighted telehealth use by ${nhis.group_labels[state.nhisGroup]}`,
    max: 50,
  });
  $('nhis-table').innerHTML = table(
    [
      esc(nhis.group_labels[state.nhisGroup]),
      'Weighted use',
      '95% confidence interval',
      'Sample size',
    ],
    rows.map((r) => [
      esc(r.label),
      percent(r.estimate) +
        (r.unstable ? ' <span class="badge">Unstable</span>' : ''),
      ci(r.ci_low, r.ci_high),
      number(r.n),
    ]),
    {numeric: [1, 2, 3]},
  );
  const missing = nhis.quality.missingness.find(
    (m) => m.group === state.nhisGroup,
  );
  $('nhis-source').innerHTML =
    `Source: <a href="https://www.cdc.gov/nchs/nhis/documentation/2024-nhis.html" target="_blank" rel="noreferrer">2024 NHIS Sample Adult</a> · U.S. civilian noninstitutionalized adults ≥18 · Survey-weighted estimates with logit-based 95% confidence intervals. ${esc(nhisDisplayNotes[state.nhisGroup])} ${missing ? `${number(missing.among_valid_outcome_n)} valid-outcome records excluded for missing group information.` : ''} Sample counts are unweighted. Insurance is measured at interview; telehealth covers the prior 12 months.`;
  renderNhisModel();
}
/**
 * Labels instability without replacing an estimate with an invented value.
 * @param {!Object} metric Estimate carrying an unstable flag.
 * @return {string} Caution badge markup or empty text.
 */
function flag(metric) {
  return metric?.unstable
    ? ` <span class="badge" title="${esc((metric.flags || []).join('; '))}">Unstable</span>`
    : '';
}
// Apply the small-sample rule to numerator people, not the larger visit denominator.
/**
 * Applies the MEPS remote-numerator person-count display rule.
 *
 * The denominator's person count cannot establish support for a sparse remote
 * numerator. Return a copy so raw aggregates remain available for reproduction.
 *
 * @param {!Object} g Insurance domain containing telehealth_n_persons.
 * @return {!Object} Display estimate with null point/limits if fewer than 30 people.
 */
function displayTelehealth(g) {
  return g.telehealth_n_persons < 30
    ? {
        ...g.telehealth_pct,
        estimate: null,
        ci_low: null,
        ci_high: null,
        withheld: true,
      }
    : g.telehealth_pct;
}
/**
 * Applies modality-level withholding consistently to charts and CSVs.
 * @param {!Object} m Modality domain; its parent n_persons controls withholding.
 * @param {string} metric share_pct, total_payment, or family_payment.
 * @return {!Object} Estimate copy with null point/limits for a sparse modality.
 */
function displayMeps(m, metric) {
  const v = m[metric];
  return m.n_persons < 30
    ? {...v, estimate: null, ci_low: null, ci_high: null, withheld: true}
    : v;
}
/**
 * Renders visit shares and payment means for one insurance domain.
 * Payment domains include zero-payment visits. Counts remain visible when the
 * estimate is withheld; the aggregate JSON itself is never rewritten.
 */
function renderMeps() {
  const g =
    meps.groups.find((g) => g.insurance === state.insurance) || meps.overall;
  const total = state.payment === 'total';
  const key = total ? 'total_payment' : 'family_payment';
  const p = g[key];
  const tele = displayTelehealth(g);
  $('meps-metrics').innerHTML =
    metric(
      'Telehealth share of visits',
      tele.withheld ? 'Not shown' : percent(tele.estimate) + flag(tele),
      tele.withheld
        ? `${number(g.telehealth_n_persons)} sampled people with telehealth visits; minimum 30`
        : `95% confidence interval ${ci(tele.ci_low, tele.ci_high)}`,
    ) +
    metric(
      total ? 'Mean total payments / visit' : 'Mean out-of-pocket / visit',
      dollars(p.estimate),
      `${ci(p.ci_low, p.ci_high, ' dollars')} · 95% confidence interval`,
    ) +
    metric(
      'Office-based visits in sample',
      number(g.n),
      `${number(g.n_persons)} people · ${esc(g.insurance)}`,
    );
  $('modality-chart').innerHTML = g.modalities
    .map((m) => {
      const d = displayMeps(m, 'share_pct');
      return `<div class="bar-row"><span>${esc(m.modality)}${m.share_pct.unstable ? ' *' : ''}</span><div class="bar-track" role="img" aria-label="${esc(m.modality)}: ${d.withheld ? 'Not shown, fewer than 30 people' : percent(d.estimate)}"><div class="bar-fill" style="width:${d.withheld ? 0 : d.estimate}%"></div></div><span class="bar-number">${d.withheld ? '—' : d.estimate < 0.1 ? number(d.estimate, 2) + '%' : percent(d.estimate)}</span></div>`;
    })
    .join('');
  $('payment-title').textContent = total
    ? 'Mean total payments per visit'
    : 'Mean out-of-pocket payments per visit';
  $('payment-chart').innerHTML = dotChart(
    g.modalities.map((m) => ({...displayMeps(m, key), label: m.modality})),
    {
      unit: 'dollars',
      compact: true,
      title: `${total ? 'Total' : 'Out-of-pocket'} payments by modality, ${g.insurance}`,
    },
  );
  $('meps-table').innerHTML = table(
    [
      'Visit type',
      'Sample visits / people',
      'Visit share (95% CI)',
      `${total ? 'Total' : 'Out-of-pocket'} payment (95% CI)`,
    ],
    g.modalities.map((m) => [
      esc(m.modality),
      `${number(m.n)} / ${number(m.n_persons)}`,
      m.n_persons < 30
        ? '<span class="badge">Not shown · &lt;30 people</span>'
        : `${percent(m.share_pct.estimate)} (${ci(m.share_pct.ci_low, m.share_pct.ci_high)})${flag(m.share_pct)}`,
      m.n_persons < 30
        ? '<span class="badge">Not shown · &lt;30 people</span>'
        : `${dollars(m[key].estimate)} (${ci(m[key].ci_low, m[key].ci_high, ' dollars')})${flag(m[key])}`,
    ]),
    {numeric: [1, 2, 3]},
  );
  $('meps-source').innerHTML =
    `Source: <a href="https://meps.ahrq.gov/data_stats/download_data/pufs/h254g/h254gdoc.shtml" target="_blank" rel="noreferrer">MEPS HC-254G</a> + HC-256 · 2024 office-based visits, all ages · Survey-weighted estimates using weights, strata, and primary sampling units. Visit shares use all office visits in the selected insurance group as denominator. Insurance describes coverage during 2024: any private (including TRICARE), public only, or uninsured all year; it is not coverage on the visit date. Modality estimates and overall telehealth shares with fewer than 30 sampled people in the numerator are not shown in charts, tables, or CSV exports. * Unstable: relative standard error &gt;30% or a boundary estimate (sparse rows are also marked). Approximate normal CIs are bounded at zero (and 100% for shares). Read rare-modality estimates cautiously.`;
  renderMepsComparison();
}
/**
 * Summarizes the three verified sources and their noninterchangeable units.
 * Live CMS status is presented separately so this panel remains a snapshot record.
 */
function renderQuality() {
  const cards = [
    [
      'CMS + ACS',
      'Geography & context',
      'Medicare Part B fee-for-service service users',
      'State / period',
      '2020–2025; ACS 2024',
      '50 states + D.C.',
    ],
    [
      'NHIS',
      'Population differences',
      'Civilian noninstitutionalized adults ≥18',
      'Person',
      '2024',
      `${number(nhis.quality.valid_outcome_n)} valid outcomes`,
    ],
    [
      'MEPS',
      'Visits & payments',
      'Office-based visits, all ages',
      'Visit',
      '2024',
      `${number(meps.quality.analytic_visit_n)} positive-weight visits`,
    ],
  ];
  $('quality-cards').innerHTML = cards
    .map(
      (c) =>
        `<article class="quality-card"><span class="eyebrow">${c[0]}</span><h3>${c[1]}</h3><dl><dt>Population</dt><dd>${c[2]}</dd><dt>Unit</dt><dd>${c[3]}</dd><dt>Period</dt><dd>${c[4]}</dd><dt>Coverage</dt><dd>${c[5]}</dd></dl></article>`,
    )
    .join('');
  const q = meps.quality;
  const rows = [
    [
      'CMS + ACS',
      '2024 state coverage matching',
      51,
      '0 unmatched records',
      'Annual CMS + same-year ACS',
    ],
    [
      'CMS',
      'Selected annual/quarterly rates',
      cms.quality.cmsRetainedRows,
      '0 suppressed or missing rates',
      'Published all-beneficiary totals',
    ],
    ...nhis.quality.missingness.map((m) => [
      'NHIS',
      esc(
        nhis.group_labels[m.group] ||
          (m.variable === 'VIRAPP12M_A' ? 'Telehealth response' : m.variable),
      ),
      nhis.quality.raw_n,
      `${number(m.n)} (${number(m.percent, 2)}%) missing`,
      'Unweighted source-file count',
    ]),
    [
      'MEPS',
      'Source → positive-weight visits',
      q.source_event_n,
      `${number(q.zero_weight_visit_n)} zero weights excluded`,
      `${number(q.analytic_visit_n)} retained`,
    ],
    [
      'MEPS',
      'Person-file linkage',
      q.analytic_visit_n,
      `${number(q.unmatched_person_n)} unmatched`,
      'Many visits to one person',
    ],
    [
      'MEPS',
      'Remote modality',
      q.telehealth_source_n,
      `${number(q.unknown_remote_modality_source_n)} unknown`,
      '132,199 nonremote = inapplicable',
    ],
    [
      'MEPS',
      'Released payment fields',
      q.source_event_n,
      '0 missing',
      'Includes imputation',
    ],
  ];
  $('quality-table').innerHTML = table(
    ['Source', 'Quality check', 'Records checked', 'Finding', 'Interpretation'],
    rows.map((r) => [r[0], r[1], number(r[2]), r[3], r[4]]),
    {numeric: [2]},
  );
}
/**
 * Selects an allowlisted module from the URL and updates navigation semantics.
 * Unknown fragments fall back to the state view rather than arbitrary DOM IDs.
 */
function navigate() {
  const view = location.hash.slice(1);
  state.view = heroes[view] ? view : 'states';
  document
    .querySelectorAll('.view')
    .forEach((el) => (el.hidden = el.id !== `view-${state.view}`));
  document.querySelectorAll('[data-view]').forEach((el) => {
    el.classList.toggle('active', el.dataset.view === state.view);
    el.setAttribute(
      'aria-current',
      el.dataset.view === state.view ? 'page' : 'false',
    );
  });
  const h = heroes[state.view];
  $('hero-kicker').textContent = h[0];
  $('hero-title').innerHTML = h[1];
  $('hero-description').textContent = h[2];
  document.title = `${{states: 'States & access', people: 'Population differences', visits: 'Visits & payments', quality: 'Data & methods'}[state.view]} — Weill Cornell Medicine Telehealth Insights`;
  hideTip();
  renderEdition();
}
/**
 * Creates a browser CSV download and announces it to assistive technology.
 * @param {!Array<!Object>} rows Export-schema records, with withheld values null.
 * @param {string} name Application-generated filename, including .csv extension.
 */
function download(rows, name) {
  const blob = new Blob(['\uFEFF' + csv(rows)], {
    type: 'text/csv;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  $('announcement').textContent = `Downloaded ${name}`;
}
// Export provenance with values so a downloaded live view can be identified later.
/**
 * Exports the current CMS edition with retrieval and validation metadata.
 * ACS columns always identify their fixed 2024 context, even for other CMS periods.
 */
function downloadCms() {
  download(
    activeCms().states.map((s) => {
      const r = currentSeries(s);
      return {
        state: s.name,
        abbreviation: s.abbr,
        period: state.period,
        telehealth_percent: r?.telehealthPct,
        telehealth_users: r?.telehealthUsers,
        eligible_service_users: r?.eligibleUsers,
        acs_context_year: 2024,
        broadband_percent_2024: s.acs2024.broadbandPct,
        broadband_moe90_pp_2024: s.acs2024.broadbandMoe90,
        median_household_income_2024: s.acs2024.medianIncome,
        income_moe90_2024: s.acs2024.incomeMoe90,
        context_note:
          'ACS context is 2024 only; associations must use CMS 2024 annual values',
        source: 'CMS Medicare Telehealth Trends; ACS 2024 1-year',
        validation_status: liveCms
          ? 'Live CMS data; not revalidated'
          : 'Verified snapshot',
        cms_retrieved_at: liveCms?.checkedAt || cms.accessDate,
        cms_api_url: liveCms?.apiUrl || '',
        cms_source_version: liveCms?.version || '',
        acs_validation_status: 'Verified 2024 snapshot',
      };
    }),
    `cms-states-${state.period.replace(' ', '-')}.csv`,
  );
}
/**
 * Exports the selected available-case comparison with its population and recode.
 * The descriptive estimates remain distinct from the adjusted model download.
 */
function downloadNhis() {
  download(
    nhis.groups[state.nhisGroup].map((r) => ({
      source: 'NHIS 2024',
      population: nhis.population,
      measure: nhis.measure,
      group_variable: state.nhisGroup,
      group: r.label,
      n: r.n,
      weighted_percent: r.estimate,
      ci95_low: r.ci_low,
      ci95_high: r.ci_high,
      unstable: r.unstable,
      method: 'Survey weighted unadjusted; logit CI',
      group_definition: nhis.group_notes[state.nhisGroup],
    })),
    `nhis-2024-${state.nhisGroup}.csv`,
  );
}
/**
 * Exports all modalities using the same withholding rules as visible estimates.
 * Sample counts and instability flags remain available when estimates are blank.
 */
function downloadMeps() {
  const g = meps.groups.find((g) => g.insurance === state.insurance);
  download(
    g.modalities.map((m) => ({
      source: meps.source,
      year: 2024,
      insurance: g.insurance,
      insurance_period: 'Annual INSCOV24; not visit-time payer',
      modality: m.modality,
      n_visits: m.n,
      n_persons: m.n_persons,
      share_percent: displayMeps(m, 'share_pct').estimate,
      share_ci95_low: displayMeps(m, 'share_pct').ci_low,
      share_ci95_high: displayMeps(m, 'share_pct').ci_high,
      share_unstable: m.share_pct.unstable,
      total_payment_dollars: displayMeps(m, 'total_payment').estimate,
      total_ci95_low: displayMeps(m, 'total_payment').ci_low,
      total_ci95_high: displayMeps(m, 'total_payment').ci_high,
      total_unstable: m.total_payment.unstable,
      family_payment_dollars: displayMeps(m, 'family_payment').estimate,
      family_ci95_low: displayMeps(m, 'family_payment').ci_low,
      family_ci95_high: displayMeps(m, 'family_payment').ci_high,
      family_unstable: m.family_payment.unstable,
      display_status:
        m.n_persons < 30
          ? 'Withheld: fewer than 30 sampled people'
          : 'Displayed; check instability flags',
      flags: [
        ...new Set([
          ...m.share_pct.flags,
          ...m.total_payment.flags,
          ...m.family_payment.flags,
        ]),
      ].join('; '),
      share_denominator: 'All positive-weight office visits in insurance group',
      payment_denominator:
        'Positive-weight visits within modality and insurance group',
    })),
    `meps-2024-${state.insurance.replaceAll(' ', '-').toLowerCase()}.csv`,
  );
}
/**
 * Positions one shared tooltip within the viewport for pointer or keyboard use.
 * @param {!Element} el Chart mark with data-tip text.
 * @param {!Object} event Pointer coordinates, or an empty object for focus events.
 */
function showTip(el, event) {
  const tip = $('tooltip');
  tip.textContent = el.dataset.tip;
  tip.hidden = false;
  const box = el.getBoundingClientRect();
  const x = event.clientX ?? box.left;
  const y = event.clientY ?? box.top;
  tip.style.left =
    Math.max(8, Math.min(window.innerWidth - tip.offsetWidth - 10, x + 12)) +
    'px';
  tip.style.top =
    Math.max(8, Math.min(window.innerHeight - tip.offsetHeight - 10, y + 16)) +
    'px';
}
/**
 * Dismisses the shared tooltip on focus exit, scrolling, or Escape.
 */
function hideTip() {
  $('tooltip').hidden = true;
}
/**
 * Loads all three aggregates before enabling data-dependent interactions.
 *
 * Handlers are attached once; subsequent renders replace panel contents and
 * reattach only controls created inside those panels. An initial failure rejects
 * to the page-level error state instead of presenting partially loaded results.
 *
 * @return {!Promise<void>} Resolves after initial rendering and navigation.
 * @throws {Error} Rejects if a data response fails or rendering cannot initialize.
 */
async function start() {
  const results = await Promise.all(
    ['cms', 'nhis', 'meps'].map(async (name) => {
      const res = await fetch(`./data/${name}.json`);
      if (!res.ok) {
        throw Error(
          `${name.toUpperCase()} data could not be loaded (${res.status}).`,
        );
      }
      return res.json();
    }),
  );
  [cms, nhis, meps] = results;
  populateCmsPeriods();
  $('cms-state').innerHTML =
    '<option value="US">United States</option>' +
    cms.states
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .map((s) => `<option value="${s.abbr}">${esc(s.name)}</option>`)
      .join('');
  $('meps-insurance').innerHTML = meps.groups
    .map(
      (g) =>
        `<option value="${esc(g.insurance)}">${g.insurance === 'All' ? 'All insurance groups' : esc(g.insurance)}</option>`,
    )
    .join('');
  $('cms-period').addEventListener('change', (e) => {
    state.period = e.target.value;
    renderCms();
  });
  $('cms-state').addEventListener('change', (e) => selectState(e.target.value));
  $('acs-measure').addEventListener('change', renderScatter);
  for (const mode of ['map', 'table']) {
    $(mode + '-view').addEventListener('click', () => {
      state.display = mode;
      $('map-content').hidden = mode !== 'map';
      $('cms-table-wrap').hidden = mode !== 'table';
      $('map-view').setAttribute('aria-pressed', mode === 'map');
      $('table-view').setAttribute('aria-pressed', mode === 'table');
    });
  }
  $('nhis-group').addEventListener('change', (e) => {
    state.nhisGroup = e.target.value;
    renderNhis();
  });
  $('meps-insurance').addEventListener('change', (e) => {
    state.insurance = e.target.value;
    renderMeps();
  });
  $('payment-measure').addEventListener('change', (e) => {
    state.payment = e.target.value;
    renderMeps();
  });
  $('cms-refresh').disabled = false;
  $('cms-refresh').addEventListener('click', refreshCms);
  $('cms-reset').addEventListener('click', restoreCms);
  $('cms-change-from').addEventListener('change', (e) => {
    state.changeFrom = Number(e.target.value);
    renderAnnualChanges();
  });
  $('cms-change-to').addEventListener('change', (e) => {
    state.changeTo = Number(e.target.value);
    renderAnnualChanges();
  });
  $('cms-change-scope').addEventListener('change', (e) => {
    state.changeScope = e.target.value;
    renderAnnualChanges();
  });
  $('cms-change-download').addEventListener('click', downloadAnnualChanges);
  $('meps-comparison-download').addEventListener('click', () =>
    download(
      meps.groups
        .filter((g) => g.insurance !== 'All')
        .map((g) => {
          const v = displayTelehealth(g);
          return {
            source: 'MEPS HC-254G + HC-256',
            year: 2024,
            insurance: g.insurance,
            telehealth_percent: v.estimate,
            ci95_low: v.ci_low,
            ci95_high: v.ci_high,
            n_visits: g.n,
            n_people: g.n_persons,
            telehealth_n_visits: g.telehealth_n,
            telehealth_n_people: g.telehealth_n_persons,
            display_status: v.withheld
              ? 'Not shown: fewer than 30 telehealth sampled people'
              : v.unstable
                ? 'Displayed: unstable'
                : 'Displayed',
            denominator:
              'All positive-weight office visits within insurance group',
          };
        }),
      'meps-2024-telehealth-by-insurance.csv',
    ),
  );
  $('cms-download').addEventListener('click', downloadCms);
  $('nhis-download').addEventListener('click', downloadNhis);
  $('meps-download').addEventListener('click', downloadMeps);
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-state]');
    if (el) {
      selectState(el.dataset.state);
    }
  });
  document.addEventListener('keydown', (e) => {
    const el = e.target.closest('[data-state]');
    if (
      el?.namespaceURI === 'http://www.w3.org/2000/svg' &&
      ['Enter', ' '].includes(e.key)
    ) {
      e.preventDefault();
      selectState(el.dataset.state);
    }
    if (e.key === 'Escape') {
      hideTip();
    }
  });
  document.addEventListener('pointerover', (e) => {
    const el = e.target.closest('[data-tip]');
    if (el) {
      showTip(el, e);
    }
  });
  document.addEventListener('pointerout', (e) => {
    if (e.target.closest('[data-tip]')) {
      hideTip();
    }
  });
  document.addEventListener('focusin', (e) => {
    const el = e.target.closest('[data-tip]');
    if (el) {
      showTip(el, {});
    }
  });
  document.addEventListener('focusout', hideTip);
  window.addEventListener('scroll', hideTip, {passive: true});
  document.querySelector('.project-brand')?.addEventListener('click', () => {
    window.scrollTo({top: 0, behavior: 'instant'});
  });
  window.addEventListener('hashchange', () => {
    navigate();
    window.scrollTo({top: 0, behavior: 'instant'});
  });
  renderCms();
  renderNhis();
  renderMeps();
  renderQuality();
  $('loading').hidden = true;
  navigate();
}
start().catch((err) => {
  $('loading').hidden = true;
  $('error').hidden = false;
  $('error').textContent =
    `The data could not be loaded. Refresh the page and try again. If the problem continues, return later.`;
  console.error(err);
});

/**
 * Renders the stored complete-case association model and its export control.
 * The forest selector filters terms from this same fit; no browser estimation occurs.
 */
function renderNhisModel() {
  const m = nhis.adjusted_model;
  if (!m) {
    $('nhis-model').hidden = true;
    return;
  }
  $('nhis-model').innerHTML =
    `<div class="section-heading"><div><span class="eyebrow">Adjusted adult associations · 2024</span><h2>Adjusted associations with telehealth use</h2></div><button id="nhis-model-download" class="text-button">Download model ↓</button></div><p class="model-intro">Survey-weighted logistic regression including insurance coverage, age, education, Internet access, and self-rated health. Reference groups are specified for each comparison below. Odds ratios describe relative odds, not probability differences or causal effects.</p><div class="toolbar"><label>Adjusted comparison <select id="nhis-model-group">${[...new Set(m.terms.map((t) => t.group))].map((g) => `<option value="${esc(g)}"${g === state.modelGroup ? ' selected' : ''}>${esc(g)}</option>`).join('')}</select></label><span class="pill">● Adjusted odds ratio &nbsp; ━ 95% confidence interval</span></div><div id="nhis-forest" class="comparison-chart"></div><p id="nhis-forest-caption" class="caption"></p><p class="model-methods">Complete-case sample: <strong>${number(m.n)}</strong> adults (${number(m.excluded_n)} excluded). All covariates enter the same model. Insurance is measured at interview; the outcome covers the prior 12 months.</p><details><summary>View all adjusted associations and model specification</summary><div class="table-wrap">${table(
      [
        'Covariate',
        'Comparison',
        'Reference',
        'Adjusted odds ratio',
        '95% confidence interval',
      ],
      m.terms.map((t) => [
        esc(t.group),
        esc(t.label),
        esc(t.reference),
        number(t.odds_ratio, 3),
        `${number(t.ci_low, 3)}–${number(t.ci_high, 3)}`,
      ]),
      {numeric: [3, 4]},
    )}</div><div class="model-methods"><p><code>${esc(m.formula)}</code></p>${m.notes.map((n) => `<p>${esc(n)}</p>`).join('')}</div></details>`;
  $('nhis-model-group').addEventListener('change', (e) => {
    state.modelGroup = e.target.value;
    renderNhisForest();
  });
  renderNhisForest();
  $('nhis-model-download').addEventListener('click', () =>
    download(
      m.terms.map((t) => ({
        source: 'NHIS 2024',
        model: m.model,
        n: m.n,
        outcome: m.outcome,
        covariate: t.group,
        comparison: t.label,
        reference: t.reference,
        adjusted_odds_ratio: t.odds_ratio,
        ci95_low: t.ci_low,
        ci95_high: t.ci_high,
        adjustment: m.formula,
      })),
      'nhis-2024-adjusted-associations.csv',
    ),
  );
}
/**
 * Renders verified state OLS/HC3 coefficients in percentage-point units.
 * The model remains pinned to 2024 regardless of the descriptive CMS edition.
 */
function renderCmsModel() {
  const m = cms.associations.adjustedModel;
  if (!m) {
    $('cms-model').hidden = true;
    return;
  }
  $('cms-model').hidden = false;
  const terms = m.coefficients;
  $('cms-model').innerHTML =
    `<div class="section-heading"><div><span class="eyebrow">Adjusted state associations · Verified 2024 snapshot</span><h2>Broadband and income associations</h2></div><button id="cms-model-download" class="text-button">Download model ↓</button></div><p class="model-intro">Annual state telehealth use is modeled with broadband subscription and median household income together. These ecological associations compare states and do not establish individual or causal effects.</p><div class="table-wrap">${table(
      ['Term', 'Coefficient (percentage points)', '95% confidence interval'],
      terms
        .filter((t) => t.term !== 'intercept')
        .map((t) => [
          esc(t.label),
          number(t.estimate, 3),
          `${number(t.ciLow, 3)}–${number(t.ciHigh, 3)}`,
        ]),
      {numeric: [1, 2]},
    )}</div><p class="model-methods">Ordinary least squares · HC3 robust standard errors · Approximate normal 95% confidence intervals · n = ${m.n}. Outcome: CMS telehealth use in percentage points. Broadband: per 1 percentage point; income: per $10,000. Each state and D.C. has equal weight. ACS measurement uncertainty is not included in this model. No adjustment for other state characteristics is made.</p><details><summary>View model specification and limitations</summary><div class="model-methods"><p><code>CMS telehealth percentage = intercept + broadband percentage + median household income / 10,000</code></p><p>Intercept: ${number(terms[0].estimate, 3)} pp (95% CI ${number(terms[0].ciLow, 3)}–${number(terms[0].ciHigh, 3)}). The intercept describes zero-valued predictors outside the observed data range and has no substantive interpretation here.</p><p>The 51 jurisdictions constitute the included state/DC set. Model-based intervals describe uncertainty under the regression assumptions, not sampling error in CMS claims. Correlated predictors, omitted variables, and geographic dependence can affect these associations. No causal or predictive claim is made.</p></div></details>`;
  $('cms-model-download').addEventListener('click', () =>
    download(
      terms.map((t) => ({
        source: 'CMS + ACS 2024',
        model: 'State OLS with HC3 covariance',
        n: m.n,
        term: t.term,
        description: t.label,
        coefficient_pp: t.estimate,
        se_hc3: t.se,
        ci95_low: t.ciLow,
        ci95_high: t.ciHigh,
        units: t.units,
        interval: 'Normal approximation 1.96 x HC3 SE',
      })),
      'cms-acs-2024-adjusted-associations.csv',
    ),
  );
}

/**
 * Formats a valid retrieval timestamp consistently in UTC.
 * @param {string} value ISO timestamp produced by the live client.
 * @return {string} Minute-resolution UTC display text.
 */
function formatCheckedAt(value) {
  return new Date(value).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}
/**
 * Shows live status only for the CMS module; other modules remain verified.
 */
function renderEdition() {
  const edition = document.querySelector('.edition');
  if (state.view === 'states' && liveCms) {
    edition.innerHTML = `<span>Live CMS view · not revalidated</span><span>Latest available: ${esc(liveCms.latestPeriod)}</span><span>Fetched ${esc(formatCheckedAt(liveCms.checkedAt))}</span>`;
  } else {
    edition.innerHTML =
      '<span>Verified data snapshot</span><span>2024 focus · CMS trends 2020–2025</span><span>Data retrieved Nov 11, 2026</span>';
  }
}
/**
 * Rebuilds period options from the current CMS edition.
 * Preserves the selected period when available, otherwise prefers 2024 annual,
 * then the latest annual record, then the latest available quarterly record.
 */
function populateCmsPeriods() {
  const data = activeCms();
  const annual = data.national.annual.toSorted((a, b) => b.year - a.year);
  const quarterly = data.national.quarterly.toSorted(
    (a, b) => b.year - a.year || b.quarter - a.quarter,
  );
  $('cms-period').innerHTML =
    `<optgroup label="Annual">${annual.map((r) => `<option value="${esc(r.period)}">${esc(r.period)} · Annual</option>`).join('')}</optgroup><optgroup label="Quarterly">${quarterly.map((r) => `<option value="${esc(r.period)}">${esc(r.period)}</option>`).join('')}</optgroup>`;
  if (![...annual, ...quarterly].some((r) => r.period === state.period)) {
    state.period =
      annual.find((r) => r.period === '2024')?.period ||
      annual[0]?.period ||
      quarterly[0].period;
  }
  $('cms-period').value = state.period;
}
// Fetch transactionally: keep the current view on failure and never partially apply a response.
/**
 * Applies a complete CMS candidate once, with a 60-second request deadline.
 *
 * The pending flag prevents overlapping checks. Failures leave the old data and
 * edition intact; finally always restores the controls and clears the timer.
 * A successful no-change check is distinct from a failed or timed-out request.
 *
 * @return {!Promise<void>} Resolves after displaying update, no-change, or error status.
 */
async function refreshCms() {
  if (cmsRefreshPending) {
    return;
  }
  cmsRefreshPending = true;
  const button = $('cms-refresh');
  const status = $('cms-refresh-status');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);
  button.disabled = true;
  $('cms-reset').disabled = true;
  button.textContent = 'Fetching from CMS…';
  button.setAttribute('aria-busy', 'true');
  status.dataset.state = 'loading';
  status.textContent = 'Contacting the official CMS source…';
  try {
    const result = await fetchCmsUpdates(cms, {
      currentCms: activeCms(),
      signal: controller.signal,
      onProgress: (message) => {
        status.textContent = message;
      },
    });
    if (result.changed) {
      liveCms = result;
      state.period = result.latestPeriod;
      populateCmsPeriods();
      renderCms();
      $('cms-live-note').hidden = false;
      $('cms-reset').hidden = false;
      status.dataset.state = 'updated';
      status.textContent = `CMS data loaded through ${result.latestPeriod}. The map, table, counts, trend, and annual comparisons have been updated; these live values have not been revalidated. Checked ${formatCheckedAt(result.checkedAt)}.`;
    } else {
      status.dataset.state = 'unchanged';
      status.textContent = `No additional or revised CMS data were found compared with the current view. Checked ${formatCheckedAt(result.checkedAt)}. You can review the official source below.`;
    }
  } catch (error) {
    status.dataset.state = 'error';
    status.textContent = controller.signal.aborted
      ? 'The CMS request timed out. Your current data have been kept. Try again or visit the official source.'
      : 'Compatible CMS data could not be retrieved. Your current data have been kept. Try again or visit the official source.';
    console.warn('CMS update was not applied:', error.message);
  } finally {
    clearTimeout(timeout);
    cmsRefreshPending = false;
    button.disabled = false;
    $('cms-reset').disabled = false;
    button.textContent = 'Check latest CMS data';
    button.removeAttribute('aria-busy');
  }
}
/**
 * Discards session-only CMS data and returns all descriptive panels to baseline.
 */
function restoreCms() {
  liveCms = null;
  populateCmsPeriods();
  renderCms();
  $('cms-live-note').hidden = true;
  $('cms-reset').hidden = true;
  $('cms-refresh-status').dataset.state = 'idle';
  $('cms-refresh-status').textContent =
    'Restored the verified snapshot retrieved November 11, 2026';
}

// Compare published annual rates only; quarterly unique users cannot be added into annual totals.
/**
 * Compares published annual records and keeps year controls ordered.
 * The chart may show ten ranked jurisdictions, but table and export retain all 51.
 * Quarterly-only live years are never promoted into annual comparison options.
 */
function renderAnnualChanges() {
  const data = activeCms();
  const years = data.national.annual.map((r) => r.year).sort((a, b) => a - b);
  if (!years.includes(state.changeTo) || state.changeTo <= years[0]) {
    state.changeTo = years.at(-1);
  }
  if (!years.includes(state.changeFrom) || state.changeFrom >= state.changeTo) {
    state.changeFrom = years.filter((y) => y < state.changeTo).at(-1);
  }
  $('cms-change-from').innerHTML = years
    .filter((y) => y < state.changeTo)
    .map(
      (y) =>
        `<option value="${y}"${y === state.changeFrom ? ' selected' : ''}>${y}</option>`,
    )
    .join('');
  $('cms-change-to').innerHTML = years
    .slice(1)
    .map(
      (y) =>
        `<option value="${y}"${y === state.changeTo ? ' selected' : ''}>${y}</option>`,
    )
    .join('');
  const rows = annualChanges(data, state.changeFrom, state.changeTo);
  const valid = rows.filter((r) => Number.isFinite(r.change));
  const shown =
    state.changeScope === 'all'
      ? rows
      : valid
          .toSorted(
            (a, b) =>
              Math.abs(b.change) - Math.abs(a.change) ||
              a.name.localeCompare(b.name),
          )
          .slice(0, 10);
  shown.sort(
    (a, b) =>
      (b.change ?? -Infinity) - (a.change ?? -Infinity) ||
      a.name.localeCompare(b.name),
  );
  $('cms-change-chart').innerHTML = changeChart(shown, {
    title: `Annual telehealth use change, ${state.changeFrom} to ${state.changeTo}`,
    selected: state.selected,
  });
  const national = annualChanges(
    {states: [{...data.national, name: 'United States', abbr: 'US'}]},
    state.changeFrom,
    state.changeTo,
  )[0];
  const delta = Number.isFinite(national.change)
    ? `${national.change > 0 ? '+' : ''}${number(national.change, 2)} percentage points`
    : 'unavailable';
  $('cms-change-caption').textContent =
    `${state.changeFrom} → ${state.changeTo} · ${state.changeScope === 'all' ? 'All 50 states and D.C.' : 'The 10 states/DC with the largest absolute changes'} · U.S. published national change: ${delta}. Change is the later annual rate minus the earlier annual rate, not a relative percent change. Annual unique-user rates are not averages of quarterly rates. ${liveCms ? 'Live CMS data; not revalidated.' : 'Verified snapshot.'}`;
  $('cms-change-table').innerHTML = table(
    [
      'State',
      `${state.changeFrom} annual use`,
      `${state.changeTo} annual use`,
      'Change (pp)',
    ],
    rows
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .map((r) => [
        esc(r.name),
        Number.isFinite(r.fromRate) ? `${number(r.fromRate, 2)}%` : '—',
        Number.isFinite(r.toRate) ? `${number(r.toRate, 2)}%` : '—',
        Number.isFinite(r.change)
          ? `${r.change > 0 ? '+' : ''}${number(r.change, 2)}`
          : '—',
      ]),
    {numeric: [1, 2, 3]},
  );
}
/**
 * Exports all jurisdictions and the active edition's provenance.
 * Differences are percentage points, not relative percentage changes.
 */
function downloadAnnualChanges() {
  download(
    annualChanges(activeCms(), state.changeFrom, state.changeTo).map((r) => ({
      source: 'CMS Medicare Telehealth Trends',
      state: r.name,
      abbreviation: r.abbr,
      baseline_year: r.fromYear,
      comparison_year: r.toYear,
      baseline_annual_percent: r.fromRate,
      comparison_annual_percent: r.toRate,
      change_percentage_points: r.change,
      validation_status: liveCms
        ? 'Live CMS data; not revalidated'
        : 'Verified snapshot',
      cms_retrieved_at: liveCms?.checkedAt || cms.accessDate,
      cms_source_version: liveCms?.version || '',
      cms_api_url: liveCms?.apiUrl || '',
    })),
    `cms-annual-change-${state.changeFrom}-${state.changeTo}.csv`,
  );
}
/**
 * Displays the selected covariate's terms from the existing adjusted model.
 * Age is continuous; the remaining selections use their stored category references.
 */
function renderNhisForest() {
  const rows = nhis.adjusted_model.terms.filter(
    (t) => t.group === state.modelGroup,
  );
  const reference = rows[0]?.reference || '';
  $('nhis-forest').innerHTML = oddsRatioChart(rows, {
    title: `Adjusted telehealth associations: ${state.modelGroup}`,
    referenceLabel: reference,
  });
  $('nhis-forest-caption').textContent =
    `${state.modelGroup === 'Age' ? 'Age is continuous; each estimate represents one additional year.' : `Reference: ${reference}.`} Odds ratios use a log scale, with equal odds at 1. Bars show 95% confidence intervals.`;
}
/**
 * Compares disjoint insurance domains, excluding the overlapping All total.
 * The shared display helper ensures sparse telehealth numerators remain withheld.
 */
function renderMepsComparison() {
  const groups = meps.groups.filter((g) => g.insurance !== 'All');
  $('meps-insurance-chart').innerHTML = dotChart(
    groups.map((g) => ({...displayTelehealth(g), label: g.insurance})),
    {
      max: 20,
      title:
        'Telehealth share of office-based visits by annual insurance coverage',
    },
  );
  $('meps-insurance-table').innerHTML = table(
    [
      'Insurance coverage',
      'Telehealth share',
      '95% confidence interval',
      'People with telehealth / all sampled people',
    ],
    groups.map((g) => {
      const v = displayTelehealth(g);
      return [
        esc(g.insurance),
        v.withheld
          ? 'Not shown · fewer than 30 people'
          : percent(v.estimate) + flag(v),
        v.withheld ? '—' : ci(v.ci_low, v.ci_high),
        `${number(g.telehealth_n_persons)} / ${number(g.n_persons)}`,
      ];
    }),
    {numeric: [1, 2, 3]},
  );
}
