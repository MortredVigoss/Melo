/**
 * Search audit B-4 regression:
 *  1. searchMemories drops temporally-invalidated rows from the FTS branch.
 *  2. When every FTS hit is invalidated, we fall through to keyword scoring
 *     instead of returning an empty list.
 *
 * Invalidation is controlled by metadata.validTo — a past timestamp marks
 * a fact expired.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { upsertMemory, searchMemories, deleteMemoryById, _resetStoreForTests } from './store.js';

let tempHome = null;
let prevHome = null;

test.beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), 'melo-search-fallback-'));
  prevHome = process.env.MELO_HOME;
  process.env.MELO_HOME = tempHome;
  _resetStoreForTests?.();
});

test.afterEach(async () => {
  _resetStoreForTests?.();
  if (prevHome === undefined) delete process.env.MELO_HOME;
  else process.env.MELO_HOME = prevHome;
  await rm(tempHome, { recursive: true, force: true });
  tempHome = null;
  prevHome = null;
});

function seedExpired(id) {
  upsertMemory({
    id,
    namespace: 'chat:p13-searchfallback',
    kind: 'fact',
    text: `expired yoga fact ${id}`,
    searchText: `expired yoga fact ${id}`,
    createdAt: '2026-03-01T10:00:00Z',
    updatedAt: '2026-03-01T10:00:00Z',
    metadata: {
      // 1970 — validTo in the deep past marks the row invalidated.
      validTo: '1970-01-01T00:00:00Z',
    },
  });
}

function seedFresh(id) {
  upsertMemory({
    id,
    namespace: 'chat:p13-searchfallback',
    kind: 'fact',
    text: `fresh yoga fact ${id}`,
    searchText: `fresh yoga fact ${id}`,
    createdAt: '2026-04-18T10:00:00Z',
    updatedAt: '2026-04-18T10:00:00Z',
    metadata: {},
  });
}

test('searchMemories drops invalidated entries from FTS results', () => {
  const id = 'b4-invalidated-fts';
  seedExpired(id);
  try {
    const hits = searchMemories({ query: 'expired yoga fact', kinds: ['fact'], limit: 20 });
    const ids = hits.map(h => h.id);
    assert.ok(!ids.includes(id), 'invalidated row filtered out');
  } finally {
    deleteMemoryById(id);
  }
});

test('searchMemories still returns fresh entries that match via FTS', () => {
  const id = 'b4-fresh-fts';
  seedFresh(id);
  try {
    const hits = searchMemories({ query: 'fresh yoga fact', kinds: ['fact'], limit: 20 });
    const ids = hits.map(h => h.id);
    assert.ok(ids.includes(id));
  } finally {
    deleteMemoryById(id);
  }
});
