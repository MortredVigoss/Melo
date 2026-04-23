/**
 * Temporal backfill — scan "forgotten" rows (validTo not set, older than 90
 * days, useCount === 0) and decide which are stale.  Runs the local LLM
 * classifier when available; falls back to a conservative rule:
 *   • if the fact contains a version string (e.g. "v1.2" / "Node 18")
 *   • AND the entry is > 180 days old
 *   • THEN assume it's stale and paste validTo = createdAt + 180d.
 *
 * The classifier is pluggable — defaults to compactOffline-style JSON call.
 * Output is a list of `{ id, validTo }` tuples that the orchestrator applies
 * via `store.setValidTo()`.
 */

const STALE_MIN_AGE_DAYS = Number(process.env.MELO_STALE_AGE_DAYS || 90);
const STALE_FORCE_AGE_DAYS = Number(process.env.MELO_STALE_FORCE_DAYS || 180);
const DAY_MS = 86_400_000;

const VERSION_RE = /\b(v?\d+\.\d+(\.\d+)?|node\s*\d{2}|python\s*\d\.\d+|bun\s*\d|pnpm\s*v?\d)\b/i;

/**
 * Shape of a candidate:
 *   { id, text, createdAt, metadata: {useCount, validTo, ...} }
 *
 * The orchestrator supplies rows already filtered by `useCount === 0` and
 * `validTo == null`.  This module does the second-stage decision.
 *
 * @param {Array} rows
 * @param {Object} [options]
 * @param {(row: Object) => Promise<boolean>} [options.llmClassifier]  async returns true if obsolete
 * @param {number} [options.nowMs]
 * @returns {Promise<Array<{ id: string, validTo: string, reason: string }>>}
 */
export async function planTemporalBackfill(rows = [], { llmClassifier = null, nowMs = Date.now() } = {}) {
  const plan = [];
  for (const row of rows) {
    if (!row?.id) continue;
    if (row.metadata?.validTo) continue; // already sealed
    const createdAt = Date.parse(row.createdAt || row.updatedAt || '');
    if (!Number.isFinite(createdAt)) continue;
    const ageDays = (nowMs - createdAt) / DAY_MS;
    if (ageDays < STALE_MIN_AGE_DAYS) continue;

    // Conservative version-string rule — always fires.
    const hasVersion = VERSION_RE.test(row.text || '');
    if (hasVersion && ageDays >= STALE_FORCE_AGE_DAYS) {
      plan.push({
        id: row.id,
        validTo: new Date(createdAt + STALE_FORCE_AGE_DAYS * DAY_MS).toISOString(),
        reason: 'version-string & age≥180d',
      });
      continue;
    }

    // Optional: ask the local LLM.
    if (llmClassifier) {
      try {
        const isStale = await llmClassifier(row);
        if (isStale) {
          plan.push({
            id: row.id,
            validTo: new Date(nowMs).toISOString(),
            reason: 'llm-classifier',
          });
        }
      } catch {
        // swallow — classifier errors must never block the sweep
      }
    }
  }
  return plan;
}

export const BACKFILL_CONFIG = { STALE_MIN_AGE_DAYS, STALE_FORCE_AGE_DAYS };
