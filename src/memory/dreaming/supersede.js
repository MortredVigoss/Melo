/**
 * Identity supersession — the lone exit valve for identity rows.
 *
 * Identity rows are merge-protected by design (see merge.js): collapsing two
 * contradictory identity rows into one would silently lose the belief
 * revision.  But that same protection means stale identity rows ("Role:
 * student" written in 2023) accumulate forever alongside the new one ("Role:
 * researcher" written in 2026).
 *
 * The rule: within a single namespace, two identity rows whose *attribute
 * prefix* (the piece before the first colon in the fact text — e.g. `Role`,
 * `Name`, `Location`, `Works at`) match, should collapse to the newest one.
 * The older rows get `validTo = now` so recall filters them out while we
 * keep the audit trail.
 *
 * This is a pure planner.  The caller applies the plan via `setValidTo`.
 */
const PREFIX_RE = /^\s*([A-Za-z][A-Za-z\s]{0,24}?)\s*[:：]/;

/** Extract a normalised attribute prefix — e.g. "Role: xyz" → "role". */
export function identityAttributeKey(row) {
  if (!row || typeof row !== 'object') return '';
  // Prefer explicit metadata, fall back to parsing text.
  const metaHint = row.metadata?.attribute || row.metadata?.attrKey;
  if (metaHint) return String(metaHint).trim().toLowerCase();
  const text = String(row.text || '').trim();
  const m = text.match(PREFIX_RE);
  if (m?.[1]) return m[1].replace(/\s+/g, ' ').trim().toLowerCase();
  return '';
}

function isIdentityRow(row) {
  if (!row) return false;
  if (row.metadata?.validTo) return false;         // already retired
  if (row.metadata?.pinned) return false;          // pinned rows opt out
  const cat = String(row.metadata?.category || row.kind || '').toLowerCase();
  return cat === 'identity';
}

function pickWinner(a, b) {
  // "Newer is truer" — prefer row with the most recent updatedAt.  Tie-break
  // on createdAt, then metadata.validFrom, then lexical id for determinism.
  const toTs = (r) => Date.parse(r?.updatedAt || r?.createdAt || r?.metadata?.validFrom || '') || 0;
  const ta = toTs(a);
  const tb = toTs(b);
  if (tb > ta) return b;
  if (ta > tb) return a;
  return String(a.id) <= String(b.id) ? a : b;
}

/**
 * @param {Array} rows
 * @param {{ nowMs?: number }} [options]
 * @returns {Array<{ id: string, validTo: string, reason: string, winnerId: string }>}
 */
export function planIdentitySupersession(rows = [], { nowMs = Date.now() } = {}) {
  const groups = new Map();
  for (const row of rows) {
    if (!isIdentityRow(row)) continue;
    const attr = identityAttributeKey(row);
    if (!attr) continue;                           // can't compare without an attribute
    const key = `${row.namespace || ''}\u241E${attr}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const plan = [];
  const nowIso = new Date(nowMs).toISOString();
  for (const [, bucket] of groups) {
    if (bucket.length < 2) continue;
    // Determine the single winner.
    let winner = bucket[0];
    for (let i = 1; i < bucket.length; i++) winner = pickWinner(winner, bucket[i]);
    for (const row of bucket) {
      if (row.id === winner.id) continue;
      plan.push({
        id: row.id,
        validTo: nowIso,
        reason: 'identity-supersession',
        winnerId: winner.id,
      });
    }
  }
  return plan;
}
