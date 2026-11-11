// Author: Jiajun (Carson) Chen
// email: jic4015@med.cornell.edu
/**
 * @fileoverview Extracts public documentation from the canonical README report.
 * Stable anchors select content; surrounding report sections must not leak into
 * the public data-quality/manual tabs when report numbering changes.
 */

/**
 * Extracts one anchored report section and restores standalone heading levels.
 *
 * @param {string} report Full README Markdown.
 * @param {string} anchor Stable section anchor without the leading hash.
 * @return {string} Standalone Markdown with the original links and prose.
 * @throws {Error} If the anchor is missing/duplicated or its section is empty.
 */
export function extractReportSection(report, anchor) {
  const marker = `<a id="${anchor}"></a>`;
  const parts = report.split(marker);
  if (parts.length !== 2) {
    throw new Error(`README must contain exactly one ${anchor} anchor.`);
  }
  const remainder = parts[1];
  const heading = remainder.match(/^\s*## ([^\n]+)\n/);
  if (!heading) {
    throw new Error(
      `README section ${anchor} must start with a level-two heading.`,
    );
  }
  const content = remainder.slice(heading[0].length);
  const nextSection = content.search(/^## /m);
  // The next section's anchor precedes its heading, so discard anchor-only lines.
  // Inline field examples and download links remain unchanged.
  const body = (nextSection < 0 ? content : content.slice(0, nextSection))
    .replace(/^<a id="[^"]+"><\/a>\s*$/gm, '')
    .replace(/^(#{3,6}) /gm, (_, hashes) => hashes.slice(1) + ' ')
    .trim();
  if (!body) {
    throw new Error(`README section ${anchor} has no documentation content.`);
  }
  return `# ${heading[1]}\n\n${body}\n`;
}
