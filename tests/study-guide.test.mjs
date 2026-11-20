// author: Yao Yao(yay4008@med.cornell.edu)
import assert from 'node:assert/strict';
import {access, readFile} from 'node:fs/promises';
import test from 'node:test';

// author: Yao Yao(yay4008@med.cornell.edu)
// A raw Markdown response from Pages or the local preview exposes source comments.
// The published HTML should preserve the guide's commands and working deep links.
test('research guide renders its content and keeps source attribution private to markup', async () => {
  const guide = new URL('../analysis/prediction/guide.html', import.meta.url);
  const html = await readFile(guide, 'utf8');
  const visibleMarkup = html.replace(/<!--[\s\S]*?-->/g, '');
  assert.doesNotMatch(visibleMarkup, /Yao Yao|yay4008|&lt;!--\s*author:/i);
  assert.match(visibleMarkup, /<pre><code>Rscript/);
  assert.match(visibleMarkup, /id="study-models-and-scoring"/);
  const hrefs = Array.from(html.matchAll(/\bhref="([^"]+)"/g), (m) => m[1]);
  for (const href of hrefs) {
    const url = new URL(href, guide);
    if (url.protocol === 'file:') {
      url.hash = '';
      await access(url);
    }
  }
});
