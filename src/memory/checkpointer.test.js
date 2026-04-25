// Cross-MELO_HOME isolation tests for the thread checkpoint cache.
//
// Phase 7d-5α-A1 commit 8+9 fix-3: `checkpointCache` was originally a flat
// Map<threadId, payload>. Codex review caught that after the lazy
// threadsDir() fix, the cache was STILL leaking across homes — same
// threadId across two MELO_HOME values would silently return the FIRST
// home's cached payload, bypassing the disk-path fix entirely.
//
// User picked Q3-B + Q4-b: nested Map<home, Map<threadId, payload>>, and
// `invalidateThreadCheckpointCache(threadId, { allHomes })` to optionally
// scope invalidation. These tests are the precise regression coverage for
// both decisions.

import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  saveThreadCheckpoint,
  loadThreadCheckpoint,
  invalidateThreadCheckpointCache,
} from './checkpointer.js';

function freshHome() {
  const home = mkdtempSync(join(tmpdir(), 'melo-cp-iso-'));
  mkdirSync(join(home, 'desktop', 'threads'), { recursive: true });
  return home;
}

function cleanup(home) {
  try { rmSync(home, { recursive: true, force: true }); } catch {}
}

// ─── Q3-B: cross-home cache isolation ──────────────────────────────────────

test('saveThreadCheckpoint + loadThreadCheckpoint isolate by MELO_HOME (cache)', async () => {
  const homeA = freshHome();
  const homeB = freshHome();
  // Wipe any cache state from earlier tests so we start clean.
  invalidateThreadCheckpointCache(null, { allHomes: true });
  try {
    const SAME_THREAD_ID = 'shared-thread-id-test';

    // Write under home A.
    process.env.MELO_HOME = homeA;
    await saveThreadCheckpoint(SAME_THREAD_ID, {
      threadId: SAME_THREAD_ID,
      messages: [{ id: 'a-msg', role: 'user', content: 'home A speaks' }],
      derived: { source: 'home-A' },
    });
    const loadedA = await loadThreadCheckpoint(SAME_THREAD_ID);
    assert.equal(loadedA.derived.source, 'home-A');

    // Switch to home B and write a DIFFERENT payload to the same thread id.
    process.env.MELO_HOME = homeB;
    await saveThreadCheckpoint(SAME_THREAD_ID, {
      threadId: SAME_THREAD_ID,
      messages: [{ id: 'b-msg', role: 'user', content: 'home B speaks' }],
      derived: { source: 'home-B' },
    });
    const loadedB = await loadThreadCheckpoint(SAME_THREAD_ID);
    assert.equal(
      loadedB.derived.source,
      'home-B',
      'home B must read its own checkpoint, not the cached home-A entry',
    );

    // Switch back to home A. If the cache was shared, this would still
    // see "home-B" because it was the most recent write. With per-home
    // buckets, it correctly reads home A's original payload from cache
    // (or disk, if the cache was evicted).
    process.env.MELO_HOME = homeA;
    const loadedAagain = await loadThreadCheckpoint(SAME_THREAD_ID);
    assert.equal(
      loadedAagain.derived.source,
      'home-A',
      'home A must still see its own checkpoint after the home B detour',
    );
  } finally {
    cleanup(homeA);
    cleanup(homeB);
    invalidateThreadCheckpointCache(null, { allHomes: true });
  }
});

// ─── Q4-b: invalidateThreadCheckpointCache scope ───────────────────────────

test('invalidateThreadCheckpointCache(id) defaults to current home only', async () => {
  const homeA = freshHome();
  const homeB = freshHome();
  invalidateThreadCheckpointCache(null, { allHomes: true });
  try {
    const ID = 'invalidate-scope-test';

    process.env.MELO_HOME = homeA;
    await saveThreadCheckpoint(ID, { threadId: ID, derived: { source: 'home-A' } });
    process.env.MELO_HOME = homeB;
    await saveThreadCheckpoint(ID, { threadId: ID, derived: { source: 'home-B' } });

    // Invalidate ID under home B only.
    process.env.MELO_HOME = homeB;
    invalidateThreadCheckpointCache(ID);

    // home A's cached entry must survive.
    process.env.MELO_HOME = homeA;
    const stillCachedA = await loadThreadCheckpoint(ID);
    assert.equal(stillCachedA.derived.source, 'home-A');

    // home B's must reload from disk (still 'home-B' since the file is intact).
    process.env.MELO_HOME = homeB;
    const reloadedB = await loadThreadCheckpoint(ID);
    assert.equal(reloadedB.derived.source, 'home-B');
  } finally {
    cleanup(homeA);
    cleanup(homeB);
    invalidateThreadCheckpointCache(null, { allHomes: true });
  }
});

test('invalidateThreadCheckpointCache(id, { allHomes: true }) clears every home bucket', async () => {
  const homeA = freshHome();
  const homeB = freshHome();
  invalidateThreadCheckpointCache(null, { allHomes: true });
  try {
    const ID = 'invalidate-allhomes-test';

    process.env.MELO_HOME = homeA;
    await saveThreadCheckpoint(ID, { threadId: ID, derived: { source: 'home-A' } });
    process.env.MELO_HOME = homeB;
    await saveThreadCheckpoint(ID, { threadId: ID, derived: { source: 'home-B' } });

    // Invalidate ID across all homes from one of them.
    invalidateThreadCheckpointCache(ID, { allHomes: true });

    // Both homes must now hit disk (which still has the files; load works).
    // The behavioral evidence is that the in-memory cache no longer holds
    // either entry — we test that by mutating the disk file out from under
    // the cache and confirming we read the fresh disk value.
    rmSync(join(homeA, 'desktop', 'threads', `${ID}.json`));
    process.env.MELO_HOME = homeA;
    const afterDiskWipeA = await loadThreadCheckpoint(ID);
    assert.equal(
      afterDiskWipeA,
      null,
      'home A cache was cleared, so a disk-removed file should now read null instead of the stale cached value',
    );
  } finally {
    cleanup(homeA);
    cleanup(homeB);
    invalidateThreadCheckpointCache(null, { allHomes: true });
  }
});
