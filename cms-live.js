// Author: Jiajun (Carson) Chen
// email: jic4015@med.cornell.edu
/**
 * @fileoverview Opt-in CMS catalog discovery, bounded downloads, and validation.
 * A candidate must pass every check before it can replace the session view.
 * No function writes the repository, persists browser data, or recomputes models.
 */
const CMS_ORIGIN = 'https://data.cms.gov';
const CATALOG_URL = `${CMS_ORIGIN}/data.json`;
const SOURCE_URL = `${CMS_ORIGIN}/summary-statistics-on-use-and-payments/medicare-medicaid-service-type-reports/medicare-telehealth-trends`;
const PAGE_SIZE = 5000;
const MAX_PAGES = 20;
const SUBGROUP_FIELDS = [
  'Bene_Mdcd_Mdcr_Enrl_Stus',
  'Bene_Race_Desc',
  'Bene_Sex_Desc',
  'Bene_Mdcr_Entlmt_Stus',
  'Bene_Age_Desc',
  'Bene_RUCA_Desc',
];
const RECORD_FIELDS = [
  'telehealthPct',
  'telehealthUsers',
  'eligibleUsers',
  'partBEnrollment',
];
const fail = (message) => {
  throw new Error(message);
};
const normalize = (value) =>
  String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
const clone = (value) => structuredClone(value);
/**
 * Stops processing as well as network requests after caller cancellation.
 * @param {AbortSignal=} signal Optional request-lifetime signal.
 * @throws {*} The signal reason, or an AbortError if none was supplied.
 */
function checkAborted(signal) {
  if (signal?.aborted) {
    throw (
      signal.reason ||
      new DOMException('The CMS update was cancelled.', 'AbortError')
    );
  }
}

/**
 * Reads a CMS JSON response with explicit failure messages and size checks.
 *
 * The declared byte limit is checked before reading. The fallback after text()
 * checks string length; it is a sanity bound, not a streaming memory guarantee.
 * Credentials and redirects are disabled for this public-data request.
 *
 * @param {string} url Validated CMS endpoint or fixed catalog address.
 * @param {!Object} options Abort signal, injected fetchImpl, and maxBytes limit.
 * @return {!Promise<*>} Parsed JSON whose schema is checked by the caller.
 * @throws {Error} On transport, HTTP, media-type, size, or parsing failure.
 */
async function fetchJson(url, {signal, fetchImpl, maxBytes}) {
  checkAborted(signal);
  let response;
  try {
    response = await fetchImpl(url, {
      signal,
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      headers: {Accept: 'application/json'},
    });
  } catch (error) {
    checkAborted(signal);
    throw new Error('CMS could not be reached. Please try again later.');
  }
  if (!response.ok) {
    fail(
      response.status === 429
        ? 'CMS is limiting requests. Please try again later.'
        : 'CMS could not provide this update. Please try again later.',
    );
  }
  const type = response.headers.get('content-type') || '';
  if (type && !/json/i.test(type)) {
    fail(
      'CMS returned an unexpected response. The existing data have been kept.',
    );
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    fail(
      'The CMS response is larger than expected. The existing data have been kept.',
    );
  }
  let text;
  try {
    text = await response.text();
  } catch (error) {
    checkAborted(signal);
    fail('The CMS download was interrupted. Please try again.');
  }
  checkAborted(signal);
  if (text.length > maxBytes) {
    fail(
      'The CMS response is larger than expected. The existing data have been kept.',
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    fail(
      'CMS returned an unexpected response. The existing data have been kept.',
    );
  }
}
/**
 * Restricts catalog-provided API URLs to the expected CMS origin and path.
 * @param {string} value Candidate endpoint without a query or fragment.
 * @return {string} Canonical HTTPS dataset API URL.
 * @throws {Error} If the endpoint is ambiguous or outside the allowed shape.
 */
function cmsApiUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail('The current CMS data address could not be verified.');
  }
  if (
    url.origin !== CMS_ORIGIN ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/data-api\/v1\/dataset\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/data$/i.test(
      url.pathname,
    )
  ) {
    fail('The current CMS data address could not be verified.');
  }
  return url.href;
}
/**
 * Resolves the catalog's explicit latest release, not a guessed date order.
 * @param {!Object} catalog CMS data.json catalog with series and datasets.
 * @return {!Object} Validated endpoint and available source-version metadata.
 * @throws {Error} If the telehealth series, release, or API is not unique.
 */
