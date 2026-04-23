/**
 * Bug D — dreaming sweep concurrency + transaction regression tests.
 *
 * Two things we now guarantee:
 *
 *   1.  Only one sweep runs at a time.  A concurrent call returns a
 *       well-formed "skipped: sweep-already-running" record instead of
 *       stepping on the live sweep's writes.
 *
 *   2.  The apply half of a sweep is wrapped in a single `withTransaction`,
 *       so an error mid-apply rolls every phase back — no half-promoted
 *       attic state, no half-merged duplicates, no dangling validTo
 *       timestamps on disk.  Inner `runInTransaction` calls fall through
 *       to SAVEPOINT so nesting is safe.
 *
 * The tests use a synthetic LLM classifier to hold the promise open —
 * that's the one `await` in the sweep's plan phase — so we can fire a
 * second sweep while the first is parked and observe the mutex.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runDreamingSweep,
  isSweepRunning,
  _resetSweepMutexForTests,
} from './sweep.js';
import {
  withTransaction,
  upsertMemory,
  recallMemories,
} from '../store.js';

// ─── helpers ──────────────────────────────────────────────────────────────

/**
 * Build an llmClassifier that parks on a promise until we release it.  This
 * lets the test hold one sweep mid-plan (the single `await` in the pipeline
 * is `planTemporalBackfill`, which consults the classifier) while firing a
 * second sweep.
 */
function makeParkableClassifier() {
  let resolveGate;
  const gate = new Promise(r => { resolveGate = r; });
  let callCount = 0;
  const classify = async (_row) => {
    callCount += 1;
    await gate;
    // Return "active" — don't actually plan a temporal backfill.  We only
    // care about parking mid-sweep, not about the classifier's output.
    return { decision: 'active' };
  };
  classify.release = () => resolveGate?.();
  classify.callCount = () => callCount;
  return classify;
}

test.beforeEach(() => {
  _resetSweepMutexForTests();
});

// ─── mutex ────────────────────────────────────────────────────────────────

test('isSweepRunning: false when no sweep is in-flight', () => {
  assert.equal(isSweepRunning(), false);
});

test('concurrent runDreamingSweep: second call returns skipped=sweep-already-running', async () => {
  // We need ONE row that would be considered stale so the classifier is
  // actually consulted — otherwise the sweep never awaits and the mutex
  // never stays held long enough to race.  planTemporalBackfill requires
  // ageDays >= STALE_MIN_AGE_DAYS (90 default) before calling the
  // classifier, so backdate createdAt by 120 days.
  const id = `bugD-concurrency-${Date.now()}`;
  const oldIso = new Date(Date.now() - 120 * 86_400_000).toISOString();
  upsertMemory({
    id,
    namespace: 'test:bugD',
    kind: 'prompt',
    text: 'bugD concurrency seed',
    searchText: 'bugd concurrency seed',
    createdAt: oldIso,
    updatedAt: oldIso,
    metadata: { useCount: 0 },
  });

  const classifier = makeParkableClassifier();

  // First sweep — parks inside planTemporalBackfill.
  const firstP = runDreamingSweep({
    sinceIso: null,
    writeDiary: false,
    llmClassifier: classifier,
  });

  // Yield so the first sweep actually enters the plan phase and flips
  // _sweepRunning to true.  A microtask + a macrotask is enough.
  await new Promise(r => setImmediate(r));

  assert.equal(isSweepRunning(), true, 'first sweep holds the mutex');

  // Second sweep must observe the mutex and skip immediately — without
  // ever consulting the classifier.
  const second = await runDreamingSweep({
    sinceIso: null,
    writeDiary: false,
    llmClassifier: classifier,
  });
  assert.equal(second.skipped, true);
  assert.equal(second.reason, 'sweep-already-running');
  // startedAt == finishedAt — we didn't actually run.
  assert.equal(second.startedAt, second.finishedAt);

  // Release the first sweep and wait for it to finish.
  classifier.release();
  const first = await firstP;
  assert.equal(first.skipped, undefined, 'first sweep completed normally');
  assert.equal(isSweepRunning(), false, 'mutex cleared after first sweep');
});

