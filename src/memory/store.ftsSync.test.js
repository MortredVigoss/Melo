/**
 * Bug A — FTS sync on upsert.
 *
 * Before the fix, upsertMemory's `if (!alreadyInFts)` branch skipped the
 * FTS insert when the id already existed, so updates to search_text only
 * landed in `memories.search_text`, not in the virtual table.  The effect
 * was classic stale-index: a full-text search for a newly-introduced term
 * wouldn't hit the row, and a search for a removed term still would.
 *
 * These tests poke the FTS table directly to prove the index now tracks
 * whatever the base table says after repeated upserts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { upsertMemory } from './store.js';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { homedir } from 'node:os';

function openStore() {
  // Open the same file the store module uses.  Read-only is enough for
  // these assertions — we're inspecting FTS state after upsertMemory.
  const storePath = join(process.env.MELO_HOME || join(homedir(), '.melo'), 'desktop', 'store.sqlite');
  return new DatabaseSync(storePath, { readOnly: true });
}

function ftsMatchCount(db, memoryId, phrase) {
  const row = db.prepare(
    `SELECT COUNT(*) AS n FROM memories_fts
      WHERE memory_id = ? AND memories_fts MATCH ?`,
  ).get(memoryId, phrase);
  return row?.n ?? 0;
}

function ftsRowCount(db, memoryId) {
  const row = db.prepare(
    `SELECT COUNT(*) AS n FROM memories_fts WHERE memory_id = ?`,
  ).get(memoryId);
  return row?.n ?? 0;
}

const NS = 'test:bug-a:fts-sync';
const MEM_ID = `bug-a-fts-${Date.now()}`;

test('upsertMemory: initial insert populates memories_fts', () => {
  upsertMemory({
    id: MEM_ID,
    namespace: NS,
    kind: 'prompt',
    text: 'the quick brown fox jumps',
    searchText: 'the quick brown fox jumps',
  });
  const db = openStore();
  try {
    assert.equal(ftsRowCount(db, MEM_ID), 1, 'FTS has exactly one row');
    assert.ok(ftsMatchCount(db, MEM_ID, 'quick') > 0, 'FTS matches "quick"');
    assert.ok(ftsMatchCount(db, MEM_ID, 'fox') > 0, 'FTS matches "fox"');
  } finally {
    db.close();
  }
});

test('upsertMemory: re-upsert with NEW searchText purges the OLD terms from FTS (Bug A regression)', () => {
  // Overwrite search_text with a totally disjoint set of terms.
  upsertMemory({
    id: MEM_ID,
    namespace: NS,
    kind: 'prompt',
    text: 'zebra mango telephone',
    searchText: 'zebra mango telephone',
  });
  const db = openStore();
  try {
    // Exactly one row — no leaking duplicates from repeated INSERTs.
    assert.equal(ftsRowCount(db, MEM_ID), 1, 'still exactly one FTS row after upsert');
    // New terms must match.
    assert.ok(ftsMatchCount(db, MEM_ID, 'zebra') > 0, 'FTS now matches "zebra"');
    assert.ok(ftsMatchCount(db, MEM_ID, 'mango') > 0, 'FTS now matches "mango"');
    // Old terms must NOT match anymore.  This is the whole point of the fix.
    assert.equal(ftsMatchCount(db, MEM_ID, 'quick'), 0, 'stale term "quick" no longer matches');
    assert.equal(ftsMatchCount(db, MEM_ID, 'fox'), 0, 'stale term "fox" no longer matches');
  } finally {
    db.close();
  }
});

test('upsertMemory: a third round of changes is also consistent', () => {
  // Belt-and-braces — the fix should be idempotent, not "works the first
  // time and then desyncs again".
  upsertMemory({
    id: MEM_ID,
    namespace: NS,
    kind: 'prompt',
    text: 'alpha beta gamma',
    searchText: 'alpha beta gamma',
  });
  const db = openStore();
  try {
    assert.equal(ftsRowCount(db, MEM_ID), 1);
    assert.ok(ftsMatchCount(db, MEM_ID, 'alpha') > 0);
    assert.equal(ftsMatchCount(db, MEM_ID, 'zebra'), 0, 'second-round term should be gone');
    assert.equal(ftsMatchCount(db, MEM_ID, 'quick'), 0, 'first-round term still gone');
  } finally {
    db.close();
  }
});