function resolveLatest(catalog) {
  if (
    !catalog ||
    !Array.isArray(catalog.datasetSeries) ||
    !Array.isArray(catalog.dataset)
  ) {
    fail('CMS release information has an unexpected format.');
  }
  const matches = catalog.datasetSeries.filter(
    (item) => normalize(item.title) === 'medicare telehealth trends',
  );
  if (matches.length !== 1) {
    fail('The current Medicare telehealth release could not be identified.');
  }
  const series = matches[0];
  const lastId = series.last?.['@id'];
  if (typeof lastId !== 'string') {
    fail('The current Medicare telehealth release could not be identified.');
  }
  const releases = catalog.dataset.filter((item) => item['@id'] === lastId);
  if (releases.length !== 1) {
    fail('The current Medicare telehealth release could not be identified.');
  }
  const release = releases[0];
  if (!Array.isArray(release.distribution)) {
    fail('CMS release information has an unexpected format.');
  }
  const apis = release.distribution.filter(
    (item) => normalize(item.format) === 'api',
  );
  const preferred = apis.filter(
    (item) => normalize(item.description) === 'latest',
  );
  const matching = apis.filter((item) => item.accessURL === series['@id']);
  const candidates = preferred.length
    ? preferred
    : matching.length
      ? matching
      : apis;
  if (candidates.length !== 1) {
    fail('The current CMS data address could not be identified.');
  }
  const apiUrl = cmsApiUrl(candidates[0].accessURL);
  const csv = release.distribution.find(
    (item) =>
      normalize(item.format) === 'csv' && typeof item.downloadURL === 'string',
  );
  let downloadUrl = null;
  if (csv) {
    try {
      const url = new URL(csv.downloadURL);
      if (
        url.origin === CMS_ORIGIN &&
        url.pathname.startsWith('/sites/default/files/') &&
        !url.username &&
        !url.password
      ) {
        downloadUrl = url.href;
      }
    } catch {}
  }
  const modified =
    typeof release.modified === 'string' &&
    /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(release.modified)
      ? release.modified
      : null;
  return {
    apiUrl,
    downloadUrl,
    modified,
    title: String(release.title || 'Medicare Telehealth Trends'),
    catalogId: lastId,
  };
}
/**
 * Parses CMS numeric cells without converting blanks into valid zeros.
 * @param {*} value Raw API field.
 * @param {string} label Field description used in a validation error.
 * @param {{integer: boolean, optional: boolean}=} options Count and missing rules.
 * @return {?number} Nonnegative finite value, or null for an optional blank.
 * @throws {Error} If the numeric syntax, range, or integer requirement fails.
 */
function numeric(value, label, {integer = false, optional = false} = {}) {
  if (optional && (value === undefined || value === null || value === '')) {
    return null;
  }
  if (
    (typeof value !== 'number' && typeof value !== 'string') ||
    (typeof value === 'string' &&
      !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim()))
  ) {
    fail(`CMS ${label} values could not be read safely.`);
  }
  const result = Number(value);
  if (
    !Number.isFinite(result) ||
    result < 0 ||
    (integer && !Number.isSafeInteger(result))
  ) {
    fail(`CMS ${label} values could not be read safely.`);
  }
  return result;
}
/**
 * Normalizes one all-beneficiary record and verifies count-rate consistency.
 *
 * CMS supplies fractions; the dashboard uses percentages. The 0.005001 pp
 * allowance reflects source rounding plus a small floating-point tolerance.
 * Enrollment is contextual and must never replace the eligible-user denominator.
 *
 * @param {!Object} row Official CMS record for one geography and reporting period.
 * @return {!Object} Normalized annual/quarterly record in dashboard units.
 * @throws {Error} If the period, counts, scale, or rate check fails.
 */
