// Author: Jiajun (Carson) Chen
// email: jic4015@med.cornell.edu
/**
 * @fileoverview Pure HTML/SVG renderers for verified aggregate measures.
 * Percent inputs use 0–100 units. Missing estimates stay missing, not zero.
 * Callers supply source-specific withholding decisions before rendering.
 */
/**
 * Escapes text before inserting it into an HTML text or quoted attribute context.
 * @param {*} value Text-like value; null and undefined become empty text.
 * @return {string} Escaped text. This does not validate URLs or CSS values.
 */
export const escapeHtml = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[
        c
      ],
  );
/**
 * Formats finite values consistently across charts, tables, and downloads.
 * @param {?number} value Numeric value in its original units.
 * @param {number=} digits Fixed decimal places, defaulting to zero.
 * @return {string} Localized number or an em dash for unavailable data.
 */
export const number = (value, digits = 0) =>
  Number.isFinite(value)
    ? value.toLocaleString('en-US', {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      })
    : '—';
/**
 * Formats a percentage already expressed on a 0–100 scale.
 * @param {?number} value Percentage, not a fraction.
 * @return {string} One-decimal percentage or an em dash.
 */
export const percent = (value) =>
  Number.isFinite(value) ? `${number(value, 1)}%` : '—';
/**
 * Formats nominal source-year US dollars without inflation adjustment.
 * @param {?number} value Payment or income in dollars.
 * @return {string} Rounded dollar amount or an em dash.
 */
export const dollars = (value) =>
  Number.isFinite(value) ? `$${number(value, 0)}` : '—';
/**
 * Abbreviates headline counts while tables retain the full counts.
 * @param {?number} value Nonnegative count from an aggregate record.
 * @return {string} Count with k/m suffix, or an em dash.
 */
export function compact(value) {
  if (!Number.isFinite(value)) {
    return '—';
  }
  return value >= 1e6
    ? `${number(value / 1e6, 1)}m`
    : value >= 1e3
      ? `${number(value / 1e3, 1)}k`
      : number(value);
}
/**
 * Formats interval endpoints without computing or changing uncertainty.
 * @param {?number} low Lower confidence limit in the displayed units.
 * @param {?number} high Upper confidence limit in the displayed units.
 * @param {string=} unit Suffix shared by both endpoints; defaults to percent.
 * @return {string} Interval text or an explicit unavailable label.
 */
export const ci = (low, high, unit = '%') =>
  Number.isFinite(low) && Number.isFinite(high)
    ? `${number(low, 1)}–${number(high, 1)}${unit}`
    : 'Not estimated';
/**
 * Serializes homogeneous row objects using the first row's column order.
 *
 * Nulls become blank fields, preserving withheld estimates. Formula-like text
 * is prefixed with an apostrophe; negative numbers retain their numeric form.
 * This serializer is for the dashboard's controlled aggregate export schemas.
 *
 * @param {!Array<!Object>} rows Records with the same keys as the first record.
 * @return {string} CSV with CRLF separators, or empty text for no rows.
 */
export function csv(rows) {
  if (!rows.length) {
    return '';
  }
  const keys = Object.keys(rows[0]);
  const cell = (x) => {
    let s = x == null ? '' : String(x);
    if (/^[=+@\t\r]/.test(s)) {
      s = "'" + s;
    }
    return /[",\n\r]/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s;
  };
  return [
    keys.map(cell).join(','),
    ...rows.map((row) => keys.map((k) => cell(row[k])).join(',')),
  ].join('\r\n');
}
// WCM primary colors form an ordered, decreasing-luminance scale.
// Keep these stops synchronized with the CSS map legend.
/**
 * Interpolates the sequential WCM palette within the selected period.
 *
 * The range is period-specific, so matching colors across years need not mean
 * matching rates. A constant range maps to the first palette stop.
 *
 * @param {?number} value Telehealth percentage to encode.
 * @param {number} min Smallest finite rate in the current map.
 * @param {number} max Largest finite rate in the current map.
 * @return {string} CSS rgb color, or the missing-data gray.
 */
export function colorFor(value, min, max) {
  if (!Number.isFinite(value)) {
    return '#ededed';
  }
  const t = Math.max(0, Math.min(1, (value - min) / (max - min || 1)));
  const stops = [
    [255, 199, 44],
    [231, 117, 29],
    [207, 69, 32],
    [179, 27, 27],
  ];
  const position = t * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.floor(position));
  const a = stops[index];
  const b = stops[index + 1];
  const fraction = position - index;
  return `rgb(${a.map((c, i) => Math.round(c + (b[i] - c) * fraction)).join(',')})`;
}
const tooltip = (label) =>
  `data-tip="${escapeHtml(label)}" aria-label="${escapeHtml(label)}" tabindex="0"`;
