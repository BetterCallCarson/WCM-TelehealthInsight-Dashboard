// Author: Jiajun (Carson) Chen
// email: jic4015@med.cornell.edu
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {extractReportSection} from '../scripts/report-sections.mjs';

test('public documentation retains field headings and links without neighboring report sections', () => {
  const report = `<a id="data-manual"></a>
## 4. Manual
Intro with [data](./data/cms.json).
### Fields
The denominator is eligible users.
#### Units
Percent, not fraction.
<a id="engineering"></a>
## 5. Engineering
Private maintenance instructions.
`;
  const manual = extractReportSection(report, 'data-manual');
  assert.match(manual, /^# 4\. Manual/);
  assert.match(manual, /\[data\]\(\.\/data\/cms\.json\)/);
  assert.match(manual, /^## Fields$/m);
  assert.match(manual, /^### Units$/m);
  assert.doesNotMatch(manual, /Engineering|Private maintenance|<a id=/);
});

test('missing, duplicated, and empty report sections fail instead of publishing incomplete documentation', () => {
  assert.throws(
    () => extractReportSection('# Report', 'data-manual'),
    /exactly one/,
  );
  assert.throws(
    () =>
      extractReportSection(
        '<a id="data-manual"></a>\n<a id="data-manual"></a>',
        'data-manual',
      ),
    /exactly one/,
  );
  assert.throws(
    () =>
      extractReportSection(
        '<a id="data-manual"></a>\n## Manual\n',
        'data-manual',
      ),
    /no documentation/,
  );
});

test('shipped README supplies both public documents with distinct source scope', async () => {
  const report = await readFile(
    new URL('../README.md', import.meta.url),
    'utf8',
  );
  const quality = extractReportSection(report, 'methods-and-quality');
  const manual = extractReportSection(report, 'data-manual');
  assert.match(quality, /SHA-256 fingerprints/);
  assert.match(manual, /CMS and ACS data fields/);
  assert.match(manual, /MEPS data fields/);
  assert.doesNotMatch(quality, /## 3\. Results and validation/);
  assert.doesNotMatch(manual, /Code documentation and formatting conventions/);
});