function readRecord(row) {
  const year = numeric(row.Year, 'reporting year', {integer: true});
  if (year < 2000 || year > 2100) {
    fail('CMS reporting periods have an unexpected format.');
  }
  if (
    row.Quarter !== undefined &&
    row.quarter !== undefined &&
    normalize(row.Quarter) !== normalize(row.quarter)
  ) {
    fail('CMS reporting periods have an unexpected format.');
  }
  const value = row.Quarter ?? row.quarter;
  let quarter = null;
  if (normalize(value) !== 'overall') {
    quarter = numeric(value, 'reporting quarter', {integer: true});
    if (quarter < 1 || quarter > 4) {
      fail('CMS reporting periods have an unexpected format.');
    }
  }
  const eligibleUsers = numeric(
    row.Total_Bene_TH_Elig,
    'eligible-user counts',
    {integer: true},
  );
  const telehealthUsers = numeric(
    row.Total_Bene_Telehealth,
    'telehealth-user counts',
    {integer: true},
  );
  const fraction = numeric(row.Pct_Telehealth, 'telehealth rates');
  const partBEnrollment = numeric(row.Total_PartB_Enrl, 'enrollment', {
    optional: true,
  });
  if (eligibleUsers === 0 || telehealthUsers > eligibleUsers || fraction > 1) {
    fail('CMS rates and counts did not pass the basic consistency checks.');
  }
  const telehealthPct = Number((fraction * 100).toFixed(8));
  const recalculatedPct = (100 * telehealthUsers) / eligibleUsers;
  if (Math.abs(telehealthPct - recalculatedPct) > 0.005001) {
    fail('CMS rates and counts did not pass the basic consistency checks.');
  }
  return {
    year,
    quarter,
    period: quarter === null ? String(year) : `${year} Q${quarter}`,
    telehealthPct,
    telehealthUsers,
    eligibleUsers,
    partBEnrollment,
    recalculatedPct: Number(recalculatedPct.toFixed(8)),
    status: 'available',
  };
}
/**
 * Indexes annual and quarterly records by geography and period.
 * @param {!Object} source Verified or currently displayed CMS aggregate data.
 * @return {!Map<string, !Object>} Lookup used to detect additions and revisions.
 */
function seriesRecords(source) {
  const values = new Map();
  for (const [geo, series] of [
    ['US', source.national],
    ...(source.states || []).map((state) => [state.abbr, state]),
  ]) {
    for (const record of [
      ...(series?.annual || []),
      ...(series?.quarterly || []),
    ]) {
      values.set(`${geo}|${record.period}`, record);
    }
  }
  return values;
}
/**
 * Builds a complete candidate without mutating either baseline dataset.
 *
 * Each retained period must cover the national record and all 51 jurisdictions.
 * The candidate must retain every previously displayed and verified key. ACS
 * context is copied from the verified snapshot; it is never fetched here.
 *
 * @param {!Array<!Object>} rows Downloaded CMS rows before subgroup filtering.
 * @param {!Object} verifiedCms Shipped snapshot and geographic allowlist.
 * @param {!Object} currentCms Current view used for repeated-check comparisons.
 * @return {!Object} Complete series, coverage counts, and change metadata.
 * @throws {Error} If duplicates, gaps, schema drift, or arithmetic errors appear.
 */
