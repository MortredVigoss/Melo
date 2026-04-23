import test from 'node:test';
import assert from 'node:assert/strict';
import { replaceMemories, getMemoriesByIds } from './store.js';

function baseEntry(id, metadata = {}) {
  return {
    id,
    namespace: 'chat:test-replace',
    kind: 'fact',
    text: `Fact body for ${id}`,
    searchText: `fact body for ${id}`,
    createdAt: new Date(Date.now() - 3_600_000).toISOString(),
    updatedAt: new Date().toISOString(),
    metadata: { category: 'preference', ...metadata },
  };
}

test('replaceMemories preserves dreaming metadata across rebuild', () => {
  // First pass — establish the row
  replaceMemories([baseEntry('replace-keep-1')]);

  // Simulate dreaming/touch work writing extra metadata via a second pass
  // that already carries the enrichment (as the background worker would).
  replaceMemories([baseEntry('replace-keep-1', {
    attic: 'hot',
    useCount: 7,
    mergedFrom: ['other-id'],
    validTo: '2099-01-01T00:00:00.000Z',
    lastBoostedAt: '2026-04-01T00:00:00.000Z',
    pinned: true,
  })]);

  // Third pass simulates buildMemoryStoreEntries — same id, **no** dreaming
  // fields in the fresh metadata.  They must survive the rebuild.
  replaceMemories([baseEntry('replace-keep-1')]);

  const rows = getMemoriesByIds(['replace-keep-1']);
  const got = rows[0];
  assert.ok(got, 'row survived');
  assert.equal(got.metadata.attic, 'hot', 'attic preserved');
  assert.equal(got.metadata.useCount, 7, 'useCount preserved');
  assert.deepEqual(got.metadata.mergedFrom, ['other-id'], 'mergedFrom preserved');
  assert.equal(got.metadata.validTo, '2099-01-01T00:00:00.000Z', 'validTo preserved');
  assert.equal(got.metadata.pinned, true, 'pin preserved');
  assert.equal(got.metadata.lastBoostedAt, '2026-04-01T00:00:00.000Z', 'lastBoostedAt preserved');
});

test('replaceMemories lets fresh metadata override non-preserved keys', () => {
  replaceMemories([baseEntry('replace-fresh-1', {
    attic: 'hot', useCount: 3, topicTags: ['old', 'stuff'],
  })]);

  replaceMemories([baseEntry('replace-fresh-1', { topicTags: ['new', 'tags'] })]);

  const rows = getMemoriesByIds(['replace-fresh-1']);
  const got = rows[0];
  assert.ok(got);
  // Rebuild wins for topicTags (not in preserve list)
  assert.deepEqual(got.metadata.topicTags, ['new', 'tags']);
  // Preserved keys still carry forward
  assert.equal(got.metadata.attic, 'hot');
  assert.equal(got.metadata.useCount, 3);
});

test('replaceMemories drops ids not in the new snapshot', () => {
  replaceMemories([
    baseEntry('replace-stay'),
    baseEntry('replace-go'),
  ]);
  replaceMemories([baseEntry('replace-stay')]);

  const rows = getMemoriesByIds(['replace-stay', 'replace-go']);
  const ids = rows.map(r => r.id);
  assert.ok(ids.includes('replace-stay'));
  assert.ok(!ids.includes('replace-go'), 'orphan row removed');
});
