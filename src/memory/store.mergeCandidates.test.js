/**
 * P2-12 regression: listMergeCandidates supports an incremental sinceIso
 * mode.  Fresh rows pull their whole namespace into the result (so the
 * merge planner can pair a new row against an older near-duplicate), and
 * namespaces with zero activity in the window are skipped outright.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  upsertMemory,
  listMergeCandidates,
  saveMemoryEmbedding,
  _resetStoreForTests,
} from './store.js';

// Test-isolation fix: the store.js module used to capture STORE_PATH at
// import time, so every test file in this suite shared one sqlite database.
// Tests further up the schedule that did not clean up their rows would leave
// rows with overlapping IDs visible to our listMergeCandidates assertions and
// flake us intermittently.  The _resetStoreForTests hook now points a fresh
// tmpdir MELO_HOME at each test, so every case sees an empty DB.
test.beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'melo-merge-cands-'));
  process.env.MELO_HOME = dir;
  _resetStoreForTests();
});

test.afterEach(() => {
  _resetStoreForTests();
  delete process.env.MELO_HOME;
});

function fakeEmbedding(seed = 1) {
  const vec = new Float32Array(1024);
  vec[0] = seed;
  return vec;
}

function insertWithEmbedding({ id, namespace, updatedAt, seed }) {
  upsertMemory({
    id,
    namespace,
    kind: 'fact',
    text: `row ${id}`,
    searchText: `row ${id}`,
    createdAt: '2026-03-01T10:00:00Z',
    updatedAt,
    metadata: {},
  });
  saveMemoryEmbedding(id, `row ${id}`, fakeEmbedding(seed));
}

function setup() {
  // Active namespace: one row updated inside the window, one outside.
  insertWithEmbedding({
    id: 'p12-active-fresh',
    namespace: 'chat:p12-active',
    updatedAt: '2026-04-18T09:00:00Z',
    seed: 1,
  });
  insertWithEmbedding({
    id: 'p12-active-old',
    namespace: 'chat:p12-active',
    updatedAt: '2026-03-01T10:00:00Z',
    seed: 2,
  });

  // Quiet namespace: both rows outside the window.
  insertWithEmbedding({
    id: 'p12-quiet-a',
    namespace: 'chat:p12-quiet',
    updatedAt: '2026-03-01T10:00:00Z',
    seed: 3,
  });
  insertWithEmbedding({
    id: 'p12-quiet-b',
    namespace: 'chat:p12-quiet',
    updatedAt: '2026-03-02T10:00:00Z',
    seed: 4,
  });
}

test('listMergeCandidates() without sinceIso returns all rows (legacy path)', () => {
  setup();
  const rows = listMergeCandidates();
  const ids = new Set(rows.map(r => r.id));
  assert.ok(ids.has('p12-active-fresh'));
  assert.ok(ids.has('p12-active-old'));
  assert.ok(ids.has('p12-quiet-a'));
  assert.ok(ids.has('p12-quiet-b'));
});

test('listMergeCandidates({sinceIso}) pulls old neighbours from active namespaces', () => {
  setup();
  const rows = listMergeCandidates({ sinceIso: '2026-04-01T00:00:00Z' });
  const ids = new Set(rows.map(r => r.id));

  // Active namespace: both rows (fresh + old) pulled so the merge planner
  // can pair them.
  assert.ok(ids.has('p12-active-fresh'), 'fresh row included');
  assert.ok(ids.has('p12-active-old'), 'older neighbour pulled into the pool');

  // Quiet namespace: skipped outright — zero activity in the window.
  assert.ok(!ids.has('p12-quiet-a'));
  assert.ok(!ids.has('p12-quiet-b'));
});

test('listMergeCandidates({sinceIso}) returns empty when nothing is fresh', () => {
  // Reuse setup but pick a cut-off in the future.
  setup();
  const rows = listMergeCandidates({ sinceIso: '2099-01-01T00:00:00Z' });
  assert.equal(rows.length, 0);
});

test('listMergeCandidates({sinceIso, namespace}) respects namespace filter', () => {
  setup();
  const rows = listMergeCandidates({
    sinceIso: '2026-04-01T00:00:00Z',
    namespace: 'chat:p12-quiet',
  });
  assert.equal(rows.length, 0, 'namespace quiet has no fresh rows');
});
