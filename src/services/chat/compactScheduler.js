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
import { persistCompactSnapshot } from './derivedState.js';
import { resolveContextBudget } from './contextBudget.js';

export const PRECOMPACT_SHARE = 0.7;

const inFlight = new Set(); // chatId

export function hasModelForCompaction(config = {}) {
  return Boolean(config.authMode === 'codex' || config.apiKey || (config.authMode === 'local' && config.baseUrl));
}

/**
 * Compact the oldest pending chunk of `chat` if pending history exceeds
 * PRECOMPACT_SHARE × window. Returns { compacted, source } or null.
 */
export async function precompactIfNeeded(chat, { config, home, env = process.env, createReply, signal } = {}) {
  if (!chat?.id || !hasModelForCompaction(config) || inFlight.has(chat.id)) return null;
  const budget = resolveContextBudget(env, { config });
  const plan = planIncrementalCompact(chat, { triggerTokens: Math.floor(budget.windowTokens * PRECOMPACT_SHARE) });
  if (!plan) return null;
  inFlight.add(chat.id);
  try {
    const { summary, source } = await compactConversationDetailed(plan.messages, {
      config, signal, previousSummary: plan.previousSummary, ...(createReply ? { _createReply: createReply } : {}),
    });
    if (!summary) return { compacted: false, source: 'none' };
    chat.compactSummary = plan.truncated
      ? '[部分历史过长，摘要仅包含可容纳的片段；原文保留在对话记录中。]\n' + summary
      : summary;
    chat.compactBoundaryMessageId = plan.boundaryId;
    chat.compactedMessageCount = plan.compactedCount;
    chat.compactedAt = new Date().toISOString();
    chat.compactFailures = 0;
    chat.compactSummarySource = source || 'cloud';
    chat.compactUpgradeAttempts = 0;
    await persistCompactSnapshot(chat, plan, { home });
    return { compacted: true, source: chat.compactSummarySource, compactedCount: plan.compactedCount };
  } finally {
    inFlight.delete(chat.id);
  }
}

export function _resetCompactSchedulerForTests() { inFlight.clear(); }
