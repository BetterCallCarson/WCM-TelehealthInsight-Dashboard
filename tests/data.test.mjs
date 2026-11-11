// Author: Jiajun (Carson) Chen
// email: jic4015@med.cornell.edu
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const read = async (name) =>
  JSON.parse(
    await readFile(new URL(`../data/${name}.json`, import.meta.url), 'utf8'),
  );
const [cms, nhis, meps] = await Promise.all(['cms', 'nhis', 'meps'].map(read));
const sum = (items, key) => items.reduce((total, item) => total + item[key], 0);
const near = (actual, expected, tolerance = 1e-5) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${actual} differs from ${expected}`,
  );
const finite = (value, path = 'root') => {
  if (typeof value === 'number') {
    assert.ok(Number.isFinite(value), `Nonfinite number at ${path}`);
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      finite(item, `${path}.${key}`);
    }
  }
};
const interval = (row, upper = Infinity) => {
  assert.ok(Number.isFinite(row.estimate));
  assert.ok(row.ci_low >= 0 && row.ci_low <= row.estimate);
  assert.ok(row.ci_high >= row.estimate && row.ci_high <= upper);
};

test('published aggregates have finite values and fingerprinted official sources', () => {
  for (const dataset of [cms, nhis, meps]) {
    finite(dataset);
  }
  const sources = [...cms.sources, ...meps.provenance, nhis.provenance];
  for (const source of sources) {
    assert.match(source.sha256, /^[a-f0-9]{64}$/);
    const url = new URL(source.url);
    assert.equal(url.protocol, 'https:');
    assert.ok(
      /(^|\.)(cms\.gov|census\.gov|cdc\.gov|ahrq\.gov)$/.test(url.hostname),
    );
    assert.match(source.accessDate ?? source.accessed, /^\d{4}-\d{2}-\d{2}$/);
  }
});

test('CMS covers all 50 states and DC, with distinct annual and quarterly periods', () => {
  assert.equal(cms.states.length, 51);
  assert.equal(new Set(cms.states.map((s) => s.fips)).size, 51);
  assert.equal(new Set(cms.states.map((s) => s.abbr)).size, 51);
  assert.ok(cms.states.some((s) => s.abbr === 'DC'));
  assert.ok(!cms.states.some((s) => ['PR', 'VI', 'GU'].includes(s.abbr)));
  assert.deepEqual(cms.years, [2020, 2021, 2022, 2023, 2024, 2025]);
  for (const location of [...cms.states, cms.national]) {
    assert.equal(location.annual.length, 6);
    assert.equal(location.quarterly.length, 24);
    for (const year of cms.years) {
      assert.equal(
        location.annual.filter((x) => x.year === year && x.quarter === null)
          .length,
        1,
      );
      assert.deepEqual(
        location.quarterly.filter((x) => x.year === year).map((x) => x.quarter),
        [1, 2, 3, 4],
      );
    }
    for (const row of [...location.annual, ...location.quarterly]) {
      assert.ok(
        row.telehealthUsers >= 0 && row.telehealthUsers <= row.eligibleUsers,
      );
      assert.ok(row.eligibleUsers > 0);
      assert.ok(row.telehealthPct >= 0 && row.telehealthPct <= 100);
      // CMS publishes rounded rates; denominator must be eligible users, not enrollment.
      near(
        row.telehealthPct,
        (100 * row.telehealthUsers) / row.eligibleUsers,
        0.005001,
      );
      near(
        row.recalculatedPct,
        (100 * row.telehealthUsers) / row.eligibleUsers,
        1e-7,
      );
    }
  }
  assert.equal(cms.quality.cmsRetainedRows, 52 * 30);
  assert.equal(cms.quality.cmsDuplicateKeys, 0);
});

test('ACS estimates are 2024 household context with positive 90% margins of error', () => {
  for (const state of cms.states) {
    const context = state.acs2024;
    assert.equal(context.year, 2024);
    assert.ok(
      context.households > 0 &&
        context.broadbandHouseholds <= context.households,
    );
    near(
      context.broadbandPct,
      (100 * context.broadbandHouseholds) / context.households,
    );
    assert.ok(context.broadbandMoe90 > 0 && context.incomeMoe90 > 0);
    assert.ok(context.medianIncome > 0);
  }
  assert.equal(cms.associations.year, 2024);
  assert.equal(cms.associations.n, 51);
  for (const key of ['broadbandPearsonR', 'incomePearsonR']) {
    assert.ok(Math.abs(cms.associations[key]) <= 1);
  }
});

test('CMS adjusted model matches independent centered OLS and HC3 calculations', () => {
  const model = cms.associations.adjustedModel;
  assert.equal(model.year, 2024);
  assert.equal(model.n, 51);
  assert.equal(model.parameters, 3);
  assert.equal(model.residualDf, 48);
  assert.deepEqual(
    model.coefficients.map((t) => t.term),
    ['intercept', 'broadbandPct', 'medianIncomePer10000'],
  );
  const points = cms.states.map((s) => [
    s.acs2024.broadbandPct,
    s.acs2024.medianIncome / 10000,
    s.annual.find((r) => r.year === 2024).telehealthPct,
  ]);
  const n = points.length;
  const means = [0, 1, 2].map(
    (k) => points.reduce((total, p) => total + p[k], 0) / n,
  );
  const centered = points.map((p) => p.map((v, k) => v - means[k]));
  const cross = (a, b) => centered.reduce((total, p) => total + p[a] * p[b], 0);
  const xx = cross(0, 0);
  const zz = cross(1, 1);
  const xz = cross(0, 1);
  const xy = cross(0, 2);
  const zy = cross(1, 2);
  const determinant = xx * zz - xz * xz;
  assert.ok(determinant > 0);
  const broadband = (xy * zz - zy * xz) / determinant;
  const income = (zy * xx - xy * xz) / determinant;
  const intercept = means[2] - broadband * means[0] - income * means[1];
  const coefficients = [intercept, broadband, income];
  const errors = points.map(
    (p) => p[2] - intercept - broadband * p[0] - income * p[1],
  );
  // Orthogonality checks the actual least-squares fit independently of its audit metadata.
  near(
    errors.reduce((total, e) => total + e, 0),
    0,
    1e-8,
  );
  for (const k of [0, 1]) {
    near(
      errors.reduce((total, e, i) => total + e * centered[i][k], 0),
      0,
      1e-8,
    );
  }
  const variances = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const [dx, dz] = centered[i];
    const h =
      1 / n + (zz * dx * dx - 2 * xz * dx * dz + xx * dz * dz) / determinant;
    assert.ok(h > 0 && h < 1);
    const slopeWeightX = (zz * dx - xz * dz) / determinant;
    const slopeWeightZ = (xx * dz - xz * dx) / determinant;
    const linearWeights = [
      1 / n - means[0] * slopeWeightX - means[1] * slopeWeightZ,
      slopeWeightX,
      slopeWeightZ,
    ];
    for (let k = 0; k < 3; k++) {
      variances[k] += ((linearWeights[k] * errors[i]) / (1 - h)) ** 2;
    }
  }
  for (let k = 0; k < 3; k++) {
    const term = model.coefficients[k];
    near(term.estimate, coefficients[k], 1e-6);
    near(term.se, Math.sqrt(variances[k]), 1e-6);
    near(term.ciLow, term.estimate - 1.959963984540054 * term.se, 3e-8);
    near(term.ciHigh, term.estimate + 1.959963984540054 * term.se, 3e-8);
  }
  const sse = errors.reduce((total, e) => total + e * e, 0);
  const sst = cross(2, 2);
  near(model.rSquared, 1 - sse / sst, 1e-8);
  near(model.adjustedRSquared, 1 - sse / 48 / (sst / 50), 1e-8);
});

test('NHIS source, outcome and grouping denominators reconcile without complete-case deletion', () => {
  assert.equal(nhis.quality.raw_n, 32629);
  assert.equal(nhis.quality.missing_outcome_n, 305);
  assert.equal(nhis.overall.n, 32324);
  assert.equal(nhis.overall.yes_n, 8293);
  assert.equal(
    nhis.overall.n + nhis.quality.missing_outcome_n,
    nhis.quality.raw_n,
  );
  for (const [name, rows] of Object.entries(nhis.groups)) {
    for (const row of rows) {
      interval(row, 100);
      assert.equal(row.raw_group_n, row.n + row.missing_outcome_n);
      assert.ok(
        row.yes_n <= row.n &&
          row.weighted_denominator > 0 &&
          row.standard_error > 0,
      );
    }
    const missing = nhis.quality.missingness.find((x) => x.group === name);
    if (missing) {
      assert.equal(sum(rows, 'raw_group_n') + missing.n, nhis.quality.raw_n);
      assert.equal(
        sum(rows, 'n') + missing.among_valid_outcome_n,
        nhis.overall.n,
      );
    }
  }
  interval(nhis.overall, 100);
  assert.ok(nhis.quality.audit.maximum_absolute_difference < 1e-10);
});

test('NHIS adjusted associations use a reconciled complete-case sample and odds-ratio intervals', () => {
  const model = nhis.adjusted_model;
  assert.equal(model.n, 32027);
  assert.equal(model.yes_n, 8233);
  assert.equal(model.excluded_n, 602);
  assert.equal(model.n + model.excluded_n, nhis.quality.raw_n);
  assert.ok(model.n < nhis.overall.n);
  assert.equal(model.quality.converged, true);
  assert.equal(model.quality.rank, model.terms.length + 1);
  assert.ok(model.quality.residual_df > 0);
  assert.ok(model.quality.coefficient_audit_max_difference < 1e-8);
  let remaining = nhis.quality.raw_n;
  for (const step of model.exclusion_flow) {
    remaining -= step.excluded_at_step;
    assert.equal(remaining, step.remaining_n);
  }
  assert.equal(remaining, model.n);
  assert.equal(sum(model.exclusion_flow, 'excluded_at_step'), model.excluded_n);
  for (const term of model.terms) {
    assert.ok(
      term.odds_ratio > 0 &&
        term.ci_low > 0 &&
        term.ci_low <= term.odds_ratio &&
        term.ci_high >= term.odds_ratio,
    );
    near(Math.exp(term.log_odds_coefficient), term.odds_ratio, 1e-8);
    assert.ok(
      term.standard_error > 0 && term.p_value >= 0 && term.p_value <= 1,
    );
    // Wald limits are symmetric on the log-odds scale, not the OR scale.
    near(
      (Math.log(term.ci_low) + Math.log(term.ci_high)) / 2,
      term.log_odds_coefficient,
      1e-8,
    );
    assert.ok(term.reference && term.group);
  }
});

test('MEPS source counts distinguish zero weights, structural missingness and unknown modality', () => {
  const q = meps.quality;
  assert.equal(q.source_event_n, 145818);
  assert.equal(q.analytic_visit_n, 144206);
  assert.equal(q.zero_weight_visit_n, 1612);
  assert.equal(q.analytic_visit_n + q.zero_weight_visit_n, q.source_event_n);
  assert.equal(q.inapplicable_modality_source_n, 132199);
  assert.equal(q.telehealth_source_n, 13619);
  assert.equal(q.unknown_remote_modality_source_n, 70);
  assert.equal(
    q.telehealth_source_n + q.inapplicable_modality_source_n,
    q.source_event_n,
  );
  assert.equal(q.unmatched_person_n, 0);
  assert.equal(q.unknown_insurance_analytic_n, 0);
  assert.equal(
    Object.values(q.imputation_flag_source_counts).reduce((a, b) => a + b, 0),
    q.source_event_n,
  );
  assert.ok(
    q.imputation_flag_source_counts['3'] > 0,
    'Released payments must retain the imputation disclosure',
  );
  assert.ok(Object.values(q.checks).every((x) => x === true));
});

test('MEPS modality shares, insurance domains and payment sample sizes reconcile', () => {
  const all = meps.groups.find((x) => x.insurance === 'All');
  const insured = meps.groups.filter((x) => x.insurance !== 'All');
  assert.deepEqual(all, meps.overall);
  assert.equal(sum(insured, 'n'), all.n);
  near(
    insured.reduce((s, x) => s + x.telehealth_pct.weighted_denominator, 0),
    all.telehealth_pct.weighted_denominator,
    0.001,
  );
  near(
    insured.reduce(
      (s, x) =>
        s + x.telehealth_pct.weighted_denominator * x.telehealth_pct.estimate,
      0,
    ) / all.telehealth_pct.weighted_denominator,
    all.telehealth_pct.estimate,
  );
  for (const group of meps.groups) {
    assert.equal(sum(group.modalities, 'n'), group.n);
    near(
      group.modalities.reduce((s, x) => s + x.share_pct.estimate, 0),
      100,
    );
    near(
      group.modalities
        .filter((x) => x.modality !== 'In person')
        .reduce((s, x) => s + x.share_pct.estimate, 0),
      group.telehealth_pct.estimate,
    );
    interval(group.telehealth_pct, 100);
    for (const modality of group.modalities) {
      assert.equal(
        modality.share_pct.n,
        group.n,
        'Modality share denominator is all visits in the group',
      );
      interval(modality.share_pct, 100);
      for (const metric of ['total_payment', 'family_payment']) {
        const payment = modality[metric];
        assert.equal(
          payment.n,
          modality.n,
          'Payment denominator is visits in that modality',
        );
        assert.ok(payment.n_persons <= payment.n);
        if (!modality.n) {
          assert.equal(payment.estimate, null);
          assert.equal(payment.ci_low, null);
          assert.equal(payment.ci_high, null);
          assert.equal(payment.unstable, true);
        } else {
          interval(payment);
          if (payment.n_persons < 30) {
            assert.equal(payment.unstable, true);
          }
        }
      }
      if (modality.n > 0) {
        assert.ok(
          modality.family_payment.estimate <= modality.total_payment.estimate,
        );
      }
    }
  }
  const uninsured = insured.find((x) => x.insurance === 'Uninsured all year');
  assert.equal(
    uninsured.modalities.find((x) => x.modality === 'Unknown remote').n,
    0,
  );
  assert.equal(
    uninsured.modalities.find((x) => x.modality === 'Unknown remote')
      .total_payment.estimate,
    null,
  );
});
