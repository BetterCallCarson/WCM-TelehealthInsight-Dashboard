// Author: Jiajun (Carson) Chen
// email: jic4015@med.cornell.edu
/**
 * @fileoverview Annual differences and adjusted-odds visualizations.
 * All functions return new results or markup; they never refit statistical models.
 * Prefixed helpers avoid name collisions in the self-contained preview bundle.
 */
// Descriptive comparisons use published annual rates and verified model terms.
// Helpers are prefixed so the same module can be bundled into a local preview.
const cmpEscape = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (char) =>
      ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[
        char
      ],
  );
const cmpNumber = (value, digits = 1) =>
  Number.isFinite(value)
    ? value.toLocaleString('en-US', {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      })
    : '—';
const cmpSigned = (value) =>
  Number.isFinite(value)
    ? `${value > 0 ? '+' : ''}${cmpNumber(Object.is(value, -0) ? 0 : value, 2)} pp`
    : 'Unavailable';
const cmpRate = (value) =>
  Number.isFinite(value) ? `${cmpNumber(value, 2)}%` : 'Unavailable';
const cmpRatio = (value) =>
  value < 0.01 || value >= 1000
    ? value.toExponential(3)
    : cmpNumber(value, Math.abs(value - 1) < 0.01 ? 4 : 3);
const cmpRateValid = (value) =>
  Number.isFinite(value) && value >= 0 && value <= 100;

/**
 * Validates a full calendar year without accepting partial numeric strings.
 * @param {(number|string)} value Year selected by a control or test.
 * @return {number} Four-digit integer year.
 * @throws {RangeError} If the value is not a full calendar year.
 */
function cmpYear(value) {
  if (typeof value === 'string' && !/^\d{4}$/.test(value)) {
    throw new RangeError('Select two full calendar years.');
  }
  if (!['number', 'string'].includes(typeof value)) {
    throw new RangeError('Select two full calendar years.');
  }
  const year = Number(value);
  if (!Number.isInteger(year) || year < 1000 || year > 9999) {
    throw new RangeError('Select two full calendar years.');
  }
  return year;
}
/**
 * Finds exactly one published annual rate; quarterly averages are invalid.
 * @param {!Object} state Geography with an annual series.
 * @param {number} year Requested calendar year.
 * @return {?number} Rate in percent, or null for missing/ambiguous records.
 */
function cmpAnnualRate(state, year) {
  // Never substitute quarterly observations or average quarterly rates.
  const matches = (Array.isArray(state.annual) ? state.annual : []).filter(
    (row) =>
      row.year === year &&
      row.quarter == null &&
      (row.period == null || row.period === String(year)),
  );
  if (matches.length !== 1) {
    return null;
  }
  const value = matches[0].telehealthPct;
  return cmpRateValid(value) ? value : null;
}
/**
 * Computes later minus earlier annual rates for every input geography.
 *
 * Missing or duplicate annual records produce a null change, not zero. Input
 * order is retained so chart ranking can be separate from complete CSV exports.
 *
 * @param {!Object} data Aggregate object containing a states array.
 * @param {(number|string)} fromYear Earlier full calendar year.
 * @param {(number|string)} toYear Later full calendar year.
 * @return {!Array<!Object>} Rates and differences in percentage points.
 * @throws {RangeError} If years are invalid or not strictly increasing.
 * @throws {TypeError} If geography records are absent.
 */
export function annualChanges(data, fromYear, toYear) {
  const start = cmpYear(fromYear);
  const end = cmpYear(toYear);
  if (start >= end) {
    throw new RangeError('The starting year must precede the ending year.');
  }
  if (!Array.isArray(data?.states)) {
    throw new TypeError('State records are required.');
  }
  return data.states.map((state) => {
    const fromRate = cmpAnnualRate(state, start);
    const toRate = cmpAnnualRate(state, end);
    return {
      name: state.name,
      abbr: state.abbr,
      fromYear: start,
      toYear: end,
      fromRate,
      toRate,
      change: fromRate === null || toRate === null ? null : toRate - fromRate,
    };
  });
}
/**
 * Rounds a nonnegative extent upward to a readable 1/2/5 axis boundary.
 * @param {number} maximum Largest absolute finite difference.
 * @return {number} Positive extent; an all-zero comparison uses one.
 */
