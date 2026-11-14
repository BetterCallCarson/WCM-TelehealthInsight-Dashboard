// Author: Jiajun (Carson) Chen
// email: jic4015@med.cornell.edu
/**
 * @fileoverview Renders two README report sections into one independent documentation page.
 * Only the supported Markdown subset is interpreted; raw HTML is escaped.
 * The dashboard sidebar is reused to keep product identity and links consistent.
 */
import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {extractReportSection} from './report-sections.mjs';
import {format, resolveConfig} from 'prettier';

const root = path.resolve(import.meta.dirname, '..');
// Programmatic formatting does not load project settings automatically.
// Use the same explicit config as the CLI to keep generated HTML consistent.
const formattingOptions = await resolveConfig(path.join(root, 'index.html'), {
  config: path.join(root, 'prettier.config.cjs'),
});
const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[
        char
      ],
  );

// The two maintained research documents use a deliberately small Markdown
// vocabulary. Raw HTML is escaped; no remote parser or browser fetch is needed.
/**
 * Rewrites documentation-relative links for the generated page location.
 * @param {string} url Source link target.
 * @return {string} Dashboard-relative or unchanged external target.
 */
function pageLink(url) {
  if (/(?:^|\/)DATA_QUALITY\.md(?:#.*)?$/i.test(url)) {
    return './documentation.html#data-quality';
  }
  if (/(?:^|\/)DATA_DICTIONARY\.md(?:#.*)?$/i.test(url)) {
    return './documentation.html#data-manual';
  }
  if (url.startsWith('../')) {
    return './' + url.slice(3);
  }
  return url;
}
/**
 * Renders inline code, links, and emphasis without allowing raw HTML.
 *
 * Temporary tokens protect code and generated links from repeated escaping.
 * README links become text because that report is not a public navigation item.
 * This is a renderer for reviewed repository documents, not an untrusted CMS.
 *
 * @param {string} source Inline Markdown from a maintained document.
 * @return {string} Escaped text with supported markup.
 */
function inline(source) {
  const tokens = [];
  const token = (html) => {
    const id = tokens.push(html) - 1;
    return `\u0000${id}\u0000`;
  };
  let text = source.replace(/`([^`]+)`/g, (_, code) =>
    token(`<code>${escapeHtml(code)}</code>`),
  );
  text = escapeHtml(text);
  text = text.replace(/\[([^\]]+)\]\(([^\s)]+)\)/g, (_, label, rawUrl) => {
    const url = rawUrl.replace(/&amp;/g, '&');
    if (/(?:^|\/)README\.md(?:#.*)?$/i.test(url)) {
      return label;
    }
    const href = pageLink(url);
    if (!/^(?:https?:|\.\.?\/|#|[\w.-]+(?:\/|#|$))/.test(href)) {
      return label;
    }
    return token(
      `<a href="${escapeHtml(href)}"${/^https?:/.test(href) ? ' target="_blank" rel="noreferrer"' : ''}>${label}</a>`,
    );
  });
  text = text
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');
  // Links may contain code tokens, so resolve innermost tokens as well.
  for (let i = 0; i < 3; i++) {
    text = text.replace(/\u0000(\d+)\u0000/g, (_, id) => tokens[Number(id)]);
  }
  return text;
}
/**
 * Splits a pipe table row while preserving escaped pipes and inline code.
 * @param {string} line One Markdown table row.
 * @return {!Array<string>} Trimmed cells without decorative outer pipes.
 */
function cells(line) {
  const result = [];
  let current = '';
  let code = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '`') {
      code = !code;
    }
    if (char === '\\' && line[i + 1] === '|') {
      current += '|';
      i++;
      continue;
    }
    if (char === '|' && !code) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  if (result[0] === '') {
    result.shift();
  }
  if (result.at(-1) === '') {
    result.pop();
  }
  return result;
}
const isTableRule = (line) =>
  cells(line).every((cell) => /^:?-{3,}:?$/.test(cell)) && line.includes('|');
