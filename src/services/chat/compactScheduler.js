// Background pre-compaction (2026-10-17 design audit L4 / plan 1D-1).
//
// Compaction used to run only inside the turn, synchronously, when pending
// history had already crossed the window: a 45k-token summarising request
// that the user experienced as 15–60 s of "thinking" every ~80 turns. Now a
// post-turn task compacts as soon as pending history passes
// PRECOMPACT_SHARE of the window, so the boundary is already in place when
// the next turn starts. The in-turn path stays as a fallback and announces
// itself with a `compact:running` event instead of hanging silently.
//
// Concurrency: persistCompactSnapshot refuses to move the boundary backwards
// (compactedMessageCount only grows), so a background pass and a fallback
// in-turn pass over the same chunk cannot clobber each other.

import { planIncrementalCompact, compactConversationDetailed } from '../../memory/contextCompact.js';
import { persistCompactSnapshot, persistCompactFailure } from './derivedState.js';
import { resolveContextBudget } from './contextBudget.js';
import { appendCompactCard } from '../../memory/compactLedger.js';

export const PRECOMPACT_SHARE = 0.7;
// A summarising request that never answers must not pin the chat's
// `inFlight` slot forever (audit L15).
export const PRECOMPACT_TIMEOUT_MS = 120_000;

const inFlight = new Set(); // chatId

export function hasModelForCompaction(config = {}) {
  return Boolean(config.authMode === 'codex' || config.apiKey || (config.authMode === 'local' && config.baseUrl));
}

/**
 * Compact the oldest pending chunk of `chat` if pending history exceeds
 * PRECOMPACT_SHARE × window. Returns { compacted, source } or null.
 *
 * `historyWindowTokens` is the effective window the last turn measured
 * (input limit minus the required prompt and tools, audit L4); when it is
 * smaller than the nominal window the trigger follows it so a local model's
 * history is summarised before the fitter has to drop it.
 */
export async function precompactIfNeeded(chat, { config, home, env = process.env, createReply, signal, historyWindowTokens = 0, timeoutMs = PRECOMPACT_TIMEOUT_MS } = {}) {
  if (!chat?.id || !hasModelForCompaction(config) || inFlight.has(chat.id)) return null;
  const budget = resolveContextBudget(env, { config });
  const window = Number.isFinite(Number(historyWindowTokens)) && Number(historyWindowTokens) > 0
    ? Math.min(budget.windowTokens, Math.floor(Number(historyWindowTokens))) : budget.windowTokens;
  const plan = planIncrementalCompact(chat, { triggerTokens: Math.floor(window * PRECOMPACT_SHARE), maxChunkTokens: budget.compactChunkTokens });
  if (!plan) return null;
  inFlight.add(chat.id);
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`background compaction timed out after ${timeoutMs} ms`);
      error.code = 'COMPACT_TIMEOUT';
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  const countFailure = async () => {
    chat.compactFailures = (chat.compactFailures || 0) + 1;
    await persistCompactFailure(chat, { home }).catch(() => {});
  };
  try {
    const { summary, source } = await Promise.race([
      compactConversationDetailed(plan.messages, {
        config, signal: controller.signal, previousSummary: plan.previousSummary, ...(createReply ? { _createReply: createReply } : {}),
      }),
      timeout,
    ]);
    if (!summary) {
      // Counted and persisted (audit L5): the circuit breaker in
      // planIncrementalCompact only works when failures survive the turn.
      await countFailure();
      return { compacted: false, source: 'none' };
    }
    appendCompactCard(chat, plan, { summary, source: source || 'cloud' });
    await persistCompactSnapshot(chat, plan, { home });
    return { compacted: true, source: chat.compactSummarySource, compactedCount: plan.compactedCount };
  } catch (error) {
    if (signal?.aborted) throw signal.reason || error;
    await countFailure();
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    inFlight.delete(chat.id);
  }
}

export function _resetCompactSchedulerForTests() { inFlight.clear(); }
