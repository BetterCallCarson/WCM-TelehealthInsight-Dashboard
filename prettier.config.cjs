// Author: Jiajun (Carson) Chen
// email: jic4015@med.cornell.edu
// Keep local formatting and GitHub Actions on the same explicit configuration.
module.exports = {
  printWidth: 80,
  tabWidth: 2,
  useTabs: false,
  singleQuote: true,
  bracketSpacing: false,
  semi: true,
  trailingComma: 'all',
  arrowParens: 'always',
  proseWrap: 'preserve',
  endOfLine: 'lf',
  overrides: [{files: '*.svg', options: {parser: 'html'}}],
};