function collect(rows, verifiedCms, currentCms) {
  if (
    !Array.isArray(verifiedCms?.states) ||
    verifiedCms.states.length !== 51 ||
    !verifiedCms.national
  ) {
    fail('The verified state reference is unavailable.');
  }
  const stateNames = new Map(
    verifiedCms.states.map((state) => [normalize(state.name), state]),
  );
  const abbreviations = new Set(verifiedCms.states.map((state) => state.abbr));
  if (
    stateNames.size !== 51 ||
    abbreviations.size !== 51 ||
    abbreviations.has('US')
  ) {
    fail('The verified state reference is unavailable.');
  }
  const byGeo = new Map([
    ['US', []],
    ...verifiedCms.states.map((state) => [state.abbr, []]),
  ]);
  const byPeriod = new Map();
  const records = new Map();
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      fail('CMS returned an unexpected record format.');
    }
    if (SUBGROUP_FIELDS.some((field) => typeof row[field] !== 'string')) {
      fail(
        'CMS subgroup definitions have changed. The existing data have been kept.',
      );
    }
    if (SUBGROUP_FIELDS.some((field) => row[field].trim() !== 'All')) {
      continue;
    }
    if (typeof row.Bene_Geo_Desc !== 'string') {
      fail('CMS geographic definitions have changed.');
    }
    const name = normalize(row.Bene_Geo_Desc);
    const geo = name === 'national' ? 'US' : stateNames.get(name)?.abbr;
    if (!geo) {
      continue;
    } // Territories and other geographies are deliberately excluded.
    const record = readRecord(row);
    const key = `${geo}|${record.period}`;
    if (records.has(key)) {
      fail(
        'CMS returned duplicate state-period records. The existing data have been kept.',
      );
    }
    records.set(key, record);
    byGeo.get(geo).push(record);
    if (!byPeriod.has(record.period)) {
      byPeriod.set(record.period, new Set());
    }
    byPeriod.get(record.period).add(geo);
  }
  if (
    !records.size ||
    [...byPeriod.values()].some((geos) => geos.size !== 52) ||
    [...byGeo.values()].some((values) => !values.length)
  ) {
    fail(
      'CMS has not supplied a complete set of national and state records. The existing data have been kept.',
    );
  }
  const previous = seriesRecords(currentCms);
  const verified = seriesRecords(verifiedCms);
  if (
    [...new Set([...previous.keys(), ...verified.keys()])].some(
      (key) => !records.has(key),
    )
  ) {
    fail(
      'The CMS update is missing previously displayed periods. The existing data have been kept.',
    );
  }
  let addedRecords = 0;
  let changedRecords = 0;
  const changedPeriods = new Set();
  for (const [key, record] of records) {
    const before = previous.get(key);
    if (!before) {
      addedRecords++;
    } else if (RECORD_FIELDS.some((field) => record[field] !== before[field])) {
      changedRecords++;
      changedPeriods.add(record.period);
    }
  }
  const priorPeriods = new Set(
    [...previous.values()].map((record) => record.period),
  );
  const baselinePeriods = new Set(
    [...verified.values()].map((record) => record.period),
  );
  const sortedPeriods = [...byPeriod.keys()].sort((a, b) => a.localeCompare(b));
  const split = (values) => ({
    annual: values
      .filter((record) => record.quarter === null)
      .sort((a, b) => a.year - b.year),
    quarterly: values
      .filter((record) => record.quarter !== null)
      .sort((a, b) => a.year - b.year || a.quarter - b.quarter),
  });
  const national = split(byGeo.get('US'));
  const states = verifiedCms.states.map((state) => ({
    ...clone(state),
    ...split(byGeo.get(state.abbr)),
  }));
  const latestQuarter = national.quarterly.at(-1);
  const latestAnnual = national.annual.at(-1);
  const latest =
    latestAnnual && (!latestQuarter || latestAnnual.year > latestQuarter.year)
      ? latestAnnual
      : latestQuarter;
  const changes = {
    addedRecords,
    changedRecords,
    newPeriods: sortedPeriods.filter((period) => !priorPeriods.has(period)),
    changedPeriods: [...changedPeriods].sort(),
    additionalPeriods: sortedPeriods.filter(
      (period) => !baselinePeriods.has(period),
    ),
  };
  return {
    national,
    states,
    latestPeriod: latest.period,
    changes,
    recordCount: records.size,
    changed: addedRecords > 0 || changedRecords > 0,
    years: [
      ...new Set([...records.values()].map((record) => record.year)),
    ].sort((a, b) => a - b),
  };
}

