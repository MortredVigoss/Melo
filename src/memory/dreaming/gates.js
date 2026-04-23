/**
 * Promotion gates — decide whether a memory row qualifies to enter the Hot
 * attic beyond the naïve `useCount >= 5` threshold.
 *
 * Three signals, each scored 0..1:
 *   • recall frequency — how many times the row was pulled into a result in
 *     the last 14 days (log-scaled, saturates at 10 hits)
 *   • query diversity  — how many distinct query hashes pulled it in
 *     (saturates at 3)
 *   • outcome quality  — fraction of hits where the agent recorded 'used'
 *
 * A row passes if the weighted sum ≥ 0.6.  The exact weights are tunable
 * through env vars so operators can experiment without a rebuild.
 */

const RECALL_WEIGHT = Number(process.env.MELO_GATE_W_RECALL || 0.4);
const DIVERSITY_WEIGHT = Number(process.env.MELO_GATE_W_DIVERSITY || 0.35);
const OUTCOME_WEIGHT = Number(process.env.MELO_GATE_W_OUTCOME || 0.25);

const GATE_THRESHOLD = Number(process.env.MELO_GATE_THRESHOLD || 0.6);

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

/**
 * Pure scoring function — stats in, gate score out.
 *
 * @param {Object} stats  { hits, distinctQueries, goodOutcomes }
 * @returns {{ score: number, components: Object }}
 */
export function scoreGate(stats = {}) {
  const hits = Math.max(0, Number(stats.hits) || 0);
  const distinctQueries = Math.max(0, Number(stats.distinctQueries) || 0);
  const goodOutcomes = Math.max(0, Number(stats.goodOutcomes) || 0);

  // log-scaled saturating curves
  const recall = clamp01(Math.log2(hits + 1) / Math.log2(11)); // hits=10 → ~1
  const diversity = clamp01(distinctQueries / 3);
  const outcome = hits > 0 ? clamp01(goodOutcomes / hits) : 0;

  const score =
    RECALL_WEIGHT * recall +
    DIVERSITY_WEIGHT * diversity +
    OUTCOME_WEIGHT * outcome;

  return {
    score,
    components: { recall, diversity, outcome, rawHits: hits, rawDistinct: distinctQueries, rawGood: goodOutcomes },
  };
}

/**
 * Decide whether a row qualifies for Hot promotion based on gate score.
 *
 * @param {Object} stats  from getHitStats()
 * @returns {boolean}
 */
export function passesHotGate(stats) {
  return scoreGate(stats).score >= GATE_THRESHOLD;
}

/**
 * Apply the gate to a list of candidates that the attic evaluator would have
 * marked Hot purely by useCount — the gate acts as a second filter to reject
 * noisy-high-count rows.
 *
 * @param {Array<{id: string, stats: Object}>} candidates
 * @returns {{ accepted: Array<string>, rejected: Array<string> }}
 */
export function filterHotCandidates(candidates = []) {
  const accepted = [];
  const rejected = [];
  for (const c of candidates) {
    if (!c?.id) continue;
    if (passesHotGate(c.stats)) accepted.push(c.id);
    else rejected.push(c.id);
  }
  return { accepted, rejected };
}

export const GATE_CONFIG = {
  RECALL_WEIGHT,
  DIVERSITY_WEIGHT,
  OUTCOME_WEIGHT,
  GATE_THRESHOLD,
};
