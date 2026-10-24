import { COMPACT_TRIGGER_TOKENS, CONTEXT_WINDOW_TOKENS, COMPACT_KEEP_RECENT_MIN, MAX_COMPACT_FAILURES } from './limits.js';
export { COMPACT_TRIGGER_TOKENS, CONTEXT_WINDOW_TOKENS, COMPACT_KEEP_RECENT_MIN, MAX_COMPACT_FAILURES };
// Pure history window; byte-for-byte port from contextCompact.js.
import { estimateMessageTokens } from './tokenEstimate.js';

// ─── Thresholds ────────────────────────────────────────────────────────────────
// These two constants are FALLBACKS only. The live values come from
// resolveContextBudget() in services/chat/contextBudget.js, which derives the
// window and the compaction trigger from one total budget so they cannot
// drift apart (2026-10-17 audit P0-2: a 60k window with an 80k trigger left
// a band of history that was neither sent nor summarised). Callers in the
// chat pipeline pass the resolved values explicitly; tests and legacy
// callers that pass nothing still get these.

/** Fallback: trigger a full LLM compact when pending history exceeds this. */


/** Fallback: maximum history tokens carried by the sliding window. */


/** Always preserve at least this many recent messages verbatim. */


/** Stop retrying compact after this many consecutive failures. */


// ─── Token-bounded sliding window ─────────────────────────────────────────────

/**
 * Returns the tail of `messages` that fits within `tokenBudget` tokens,
 * always keeping at least `minKeep` messages regardless of size.
 *
 * This replaces the old hard `slice(-12)`:  short conversations send their full
 * history; long ones are trimmed at the token boundary, not a fixed count.
 *
 * @param {Array}  messages
 * @param {number} [tokenBudget]  – default CONTEXT_WINDOW_TOKENS
 * @param {number} [minKeep]      – default COMPACT_KEEP_RECENT_MIN
 * @returns {Array}
 */
export function buildRecentWindow(
  messages = [],
  tokenBudget = CONTEXT_WINDOW_TOKENS,
  minKeep = COMPACT_KEEP_RECENT_MIN,
) {
  const all = messages;
  if (!Number.isFinite(tokenBudget) || tokenBudget <= 0) tokenBudget = CONTEXT_WINDOW_TOKENS;
  // Start from the minimum guaranteed tail and grow backwards.
  // Use raw (un-padded) per-message estimates throughout so the loop increment
  // is consistent with the initial used sum.  The caller-facing budget is
  // already expressed in conservative "final" tokens; dividing by (4/3) here
  // converts it to the same raw scale as estimateMessageTokens().
  const rawBudget = Math.floor(tokenBudget * (3 / 4));
  let start = Math.max(0, all.length - minKeep);
  let used = all.slice(start).reduce((s, m) => s + estimateMessageTokens(m), 0);

  while (start > 0) {
    const cost = estimateMessageTokens(all[start - 1]);
    if (used + cost > rawBudget) break;
    start--;
    used += cost;
  }

  return all.slice(start);
}