/**
 * Fetch CMS's current catalog-selected release and validate it transactionally.
 * Only a complete candidate is returned. The verified source is never changed.
 * Passing currentCms allows repeated checks to report no record changes.
 * These schema/arithmetic checks do not constitute research validation.
 *
 * @param {!Object} verifiedCms Immutable baseline with all states and ACS context.
 * @param {!Object=} options Optional currentCms, AbortSignal signal, onProgress
 *     callback receiving status text, and fetchImpl for deterministic tests.
 * @return {!Promise<!Object>} Candidate data, changed flag, latest period,
 *     retrieval time, source version/URLs, and record-level change summary.
 * @throws {Error} Rejects on cancellation, incomplete pagination, or validation
 *     failure. The caller must retain its previous view when the promise rejects.
 */
export async function fetchCmsUpdates(
  verifiedCms,
  {
    currentCms = verifiedCms,
    signal,
    onProgress,
    fetchImpl = globalThis.fetch,
  } = {},
) {
  if (typeof fetchImpl !== 'function') {
    fail('Live CMS updates are unavailable in this browser.');
  }
  onProgress?.('Checking the current CMS release…');
  const catalog = await fetchJson(CATALOG_URL, {
    signal,
    fetchImpl,
    maxBytes: 50 * 1024 * 1024,
  });
  const release = resolveLatest(catalog);
  let rows = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    checkAborted(signal);
    onProgress?.(
      page === 0
        ? 'Downloading current CMS records…'
        : `Downloading CMS records (${rows.length.toLocaleString('en-US')} received)…`,
    );
    const url = new URL(release.apiUrl);
    url.searchParams.set('size', String(PAGE_SIZE));
    url.searchParams.set('offset', String(page * PAGE_SIZE));
    for (const field of SUBGROUP_FIELDS) {
      url.searchParams.set(`filter[${field}]`, 'All');
    }
    const batch = await fetchJson(url.href, {
      signal,
      fetchImpl,
      maxBytes: 12 * 1024 * 1024,
    });
    if (!Array.isArray(batch) || batch.length > PAGE_SIZE) {
      fail('CMS returned an unexpected record format.');
    }
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) {
      break;
    }
    if (page === MAX_PAGES - 1) {
      fail(
        'The CMS update exceeds the supported download size. The existing data have been kept.',
      );
    }
  }
  onProgress?.('Checking state coverage and rate calculations…');
  const result = collect(rows, verifiedCms, currentCms);
  checkAborted(signal);
  const checkedAt = new Date().toISOString();
  const data = clone(verifiedCms);
  data.status = 'unvalidated_live';
  data.accessDate = checkedAt.slice(0, 10);
  data.years = result.years;
  data.national = result.national;
  data.states = result.states;
  data.sources = [
    {
      id: 'cms',
      title: 'CMS Medicare Telehealth Trends',
      url: release.downloadUrl || SOURCE_URL,
      apiUrl: release.apiUrl,
      landingUrl: SOURCE_URL,
      releaseDate: release.modified,
      accessDate: data.accessDate,
    },
    ...(data.sources || []).filter((source) => source.id !== 'cms'),
  ];
  data.quality = {
    cmsRetainedRows: result.recordCount,
    validationStatus: 'basic_checks_only',
    checks: [
      'Complete state and national coverage for each period',
      'Unique state-period keys',
      'Valid numeric rates and counts',
      'Rates agree with numerator and denominator within source rounding tolerance',
    ],
    verifiedSnapshotAccessDate: verifiedCms.accessDate,
  };
  data.live = {
    checkedAt,
    apiUrl: release.apiUrl,
    catalogUrl: CATALOG_URL,
    catalogId: release.catalogId,
    sourceModified: release.modified,
    sourceTitle: release.title,
    changes: result.changes,
    acsContextYear: 2024,
    associationsFromVerifiedSnapshot: true,
    validationStatus: 'unvalidated',
  };
  return {
    data,
    changed: result.changed,
    latestPeriod: result.latestPeriod,
    checkedAt,
    sourceUrl: SOURCE_URL,
    apiUrl: release.apiUrl,
    version: release.modified,
    changes: result.changes,
  };
}
