/**
 * Duplicate merging — collapse semantically identical facts discovered via
 * cosine similarity over their bge-m3 embeddings.  The survivor inherits the
 * union useCount + mergedFrom[] list; the losers are flagged
 * metadata.mergedInto and demoted to cold (kept for audit).
 *
 * This is a *pure planner* module — it returns a list of merge operations.
 * The caller applies them via `store.mergeMemoryInto()` in a transaction.
 *
 * Threshold: cosine ≥ 0.92 by default (MELO_MERGE_COSINE override).
 *
 * Grouping rules (Search audit C-5):
 *   - By default, only rows with the same (namespace, kind) tuple are
 *     grouped. A 'scene' will never be merged into a 'frame' etc.
 *   - Exception: `fact` and `session-fact` in the same namespace ARE
 *     grouped together and can merge across that boundary. The reason is
 *     that a promotable session fact ("2024-01-01 user said they live in
 *     Paris") is often a near-duplicate of a standing fact ("User lives
 *     in Paris") once it graduates — and leaving both in the store
 *     dilutes recall and shows the user two rows that say the same thing.
 *   - When a cross-kind merge fires, the kept row is ALWAYS the `fact`
 *     variant (more permanent / more general). useCount is still the
 *     tiebreaker inside a single kind.
 */

import { cosineSimilarity } from '../embeddings.js';

const MERGE_COSINE = Number(process.env.MELO_MERGE_COSINE || 0.92);

// Rows in these categories carry supersession semantics (corrections), lock
// a commitment (decisions) or state a core identity fact — merging them
// silently collapses belief revisions and is always the wrong move.  Also
// protect any pinned row regardless of category.
const PROTECTED_CATEGORIES = new Set(['correction', 'decision', 'identity']);

function isMergeProtected(candidate) {
  if (!candidate || typeof candidate !== 'object') return false;
  if (candidate.metadata?.pinned) return true;
  const category = String(
    candidate.metadata?.category || candidate.kind || '',
  ).toLowerCase();
  return PROTECTED_CATEGORIES.has(category);
}

/** Test-only inspection hook. */
export function _isMergeProtectedForTests(candidate) {
  return isMergeProtected(candidate);
}

/**
 * @typedef {{id: string, namespace: string, kind: string, text: string,
 *           embedding: Float32Array|null, metadata: Object, updatedAt: string}} Candidate
 */

/**
 * Kinds that should be grouped together despite having different `kind`
 * values.  Used for cross-kind duplicate detection: a promoted `fact` and
 * its originating `session-fact` are semantic duplicates even though their
 * `kind` differs.  Expressed as a sorted canonical key so either permutation
 * maps to the same bucket.
 */
const CROSS_KIND_GROUPS = [['fact', 'session-fact']];

function groupKeyFor(kind) {
  for (const group of CROSS_KIND_GROUPS) {
    if (group.includes(kind)) return `@${[...group].sort().join('+')}`;
  }
  return kind;
}

/**
 * Within a cross-kind group, prefer the more general kind.  Today that
 * means `fact` beats `session-fact`; other ties fall through to the
 * useCount-based sort below.  Returns a rank number — lower ranks sort
 * first (i.e. lower = survivor).
 */
function kindSurvivorRank(kind) {
  if (kind === 'fact') return 0;
  if (kind === 'session-fact') return 1;
  return 2;
}

/**
 * @param {Candidate[]} candidates
 * @returns {Array<{ keepId: string, dropId: string, similarity: number, useCountBonus: number }>}
 */
export function planDuplicateMerges(candidates = []) {
  const byKey = new Map();
  for (const c of candidates) {
    if (!c?.embedding) continue;
    if (c.metadata?.mergedInto) continue; // already merged
    if (isMergeProtected(c)) continue;    // corrections/decisions/identity/pinned are never merged
    const key = `${c.namespace}\u241E${groupKeyFor(c.kind)}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(c);
  }

  const plan = [];

  for (const group of byKey.values()) {
    // Sort survivor-first.  Inside a cross-kind bucket we prefer the more
    // general kind (fact over session-fact); inside any bucket we then
    // prefer higher useCount; final tiebreaker is older updatedAt so we
    // don't churn on identical rows.
    group.sort((a, b) => {
      const rk = kindSurvivorRank(a.kind) - kindSurvivorRank(b.kind);
      if (rk !== 0) return rk;
      const uc = (Number(b.metadata?.useCount) || 0) - (Number(a.metadata?.useCount) || 0);
      if (uc !== 0) return uc;
      return String(a.updatedAt || '').localeCompare(String(b.updatedAt || ''));
    });

    const dropped = new Set();
    for (let i = 0; i < group.length; i++) {
      const keeper = group[i];
      if (dropped.has(keeper.id)) continue;
      for (let j = i + 1; j < group.length; j++) {
        const cand = group[j];
        if (dropped.has(cand.id)) continue;
        const sim = cosineSimilarity(keeper.embedding, cand.embedding);
        if (sim >= MERGE_COSINE) {
          plan.push({
            keepId: keeper.id,
            dropId: cand.id,
            similarity: sim,
            useCountBonus: Math.max(0, Number(cand.metadata?.useCount) || 0),
            crossKind: keeper.kind !== cand.kind,
          });
          dropped.add(cand.id);
        }
      }
    }
  }

  return plan;
}

export const MERGE_CONFIG = { MERGE_COSINE };