/**
 * Converts the project's Markdown subset and records section navigation.
 *
 * Heading IDs are prefixed per document and deduplicated within that document.
 * The source title is supplied by the page template; author comments stay in
 * source metadata. Unsupported raw HTML remains visible escaped text.
 *
 * @param {string} markdown Full maintained Markdown document.
 * @param {string} prefix Stable document ID used in fragment links.
 * @return {{html: string, headings: !Array<!Object>}} Body and contents entries.
 * @throws {Error} If a table row has a different width from its header.
 */
function renderMarkdown(markdown, prefix) {
  // File attribution is source metadata, not content for the public documentation.
  const lines = markdown
    .replace(/^<!-- Author:[\s\S]*?-->\s*/, '')
    .replace(/\r/g, '')
    .split('\n');
  const parts = [];
  const headings = [];
  const seen = new Map();
  let section = 'Research documentation';
  const slug = (title) => {
    const base = title
      .replace(/[`*]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    const count = (seen.get(base) || 0) + 1;
    seen.set(base, count);
    return `${prefix}-${base}${count > 1 ? '-' + count : ''}`;
  };
  const startsBlock = (line, next = '') =>
    !line.trim() ||
    /^#{1,6}\s|^```|^\s*(?:[-*]|\d+\.)\s|^>/.test(line) ||
    (line.includes('|') && isTableRule(next));
  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      if (heading[1].length === 1) {
        i++;
        continue;
      }
      const level = Math.min(6, heading[1].length + 1);
      const id = slug(heading[2]);
      section = heading[2];
      headings.push({id, label: heading[2], level: heading[1].length});
      parts.push(
        `<h${level} id="${id}" tabindex="-1">${inline(heading[2])}</h${level}>`,
      );
      i++;
      continue;
    }
    if (line.includes('|') && isTableRule(lines[i + 1] || '')) {
      const headers = cells(line);
      const alignment = cells(lines[i + 1]);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(cells(lines[i]));
        i++;
      }
      if (rows.some((row) => row.length !== headers.length)) {
        throw Error(`Unbalanced table in ${prefix}: ${section}`);
      }
      const cell = (value, j, tag) =>
        `<${tag}${tag === 'th' ? ' scope="col"' : ''}${/:$/.test(alignment[j]) ? ' class="numeric"' : ''}>${inline(value)}</${tag}>`;
      parts.push(
        `<div class="doc-table-scroll" tabindex="0" role="region" aria-label="${escapeHtml(section)} table"><table class="doc-table"><thead><tr>${headers.map((value, j) => cell(value, j, 'th')).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((value, j) => cell(value, j, 'td')).join('')}</tr>`).join('')}</tbody></table></div>`,
      );
      continue;
    }
    if (line.startsWith('```')) {
      const code = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        code.push(lines[i++]);
      }
      i++;
      parts.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }
    if (/^\s*(?:[-*]|\d+\.)\s/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items = [];
      const re = ordered ? /^\s*\d+\.\s+(.+)$/ : /^\s*[-*]\s+(.+)$/;
      while (i < lines.length && re.test(lines[i])) {
        items.push(`<li>${inline(lines[i].match(re)[1])}</li>`);
        i++;
      }
      parts.push(
        `<${ordered ? 'ol' : 'ul'}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`,
      );
      continue;
    }
    if (line.startsWith('>')) {
      const quote = [];
      while (i < lines.length && lines[i].startsWith('>')) {
        quote.push(lines[i++].replace(/^>\s?/, ''));
      }
      parts.push(`<blockquote>${inline(quote.join(' '))}</blockquote>`);
      continue;
    }
    const paragraph = [line];
    i++;
    while (i < lines.length && !startsBlock(lines[i], lines[i + 1] || '')) {
      paragraph.push(lines[i]);
      i++;
    }
    parts.push(`<p>${inline(paragraph.join(' '))}</p>`);
  }
  return {html: parts.join('\n'), headings};
}
const definitions = [
  {
    id: 'data-quality',
    anchor: 'methods-and-quality',
    title: 'Data quality note',
    description:
      'Sources, analytical populations, processing decisions, and interpretation limits',
  },
  {
    id: 'data-manual',
    anchor: 'data-manual',
    title: 'Data manual',
    description:
      'Field definitions, units, recodes, and downloadable data structures',
  },
];
// README is the only maintained documentation source; no docs/ directory is needed.
const report = await readFile(path.join(root, 'README.md'), 'utf8');
const documents = definitions.map((doc) => ({
  ...doc,
  ...renderMarkdown(extractReportSection(report, doc.anchor), doc.id),
}));
const documentHtml = documents
  .map(
    (
      doc,
    ) => `<section class="research-document" id="${doc.id}" aria-labelledby="${doc.id}-title">
 <div class="document-heading"><h2 id="${doc.id}-title">${doc.title}</h2><p>${doc.description}</p></div>
 <div class="document-layout"><aside class="document-contents"><details open><summary>On this page</summary><nav aria-label="${doc.title} contents">${doc.headings.map((h) => `<a href="#${h.id}"${h.level > 2 ? ' class="subsection"' : ''}>${inline(h.label)}</a>`).join('')}</nav></details></aside><article class="document-body" aria-label="${doc.title}">${doc.html}</article></div>
</section>`,
  )
  .join('\n');
