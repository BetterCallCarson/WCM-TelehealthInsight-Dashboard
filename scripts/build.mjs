// Author: Jiajun (Carson) Chen
// email: jic4015@med.cornell.edu
/**
 * @fileoverview Recreates the static distribution from an explicit publish allowlist.
 * Only aggregate data and reproduction code are copied; .work never ships.
 * The generated documentation is refreshed before files are copied.
 */
import {cp, mkdir, rm} from 'node:fs/promises';
import path from 'node:path';
import './render-docs.mjs';
// author: Yao Yao(yay4008@med.cornell.edu)
// Publish validation results from the fixed analysis report.
import './render-validation.mjs';
const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dist');
await rm(dist, {recursive: true, force: true});
await mkdir(dist, {recursive: true});
for (const file of [
  'index.html',
  'styles.css',
  'app.js',
  'charts.js',
  'comparisons.js',
  'cms-live.js',
  // author: Yao Yao(yay4008@med.cornell.edu)
  'validation.html',
  'validation.css',
  'documentation.html',
  'documentation.css',
  'documentation.js',
  'assets',
  'data',
  'README.md',
]) {
  await cp(path.join(root, file), path.join(dist, file), {recursive: true});
}
await mkdir(path.join(dist, 'scripts'), {recursive: true});
for (const file of ['cms_acs.py', 'nhis.py', 'nhis.R', 'meps.py']) {
  await cp(path.join(root, 'scripts', file), path.join(dist, 'scripts', file));
}
// author: Yao Yao(yay4008@med.cornell.edu)
// Select research artifacts explicitly so a local re-knit cannot publish respondents or caches.
const prediction = 'analysis/prediction';
const artifacts = [
  'README.md',
  'guide.html',
  'nhis_telehealth_prediction_final.Rmd',
  'nhis_telehealth_prediction_final.html',
  'figures/study_design.png',
  'figures/study_design.pdf',
  'supplementary/codebook_verification.csv',
  'supplementary/variable_screening.csv',
  ...[
    'README.md',
    'coding_dictionary.csv',
    'factor_levels.csv',
    'model_coefficients.csv',
    'predict_from_csv.R',
    'spline_knots.csv',
    'xgb_features.csv',
    'xgb_full_pool.json',
    'xgb_settings.csv',
  ].map((name) => 'model_export/' + name),
];
for (const artifact of artifacts) {
  const relativePath = path.join(prediction, artifact);
  await cp(path.join(root, relativePath), path.join(dist, relativePath));
}
console.log('Static site built in dist/ — aggregate data only.');

// Reapply attribution after regenerating HTML and copying build artifacts.
await import('./add-author-headers.mjs');
