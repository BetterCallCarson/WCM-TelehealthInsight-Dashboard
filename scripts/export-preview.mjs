// Author: Jiajun (Carson) Chen
// email: jic4015@med.cornell.edu
/**
 * @fileoverview Builds optional self-contained HTML previews from canonical modules.
 * Transforms are checked for exactly one match so source changes fail loudly.
 * The bundle embeds verified aggregates and keeps CMS checks opt-in.
 */
import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import {format, resolveConfig} from 'prettier';

// Standalone snapshots embed verified data. Live CMS requests remain opt-in.
const root = path.resolve(import.meta.dirname, '..');
// Programmatic formatting does not load project settings automatically.
// Use the same explicit config as the CLI to keep generated HTML consistent.
const formattingOptions = await resolveConfig(path.join(root, 'index.html'), {
  config: path.join(root, 'prettier.config.cjs'),
});
const names = ['cms', 'nhis', 'meps'];
const [
  html,
  css,
  chartsSource,
  appSource,
  liveSource,
  comparisonSource,
  ...dataSources
] = await Promise.all([
  ...[
    'index.html',
    'styles.css',
    'charts.js',
    'app.js',
    'cms-live.js',
    'comparisons.js',
  ].map((file) => readFile(path.join(root, file), 'utf8')),
  ...names.map((name) =>
    readFile(path.join(root, 'data', `${name}.json`), 'utf8'),
  ),
]);
const previewData = Object.fromEntries(
  names.map((name, i) => [name, JSON.parse(dataSources[i])]),
);
/**
 * Replaces one known source construct, rejecting missing or ambiguous matches.
 * @param {string} source Input module or HTML text.
 * @param {(string|RegExp)} needle Literal or formatting-tolerant pattern.
 * @param {string} replacement Literal replacement; dollar signs are not expanded.
 * @param {string} description Construct name for a useful build error.
 * @return {string} Updated source.
 * @throws {Error} If the construct is absent or occurs more than once.
 */
function replaceOnce(source, needle, replacement, description) {
  if (
    (typeof needle === 'string'
      ? source.split(needle).length - 1
      : [
          ...source.matchAll(
            new RegExp(
              needle.source,
              [...new Set(needle.flags + 'g')].join(''),
            ),
          ),
        ].length) !== 1
  ) {
    throw Error(`Preview export expected exactly one ${description}.`);
  }
  return source.replace(needle, () => replacement);
}
const imports =
  appSource.match(
    /^import\s+\{[^}]+\}\s+from\s+['"]\.\/charts\.js['"];?\s*$/gm,
  ) || [];
if (imports.length !== 1) {
  throw Error('Preview export requires one charts import.');
}
const aliases = imports[0]
  .match(/\{([^}]+)\}/)[1]
  .split(',')
  .map((s) => s.trim())
  .filter((s) => /\s+as\s+/.test(s))
  .map((s) => {
    const [name, alias] = s.split(/\s+as\s+/);
    if (!/^\w+$/.test(name) || !/^\w+$/.test(alias)) {
      throw Error('Unexpected import alias.');
    }
    return `const ${alias}=${name};`;
  })
  .join('\n');
let app = appSource.replace(imports[0], '');
app = replaceOnce(
  app,
  /^import\s+\{[^}]+\}\s+from\s+['"]\.\/cms-live\.js['"];?\s*$/m,
  '',
  'live CMS import',
);
app = replaceOnce(
  app,
  /^import\s+\{[^}]+\}\s+from\s+['"]\.\/comparisons\.js['"];?\s*$/m,
  '',
  'comparison charts import',
);
app = replaceOnce(
  app,
  /const\s+res\s*=\s*await\s+fetch\(\s*`\.\/data\/\$\{name\}\.json`\s*\)/,
  'const res={ok:true,json:async()=>__previewData[name]}',
  'aggregate data fetch',
);
const live = liveSource.replace(/^export\s+/gm, '');
if (/^\s*(import|export)\s/m.test(live)) {
  throw Error('Unbundled live CMS dependency.');
}
// Isolate live-client helpers from chart/application names.
const client = `const {fetchCmsUpdates}=(()=>{\n${live}\nreturn {fetchCmsUpdates};\n})();`;
const dataJson = JSON.stringify(previewData)
  .replace(/</g, '\\u003c')
  .replace(/>/g, '\\u003e')
  .replace(/&/g, '\\u0026')
  .replace(/\u2028/g, '\\u2028')
  .replace(/\u2029/g, '\\u2029');