function cmpChangeExtent(maximum) {
  if (maximum === 0) {
    return 1;
  }
  const power = 10 ** Math.floor(Math.log10(maximum));
  if (power === 0) {
    return maximum;
  }
  const scaled = maximum / power;
  return (scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10) * power;
}
/**
 * Renders signed changes around zero with a symmetric percentage-point axis.
 *
 * The caller selects or ranks rows; this function preserves that order. Source
 * rates remain visible alongside differences to prevent relative-change confusion.
 *
 * @param {!Array<!Object>} rows Output from annualChanges, optionally filtered.
 * @param {{title: string, selected: string}=} options Accessible title and state.
 * @return {string} SVG markup, or an explicit empty-state message.
 */
export function changeChart(
  rows,
  {title = 'Change in annual telehealth use', selected = 'US'} = {},
) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return '<div class="empty-state">Annual comparisons are unavailable.</div>';
  }
  const width = 1320;
  const left = 310;
  const right = 380;
  const top = 52;
  const rowHeight = 44;
  const bottom = 48;
  const height = top + rows.length * rowHeight + bottom;
  const finite = rows
    .map((row) => row.change)
    .filter((value) => Number.isFinite(value) && Math.abs(value) <= 100);
  const extent = cmpChangeExtent(
    finite.length ? Math.max(...finite.map(Math.abs)) : 0,
  );
  const x = (value) =>
    left + ((value + extent) / (2 * extent)) * (width - left - right);
  const zero = x(0);
  const plotBottom = top + rows.length * rowHeight - 12;
  const first = rows[0];
  const headerFrom = Number.isInteger(first.fromYear)
    ? first.fromYear
    : 'Earlier';
  const headerTo = Number.isInteger(first.toYear) ? first.toYear : 'Later';
  let grid = '';
  for (const value of [-extent, -extent / 2, 0, extent / 2, extent]) {
    const position = x(value);
    grid += `<line class="${value === 0 ? 'change-zero' : 'chart-grid'}" x1="${position}" x2="${position}" y1="32" y2="${plotBottom}"${value === 0 ? ' stroke="var(--ink, #000000)" stroke-width="1"' : ''}/><text class="chart-tick" x="${position}" y="${height - 27}" text-anchor="middle">${value > 0 ? '+' : ''}${cmpNumber(value, Number.isInteger(value) ? 0 : 1)}</text>`;
  }
  const marks = rows
    .map((row, index) => {
      const y = top + index * rowHeight;
      const valid = Number.isFinite(row.change) && Math.abs(row.change) <= 100;
      const isSelected = row.abbr === selected;
      const label = `${row.name}: ${row.fromYear} ${cmpRate(row.fromRate)}; ${row.toYear} ${cmpRate(row.toRate)}; change ${valid ? cmpSigned(row.change) : 'unavailable'}`;
      const fill =
        row.change > 0
          ? 'var(--accent, #b31b1b)'
          : row.change < 0
            ? 'var(--comparison, #666666)'
            : 'var(--ink, #000000)';
      const bar = valid
        ? row.change === 0
          ? `<circle class="change-zero-point" cx="${zero}" cy="${y}" r="3" fill="${fill}"/>`
          : `<rect class="change-bar" data-value="${row.change}" x="${Math.min(x(row.change), zero)}" y="${y - 6}" width="${Math.abs(x(row.change) - zero)}" height="12" fill="${fill}"/>`
        : '';
      return `<g class="change-row${isSelected ? ' is-selected' : ''}" data-state="${cmpEscape(row.abbr)}" role="button" aria-pressed="${isSelected}" tabindex="0" data-tip="${cmpEscape(label)}" aria-label="${cmpEscape(label)}">${isSelected ? `<rect class="change-selection" x="0" y="${y - 16}" width="${width}" height="32" fill="var(--selection, #fbeaea)"/>` : ''}<text class="chart-tick" style="fill:var(--ink, #000000);font-size:24px" x="8" y="${y + 5}">${cmpEscape(row.name)}</text>${bar}<text class="chart-tick" x="1050" y="${y + 5}" text-anchor="end">${cmpRate(row.fromRate)}</text><text class="chart-tick" x="1170" y="${y + 5}" text-anchor="end">${cmpRate(row.toRate)}</text><text class="chart-tick" x="1312" y="${y + 5}" text-anchor="end" style="fill:var(--ink, #000000)">${valid ? cmpSigned(row.change) : '—'}</text></g>`;
    })
    .join('');
  return `<svg class="change-chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${cmpEscape(title)}"><title>${cmpEscape(title)}</title><text class="chart-axis-title" x="8" y="26">State / D.C.</text><text class="chart-axis-title" x="1050" y="26" text-anchor="end">${headerFrom}</text><text class="chart-axis-title" x="1170" y="26" text-anchor="end">${headerTo}</text><text class="chart-axis-title" x="1312" y="26" text-anchor="end">Change</text>${grid}${marks}<text class="chart-axis-title" x="${zero}" y="${height - 5}" text-anchor="middle">Change in percentage points</text></svg>`;
}

