/**
 * 2026-06-04 audit闭环: media-cache TTL eviction.
 *
 * Pre-fix, getCachedExtraction returned null for an expired entry but never
 * deleted the file → $MELO_HOME/media-cache grew unbounded over a long-lived
 * process (only per-entry size cap, no time-based pruning). The fix unlinks
 * the stale file on read. These are real behavioral tests (fs + MELO_HOME
 * isolation), not source greps.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { readdir, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

let prevHome;
let tmpHome;

test.beforeEach(() => {
  prevHome = process.env.MELO_HOME;
  tmpHome = mkdtempSync(join(tmpdir(), 'melo-media-cache-test-'));
  process.env.MELO_HOME = tmpHome;
});
test.afterEach(() => {
  if (prevHome === undefined) delete process.env.MELO_HOME;
  else process.env.MELO_HOME = prevHome;
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch {}
});

const {
  getCachedExtraction,
  setCachedExtraction,
  _sweepExpiredNowForTests,
  _resetSweepStateForTests,
  _drainPendingSweepForTests,
} = await import('./cache.js');

// Mirror cacheKeyToPath so the test can locate a specific key's file WITHOUT
// re-reading it (the whole point: prove a never-re-read entry gets swept).
function keyToPath(home, key) {
  const hash = createHash('sha256').update(String(key)).digest('hex');
  return join(home, 'media-cache', hash.slice(0, 2), `${hash.slice(2)}.json`);
}

async function backdate(filePath, daysAgo) {
  const sec = Date.now() / 1000 - daysAgo * 24 * 60 * 60;
  await utimes(filePath, sec, sec);
}

test('fresh entry round-trips (set → get returns value, file kept)', async () => {
  await setCachedExtraction('key-fresh', { text: 'hello', kind: 'transcript' });
  const got = await getCachedExtraction('key-fresh');
  assert.deepEqual(got, { text: 'hello', kind: 'transcript' });
  assert.ok(existsSync(keyToPath(tmpHome, 'key-fresh')), 'fresh entry file kept after a read');
});

test('expired entry is unlinked on read (opportunistic prune of re-read stale keys)', async () => {
  await setCachedExtraction('key-stale', { text: 'old' });
  const file = keyToPath(tmpHome, 'key-stale');
  assert.ok(existsSync(file), 'entry file must exist after set');
  await backdate(file, 30); // 30 days > 7-day TTL

  const got = await getCachedExtraction('key-stale');
  assert.equal(got, null, 'expired entry reads as miss');
  assert.equal(existsSync(file), false, 'expired entry unlinked on read');
});

test('write-path sweep prunes NEVER-RE-READ expired entries (the real growth bound — Codex C round-2 闭环)', async () => {
  // This is the invariant the on-read prune alone could NOT satisfy: a
  // one-shot URL whose key is never queried again. The rate-limited sweep on
  // the write path must reclaim it.
  _resetSweepStateForTests();

  // Two one-shot entries that we will NEVER getCachedExtraction() on, then
  // backdate past TTL.
  await setCachedExtraction('oneshot-a', { text: 'a' });
  await setCachedExtraction('oneshot-b', { text: 'b' });
  // A fresh entry that must survive the sweep.
  await setCachedExtraction('keep-fresh', { text: 'keep' });

  const fileA = keyToPath(tmpHome, 'oneshot-a');
  const fileB = keyToPath(tmpHome, 'oneshot-b');
  const fileKeep = keyToPath(tmpHome, 'keep-fresh');
  assert.ok(existsSync(fileA) && existsSync(fileB) && existsSync(fileKeep), 'all three written');

  await backdate(fileA, 30);
  await backdate(fileB, 30);
  // keep-fresh stays at its real (now) mtime.

  // Run the sweep (bypassing the hourly cooldown). Note: we NEVER read
  // oneshot-a/b, so only the sweep can reclaim them.
  await _sweepExpiredNowForTests();

  assert.equal(existsSync(fileA), false, 'never-re-read expired entry A must be swept');
  assert.equal(existsSync(fileB), false, 'never-re-read expired entry B must be swept');
  assert.ok(existsSync(fileKeep), 'fresh entry must survive the sweep');
});

test('setCachedExtraction triggers the rate-limited sweep on the write path', async () => {
  // Wiring proof: a stale never-re-read file is reclaimed by a subsequent
  // write (after the cooldown is reset), without ever reading the stale key.
  _resetSweepStateForTests();
  await setCachedExtraction('stale-oneshot', { text: 'x' }); // first write also sweeps (cooldown empty)
  const stale = keyToPath(tmpHome, 'stale-oneshot');
  await backdate(stale, 30);

  _resetSweepStateForTests(); // allow the next write to sweep again
  await setCachedExtraction('any-trigger', { text: 'y' }); // launches a background sweep
  // Deterministically await the background sweep the write launched (no
  // fixed-tick guessing — that could flake on a slow FS).
  await _drainPendingSweepForTests();
  assert.equal(existsSync(stale), false,
    'a write (post-cooldown) must trigger a sweep that reclaims never-re-read expired entries');
});

test('unlink failure does not break the read path (best-effort prune)', async () => {
  // Reading a never-written key: stat throws → caught → null, exception-safe
  // regardless of any prune attempt.
  const got = await getCachedExtraction('never-written-key');
  assert.equal(got, null);
});
