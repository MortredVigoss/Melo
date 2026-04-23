/**
 * Dreaming sweep — single orchestrated pass over the memory store that:
 *
 *   1. Reassesses attic levels (via attic.js)
 *   2. Applies promotion gates to reject noisy-high-count Hot candidates
 *   3. Plans + applies duplicate merges via cosine similarity
 *   4. Plans temporal backfill (validTo for stale entries)
 *   5. Prunes old hit records
 *   6. Writes a DREAMS.md audit block
 *
 * The sweep is idempotent — running it twice in a row should make no further
 * changes on the second call.  Env-var `MELO_DREAMING_ENABLED=0` disables the
 * whole pipeline (useful for tests / paranoid users).
 */

import {
  listMemoriesForAtticReassess,
  setAtticLevels,
  listMergeCandidates,
  mergeMemoryInto,
  getHitStats,
  setValidTo,
  pruneHits,
  getMemoriesByIds,
  withTransaction,
} from '../store.js';
import { evaluateAtticLevel } from '../attic.js';
import { passesHotGate, scoreGate } from './gates.js';
import { planDuplicateMerges } from './merge.js';
import { planTemporalBackfill } from './backfill.js';
import { planIdentitySupersession } from './supersede.js';
import { appendDreamRecord } from './diary.js';

export function dreamingEnabled() {
  return process.env.MELO_DREAMING_ENABLED !== '0';
}

// ─── Module-scoped concurrency guard (Bug D) ─────────────────────────────────
//
// Two code paths can invoke a sweep concurrently:
//   • `startDreamingScheduler` fires the incremental + full timers
//   • `triggerDreamingNow` fires on UI "Consolidate now" and on idle detect
//
// Without a mutex, an incremental sweep started at T=0 and a full sweep at
// T=1s both read the same snapshot of `rows`, both plan the same merges,
// and both call `mergeMemoryInto` — the second caller now merges onto an
// already-merged chain, wasting work and occasionally tripping foreign-key
// edge cases.  The fix is a single flag: if a sweep is in-flight, return a
// well-formed "skipped" record instead of running.
let _sweepRunning = false;

/** @returns {boolean} true if a sweep is currently executing */
export function isSweepRunning() { return _sweepRunning; }

/** Test-only: force-release the mutex when a test throws mid-sweep. */
export function _resetSweepMutexForTests() { _sweepRunning = false; }

/**
 * Categorise a set of attic transitions into promoted / demoted / unchanged.
 *
 * Tier ranking: cold(0) < warm(1) < hot(2).  An "unknown" tier is treated as
 * cold so that a nascent row landing at warm counts as a promotion rather
 * than a no-op.
 *
 * @param {Array<{from: string, to: string}>} transitions
 * @returns {{ promoted: number, demoted: number, unchanged: number }}
 */
export function countAtticTransitions(transitions = []) {
  const RANK = { cold: 0, warm: 1, hot: 2 };
  let promoted = 0;
  let demoted = 0;
  let unchanged = 0;
  for (const t of transitions || []) {
    const from = RANK[t?.from] ?? 0;
    const to = RANK[t?.to] ?? 0;
    if (to > from) promoted += 1;
    else if (to < from) demoted += 1;
    else unchanged += 1;
  }
  return { promoted, demoted, unchanged };
}

/**
 * @param {Object} [options]
 * @param {string} [options.sinceIso]     incremental since timestamp
 * @param {number} [options.limit]        row cap for each phase
 * @param {boolean} [options.writeDiary]  default true
 * @param {Function} [options.llmClassifier]  stale-detection LLM
 * @param {number} [options.nowMs]        for tests
 * @returns {Promise<Object>} record with counts + per-phase detail
 */
