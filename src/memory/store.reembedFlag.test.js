/**
 * Search audit C-6 regression:
 *   - mergeMemoryInto flags the survivor with metadata.needsReembed = true
 *     so downstream embedding-refresh passes can pick it up.
 *   - listMemoriesNeedingReembed returns only live (non-merged) flagged rows.
 *   - clearNeedsReembed removes the flag cleanly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  upsertMemory,
  mergeMemoryInto,
  listMemoriesNeedingReembed,
  clearNeedsReembed,
  deleteMemoryById,
  getMemoriesByIds,
} from './store.js';

function seed(id, kind = 'fact') {
  upsertMemory({
    id,
    namespace: 'chat:c6-reembed',
    kind,
    text: `row ${id}`,
    searchText: `row ${id}`,
    createdAt: '2026-04-01T00:00:00Z',
    updatedAt: '2026-04-01T00:00:00Z',
    metadata: {},
  });
}

test('C-6: mergeMemoryInto flags survivor needsReembed=true', () => {
  const src = 'c6-src';
  const tgt = 'c6-tgt';
  seed(src);
  seed(tgt);
  try {
    const ok = mergeMemoryInto({ sourceId: src, targetId: tgt, useCountBonus: 2 });
    assert.equal(ok, true);
    const [tgtRow] = getMemoriesByIds([tgt]);
    assert.equal(tgtRow.metadata.needsReembed, true);
    // mergedFrom and useCount still populated as before.
    assert.deepEqual(tgtRow.metadata.mergedFrom, [src]);
    assert.equal(tgtRow.metadata.useCount, 2);
  } finally {
    deleteMemoryById(src);
    deleteMemoryById(tgt);
  }
});

test('C-6: listMemoriesNeedingReembed returns flagged survivors', () => {
  const src = 'c6-list-src';
  const tgt = 'c6-list-tgt';
  seed(src);
  seed(tgt);
  try {
    mergeMemoryInto({ sourceId: src, targetId: tgt });
    const rows = listMemoriesNeedingReembed({ limit: 50 });
    const ids = rows.map(r => r.id);
    assert.ok(ids.includes(tgt), 'survivor appears in needs-reembed list');
    assert.ok(!ids.includes(src), 'dropped row is NOT listed (it is mergedInto)');
  } finally {
    deleteMemoryById(src);
    deleteMemoryById(tgt);
  }
});

test('C-6: clearNeedsReembed removes the flag', () => {
  const src = 'c6-clear-src';
  const tgt = 'c6-clear-tgt';
  seed(src);
  seed(tgt);
  try {
    mergeMemoryInto({ sourceId: src, targetId: tgt });
    const cleared = clearNeedsReembed([tgt]);
    assert.equal(cleared, 1);
    const [tgtRow] = getMemoriesByIds([tgt]);
    // needsReembed should be gone from metadata (JSON key removed).
    assert.equal(tgtRow.metadata.needsReembed, undefined);
    // Other merge metadata is still present.
    assert.deepEqual(tgtRow.metadata.mergedFrom, [src]);
  } finally {
    deleteMemoryById(src);
    deleteMemoryById(tgt);
  }
});

test('C-6: merged-source rows do not appear in needs-reembed list', () => {
  // Even if by some path a source row ever had needsReembed set, we filter
  // out rows with mergedInto from the list — a dropped row shouldn't pull
  // embedder time.
  const src = 'c6-filter-src';
  const tgt = 'c6-filter-tgt';
  seed(src);
  seed(tgt);
  try {
    mergeMemoryInto({ sourceId: src, targetId: tgt });
    const rows = listMemoriesNeedingReembed({ limit: 50 });
    for (const row of rows) {
      assert.equal(row.metadata.mergedInto, undefined,
        `row ${row.id} has mergedInto=${row.metadata.mergedInto} but leaked into list`);
    }
  } finally {
    deleteMemoryById(src);
    deleteMemoryById(tgt);
  }
});
