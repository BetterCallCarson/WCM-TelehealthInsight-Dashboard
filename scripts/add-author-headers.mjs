// Author: Jiajun (Carson) Chen
// email: jic4015@med.cornell.edu
/**
 * @fileoverview Maintains source attribution without claiming authorship of agency data.
 * Dependencies, raw downloads, lockfiles, and compiled caches retain their own
 * metadata. Supported data JSON uses a maintainer field instead of comments.
 */

// Keep attribution consistent in source files and generated deliverables.
// Raw downloads, dependencies, version-control internals, and compiled caches
// are excluded: their authorship belongs to their original publishers.
import {readdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const author = 'Jiajun (Carson) Chen';
const email = 'jic4015@med.cornell.edu';
const excluded = new Set(['.work', 'node_modules', '.git', '__pycache__']);
/**
 * Recursively adds missing attribution using each format's comment syntax.
 *
 * Shebangs and HTML doctypes stay first. Existing headers are left intact, so
 * repeated builds do not duplicate comments. JSON changes are limited to the
 * package manifest and dashboard aggregate data directories.
 *
 * @param {string} directory Absolute project or generated-output directory.
 * @return {!Promise<void>} Resolves after supported files have been processed.
 * @throws {Error} Rejects on unreadable files or invalid aggregate JSON.
 */
async function annotate(directory) {
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    if (excluded.has(entry.name)) {
      continue;
    }
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await annotate(file);
      continue;
    }
    const ext = path.extname(file);
    if (
      ![
        '.js',
        '.mjs',
        '.cjs',
        '.css',
        '.html',
        '.svg',
        '.md',
        '.py',
        '.R',
        '.yml',
        '.toml',
        '.json',
      ].includes(ext) &&
      !['.gitignore', '.prettierignore'].includes(entry.name)
    ) {
      continue;
    }
    let text = await readFile(file, 'utf8');
    if (ext === '.json') {
      // Lockfiles and tool schemas are generated contracts, not dashboard datasets.
      if (
        entry.name !== 'package.json' &&
        path.basename(directory) !== 'data'
      ) {
        continue;
      }
      const data = JSON.parse(text);
      // This identifies the dashboard maintainer, not the government data author.
      const attribution = {name: author, email};
      const result =
        entry.name === 'package.json'
          ? {author: attribution, ...data}
          : {_maintainer: attribution, ...data};
      if (entry.name === 'package.json') {
        result.author = attribution;
      } else {
        result._maintainer = attribution;
      }
      // Do not undo the formatter when attribution already matches.
      if (JSON.stringify(result) !== JSON.stringify(data)) {
        await writeFile(file, JSON.stringify(result, null, 2) + '\n');
      }
      continue;
    }
    if (text.slice(0, 500).includes(`Author: ${author}`)) {
      continue;
    }
    let header;
    if (['.html', '.svg', '.md'].includes(ext)) {
      header = `<!-- Author: ${author}\nemail: ${email} -->\n`;
    } else if (ext === '.css') {
      header = `/* Author: ${author}\nemail: ${email} */\n`;
    } else if (
      ['.py', '.R', '.yml', '.toml'].includes(ext) ||
      ['.gitignore', '.prettierignore'].includes(entry.name)
    ) {
      header = `# Author: ${author}\n# email: ${email}\n`;
    } else {
      header = `// Author: ${author}\n// email: ${email}\n`;
    }
    // Markdown needs a blank line after metadata to stay Prettier-clean.
    if (ext === '.md') {
      header += '\n';
    }
    // Preserve the interpreter directive and HTML standards-mode declaration.
    const leading = text.match(/^(?:#![^\n]*\n|<!doctype html>\s*\n)/i);
    text = leading
      ? leading[0] + header + text.slice(leading[0].length)
      : header + text;
    await writeFile(file, text);
  }
}
await annotate(root);
