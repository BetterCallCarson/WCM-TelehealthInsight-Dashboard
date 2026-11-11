// Author: Jiajun (Carson) Chen
// email: jic4015@med.cornell.edu
import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchCmsUpdates} from '../cms-live.js';

const API =
  'https://data.cms.gov/data-api/v1/dataset/11111111-1111-4111-8111-111111111111/data';
const fields = [
  'Bene_Mdcd_Mdcr_Enrl_Stus',
  'Bene_Race_Desc',
  'Bene_Sex_Desc',
  'Bene_Mdcr_Entlmt_Stus',
  'Bene_Age_Desc',
  'Bene_RUCA_Desc',
];
const record = {
  year: 2024,
  quarter: null,
  period: '2024',
  telehealthPct: 25,
  telehealthUsers: 25,
  eligibleUsers: 100,
  partBEnrollment: 110,
  recalculatedPct: 25,
  status: 'available',
};
function baseline() {
  return {
    accessDate: '2026-11-11',
    status: 'verified',
    years: [2024],
    national: {annual: [{...record}], quarterly: []},
    states: Array.from({length: 51}, (_, i) => ({
      name: i === 50 ? 'District of Columbia' : `State ${i + 1}`,
      abbr: `S${i + 1}`,
      fips: String(i + 1).padStart(2, '0'),
      annual: [{...record}],
      quarterly: [],
      acs2024: {broadbandPct: 90 + i / 100},
    })),
    sources: [
      {id: 'cms', sha256: 'old-source-fingerprint'},
      {id: 'acs', sha256: 'frozen-acs-fingerprint'},
    ],
    associations: {frozen: true},
    quality: {frozen: true},
  };
}
function sourceRows(base, quarter = 'Overall', year = '2024') {
  return ['National', ...base.states.map((state) => state.name)].map(
    (name) => ({
      Year: year,
      Quarter: quarter,
      Bene_Geo_Desc: name,
      ...Object.fromEntries(fields.map((field) => [field, 'All'])),
      Total_Bene_TH_Elig: '100',
      Total_Bene_Telehealth: '25',
      Pct_Telehealth: '0.25',
      Total_PartB_Enrl: '110',
    }),
  );
}
function catalog(api = API) {
  const id = api.replace(/\/data$/, '/data-viewer');
  return {
    datasetSeries: [
      {title: 'Medicare Telehealth Trends', '@id': api, last: {'@id': id}},
    ],
    dataset: [
      {
        '@id': id,
        title: 'Medicare Telehealth Trends : 2026-01-01',
        modified: '2026-09-17',
        distribution: [
          {format: 'API', description: 'latest', accessURL: api},
          {
            format: 'CSV',
            downloadURL:
              'https://data.cms.gov/sites/default/files/2026-09/source.csv',
          },
        ],
      },
    ],
  };
}
function transport(rows, {catalogValue = catalog(), response = null} = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({url, options});
    if (String(url).endsWith('/data.json')) {
      return Response.json(catalogValue);
    }
    return response ? response() : Response.json(rows);
  };
  return {calls, fetchImpl};
}

test('catalog discovery adds a complete new quarter without mutating verified data or ACS context', async () => {
  const base = baseline();
  const saved = structuredClone(base);
  const rows = [...sourceRows(base), ...sourceRows(base, '1', '2026')];
  rows.find(
    (row) => row.Bene_Geo_Desc === 'District of Columbia',
  ).Bene_Geo_Desc = 'District Of Columbia';
  const t = transport(rows);
  const progress = [];
  const result = await fetchCmsUpdates(base, {
    fetchImpl: t.fetchImpl,
    onProgress: (text) => progress.push(text),
  });
  assert.deepEqual(base, saved);
  assert.equal(result.changed, true);
  assert.equal(result.latestPeriod, '2026 Q1');
  assert.equal(result.data.status, 'unvalidated_live');
  assert.equal(result.data.states.length, 51);
  assert.equal(result.data.national.quarterly.length, 1);
  assert.deepEqual(result.data.states[0].acs2024, base.states[0].acs2024);
  assert.notEqual(result.data.states[0].acs2024, base.states[0].acs2024);
  assert.deepEqual(result.changes.newPeriods, ['2026 Q1']);
  assert.equal(result.changes.addedRecords, 52);
  assert.equal(result.version, '2026-09-17');
  assert.equal(result.data.sources[0].sha256, undefined);
  assert.equal(result.data.sources[1].sha256, 'frozen-acs-fingerprint');
  const requested = new URL(t.calls[1].url);
  for (const field of fields) {
    assert.equal(requested.searchParams.get(`filter[${field}]`), 'All');
  }
  assert.equal(t.calls[0].options.cache, 'no-store');
  assert.ok(progress.length >= 3);
});

test('unchanged records and repeat checks report no update; a revision is detected separately', async () => {
  const base = baseline();
  const rows = sourceRows(base);
  const t = transport(rows);
  const unchanged = await fetchCmsUpdates(base, {fetchImpl: t.fetchImpl});
  assert.equal(unchanged.changed, false);
  const expanded = [...rows, ...sourceRows(base, '1', '2026')];
  const first = await fetchCmsUpdates(base, {
    fetchImpl: transport(expanded).fetchImpl,
  });
  const repeat = await fetchCmsUpdates(base, {
    currentCms: first.data,
    fetchImpl: transport(expanded).fetchImpl,
  });
  assert.equal(repeat.changed, false);
  assert.deepEqual(repeat.changes.additionalPeriods, ['2026 Q1']);
  const changed = structuredClone(rows);
  changed[0].Total_Bene_Telehealth = '30';
  changed[0].Pct_Telehealth = '.3';
  const revision = await fetchCmsUpdates(base, {
    fetchImpl: transport(changed).fetchImpl,
  });
  assert.equal(revision.changed, true);
  assert.equal(revision.changes.changedRecords, 1);
  assert.equal(revision.changes.addedRecords, 0);
});

