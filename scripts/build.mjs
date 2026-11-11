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
  'documentation.html',
  'documentation.css',
  'documentation.js',
  'assets',
  'data',
  'docs',
  'README.md',
]) {
  await cp(path.join(root, file), path.join(dist, file), {recursive: true});
}
await mkdir(path.join(dist, 'scripts'), {recursive: true});
for (const file of ['cms_acs.py', 'nhis.py', 'nhis.R', 'meps.py']) {
  await cp(path.join(root, 'scripts', file), path.join(dist, 'scripts', file));
}
console.log('Static site built in dist/ — aggregate data only.');

// Reapply attribution after regenerating HTML and copying build artifacts.
await import('./add-author-headers.mjs');