const tickStyle = 'style="font-size:14px"';

/**
 * Renders ordered quarterly series on a shared zero-based percent axis.
 *
 * A missing observation breaks the line rather than interpolating a value.
 * Callers provide chronological points, including explicit missing periods.
 * Colors are trusted application constants, never remote source text.
 *
 * @param {!Array<!Object>} series Labels, colors, and values of {period, value}.
 * @param {{title: string, height: number}=} options Accessible title and height.
 * @return {string} Accessible SVG markup or an unavailable-data message.
 */
export function lineChart(
  series,
  {title = 'Quarterly telehealth use', height = 264} = {},
) {
  const width = 490;
  const m = {l: 48, r: 20, t: 20, b: 40};
  const all = series
    .flatMap((s) => s.values)
    .filter((v) => Number.isFinite(v.value));
  if (!all.length) {
    return '<div class="empty-state">Quarterly data unavailable</div>';
  }
  const periods = [
    ...new Set(series.flatMap((s) => s.values.map((v) => v.period))),
  ].sort();
  const ymax = Math.max(
    10,
    Math.ceil(Math.max(...all.map((v) => v.value)) / 10) * 10,
  );
  const x = (i) => m.l + (i / (periods.length - 1 || 1)) * (width - m.l - m.r);
  const y = (v) => height - m.b - (v / ymax) * (height - m.t - m.b);
  let grid = '';
  for (let i = 0; i <= 4; i++) {
    const v = (ymax * i) / 4;
    grid += `<line class="chart-grid" x1="${m.l}" x2="${width - m.r}" y1="${y(v)}" y2="${y(v)}"/><text class="chart-tick" ${tickStyle} x="${m.l - 8}" y="${y(v) + 4}" text-anchor="end">${number(v, Number.isInteger(v) ? 0 : 1)}%</text>`;
  }
  periods.forEach((p, i) => {
    if (p.endsWith('Q1')) {
      grid += `<text class="chart-tick" ${tickStyle} x="${x(i)}" y="${height - 12}" text-anchor="middle">${p.slice(0, 4)}</text>`;
    }
  });
  const lines = series
    .map((s) => {
      let d = '';
      let connected = false;
      const points = s.values
        .map((v) => {
          const i = periods.indexOf(v.period);
          if (!Number.isFinite(v.value)) {
            connected = false;
            return '';
          }
          d += `${connected ? 'L' : 'M'}${x(i)} ${y(v.value)} `;
          connected = true;
          return `<circle class="line-point" cx="${x(i)}" cy="${y(v.value)}" r="3.5" fill="${s.color}" ${tooltip(`${s.label} · ${v.period}: ${percent(v.value)}`)}/>`;
        })
        .join('');
      return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2.4"/>${points}`;
    })
    .join('');
  return `<svg class="line-chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(title)}"><title>${escapeHtml(title)}</title>${grid}${lines}</svg>`;
}

/**
 * Plots matched 2024 state aggregates, keeping the selected state on top.
 *
 * This renderer does not fit a model or propagate ACS measurement error.
 * The caller must use the verified matched-year data even during live updates.
 *
 * @param {!Array<!Object>} points State records with x, y, name, and abbr.
 * @param {{xKey: string, selected: string, xlabel: string}=} options Axis and selection.
 * @return {string} Accessible SVG markup or an unavailable-data message.
 */
