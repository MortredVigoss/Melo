// Pure history window; byte-for-byte port from contextCompact.js.
import { estimateMessageTokens } from './tokenEstimate.js';

// ─── Thresholds ────────────────────────────────────────────────────────────────

/** Trigger a full LLM compact when total history exceeds this. */
export const COMPACT_TRIGGER_TOKENS = 80_000;

/**
 * Maximum tokens sent in a single API request.
 * The sliding window never exceeds this budget.
 */
export const CONTEXT_WINDOW_TOKENS = 60_000;

/** Always preserve at least this many recent messages verbatim. */
export const COMPACT_KEEP_RECENT_MIN = 6;

/** Stop retrying compact after this many consecutive failures. */
export const MAX_COMPACT_FAILURES = 3;

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

