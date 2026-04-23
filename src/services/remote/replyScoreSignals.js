// ─── Reply score signals ─────────────────────────────────────────────────────
// Pure, per-message signal functions used by both Telegram and Discord routing
// to decide whether a group-chat message is addressed to the bot. Each signal
// returns a 0–1 score; the caller (buildTelegramReplyScore /
// buildDiscordReplyScore in desktopStore.js) aggregates them against a
// weighted-max.
//
// This module owns:
//   - FOLLOW_UP_WINDOW_MS — 2 min window for "is this a reply to the bot's
//     last turn?" scoring
//   - computeFollowUpScore — time-decay + content-continuity - intervening
//     sender score. Previously wrapped by isLikelyTelegramFollowUpToBot.
//   - isLikelyTelegramFollowUpToBot — legacy boolean wrapper (≥ 0.4)
//   - IMPLICIT_REQUEST_RE / IMPLICIT_IMPERATIVE_RE / IMPLICIT_AT_OTHERS_RE —
//     regex constants for implicit-address detection
//   - detectImplicitAddress — "user is clearly asking for help even without
//     naming the bot" score in {0, 0.35, 0.45, 0.50}
//
// Heuristic continuity detection (isLikelyContextDependentReply) lives in
// src/memory/heuristics.js and is re-used here directly — no new coupling.
//
// Extracted from desktopStore.js in the Phase 4 refactor (see
// _refactor-backup/REFACTOR_PLAN.md). Pure module with no state dependencies.

import { isLikelyContextDependentReply as isLikelyContextDependentReplyFromHeuristics } from '../../memory/heuristics.js';

export const FOLLOW_UP_WINDOW_MS = 120_000; // 2 minutes

/**
 * Compute a 0–1 follow-up confidence score (Plan C: time-decay + content continuity).
 *
 * Components:
 *   - Time decay: linear from 1.0 at t=0 to 0 at FOLLOW_UP_WINDOW_MS (2 min).
 *     No hard cutoff — a message at 1m50s still gets a small score instead of 0.
 *   - Content bonus: short/context-dependent replies (e.g. "好的", "再说一次",
 *     single-sentence answers to bot's question) add +0.25.
 *   - Intervening sender penalty: each unique OTHER sender who spoke between the
 *     bot's last reply and now subtracts 0.18 (group conversation shifted away).
 *
 * Returns 0 if no recent assistant message exists or sender is unknown.
 */
export function computeFollowUpScore(incoming, recentChat) {
  if (!recentChat?.messages?.length) return 0;

  const messages = recentChat.messages;
  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'assistant') { lastAssistantIdx = i; break; }
  }
  if (lastAssistantIdx === -1) return 0;

  const lastAssistant = messages[lastAssistantIdx];
  const lastAssistantTime = Date.parse(lastAssistant?.createdAt || 0);
  if (!Number.isFinite(lastAssistantTime)) return 0;

  const incomingTime = Date.parse(incoming?.receivedAt || 0) || Date.now();
  const elapsedMs = incomingTime - lastAssistantTime;
  if (elapsedMs > FOLLOW_UP_WINDOW_MS) return 0;

  const currentSenderId = String(incoming?.senderId || '').trim();
  if (!currentSenderId) return 0;

  // Time-decay component: 1.0 → 0.0 over FOLLOW_UP_WINDOW_MS
  let score = Math.max(0, 1 - elapsedMs / FOLLOW_UP_WINDOW_MS);

  // Content continuity bonus: short contextual replies strongly suggest follow-up
  const incomingText = String(incoming?.text || '');
  if (isLikelyContextDependentReplyFromHeuristics(incomingText)) {
    score = Math.min(1, score + 0.25);
  }

  // Intervening sender penalty: other people speaking shifts conversation away from bot
  const interveningSenders = new Set();
  for (let i = lastAssistantIdx + 1; i < messages.length; i += 1) {
    const msg = messages[i];
    if (msg?.role === 'user' && msg?.senderId && String(msg.senderId) !== currentSenderId) {
      interveningSenders.add(String(msg.senderId));
    }
  }
  score -= interveningSenders.size * 0.18;

  return Math.max(0, Math.min(1, score));
}

