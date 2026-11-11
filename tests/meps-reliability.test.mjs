// Author: Jiajun (Carson) Chen
// email: jic4015@med.cornell.edu
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const meps = JSON.parse(
  await readFile(new URL('../data/meps.json', import.meta.url), 'utf8'),
);

test('MEPS telehealth numerators reconcile with remote visits and unique persons across insurance groups', () => {
  const all = meps.overall;
  const groups = meps.groups.filter((g) => g.insurance !== 'All');
  assert.deepEqual(meps.groups[0], all);
  assert.equal(all.telehealth_n, meps.quality.telehealth_analytic_n);
  assert.equal(
    groups.reduce((n, g) => n + g.telehealth_n, 0),
    all.telehealth_n,
  );
  assert.equal(
    groups.reduce((n, g) => n + g.telehealth_n_persons, 0),
    all.telehealth_n_persons,
  );
  for (const group of meps.groups) {
    const remote = group.modalities.filter((m) => m.modality !== 'In person');
    assert.equal(
      group.telehealth_n,
      remote.reduce((n, m) => n + m.n, 0),
    );
    assert.ok(group.telehealth_n_persons <= group.n_persons);
    assert.ok(group.telehealth_n_persons <= group.telehealth_n);
    assert.ok(
      group.telehealth_n_persons >= Math.max(...remote.map((m) => m.n_persons)),
    );
    assert.ok(
      group.telehealth_n_persons <= remote.reduce((n, m) => n + m.n_persons, 0),
    );
  }
});

test('MEPS small telehealth numerator is flagged even when the denominator contains many people', () => {
  // Independent raw-source audit: the uninsured numerator has 26 distinct people,
  // not the sum of the overlapping phone/video/other modality person counts (30).
  const uninsured = meps.groups.find(
    (g) => g.insurance === 'Uninsured all year',
  );
  assert.equal(uninsured.n_persons, 362);
  assert.equal(uninsured.telehealth_n, 129);
  assert.equal(uninsured.telehealth_n_persons, 26);
  assert.equal(uninsured.telehealth_pct.unstable, true);
  assert.ok(
    uninsured.telehealth_pct.flags.includes(
      'Fewer than 30 sampled persons with telehealth visits',
    ),
  );
  for (const group of meps.groups.filter(
    (g) => g.insurance !== 'Uninsured all year',
  )) {
    assert.ok(group.telehealth_n_persons >= 30);
    assert.ok(
      !group.telehealth_pct.flags.includes(
        'Fewer than 30 sampled persons with telehealth visits',
      ),
    );
  }
  // The reproducible aggregate remains available even though display-ready
  // exports must withhold the estimate for this sparse numerator.
  assert.equal(uninsured.telehealth_pct.estimate, 11.584312);
});
