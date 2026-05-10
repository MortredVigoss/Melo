import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replaceMemories, getMemoriesByIds, upsertMemory, _resetStoreForTests } from './store.js';

async function withTempMeloHome(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'melo-store-replace-'));
  const prevHome = process.env.MELO_HOME;
  process.env.MELO_HOME = dir;
  _resetStoreForTests?.();
  try {
    await fn();
  } finally {
    _resetStoreForTests?.();
    if (prevHome === undefined) delete process.env.MELO_HOME;
    else process.env.MELO_HOME = prevHome;
    await rm(dir, { recursive: true, force: true });
  }
}

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

test('replaceMemories preserves dreaming metadata across rebuild', async () => {
  await withTempMeloHome(async () => {
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
});

test('replaceMemories lets fresh metadata override non-preserved keys', async () => {
  await withTempMeloHome(async () => {
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
});

test('replaceMemories drops ids not in the new snapshot', async () => {
  await withTempMeloHome(async () => {
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
});

test('replaceMemories preserves promoted session facts across snapshot rebuilds', async () => {
  await withTempMeloHome(async () => {
    replaceMemories([baseEntry('replace-protected-seed')]);

    upsertMemory({
      id: 'promoted:replace-agent:survives',
      namespace: 'agent:replace-agent',
      kind: 'session-fact',
      sourceId: 'chat-replace',
      text: 'User prefers durable memory facts to survive compaction',
      searchText: 'user prefers durable memory facts to survive compaction',
      createdAt: '2026-05-01T00:00:00.000Z',
      updatedAt: '2026-05-01T00:00:00.000Z',
      metadata: { category: 'user_preference', chatId: 'chat-replace' },
    });

    replaceMemories([baseEntry('replace-protected-next')]);

    const rows = getMemoriesByIds([
      'promoted:replace-agent:survives',
      'replace-protected-seed',
      'replace-protected-next',
    ]);
    const ids = rows.map(row => row.id);
    assert.ok(ids.includes('promoted:replace-agent:survives'),
      'promoted session fact must survive the rebuild');
    assert.ok(!ids.includes('replace-protected-seed'),
      'ordinary snapshot rows are still pruned when omitted');
    assert.ok(ids.includes('replace-protected-next'),
      'fresh snapshot row is inserted');
  });
});