// Legacy boolean wrapper kept for any remaining direct call sites
export function isLikelyTelegramFollowUpToBot(incoming, recentChat) {
  return computeFollowUpScore(incoming, recentChat) >= 0.4;
}

// ─── Persona language heuristic ───────────────────────────────────────────────

/**
 * Detect whether an agent profile is configured to speak English only.
 *
 * The addressal scoring + LLM classifier are implicitly tuned for Chinese-speaking
 * agents in Chinese groups (bot name is usually Chinese, alias substring match is
 * cheap for CJK, implicit-address regex has dense Chinese patterns). English-only
 * personas (e.g. 懂王 = "Know-It-All, speaks English only") can cap at
 * implicitAddress=0.50 which is below the 0.55 threshold, so they get pushed into
 * the gray zone for every English sentence.
 *
 * Callers use this signal to (a) lower the auto-pass threshold, and (b) skip the
 * Chinese-biased synergy boosts that otherwise never fire for this persona.
 *
 * We look in voicePersonality first, then soul markdown, then identity — whatever
 * the user wrote to define the persona.
 */
export function isEnglishOnlyPersona(profile) {
  const haystack = [
    profile?.voicePersonality,
    profile?.soulMd,
    profile?.['soul.md'],
    profile?.soul,
    profile?.identity,
    profile?.identify,
  ]
    .map(v => (typeof v === 'string' ? v : ''))
    .join(' ')
    .toLowerCase();
  if (!haystack.trim()) return false;
  // Match common ways a user declares English-only behavior, in either language.
  return /\b(english[- ]?only|only[- ]?english|speak[- ]?english[- ]?only|reply[- ]?in[- ]?english[- ]?only)\b/i
    .test(haystack)
    || /只说英语|只讲英语|只用英语|纯英文|纯英语|英文\s*only|英语\s*only/i.test(haystack);
}

// ─── Implicit address detection ───────────────────────────────────────────────

/**
 * Detect implicit conversational intent — messages that are clearly directed at
 * "someone who can help" even without mentioning the bot by name.
 *
 * Returns a score 0–1:
 *   0.50 — strong implicit address (request keyword + question/short sentence)
 *   0.45 — request keyword alone
 *   0.35 — question pattern or imperative alone
 *   0.00 — no implicit signal
 */
export const IMPLICIT_REQUEST_RE =
  /(?:帮我|帮忙|请问|请帮|麻烦|你好|在吗|在不在|能不能|可不可以|可以吗|能帮|告诉我|查一下|搜一下|搜索一下|查查|问一下|算一下|翻译一下|解释一下|你知道|你觉得|你能|你会|有没有|是不是|怎么办|怎么样|咋办|啥意思|什么意思|hey|help me|can you|could you|please|tell me|search for|look up|what is|what's|how to|how do)/i;

export const IMPLICIT_IMPERATIVE_RE =
  /^(?:翻译|解释|推荐|总结|分析|计算|查|搜|找|说说|讲讲|列出|对比|比较|describe|explain|translate|summarize|recommend|list|compare|find|show)/i;

export const IMPLICIT_AT_OTHERS_RE = /@\w{2,}/; // mentioning someone else in group

export function detectImplicitAddress(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 300) return 0; // very long messages are likely general discussion
  if (IMPLICIT_AT_OTHERS_RE.test(t)) return 0; // addressing someone else

  let score = 0;

  // Request keywords: "帮我", "请问", "你好", "can you" etc.
  if (IMPLICIT_REQUEST_RE.test(t)) score += 0.45;

  // Question ending: "？" or "?" (but not rhetorical-length)
  const isQuestion = /[？?]\s*$/.test(t) && t.length < 150;
  if (isQuestion && score === 0) score += 0.35;

  // Imperative: short sentence starting with action verb
  const isImperative = t.length < 80 && IMPLICIT_IMPERATIVE_RE.test(t);
  if (isImperative && score === 0) score += 0.35;

  // Compound boost: request keyword + question/short → stronger signal
  if (score >= 0.45 && (isQuestion || t.length < 60)) score = 0.50;

  return score;
}