export function scatterChart(
  points,
  {
    xKey = 'broadbandPct',
    selected = 'US',
    xlabel = 'Households with broadband (%)',
  } = {},
) {
  const width = 490;
  const height = 280;
  const m = {l: 52, r: 28, t: 36, b: 64};
  const valid = points.filter(
    (p) => Number.isFinite(p.x) && Number.isFinite(p.y),
  );
  if (!valid.length) {
    return '<div class="empty-state">Matched ACS data are not available</div>';
  }
  const xs = valid.map((p) => p.x);
  const ys = valid.map((p) => p.y);
  let xmin = Math.min(...xs);
  let xmax = Math.max(...xs);
  let ymin = Math.floor(Math.min(...ys) / 5) * 5;
  let ymax = Math.ceil(Math.max(...ys) / 5) * 5;
  const pad = (xmax - xmin) * 0.1 || 1;
  xmin -= pad;
  xmax += pad;
  const x = (v) => m.l + ((v - xmin) / (xmax - xmin)) * (width - m.l - m.r);
  const y = (v) =>
    height - m.b - ((v - ymin) / (ymax - ymin || 1)) * (height - m.t - m.b);
  let grid = `<text class="chart-axis-title" ${tickStyle} x="${m.l}" y="16">Telehealth use (%)</text>`;
  for (let i = 0; i <= 4; i++) {
    const v = ymin + ((ymax - ymin) * i) / 4;
    grid += `<line class="chart-grid" x1="${m.l}" x2="${width - m.r}" y1="${y(v)}" y2="${y(v)}"/><text class="chart-tick" ${tickStyle} x="${m.l - 8}" y="${y(v) + 4}" text-anchor="end">${number(v, Number.isInteger(v) ? 0 : 1)}%</text>`;
    const a = xmin + ((xmax - xmin) * i) / 4;
    grid += `<text class="chart-tick" ${tickStyle} x="${x(a)}" y="${height - m.b + 24}" text-anchor="middle">${xKey === 'income' ? '$' + number(a / 1000) + 'k' : number(a, 0) + '%'}</text>`;
  }
  const circles = valid
    .sort(
      (a, b) => (a.abbr === selected ? 1 : 0) - (b.abbr === selected ? 1 : 0),
    )
    .map((p) => {
      const isSelected = p.abbr === selected;
      return `<circle class="chart-point${isSelected ? ' is-selected' : ''}" data-state="${p.abbr}" role="button" aria-pressed="${isSelected}" cx="${x(p.x)}" cy="${y(p.y)}" r="${isSelected ? 6 : 4.5}" fill="${isSelected ? 'var(--accent, #b31b1b)' : 'var(--series, #cf4520)'}" opacity="${isSelected ? 1 : 0.85}" ${tooltip(`${p.name}: ${percent(p.y)} telehealth; ${xKey === 'income' ? dollars(p.x) : percent(p.x)} ${xKey === 'income' ? 'income' : 'broadband'}`)}/>`;
    })
    .join('');
  const chosen = valid.find((p) => p.abbr === selected);
  let selectedLabel = '';
  if (chosen) {
    const cx = x(chosen.x);
    const cy = y(chosen.y);
    const placeLeft = cx > width - m.r - 40;
    selectedLabel = `<text class="chart-selection-label" style="font-size:14px;fill:var(--accent, #b31b1b)" x="${cx + (placeLeft ? -10 : 10)}" y="${Math.max(m.t + 12, cy - 12)}" text-anchor="${placeLeft ? 'end' : 'start'}">${escapeHtml(chosen.abbr)}</text>`;
  }
  return `<svg class="scatter-chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="2024 state telehealth use versus ${escapeHtml(xlabel)}"><title>2024 telehealth use versus ${escapeHtml(xlabel)}</title>${grid}${circles}${selectedLabel}<text class="chart-axis-title" ${tickStyle} x="${(width + m.l - m.r) / 2}" y="${height - 12}" text-anchor="middle">${escapeHtml(xlabel)}</text></svg>`;
}