test('duplicates, incomplete geography, and omitted historical periods fail transactionally', async () => {
  const base = baseline();
  const original = JSON.stringify(base);
  const rows = sourceRows(base);
  await assert.rejects(
    fetchCmsUpdates(base, {fetchImpl: transport([...rows, rows[0]]).fetchImpl}),
    /duplicate/,
  );
  await assert.rejects(
    fetchCmsUpdates(base, {fetchImpl: transport(rows.slice(1)).fetchImpl}),
    /complete set/,
  );
  await assert.rejects(
    fetchCmsUpdates(base, {
      fetchImpl: transport(sourceRows(base, '1', '2026')).fetchImpl,
    }),
    /previously displayed/,
  );
  assert.equal(JSON.stringify(base), original);
});

test('invalid count, changed rate scale, inconsistent rate, and missing schema are rejected', async () => {
  const base = baseline();
  const rows = sourceRows(base);
  for (const edit of [
    (row) => (row.Total_Bene_Telehealth = '-1'),
    (row) => (row.Total_Bene_TH_Elig = '0'),
    (row) => (row.Pct_Telehealth = '25'),
    (row) => (row.Pct_Telehealth = '.8'),
    (row) => delete row.Year,
    (row) => delete row.Bene_Age_Desc,
    (row) => (row.Quarter = '5'),
  ]) {
    const copy = structuredClone(rows);
    edit(copy[0]);
    await assert.rejects(
      fetchCmsUpdates(base, {fetchImpl: transport(copy).fetchImpl}),
      /CMS/,
    );
  }
});

test('only the catalog-selected official CMS endpoint is followed', async () => {
  const base = baseline();
  const rows = sourceRows(base);
  const moved =
    'https://data.cms.gov/data-api/v1/dataset/22222222-2222-4222-8222-222222222222/data';
  const t = transport(rows, {catalogValue: catalog(moved)});
  const result = await fetchCmsUpdates(base, {fetchImpl: t.fetchImpl});
  assert.equal(result.apiUrl, moved);
  const malicious = transport(rows, {
    catalogValue: catalog('https://example.com/data'),
  });
  await assert.rejects(
    fetchCmsUpdates(base, {fetchImpl: malicious.fetchImpl}),
    /address/,
  );
  assert.equal(malicious.calls.length, 1);
  await assert.rejects(
    fetchCmsUpdates(base, {
      fetchImpl: transport(rows, {catalogValue: {dataset: []}}).fetchImpl,
    }),
    /release information/,
  );
});

test('non-JSON, failed HTTP, and cancellation leave the original source intact', async () => {
  const base = baseline();
  const original = JSON.stringify(base);
  const rows = sourceRows(base);
  await assert.rejects(
    fetchCmsUpdates(base, {
      fetchImpl: transport(rows, {
        response: () =>
          new Response('<html>Sign in</html>', {
            headers: {'content-type': 'text/html'},
          }),
      }).fetchImpl,
    }),
    /unexpected/,
  );
  await assert.rejects(
    fetchCmsUpdates(base, {
      fetchImpl: transport(rows, {
        response: () => new Response('', {status: 429}),
      }).fetchImpl,
    }),
    /limiting/,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    fetchCmsUpdates(base, {
      signal: controller.signal,
      fetchImpl: transport(rows).fetchImpl,
    }),
    (error) => error.name === 'AbortError',
  );
  assert.equal(JSON.stringify(base), original);
});

test('subgroups and excluded geographies do not contaminate state-level estimates', async () => {
  const base = baseline();
  const rows = sourceRows(base);
  const subgroup = {...rows[0], Bene_Sex_Desc: 'Female'};
  const territory = {...rows[0], Bene_Geo_Desc: 'Puerto Rico'};
  const result = await fetchCmsUpdates(base, {
    fetchImpl: transport([...rows, subgroup, territory]).fetchImpl,
  });
  assert.equal(result.changed, false);
  assert.equal(result.data.quality.cmsRetainedRows, 52);
});

test('pagination follows offsets and a later-page failure never returns a partial update', async () => {
  const base = baseline();
  const saved = structuredClone(base);
  const retained = sourceRows(base);
  const territory = {...retained[0], Bene_Geo_Desc: 'Puerto Rico'};
  const first = [
    ...retained,
    ...Array.from({length: 5000 - retained.length}, () => ({...territory})),
  ];
  const second = sourceRows(base, '1', '2026');
  const offsets = [];
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/data.json')) {
      return Response.json(catalog());
    }
    const offset = new URL(url).searchParams.get('offset');
    offsets.push(offset);
    return Response.json(offset === '0' ? first : second);
  };
  const result = await fetchCmsUpdates(base, {fetchImpl});
  assert.deepEqual(offsets, ['0', '5000']);
  assert.equal(result.data.quality.cmsRetainedRows, 104);
  assert.equal(result.latestPeriod, '2026 Q1');
  await assert.rejects(
    fetchCmsUpdates(base, {
      fetchImpl: async (url) =>
        String(url).endsWith('/data.json')
          ? Response.json(catalog())
          : new URL(url).searchParams.get('offset') === '0'
            ? Response.json(first)
            : new Response('', {status: 503}),
    }),
    /could not provide/,
  );
  assert.deepEqual(base, saved);
});