/**
 * Checks positive, ordered limits before taking logarithms.
 * @param {!Object} row Model term with odds_ratio, ci_low, and ci_high.
 * @return {boolean} Whether the point and both limits can be plotted.
 */
function cmpOddsValid(row) {
  return (
    [row.odds_ratio, row.ci_low, row.ci_high].every(
      (value) => Number.isFinite(value) && value > 0,
    ) &&
    row.ci_low <= row.odds_ratio &&
    row.odds_ratio <= row.ci_high
  );
}
/**
 * Labels powers of two without collapsing near-null ticks to the same value.
 * @param {number} power Tick position on the base-two logarithmic axis.
 * @param {number} extent Symmetric axis extent in logarithmic units.
 * @return {string} Tick label with sufficient precision.
 */
function cmpOddsTick(power, extent) {
  if (Math.abs(power) > 10) {
    return `2^${power}`;
  }
  const value = 2 ** power;
  if (extent < 1) {
    return cmpNumber(
      value,
      Math.max(3, Math.min(15, Math.ceil(-Math.log10(extent)) + 2)),
    );
  }
  return value >= 1
    ? cmpNumber(value, 0)
    : value.toLocaleString('en-US', {maximumFractionDigits: 5});
}
/**
 * Renders adjusted model terms on a logarithmic axis centered at odds ratio 1.
 *
 * The full confidence limits determine the range. Selecting a covariate changes
 * only the displayed terms; it does not change the fitted model or references.
 * Invalid intervals are labelled unavailable and never coerced to zero.
 *
 * @param {!Array<!Object>} rows Model terms with labels, odds ratios, and limits.
 * @param {{title: string, referenceLabel: string}=} options Title and reference.
 * @return {string} Accessible forest-plot SVG or an unavailable-data message.
 */
