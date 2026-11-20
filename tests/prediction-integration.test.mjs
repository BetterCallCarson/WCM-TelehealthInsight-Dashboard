// author: Yao Yao(yay4008@med.cornell.edu)
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

// author: Yao Yao(yay4008@med.cornell.edu)
// The GitHub Pages repository lives under a path prefix. A site-root slash would
// open the account homepage and a view fragment would leave #states in the URL.
test('brand links resolve to the project home from each research page', async () => {
  const home = new URL('https://example.org/WCM-TelehealthInsight-Dashboard/');
  for (const page of ['index.html', 'documentation.html', 'validation.html']) {
    const html = await readFile(new URL('../' + page, import.meta.url), 'utf8');
    const brand = html.match(
      /<a\b[^>]*\bclass="[^"]*\bproject-brand\b[^"]*"[^>]*>/i,
    );
    assert.ok(brand, page);
    const href = brand[0].match(/\bhref="([^"]+)"/);
    assert.ok(href, page);
    assert.equal(
      new URL(href[1], new URL(page + '#people', home)).href,
      home.href,
    );
  }
});

// author: Yao Yao(yay4008@med.cornell.edu)
// Prediction is a top-level destination on both the dashboard and its reference pages.
test('primary navigation exposes a standalone Prediction page', async () => {
  for (const page of ['index.html', 'documentation.html', 'validation.html']) {
    const html = await readFile(new URL('../' + page, import.meta.url), 'utf8');
    const menu = html.match(/<nav class="site-nav"[^>]*>([\s\S]*?)<\/nav>/)[1];
    assert.match(
      menu.replace(/\s+/g, ' '),
      /<a href="\.\/validation\.html"[^>]*>\s*Prediction\s*<\/a\s*>/,
    );
    if (page === 'validation.html') {
      assert.match(menu, /href="\.\/validation\.html"[^>]*aria-current="page"/);
      assert.match(html, /href="\.\/analysis\/prediction\/guide\.html"/);
    }
  }
});
