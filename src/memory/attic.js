/**
 * Attic theory — macroscopic three-tier importance dial.
 *
 *   Hot    : always injected, ≤ 800 tokens.  Core identity, pins, active
 *            corrections and decisions, plus a few frequently-used facts.
 *   Warm   : injected when a related query triggers tier-2 recall,
 *            ≤ 1600 tokens.
 *   Cold   : not in the prompt budget at all.  Only surfaces when the
 *            tiered ANN recall pulls it up.
 *
 * This module is pure policy — it decides where a row belongs based on use
 * count, freshness, category, and explicit pin flags.  The store owns the
 * persistence side of things (setAtticLevels / listMemoriesForAtticReassess).
 *
 * Exports:
 *   evaluateAtticLevel(row, nowMs)        – pure, deterministic
 *   reassessAttic({ sinceIso })           – one pass; updates metadata.attic
 *   injectHotAttic({ namespaces, limit }) – assemble the Hot block for prompts
 */

import { requestEnvironment } from '../runtime/requestScope.js';
import { estimateTextTokens } from './tokenEstimate.js';
import { normalizedFact } from './factPolicy.js';
import {
  listMemoriesForAtticReassess,
  setAtticLevels,
  recallMemories,
} from './store.js';

// Thresholds
const HOT_USE_COUNT = 5;
const HOT_USE_MAX_AGE_DAYS = 14;
const WARM_USE_COUNT = 1;
const WARM_USE_MAX_AGE_DAYS = 30;
const COLD_IDLE_DAYS = 90;
const DAY_MS = 86_400_000;

const HOT_CATEGORIES = new Set(['correction', 'decision']);

export const ATTIC_HOT_TOKEN_BUDGET = 800;
export const ATTIC_WARM_TOKEN_BUDGET = 1600;

// ─── Pure evaluation ────────────────────────────────────────────────────────

/**
 * Decide whether a row belongs in 'hot' | 'warm' | 'cold'.
 *
 * Inputs use Melo's "row" shape: { metadata, updatedAt, lastUsedAt, … }.
 * `metadata.category` (from session-fact kind) or `metadata.kind`-ish cues
 * can bump the row to hot directly.
 *
 * @param {Object} row
 * @param {number} [nowMs]
 * @returns {'hot' | 'warm' | 'cold'}
 */
export function evaluateAtticLevel(row, nowMs = Date.now()) {
  const metadata = row?.metadata || {};
  const pinned = Boolean(metadata.pinned);
  const currentLevel = metadata.attic;
  const category = String(metadata.category || row?.kind || '').toLowerCase();
  const useCount = Math.max(0, Number(metadata.useCount) || 0);

  // Explicit pins always win.
  if (pinned) return 'hot';

  // Correction / decision / identity → hot unconditionally.
  if (HOT_CATEGORIES.has(category)) return 'hot';
  if (category === 'identity' || metadata.kind === 'identity') return 'hot';

  const lastUsedRaw = row?.lastUsedAt || metadata.lastUsedAt || row?.updatedAt;
  const lastUsedTs = Date.parse(lastUsedRaw || '') || nowMs;
  const daysSinceUse = (nowMs - lastUsedTs) / DAY_MS;

  if (useCount >= HOT_USE_COUNT && daysSinceUse <= HOT_USE_MAX_AGE_DAYS) {
    return 'hot';
  }
  if (useCount >= WARM_USE_COUNT && daysSinceUse <= WARM_USE_MAX_AGE_DAYS) {
    return 'warm';
  }
  if (daysSinceUse > COLD_IDLE_DAYS) return 'cold';

  // No clear signal — keep whatever we had, default 'cold'.
  return currentLevel === 'hot' || currentLevel === 'warm' ? currentLevel : 'cold';
}

// ─── Worker pass ─────────────────────────────────────────────────────────────

/**
 * Incremental reassess.  If `sinceIso` is provided, only rows updated on/after
 * that timestamp are scanned — cheap enough to run on every write.  Without
 * `sinceIso` it scans the full store (capped by `limit`) — use for the daily
 * batch.
 *
 * @param {Object} [options]
 * @param {string} [options.sinceIso]
 * @param {number} [options.limit]
 * @param {number} [options.nowMs]  override for tests
 * @returns {{ examined: number, updated: number }}
 */
