/**
 * Phase 3 — collectMemoryStatus / withLiveProviderModelId contract tests.
 *
 * The collector is consumed by two surfaces (CLI + server), so the shape
 * is part of the contract — the UI and the stdout formatter both rely on
 * the same keys being present.  These tests pin that shape.
 *
 * We DO NOT want to mutate the real store under $MELO_HOME, so every test
 * here swaps in a disposable temp dir via MELO_HOME before importing /
 * calling the collector.  That also lets us verify the "fresh install"
 * shape (no store yet) without special-casing the live DB.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { collectMemoryStatus, withLiveProviderModelId, getMeloHome } from './status.js';

function withTempMeloHome(fn) {
  const prev = process.env.MELO_HOME;
  const dir = mkdtempSync(join(tmpdir(), 'melo-status-test-'));
  process.env.MELO_HOME = dir;
  try {
    return fn(dir);
  } finally {
    if (prev === undefined) delete process.env.MELO_HOME;
    else process.env.MELO_HOME = prev;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
  }
}

test('getMeloHome honours MELO_HOME override', () => {
  withTempMeloHome(dir => {
    assert.equal(getMeloHome(), dir);
  });
});

test('collectMemoryStatus: fresh install (no store.sqlite) has a valid shape', () => {
  withTempMeloHome(dir => {
    const snap = collectMemoryStatus();
    // Top-level keys the UI + CLI both expect.
    assert.equal(snap.meloHome, dir);
    assert.ok(snap.store && typeof snap.store === 'object');
    assert.equal(snap.store.exists, false, 'no store in a fresh temp home');
    assert.equal(snap.store.sizeBytes, null);
    assert.equal(snap.meta, null);
    // Counts all present but null-valued on fresh install.
    assert.ok(snap.counts && typeof snap.counts === 'object');
    for (const k of ['memories', 'memoriesFts', 'vecMemories', 'embeddingCache']) {
      assert.ok(k in snap.counts, `counts missing key ${k}`);
      assert.equal(snap.counts[k], null, `counts.${k} should be null pre-store`);
    }
    // Dreams dir simply doesn't exist — count 0, no latest.
    assert.equal(snap.dreams.count, 0);
    assert.equal(snap.dreams.latest, null);
    assert.ok(snap.dreams.dir.endsWith('dreams'));
    // Embedding block — defaults populated, drift slot exists but not flagged.
    assert.ok(snap.embedding && typeof snap.embedding === 'object');
    assert.equal(typeof snap.embedding.dimsConfigured, 'number');
    assert.equal(snap.embedding.storedModelId, null);
    assert.deepEqual(snap.embedding.drift, {
      stored: null,
      inferredProvider: null,
      hasDrift: false,
      probeAttempted: false,
    });
    // Tuning reads env; default values must be numbers, never NaN.
    assert.equal(typeof snap.tuning.mmrLambda, 'number');
    assert.equal(Number.isFinite(snap.tuning.mmrLambda), true);
    assert.equal(typeof snap.tuning.recencyHalfLifeDays, 'number');
    assert.equal(Number.isFinite(snap.tuning.recencyHalfLifeDays), true);
  });
});

test('collectMemoryStatus: counts dream .md files under desktop/dreams', () => {
  withTempMeloHome(dir => {
    const dreamsDir = join(dir, 'desktop', 'dreams');
    mkdirSync(dreamsDir, { recursive: true });
    writeFileSync(join(dreamsDir, 'a.md'), '# dream a');
    writeFileSync(join(dreamsDir, 'b.md'), '# dream b');
    // A non-.md file should be ignored.
    writeFileSync(join(dreamsDir, 'notes.txt'), 'ignored');
    const snap = collectMemoryStatus();
    assert.equal(snap.dreams.count, 2);
    assert.ok(snap.dreams.latest);
    assert.match(snap.dreams.latest.name, /^[ab]\.md$/);
    assert.equal(typeof snap.dreams.latest.mtimeMs, 'number');
  });
});

test('collectMemoryStatus: env overrides for MMR + recency are picked up', () => {
  const prevLambda = process.env.MELO_MMR_LAMBDA;
  const prevHalf = process.env.MELO_RECENCY_HALF_LIFE_DAYS;
  withTempMeloHome(() => {
    process.env.MELO_MMR_LAMBDA = '0.42';
    process.env.MELO_RECENCY_HALF_LIFE_DAYS = '7';
    try {
      const snap = collectMemoryStatus();
      assert.equal(snap.tuning.mmrLambda, 0.42);
      assert.equal(snap.tuning.recencyHalfLifeDays, 7);
    } finally {
      if (prevLambda === undefined) delete process.env.MELO_MMR_LAMBDA;
      else process.env.MELO_MMR_LAMBDA = prevLambda;
      if (prevHalf === undefined) delete process.env.MELO_RECENCY_HALF_LIFE_DAYS;
      else process.env.MELO_RECENCY_HALF_LIFE_DAYS = prevHalf;
    }
  });
});

test('withLiveProviderModelId: no stored + no live → no drift', () => {
  withTempMeloHome(() => {
    const base = collectMemoryStatus();
    const aug = withLiveProviderModelId(base, null);
    assert.equal(aug.embedding.drift.hasDrift, false);
    assert.equal(aug.embedding.drift.stored, null);
    assert.equal(aug.embedding.drift.inferredProvider, null);
  });
});

test('withLiveProviderModelId: stored matches live → no drift', () => {
  withTempMeloHome(() => {
    // Seed a drift.stored manually; the collector normally reads this from
    // _meta, but we're testing the pure augmenter here.
    const base = collectMemoryStatus();
    base.embedding.drift.stored = 'bge-m3';
    const aug = withLiveProviderModelId(base, 'bge-m3');
    assert.equal(aug.embedding.drift.hasDrift, false);
    assert.equal(aug.embedding.drift.stored, 'bge-m3');
    assert.equal(aug.embedding.drift.inferredProvider, 'bge-m3');
  });
});

test('withLiveProviderModelId: stored differs from live → flags drift', () => {
  withTempMeloHome(() => {
    const base = collectMemoryStatus();
    base.embedding.drift.stored = 'bge-m3';
    const aug = withLiveProviderModelId(base, 'text-embedding-3-large');
    assert.equal(aug.embedding.drift.hasDrift, true);
    assert.equal(aug.embedding.drift.stored, 'bge-m3');
    assert.equal(aug.embedding.drift.inferredProvider, 'text-embedding-3-large');
  });
});

test('withLiveProviderModelId: live set but stored null → treated as not-yet-drift', () => {
  // First boot: nothing stored yet.  The collector returns stored=null; the
  // augmenter must NOT flag drift in that case — runtime.js will seed the
  // stored value on the first healthy boot, not warn about it.
  withTempMeloHome(() => {
    const base = collectMemoryStatus();
    base.embedding.drift.stored = null;
    const aug = withLiveProviderModelId(base, 'bge-m3');
    assert.equal(aug.embedding.drift.hasDrift, false);
    assert.equal(aug.embedding.drift.inferredProvider, 'bge-m3');
  });
});

test('withLiveProviderModelId: whitespace in live modelId is trimmed before compare', () => {
  withTempMeloHome(() => {
    const base = collectMemoryStatus();
    base.embedding.drift.stored = 'bge-m3';
    const aug = withLiveProviderModelId(base, '   bge-m3  ');
    assert.equal(aug.embedding.drift.hasDrift, false);
    assert.equal(aug.embedding.drift.inferredProvider, 'bge-m3');
  });
});

test('withLiveProviderModelId: does not mutate the input snapshot', () => {
  withTempMeloHome(() => {
    const base = collectMemoryStatus();
    base.embedding.drift.stored = 'model-a';
    const snapshotJson = JSON.stringify(base);
    withLiveProviderModelId(base, 'model-b');
    assert.equal(JSON.stringify(base), snapshotJson, 'augmenter must be pure');
  });
});

test('withLiveProviderModelId: probeAttempted defaults false on collect, true after augment', () => {
  withTempMeloHome(() => {
    const base = collectMemoryStatus();
    // Collector alone never probes — probeAttempted must be false.
    assert.equal(base.embedding.drift.probeAttempted, false);
    // Calling the augmenter flips it, regardless of whether the live
    // modelId was actually resolved.
    const withNull = withLiveProviderModelId(base, null);
    assert.equal(withNull.embedding.drift.probeAttempted, true);
    assert.equal(withNull.embedding.drift.inferredProvider, null);
    const withValue = withLiveProviderModelId(base, 'bge-m3');
    assert.equal(withValue.embedding.drift.probeAttempted, true);
    assert.equal(withValue.embedding.drift.inferredProvider, 'bge-m3');
  });
});
