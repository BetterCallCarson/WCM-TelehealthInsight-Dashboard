// author: Yao Yao(yay4008@med.cornell.edu)
/**
 * Builds a static validation page from printed aggregate results in the knitted
 * NHIS analysis. Reading the report does not execute its scripts. Retain the
 * published rounding and distinguish the unweighted and survey-weighted tables.
 */
import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {format, resolveConfig} from 'prettier';

// author: Yao Yao(yay4008@med.cornell.edu)
// A changed table layout must stop the build before the metrics can be mislabelled.
const root = path.resolve(import.meta.dirname, '..');
const study = './analysis/prediction';
const reportPath = study + '/nhis_telehealth_prediction_final.html';
const [report, dashboard] = await Promise.all(
  [reportPath, 'index.html'].map((p) => readFile(path.join(root, p), 'utf8')),
);
const attribution = '<!-- author: Yao Yao(yay4008@med.cornell.edu) -->';
const output = [
  ...report.matchAll(/<pre><code>(##[\s\S]*?)<\/code><\/pre>/g),
].map(([, block]) =>
  block.split('\n').map((line) => line.replace(/^##\s*/, '').trim()),
);

// author: Yao Yao(yay4008@med.cornell.edu)
/** Select printed outputs by their first line. Count checks protect year order. */
function tables(header, count, firstRow = '') {
  const matches = output.filter(
    (lines) =>
      lines[0].replace(/\s+/g, ' ') === header &&
      lines[1]?.startsWith(firstRow),
  );
  assert.equal(matches.length, count, 'Unexpected output count for ' + header);
  return matches.map((lines) => lines.slice(1));
}

// author: Yao Yao(yay4008@med.cornell.edu)
/** Extract a named row and reject unexpected columns or nonnumeric output. */
function modelRow(rows, label, columns) {
  const matching = rows.filter((row) => row.startsWith(label + ' '));
  assert.equal(matching.length, 1, 'Missing or duplicate row: ' + label);
  const values = matching[0]
    .slice(label.length)
    .trim()
    .split(/\s+/)
    .map(Number);
  assert.equal(values.length, columns);
  assert.ok(values.every(Number.isFinite));
  return values;
}

// author: Yao Yao(yay4008@med.cornell.edu)
const models = [
  'Constant baseline',
  'Theory-based logistic',
  'Theory-based BIC logistic',
  'Stepwise BIC logistic',
  'Group lasso (lambda.min)',
  'Group lasso (lambda.1se)',
  'Full pool XGBoost',
];
const primary = 'Stepwise BIC logistic';
const unweighted = tables('log_loss AUROC AUPRC Brier', 2);
const weighted = tables('log_loss AUROC Brier', 2, 'Constant baseline');
const intervals = tables('2.5% 50% 97.5%', 2, 'primary_AUROC');
const cohorts = tables('complete_case_n', 2).map((rows) => Number(rows[0]));
const split = tables('dataset n users use_pct', 1)[0].map((row) =>
  Number(row.split(/\s+/)[2]),
);
assert.equal(split[0] + split[1], cohorts[0]);
const validation = cohorts[1];
const [gap, lower, upper] = modelRow(
  tables('gap_pp lower_95 upper_95', 1)[0],
  primary,
  3,
);
const populationMeans = tables(
  'weighted_observed_pct weighted_predicted_pct',
  1,
)[0][0]
  .split(/\s+/)
  .map(Number);
assert.equal(populationMeans.length, 2);
assert.ok(populationMeans.every(Number.isFinite));

// author: Yao Yao(yay4008@med.cornell.edu)
// The output order is 2024 holdout, 2025 unweighted, then 2025 weighted.
// Keep the count alongside every point so the sparsest bands remain identifiable.
const bands = tables(
  'n weighted_share_pct predicted observed gap_pp',
  3,
)[2].map((row) => {
  const fields = row.split(/\s+/);
  assert.equal(fields.length, 6);
  const match = /^[[(]([\d.]+),([\d.]+)\]$/.exec(fields[0]);
  assert.ok(match, 'Unrecognized calibration band: ' + fields[0]);
  const [n, share, predicted, observed, difference] = fields
    .slice(1)
    .map(Number);
  assert.ok([n, share, predicted, observed, difference].every(Number.isFinite));
  return {
    label:
      Math.round(100 * Number(match[1])) +
      '–' +
      Math.round(100 * Number(match[2])) +
      '%',
    n,
    predicted: 100 * predicted,
    observed: 100 * observed,
    difference,
  };
});
assert.equal(
  bands.reduce((sum, band) => sum + band.n, 0),
  validation,
);
const formatCount = (n) => n.toLocaleString('en-US');
const signed = (n) => (n < 0 ? '−' : '+') + Math.abs(n).toFixed(2);
const fmt = (n) => n.toFixed(3);

// author: Yao Yao(yay4008@med.cornell.edu)
/** Table values are display strings derived from known labels and numeric estimates. */
function table(label, headers, rows) {
  return `<div class="table-wrap" role="region" aria-label="${label}" tabindex="0"><table><thead><tr>${headers.map((h) => `<th scope="col">${h}</th>`).join('')}</tr></thead><tbody>${rows
    .map(
      (row) =>
        `<tr><th scope="row">${row[0]}</th>${row
          .slice(1)
          .map((c) => `<td>${c}</td>`)
          .join('')}</tr>`,
    )
    .join('')}</tbody></table></div>`;
}

// author: Yao Yao(yay4008@med.cornell.edu)
/** The bar length represents a percentage-point difference on a common signed scale. */
function calibrationBars() {
  const scale = Math.max(
    1,
    Math.ceil(Math.max(...bands.map((b) => Math.abs(b.difference)))),
  );
  return `<figure class="gap-figure" aria-labelledby="gap-title"><figcaption id="gap-title">Observed minus predicted use</figcaption><div class="gap-row gap-heading"><span>Score band</span><span class="gap-axis"><span>−${scale}</span><span>0</span><span>+${scale}</span></span><span>Gap (pp)</span></div>${bands
    .map((b) => {
      const pct = (50 * Math.abs(b.difference)) / scale;
      return `<div class="gap-row"><span>${b.label}</span><span class="gap-track" aria-hidden="true"><i style="left:${b.difference < 0 ? 50 - pct : 50}%;width:${pct}%"></i></span><span>${signed(b.difference)}</span></div>`;
    })
    .join('')}</figure>`;
}

// author: Yao Yao(yay4008@med.cornell.edu)
// Static pages share the dashboard's identity and navigation, including its
// deployment-path-relative home URL. Prediction is a standalone research module.
const headerMatch = dashboard.match(
  /<header class="site-header">[\s\S]*?<\/header>/,
);
const footerMatch = dashboard.match(/<footer>[\s\S]*?<\/footer>/);
assert.ok(headerMatch && footerMatch, 'Dashboard header or footer missing');
const header = headerMatch[0]
  .replace(/(<a\s+class="project-brand"\s+href=")[^"]+(")/, '$1./$2')
  .replace(
    /<a\s+href="#(states|people|visits|quality)"[^>]*>/g,
    (_, view) => `<a href="./index.html#${view}">`,
  )
  .replace(
    '<a href="./validation.html">',
    '<a href="./validation.html" class="active" aria-current="page">',
  );
const footer = footerMatch[0].replace(
  'href="#quality"',
  'href="./index.html#quality"',
);
const metrics = ['2024 holdout', '2025 temporal validation'].map((name, i) => {
  const [, auc, , brier] = modelRow(unweighted[i], primary, 4);
  const [, weightedAuc, weightedBrier] = modelRow(weighted[i], primary, 3);
  const [lo, , hi] = modelRow(intervals[i], 'primary_AUROC', 3);
  return [
    name,
    formatCount(i ? validation : split[1]),
    fmt(auc),
    fmt(lo) + '–' + fmt(hi),
    fmt(weightedAuc),
    brier.toFixed(4),
    weightedBrier.toFixed(4),
  ];
});
const headToHead = models.map((m) => {
  const [, a] = modelRow(unweighted[0], m, 4);
  const [, b, , brier] = modelRow(unweighted[1], m, 4);
  return [m, fmt(a), fmt(b), brier.toFixed(4)];
});
// author: Yao Yao(yay4008@med.cornell.edu)
// Scores use the report's four-decimal, unweighted holdout and validation results.
function aurocFigure() {
  const selectedModels = [
    [primary, 'Primary · Stepwise BIC'],
    ['Theory-based logistic', 'Andersen · Full model'],
    ['Group lasso (lambda.min)', 'Group lasso · Minimum loss'],
    ['Group lasso (lambda.1se)', 'Group lasso · One standard error'],
    ['Full pool XGBoost', 'XGBoost'],
  ];
  const pairs = selectedModels.map(([key, label]) => ({
    label,
    test: modelRow(unweighted[0], key, 4)[1],
    validation: modelRow(unweighted[1], key, 4)[1],
  }));
  const values = pairs.flatMap((row) => [row.test, row.validation]);
  const step = 0.01;
  const low = Math.floor(Math.min(...values) / step) * step;
  const high = Math.ceil(Math.max(...values) / step) * step;
  const position = (value) => (100 * (value - low)) / (high - low);
  const ticks = Array.from(
    {length: Math.round((high - low) / step) + 1},
    (_, i) => (low + i * step).toFixed(2),
  );
  const rows = pairs
    .map(({label, test, validation}) => {
      const a = position(test),
        b = position(validation);
      const change = validation - test;
      return `<li><strong>${label}</strong><div class="auroc-track" aria-hidden="true" style="--test:${a}%;--validation:${b}%;--start:${Math.min(a, b)}%;--length:${Math.abs(b - a)}%"><i></i><b></b></div><div class="auroc-values"><span aria-label="2024 test ${test}"><i aria-hidden="true">○</i> ${test.toFixed(4)}</span><span aria-label="2025 validation ${validation}"><i aria-hidden="true">◆</i> ${validation.toFixed(4)}</span><span>Δ ${change >= 0 ? '+' : '−'}${Math.abs(change).toFixed(4)}</span></div></li>`;
    })
    .join('');
  return `<figure class="auroc-figure"><figcaption><strong>Unweighted AUROC</strong> · Higher scores indicate better discrimination.</figcaption><p class="auroc-key">○ 2024 test &nbsp; ◆ 2025 validation</p><div class="auroc-axis" aria-hidden="true">${ticks.map((t) => '<span>' + t + '</span>').join('')}</div><ol>${rows}</ol><p class="caption">The axis spans ${ticks[0]}–${ticks.at(-1)}. Δ is the difference between scores in two separate survey samples (2025 minus 2024).</p></figure>`;
}

const [deltaLo, , deltaHi] = modelRow(
  intervals[1],
  'Theory-based logistic.AUROC_gain',
  3,
);

// author: Yao Yao(yay4008@med.cornell.edu)
// Compare all four models on the same unweighted 2025 validation sample.
const validationAuc = (model) => modelRow(unweighted[1], model, 4)[1];
const primaryAuc = validationAuc(primary);
const andersenGain = primaryAuc - validationAuc('Theory-based logistic');
const lassoGain = validationAuc('Group lasso (lambda.min)') - primaryAuc;
const boostingGain = validationAuc('Full pool XGBoost') - primaryAuc;

// author: Yao Yao(yay4008@med.cornell.edu)
const html = `<!doctype html>${attribution}<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#ffffff"><meta name="description" content="Development and temporal validation of an NHIS model of reported past-year telehealth use."><title>Prediction — Weill Cornell Medicine Telehealth Insights</title><link rel="icon" href="./assets/wcm-ti-icon.svg"><link rel="stylesheet" href="./styles.css"><link rel="stylesheet" href="./validation.css"></head>
<body class="validation-page"><a class="skip" href="#main">Skip to model validation</a>${attribution}${header}<main id="main">
${attribution}<section class="overview" aria-labelledby="model-title"><div class="hero"><span class="eyebrow">NHIS prediction study</span><h1 id="model-title">Predicting past-year telehealth use</h1><p class="edition">Verified snapshot · NHIS 2024–2025</p>
${attribution}<p class="snapshot-finding">In 2025, the primary model ranked a telehealth user above a nonuser about ${Math.round(primaryAuc * 100)}% of the time. Its unweighted AUROC of <strong>${primaryAuc.toFixed(4)}</strong> exceeded the full Andersen model by ${andersenGain.toFixed(4)}. Group lasso (minimum loss) and XGBoost scored only ${lassoGain.toFixed(4)} and ${boostingGain.toFixed(4)} higher than the primary model.</p></div>
<div class="metric-grid"><div class="metric"><div class="metric-label">2025 AUROC</div><div class="metric-value">${metrics[1][2]}</div><div class="metric-sub">Unweighted</div></div><div class="metric"><div class="metric-label">2025 adults</div><div class="metric-value">${formatCount(validation)}</div><div class="metric-sub">Temporal validation</div></div><div class="metric"><div class="metric-label">Calibration gap</div><div class="metric-value">${signed(gap)} <small>pp</small></div><div class="metric-sub">Survey-weighted</div></div></div></section>
${attribution}<section class="panel"><h2>AUROC by model and year</h2>${aurocFigure()}</section>
${attribution}<section class="panel"><h2>From one survey year to the next</h2><div class="study-grid"><div><h3>2024 · Develop and test</h3><p>${formatCount(cohorts[0])} adults met the completeness criteria. An outcome-stratified split assigned ${formatCount(split[0])} to training and ${formatCount(split[1])} to testing. Stepwise BIC selected 23 predictor terms for the primary logistic model.</p></div><div><h3>2025 · Evaluate the fixed model</h3><p>A new NHIS sample provided ${formatCount(validation)} eligible adults. Each respondent reported their own past-year use. The team applied the 2024 model without refitting.</p></div></div></section>
${attribution}<section class="panel"><h2>Discrimination and probability error</h2><p>AUROC measures how often a user ranks above a nonuser, with ties receiving half credit. Lower Brier scores indicate smaller squared probability errors.</p>${table('Primary model performance', ['Evaluation', 'Adults', 'AUROC', '95% CI¹', 'Weighted AUROC', 'Brier', 'Weighted Brier'], metrics)}
<p class="caption">¹ Unweighted AUROC intervals resample primary sampling units within strata and hold the model fixed. Weighted estimates use annual survey weights among complete cases. Model fitting used unweighted data.</p><details><summary>Compare the models</summary>${table('Unweighted model comparisons', ['Model', '2024 test AUROC', '2025 AUROC', '2025 Brier'], headToHead)}<p class="caption">The constant model uses training prevalence. Against the full Andersen theory-based model, the primary model's 2025 AUROC gain has a paired 95% bootstrap interval of +${deltaLo.toFixed(4)} to +${deltaHi.toFixed(4)}.</p></details></section>
${attribution}<section class="panel"><h2>Calibration in 2025</h2><div class="calibration-layout"><div><p>The weighted share reporting use was <strong>${populationMeans[0].toFixed(2)}%</strong>. The model predicted <strong>${populationMeans[1].toFixed(2)}%</strong> on average. The gap was <strong>${signed(gap)} percentage points</strong> (design-based 95% CI ${signed(lower)} to ${signed(upper)}).</p><p class="caption">Each bar compares observed and predicted shares in one ten-point probability band. A positive gap indicates underprediction. The uppermost occupied band contains ${formatCount(bands.at(-1).n)} sampled adults.</p></div>${calibrationBars()}</div><details><summary>View calibration values and sample sizes</summary>${table(
  'Survey-weighted calibration by predicted probability',
  ['Predicted band', 'Sample count', 'Mean predicted', 'Observed', 'Gap (pp)'],
  bands.map((b) => [
    b.label,
    formatCount(b.n),
    b.predicted.toFixed(2) + '%',
    b.observed.toFixed(2) + '%',
    signed(b.difference),
  ]),
)}</details></section>
${attribution}<section class="panel"><h2>Scope and limitations</h2><p>The 2025 evaluation measures performance in a new sample from the same survey. Earlier iterations examined both evaluation samples. Screening and the outcome-proxy diagnostic preceded cross-validation, and XGBoost tuning was outside the nested comparison.</p><p>Complete-case requirements differ from the population trends. The survey weights do not correct for exclusions specific to this model.</p></section>
${attribution}<section class="panel"><h2>Analysis materials</h2><div class="resource-row"><a href="${study}/guide.html">Study guide</a><a href="${reportPath}">Full analysis report</a><a href="${study}/figures/study_design.pdf">Study design (PDF)</a><a href="${study}/model_export/model_coefficients.csv" download>Model coefficients (CSV)</a><a href="${study}/supplementary/codebook_verification.csv" download>Codebook checks (CSV)</a></div>
${attribution}<details><summary>Download analysis and scoring files</summary>
<h3>Reproduce the analysis</h3><div class="resource-row"><a href="${study}/nhis_telehealth_prediction_final.Rmd" download>Analysis notebook (R Markdown)</a><a href="${study}/figures/study_design.png" download>Study design (PNG)</a><a href="${study}/supplementary/variable_screening.csv" download>Variable screening (CSV)</a></div>
<h3>Score the regression models</h3><div class="resource-row"><a href="${study}/model_export/predict_from_csv.R" download>Scoring function (R)</a><a href="${study}/model_export/coding_dictionary.csv" download>Coding dictionary (CSV)</a><a href="${study}/model_export/factor_levels.csv" download>Factor levels (CSV)</a><a href="${study}/model_export/spline_knots.csv" download>Spline knots (CSV)</a></div>
<h3>Recreate XGBoost predictions</h3><div class="resource-row"><a href="${study}/model_export/xgb_full_pool.json" download>Fitted model (JSON)</a><a href="${study}/model_export/xgb_features.csv" download>Ordered features (CSV)</a><a href="${study}/model_export/xgb_settings.csv" download>Tuning settings (CSV)</a></div>
</details></section>
${attribution}${footer}</main></body></html>`;

// author: Yao Yao(yay4008@med.cornell.edu)
const config = await resolveConfig(path.join(root, 'index.html'), {
  config: path.join(root, 'prettier.config.cjs'),
});
await writeFile(
  path.join(root, 'validation.html'),
  await format(html, {...config, parser: 'html'}),
);