export function oddsRatioChart(
  rows,
  {
    title = 'Adjusted odds ratios with 95% confidence intervals',
    referenceLabel = 'Reference group',
  } = {},
) {
  if (!Array.isArray(rows) || !rows.some(cmpOddsValid)) {
    return '<div class="empty-state">Adjusted estimates are unavailable.</div>';
  }
  const width = 1320;
  const left = 425;
  const right = 420;
  const rowHeight = 52;
  const top = 46;
  const height = rows.length * rowHeight + 92;
  const values = rows
    .filter(cmpOddsValid)
    .flatMap((row) => [row.ci_low, row.ci_high]);
  const rawExtent = Math.max(
    ...values.map((value) => Math.abs(Math.log2(value))),
  );
  const exponent =
    rawExtent < 0.5 ? cmpChangeExtent(rawExtent || 0.02) : Math.ceil(rawExtent);
  const x = (value) =>
    left +
    ((Math.log2(value) + exponent) / (2 * exponent)) * (width - left - right);
  const yBottom = top + (rows.length - 1) * rowHeight + 20;
  const zero = x(1);
  const step = Math.max(1, Math.ceil(exponent / 3));
  const tickExponents =
    exponent < 1
      ? [-exponent, -exponent / 2, 0, exponent / 2, exponent]
      : [
          ...new Set([
            -exponent,
            0,
            exponent,
            ...Array.from(
              {length: Math.floor(exponent / step)},
              (_, i) => (i + 1) * step,
            ).flatMap((value) => [-value, value]),
          ]),
        ].sort((a, b) => a - b);
  const ticks = tickExponents
    .map((power) => {
      const position =
        left + ((power + exponent) / (2 * exponent)) * (width - left - right);
      return `<line class="${power === 0 ? 'odds-reference' : 'chart-grid'}" x1="${position}" x2="${position}" y1="26" y2="${yBottom}"${power === 0 ? ' stroke="var(--ink, #000000)" stroke-width="1.2" stroke-dasharray="4 4"' : ''}/><text class="chart-tick" x="${position}" y="${height - 42}" text-anchor="middle">${cmpOddsTick(power, exponent)}</text>`;
    })
    .join('');
  const marks = rows
    .map((row, index) => {
      const y = top + index * rowHeight;
      const label = cmpEscape(row.label);
      if (!cmpOddsValid(row)) {
        return `<text class="chart-tick" x="0" y="${y + 5}" style="fill:var(--ink, #000000);font-size:24px">${label}</text><text class="chart-tick" x="${left}" y="${y + 5}">Not estimated</text>`;
      }
      const low = x(row.ci_low);
      const high = x(row.ci_high);
      const point = x(row.odds_ratio);
      const tooltip = `${row.label}: adjusted odds ratio ${cmpRatio(row.odds_ratio)}; 95% confidence interval ${cmpRatio(row.ci_low)} to ${cmpRatio(row.ci_high)}; reference ${row.reference || referenceLabel}`;
      return `<g class="odds-row"><text class="chart-tick" x="0" y="${y + 5}" style="fill:var(--ink, #000000);font-size:24px">${label}</text><line class="odds-interval" x1="${low}" x2="${high}" y1="${y}" y2="${y}" stroke="var(--series, #cf4520)" stroke-width="2"/><path d="M${low} ${y - 5}v10 M${high} ${y - 5}v10" stroke="var(--series, #cf4520)"/><circle class="odds-point" cx="${point}" cy="${y}" r="5" fill="var(--accent, #b31b1b)" tabindex="0" data-tip="${cmpEscape(tooltip)}" aria-label="${cmpEscape(tooltip)}"/><text class="chart-tick" x="1312" y="${y + 5}" text-anchor="end" style="fill:var(--ink, #000000)">${cmpRatio(row.odds_ratio)} (${cmpRatio(row.ci_low)}–${cmpRatio(row.ci_high)})</text></g>`;
    })
    .join('');
  return `<svg class="odds-ratio-chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${cmpEscape(title)}"><title>${cmpEscape(title)}</title><text class="chart-axis-title" x="${left}" y="25">Adjusted odds ratio · log scale</text><text class="chart-axis-title" x="1312" y="25" text-anchor="end">Estimate (95% CI)</text>${ticks}${marks}<text class="chart-axis-title" x="0" y="${height - 12}">Reference: ${cmpEscape(referenceLabel)} · 1 = equal odds</text></svg>`;
}