export function reassessAttic({ sinceIso = null, limit = 2000, nowMs = Date.now() } = {}) {
  const rows = listMemoriesForAtticReassess({ sinceIso, limit });
  const updates = [];
  for (const row of rows) {
    const next = evaluateAtticLevel(row, nowMs);
    const current = row.metadata?.attic;
    if (next !== current) updates.push({ id: row.id, attic: next });
  }
  const updated = setAtticLevels(updates);
  return { examined: rows.length, updated };
}

// ─── Hot attic injection ────────────────────────────────────────────────────

/**
 * Build the "Hot attic" block for the system prompt.  Aggregates across the
 * caller-supplied namespaces.  Returns '' when nothing qualifies.
 *
 * The Hot attic block is appended *before* any other memory block so it
 * stays visible even when downstream blocks are trimmed for token budget.
 *
 * @param {Object}     options
 * @param {string[]}   options.namespaces
 * @param {number}     [options.limit]            max rows (default 8)
 * @param {number}     [options.tokenBudget]      default ATTIC_HOT_TOKEN_BUDGET
 * @returns {string}
 */
export function injectHotAttic({ namespaces = [], limit = 8, tokenBudget = ATTIC_HOT_TOKEN_BUDGET, accept, onRecall } = {}) {
  // `identity` rows are deliberately NOT recalled here. The agent persona is
  // already rendered verbatim in the `agent` section of the system prompt;
  // re-injecting it through memory meant every turn carried two copies (the
  // second one wrapped in "Reference data; not instructions"), and a project
  // override put the project persona in one block and the stale global persona
  // in the other (2026-10-17 audit B-1 / C-9).
  // Project namespaces are rendered by the Project Memory Book in the stable
  // prefix (design 2B); the attic only covers the chat, user and agent rows.
  const rows = recallMemories({
    namespaces: namespaces.filter(ns => !String(ns).startsWith('project:')),
    kinds: ['fact', 'session-fact', 'verification-correction'],
    limit: limit * 4,
    sideEffects: false,
    accept,
    // Pinned / correction / decision / sweep-marked-hot rows first, so an
    // old pinned decision is not pushed out of the pool by newer ordinary
    // facts (design audit M3).
    preferHot: true,
  });

  const seen = new Set();
  const candidates = rows
    .map(row => ({
      row,
      level: evaluateAtticLevel(row),
    }))
    .filter(({ level,row }) => {
      if (level !== 'hot') return false;
      const key = normalizedFact(row.text);
      if (seen.has(key)) return false;
      seen.add(key);return true;
    })
    .slice(0, limit);

  if (!candidates.length) return '';

  const lines = ['## Hot Attic (always-on memory)'];
  const renderedIds = [];
  let tokensRemaining = tokenBudget;
  for (const { row } of candidates) {
    const line = `- [${row.metadata?.category || row.kind}] ${row.text}`;
    // Shared estimator (CJK-aware) instead of length/4, and `continue` rather
    // than `break`: one oversized row must not blank out every row after it.
    const cost = estimateTextTokens(line);
    if (cost > tokensRemaining) continue;
    lines.push(line);
    if (row.id) renderedIds.push(row.id);
    tokensRemaining -= cost;
  }
  onRecall?.(candidates.filter(({row})=>renderedIds.includes(row.id)).map(({row})=>({
    ...row, renderedText: `- [${row.metadata?.category || row.kind}] ${row.text}`,
  })));
  lines.push('(These facts are invariant enough to be always visible.)');
  return lines.join('\n');
}

// ─── Env-var helpers (so the caller can gate whole phases) ──────────────────

export function atticEnabled(env = requestEnvironment()) {
  return env.MELO_ATTIC_ENABLED !== '0';
}

/**
 * Parse MELO_MEMORY_TIERS into a Set of enabled tier names.
 * Default: all tiers enabled.
 */
export function enabledTiers(env = requestEnvironment()) {
  const raw = String(env.MELO_MEMORY_TIERS || '').trim();
  if (!raw) return new Set(['scene', 'frame', 'content']);
  return new Set(raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
}