export async function runDreamingSweep({
  sinceIso = null,
  limit = 2000,
  writeDiary = true,
  llmClassifier = null,
  nowMs = Date.now(),
} = {}) {
  const startedAt = new Date(nowMs).toISOString();

  if (!dreamingEnabled()) {
    return {
      startedAt,
      finishedAt: startedAt,
      skipped: true,
      reason: 'MELO_DREAMING_ENABLED=0',
    };
  }

  // Bug D: single-sweep-at-a-time.  If a sweep is already running, return a
  // "skipped" record rather than stepping on its toes.  The flag is cleared
  // in a finally so a thrown error doesn't wedge the mutex forever.
  if (_sweepRunning) {
    return {
      startedAt,
      finishedAt: startedAt,
      skipped: true,
      reason: 'sweep-already-running',
    };
  }
  _sweepRunning = true;

  try {

  // ────────────────────────────────────────────────────────────────────────
  // PLAN PHASE — reads + async LLM work.  NO writes happen in this half.
  // Splitting planning from applying lets us wrap every write in a single
  // atomic outer transaction below (Bug D) without holding the SQLite lock
  // across an await on planTemporalBackfill's LLM classifier.
  // ────────────────────────────────────────────────────────────────────────

  // ─── Phase 1: attic reassessment + gate filter ──────────────────────────
  const rows = listMemoriesForAtticReassess({ sinceIso, limit });
  const atticUpdates = [];
  const hotCandidates = [];
  // Keep each update's origin attic so the counters below can tell promotion
  // from demotion instead of bucketing everything non-hot as "demoted".
  const updateOrigin = new Map();
  const originOf = (row) => {
    const cur = row?.metadata?.attic;
    return cur === 'hot' || cur === 'warm' || cur === 'cold' ? cur : 'cold';
  };

  for (const row of rows) {
    const desired = evaluateAtticLevel(row, nowMs);
    const current = row.metadata?.attic;
    if (desired === current) continue;
    if (desired === 'hot') {
      hotCandidates.push(row.id);
    } else {
      atticUpdates.push({ id: row.id, attic: desired });
      updateOrigin.set(row.id, originOf(row));
    }
  }

  // Gate hot promotions against hit stats
  let promotedDetail = [];
  if (hotCandidates.length) {
    const statsRows = getHitStats({ memoryIds: hotCandidates, windowDays: 14 });
    const statsById = new Map(statsRows.map(r => [r.memoryId, r]));
    for (const id of hotCandidates) {
      const stats = statsById.get(id) || { hits: 0, distinctQueries: 0, goodOutcomes: 0 };
      const { score } = scoreGate(stats);
      // Identity / correction / decision short-circuit — those are Hot regardless.
      const source = rows.find(r => r.id === id);
      const category = String(source?.metadata?.category || source?.kind || '').toLowerCase();
      const isShortCircuit =
        category === 'correction' ||
        category === 'decision' ||
        category === 'identity' ||
        source?.metadata?.pinned;

      const origin = originOf(source);
      if (isShortCircuit || passesHotGate(stats)) {
        atticUpdates.push({ id, attic: 'hot' });
        updateOrigin.set(id, origin);
        promotedDetail.push({ id, level: 'hot', score });
      } else {
        // Reject Hot, but allow Warm if the row was at least touched.
        const resolved = stats.hits > 0 ? 'warm' : 'cold';
        atticUpdates.push({ id, attic: resolved });
        updateOrigin.set(id, origin);
      }
    }
  }

  // Rank-aware counters: promotion means moving up the temperature ladder
  // (cold → warm → hot), demotion means moving down.  The old implementation
  // double-counted cold → warm as demotion because "attic === 'warm'" was
  // treated as a demote state.
  const { promoted, demoted, unchanged } = countAtticTransitions(
    atticUpdates.map(u => ({
      from: updateOrigin.get(u.id) || 'cold',
      to: u.attic,
    })),
  );

  // ─── Phase 2: duplicate merge plan ──────────────────────────────────────
  // P2-12: an incremental sweep only needs to examine namespaces that have
  // been touched since the last run.  The full daily sweep (sinceIso=null)
  // still scans everything.
  const mergeCandidates = listMergeCandidates({ limit, sinceIso });
  const mergePlan = planDuplicateMerges(mergeCandidates);

  // ─── Phase 3a: identity supersession plan ───────────────────────────────
  const supersedePlan = planIdentitySupersession(rows, { nowMs });

  // ─── Phase 3b: temporal backfill plan (async — LLM classifier) ──────────
  // Skip rows we just plan to supersede — setValidTo would no-op but it's
  // cleaner to keep the phases independent.
  const supersededIds = new Set(supersedePlan.map(p => p.id));
  const staleCandidateRows = rows.filter(r => {
    if (supersededIds.has(r.id)) return false;
    const useCount = Number(r.metadata?.useCount) || 0;
    return !r.metadata?.validTo && useCount === 0;
  });
  const staleRowsFull = staleCandidateRows.length
    ? getMemoriesByIds(staleCandidateRows.map(r => r.id))
    : [];
  const backfillPlan = await planTemporalBackfill(staleRowsFull, { llmClassifier, nowMs });

  // ────────────────────────────────────────────────────────────────────────
  // APPLY PHASE — every write under one outer transaction.  Inner writers
  // still open their own `runInTransaction`, which falls through to a
  // SAVEPOINT so nesting is safe.  If anything throws the whole outer tx
  // rolls back — no half-done sweep state on disk.
  // ────────────────────────────────────────────────────────────────────────
  let mergedCount = 0;
  let supersededCount = 0;
  let expiredCount = 0;
  let hitsPruned = 0;

  withTransaction(() => {
    // Phase 1 apply
    setAtticLevels(atticUpdates);

    // Phase 2 apply
    for (const plan of mergePlan) {
      if (mergeMemoryInto({
        sourceId: plan.dropId,
        targetId: plan.keepId,
        useCountBonus: plan.useCountBonus,
      })) {
        mergedCount += 1;
      }
    }

    // Phase 3a apply — group by validTo so identical timestamps share a call.
    if (supersedePlan.length) {
      const byTo = new Map();
      for (const { id, validTo } of supersedePlan) {
        if (!byTo.has(validTo)) byTo.set(validTo, []);
        byTo.get(validTo).push(id);
      }
      for (const [vt, ids] of byTo) {
        supersededCount += setValidTo(ids, vt);
      }
    }

    // Phase 3b apply
    if (backfillPlan.length) {
      const byTo = new Map();
      for (const { id, validTo } of backfillPlan) {
        if (!byTo.has(validTo)) byTo.set(validTo, []);
        byTo.get(validTo).push(id);
      }
      for (const [vt, ids] of byTo) {
        expiredCount += setValidTo(ids, vt);
      }
    }

    // Phase 4 apply
    hitsPruned = pruneHits({ maxDays: 60 });
  });

  // ─── Phase 5: write audit record ────────────────────────────────────────
  const finishedAt = new Date().toISOString();
  const record = {
    startedAt,
    finishedAt,
    examined: rows.length,
    promoted,
    demoted,
    unchanged,
    merged: mergedCount,
    superseded: supersededCount,
    expired: expiredCount,
    hitsPruned,
    promotedRows: promotedDetail.slice(0, 50),
    mergeRows: mergePlan.slice(0, 50),
    supersededRows: supersedePlan.slice(0, 50),
    expiredRows: backfillPlan.slice(0, 50),
  };

  let diaryPath = null;
  if (writeDiary) {
    try { diaryPath = appendDreamRecord(record); } catch {}
  }

  return { ...record, diaryPath };
  } finally {
    _sweepRunning = false;
  }
}