// Share the dashboard header so product identity and navigation stay consistent.
const dashboard = await readFile(path.join(root, 'index.html'), 'utf8');
const headerMatch = dashboard.match(
  /<header class="site-header">[\s\S]*?<\/header>/,
);
if (!headerMatch) {
  throw Error('Dashboard navigation header not found.');
}
const navigation = headerMatch[0]
  .replace(/href="#(states|people|visits|quality)"/g, 'href="./index.html#$1"')
  .replace(/ data-view="[^"]+"/g, '')
  .replace(/ class="active"/g, '')
  .replace(
    'class="documentation-link"',
    'class="documentation-link active" aria-current="page"',
  );
const favicon =
  dashboard.match(/<link\b(?=[^>]*\brel="icon")[^>]*>/)?.[0] ||
  '<link rel="icon" href="./assets/wcm-ti-icon.svg">';
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#ffffff"><meta name="description" content="Data quality, source provenance, variable definitions, and analytical methods for Weill Cornell Medicine Telehealth Insights.">
<title>Data documentation — Weill Cornell Medicine Telehealth Insights</title>
${favicon}<link rel="stylesheet" href="./styles.css"><link rel="stylesheet" href="./documentation.css"><script defer src="./documentation.js"></script>
</head>
<body class="documentation-page">
<a class="skip" href="#main">Skip to documentation</a>
${navigation}
<main id="main">
<section class="hero"><h1>Data documentation</h1><p>Sources, definitions, and limitations for the dashboard.</p></section>
<nav class="document-switcher" aria-label="Documentation sections"><a href="#data-quality" data-document="data-quality" aria-current="true">Data quality note</a><a href="#data-manual" data-document="data-manual">Data manual</a></nav>
${documentHtml}
<footer><span>WCM-TI · CHERY Lab</span><span>Sources retrieved November 11, 2026</span><a href="./index.html#states">Explore the dashboard ↗</a></footer>
</main>
</body></html>`;
if (/href="[^"]*README\.md/i.test(html)) {
  throw Error('README links must not appear in the public documentation.');
}
await writeFile(
  path.join(root, 'documentation.html'),
  await format(html, {...formattingOptions, filepath: 'documentation.html'}),
);
console.log(
  `Rendered research documentation: ${documents.reduce((n, doc) => n + doc.headings.length, 0)} sections in one standalone page.`,
);