/**
 * Bundles chart modules, isolated CMS helpers, and application code into HTML.
 *
 * JSON and script-closing sequences are escaped for their embedding contexts.
 * A syntax check runs before any output is written; no browser execution occurs.
 *
 * @param {string} pageHtml Source dashboard HTML.
 * @param {string} pageCss Theme-specific CSS.
 * @param {string} chartModule Chart source using the selected palette.
 * @return {string} Standalone page with embedded verified data.
 * @throws {Error} If an expected marker, module boundary, or syntax check fails.
 */
function snapshot(pageHtml, pageCss, chartModule) {
  const charts = chartModule.replace(/^export\s+/gm, '');
  if (/^\s*(import|export)\s/m.test(`${charts}\n${app}`)) {
    throw Error('Unbundled application module.');
  }
  const code = `(()=>{\n'use strict';\nconst __previewData=JSON.parse(document.getElementById('telehealth-preview-data').textContent);\n${charts}\n${comparisonSource.replace(/^export\s+/gm, '')}\n${aliases}\n${client}\n${app}\n})();`;
  new vm.Script(code, {filename: 'preview-inline.js'});
  let output = replaceOnce(
    pageHtml,
    /<link\b(?=[^>]*\brel="stylesheet")(?=[^>]*\bhref="\.\/styles\.css")[^>]*>/,
    `<style>\n${pageCss.replace(/<\/style/gi, '<\\/style')}\n</style>`,
    'stylesheet',
  );
  output = replaceOnce(
    output,
    /<script\b(?=[^>]*\btype="module")(?=[^>]*\bsrc="\.\/app\.js")[^>]*>\s*<\/script>/,
    '',
    'application module',
  );
  return replaceOnce(
    output,
    '</body>',
    `<script type="application/json" id="telehealth-preview-data">${dataJson}</script>\n<script>\n${code.replace(/<\/script/gi, '<\\/script')}\n</script>\n</body>`,
    'closing body',
  );
}
const output = await format(snapshot(html, css, chartsSource), {
  ...formattingOptions,
  filepath: 'preview.html',
});
await writeFile(path.join(root, 'preview.html'), output);
// Retain the earlier palette for comparison, with current researcher-facing copy.
const keynoteCss =
  css +
  `\n:root{--paper:#f4f6f7;--white:#fff;--surface:#eceff1;--ink:#202325;--secondary:#50585e;--muted:#606970;--line:#dbe0e3;--accent:#006b60;--series:#16766c;--pale:#e9eef0;--selection:#dbeee7;--comparison:#7b8991;--control-border:#c9d1d6;--map-low:#e5f3f0;--map-mid-light:#9fc2c1;--map-mid-dark:#599091;--map-high:#145f62;--grid:#e4e8eb;--note:#edf5f2;--note-border:#8ab7a8;--row-hover:#f1f5f6;--warning-bg:#fff1d6;--warning:#87520a;--error:#9b3b30}.primary-button:hover{background:#00584f}\n`;
const keynoteCharts = replaceOnce(
  chartsSource,
  /const stops\s*=\s*\[[\s\S]*?\];/,
  'const stops = [[229,243,240],[159,194,193],[89,144,145],[20,95,98]];',
  'map palette',
);
const keynoteHtml = html.replace(
  'name="theme-color" content="#ffffff"',
  'name="theme-color" content="#f4f6f7"',
);
await writeFile(
  path.join(root, 'preview-keynote.html'),
  await format(snapshot(keynoteHtml, keynoteCss, keynoteCharts), {
    ...formattingOptions,
    filepath: 'preview-keynote.html',
  }),
);
console.log(
  `Created preview.html (${Math.round(Buffer.byteLength(output) / 1024)} KB) and the current-copy palette comparison.`,
);

// Reapply attribution after regenerating HTML and copying build artifacts.
await import('./add-author-headers.mjs');