/**
 * Renders weighted estimates and intervals after caller-side withholding.
 *
 * The domain expands to include finite upper confidence limits. The max option
 * is a minimum domain suggestion, not a cap that could truncate an interval.
 * Percentage axes remain within 0–100; missing estimates have no point mark.
 *
 * @param {!Array<!Object>} rows Labels, estimates, ci_low/ci_high, n, and flags.
 * @param {{unit: string, compact: boolean, title: string, max: ?number}=} options
 *     Units, responsive sizing, accessible title, and minimum axis maximum.
 * @return {string} Accessible SVG markup with uncertainty and missingness labels.
 */
export function dotChart(
  rows,
  {
    unit = 'percent',
    compact = false,
    title = 'Weighted estimates with 95% confidence intervals',
    max = null,
  } = {},
) {
  const width = compact ? 470 : 760;
  const left = compact ? 112 : 248;
  const right = compact ? 68 : 96;
  const rowH = compact ? 44 : 52;
  const height = rows.length * rowH + 56;
  const vals = rows
    .flatMap((r) => [r.estimate, r.ci_high])
    .filter(Number.isFinite);
  const rawMax = Math.max(max ?? 0, Math.max(...vals, 1) * 1.12);
  const xmax =
    unit === 'percent'
      ? Math.min(100, Math.ceil(rawMax / 10) * 10)
      : Math.ceil(rawMax / 100) * 100;
  const x = (v) => left + (v / xmax) * (width - left - right);
  let grid = '';
  for (let i = 0; i <= 4; i++) {
    const v = (xmax * i) / 4;
    grid += `<line class="chart-grid" x1="${x(v)}" x2="${x(v)}" y1="12" y2="${height - 36}"/><text class="chart-tick" style="font-size:${compact ? 12 : 14}px" x="${x(v)}" y="${height - 12}" text-anchor="middle">${unit === 'percent' ? number(v, Number.isInteger(v) ? 0 : 1) + '%' : '$' + number(v)}</text>`;
  }
  const marks = rows
    .map((r, i) => {
      const y = 28 + i * rowH;
      const has = Number.isFinite(r.estimate);
      const f = unit === 'percent' ? percent : dollars;
      const label = escapeHtml(r.label);
      const labelStyle = `style="font-size:${compact ? 12 : 14}px;fill:var(--ink, #000000)"`;
      const interval =
        Number.isFinite(r.ci_low) && Number.isFinite(r.ci_high)
          ? `<line x1="${x(Math.max(0, r.ci_low))}" x2="${x(r.ci_high)}" y1="${y}" y2="${y}" stroke="var(--series, #cf4520)" stroke-width="2"/><path d="M${x(Math.max(0, r.ci_low))} ${y - 5}v10 M${x(r.ci_high)} ${y - 5}v10" stroke="var(--series, #cf4520)"/>`
          : '';
      return `<text class="chart-tick chart-row-label" x="0" y="${y + 4}" ${labelStyle}>${label}</text>${has ? `${interval}<circle class="estimate-point" cx="${x(r.estimate)}" cy="${y}" r="5" fill="${r.unstable ? 'var(--accent, #b31b1b)' : 'var(--series, #cf4520)'}" ${tooltip(`${r.label}: ${f(r.estimate)}; 95% CI ${ci(r.ci_low, r.ci_high, unit === 'percent' ? '%' : ' dollars')}; n=${number(r.n)}`)}/><text class="chart-tick chart-value" x="${width - 4}" y="${y + 4}" text-anchor="end" ${labelStyle}>${f(r.estimate)}${r.unstable ? ' *' : ''}</text>` : `<text class="chart-tick" style="font-size:${compact ? 12 : 14}px" x="${left}" y="${y + 4}">${r.withheld ? 'Not shown' : 'Not estimated'}</text>`}`;
    })
    .join('');
  return `<svg class="dot-chart-svg${compact ? ' compact' : ''}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(title)}"><title>${escapeHtml(title)}</title>${grid}${marks}</svg>`;
}