test('mutex clears even when the sweep throws mid-plan', async () => {
  // Make the LLM classifier throw.  planTemporalBackfill treats that as a
  // fatal error that aborts the whole sweep (it's inside our try/finally).
  const throwingClassifier = async () => {
    throw new Error('boom — synthetic llm failure');
  };

  // We need at least one stale-candidate row (age >=90d, useCount=0) to
  // trigger the classifier.
  const id = `bugD-throw-${Date.now()}`;
  const oldIso = new Date(Date.now() - 120 * 86_400_000).toISOString();
  upsertMemory({
    id,
    namespace: 'test:bugD',
    kind: 'prompt',
    text: 'bugD throw seed',
    searchText: 'bugd throw seed',
    createdAt: oldIso,
    updatedAt: oldIso,
    metadata: { useCount: 0 },
  });

  let caught = null;
  try {
    await runDreamingSweep({
      sinceIso: null,
      writeDiary: false,
      llmClassifier: throwingClassifier,
    });
  } catch (err) {
    caught = err;
  }
  // Whether planTemporalBackfill swallows the error or not, the mutex MUST
  // be released.  If it doesn't swallow, we record the thrown error here
  // but still expect the mutex to be clear.
  void caught;
  assert.equal(isSweepRunning(), false, 'mutex must be cleared in finally');

  // And a follow-up sweep should be free to run (classifier returns active
  // this time so nothing changes).
  const follow = await runDreamingSweep({
    sinceIso: null,
    writeDiary: false,
    llmClassifier: async () => ({ decision: 'active' }),
  });
  assert.notEqual(follow.reason, 'sweep-already-running', 'follow-up sweep is not blocked');
});

test('runDreamingSweep releases mutex on normal completion', async () => {
  assert.equal(isSweepRunning(), false);
  await runDreamingSweep({ sinceIso: null, writeDiary: false });
  assert.equal(isSweepRunning(), false);
});

// ─── withTransaction (re-entrant) ────────────────────────────────────────

test('withTransaction: inner writer that uses runInTransaction nests via SAVEPOINT', () => {
  // If re-entry were broken, the inner upsertMemory's BEGIN would throw
  // "cannot start a transaction within a transaction".  This test proves
  // the savepoint path works.
  const id = `bugD-nested-${Date.now()}`;
  withTransaction(() => {
    upsertMemory({
      id,
      namespace: 'test:bugD',
      kind: 'prompt',
      text: 'nested tx writer',
      searchText: 'nested tx writer',
    });
  });
  const rows = recallMemories({
    namespaces: ['test:bugD'],
    kinds: ['prompt'],
    limit: 20,
  });
  assert.ok(rows.some(r => r.id === id), 'row written inside outer tx is visible');
});

test('withTransaction: throwing inside rolls back every inner write', () => {
  const idA = `bugD-rollback-A-${Date.now()}`;
  const idB = `bugD-rollback-B-${Date.now()}`;

  assert.throws(() => {
    withTransaction(() => {
      upsertMemory({
        id: idA,
        namespace: 'test:bugD',
        kind: 'prompt',
        text: 'should rollback A',
        searchText: 'should rollback a',
      });
      upsertMemory({
        id: idB,
        namespace: 'test:bugD',
        kind: 'prompt',
        text: 'should rollback B',
        searchText: 'should rollback b',
      });
      throw new Error('boom — mid-transaction failure');
    });
  }, /boom/);

  const rows = recallMemories({
    namespaces: ['test:bugD'],
    kinds: ['prompt'],
    limit: 50,
  });
  const ids = rows.map(r => r.id);
  assert.equal(
    ids.includes(idA),
    false,
    'row A was NOT committed — outer tx rollback worked',
  );
  assert.equal(
    ids.includes(idB),
    false,
    'row B was NOT committed — outer tx rollback worked',
  );
});

test('withTransaction: savepoint rollback on inner throw does not poison outer writes', () => {
  // Outer tx writes row A, then a nested withTransaction throws after
  // writing row B.  Outer should catch + ignore, commit A.  (We model
  // that catch manually — in production a caller would decide whether to
  // rethrow.)
  const idA = `bugD-sp-A-${Date.now()}`;
  const idB = `bugD-sp-B-${Date.now()}`;

  withTransaction(() => {
    upsertMemory({
      id: idA,
      namespace: 'test:bugD',
      kind: 'prompt',
      text: 'outer commits',
      searchText: 'outer commits',
    });
    try {
      withTransaction(() => {
        upsertMemory({
          id: idB,
          namespace: 'test:bugD',
          kind: 'prompt',
          text: 'inner rolls back',
          searchText: 'inner rolls back',
        });
        throw new Error('inner-boom');
      });
    } catch (err) {
      // Swallow — the outer tx should still be in a clean state and able
      // to commit.  If savepoint rollback were broken, the inner's
      // ROLLBACK would have taken out the outer BEGIN too.
      void err;
    }
  });

  const rows = recallMemories({
    namespaces: ['test:bugD'],
    kinds: ['prompt'],
    limit: 50,
  });
  const ids = rows.map(r => r.id);
  assert.ok(ids.includes(idA), 'outer row A committed');
  assert.equal(ids.includes(idB), false, 'inner row B rolled back at savepoint');
});
