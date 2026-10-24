// ─── Telegram reply score ────────────────────────────────────────────────────
// Pure signal-fusion layer for "should the bot reply to this group-chat
// Telegram message?". Combines five weighted signals (isReplyToBot,
// mentionUsername, invokePrefix, aliasMatch, followUp, implicitAddress) into a
// single 0–1 score. The routing gate in desktopStore.js compares that score
// against REPLY_SCORE_THRESHOLD (pass), GRAY_ZONE_MIN (reject), or falls into
// the async LLM classifier between them.
//
// This module owns:
//   - TELEGRAM_SIGNAL_WEIGHTS — per-signal weight table
//   - REPLY_SCORE_THRESHOLD — 0.55, the auto-reply threshold
//   - GRAY_ZONE_MIN — 0.30, below this we reject without calling the LLM
//   - buildTelegramReplyScore — (incoming, channel, profile, recentChat) →
//     { signals, totalScore }. Reads chat.groupGraph to downgrade aliasMatch
//     weight for senders with a low historical bot-address ratio.
//
// Extracted from desktopStore.js in the Phase 5d refactor (see
// _refactor-backup/REFACTOR_PLAN.md). Pure module — no state deps.

import {
  hasTelegramInvokePrefix,
  collectTelegramBotAliases,
  containsTelegramBotAlias,
} from './telegramAddressHelpers.js';
import {
  computeFollowUpScore,
  detectImplicitAddress,
} from './replyScoreSignals.js';
import { normalizeMessageAttachments } from '../../shared/helpers.js';

export const TELEGRAM_SIGNAL_WEIGHTS = {
  isReplyToBot:     1.00, // Telegram explicit reply to bot message → always respond
  mentionUsername:  0.90, // @botUsername in text
  invokePrefix:     0.85, // /ask, /melo, "melo:" prefix
  aliasMatch:       0.60, // bot name / nickname match (word-boundary checked)
  followUp:         0.50, // max possible from computeFollowUpScore
  implicitAddress:  1.00, // pass-through multiplier (detectImplicitAddress returns 0–0.50)
};

export const REPLY_SCORE_THRESHOLD = 0.55; // pass directly
export const GRAY_ZONE_MIN          = 0.30; // below this → reject without LLM call

/**
 * Build weighted signal scores for a group-chat routing decision.
 * Also factors in the sender's historical bot-address ratio from the group
 * relationship graph (chat.groupGraph) to adjust aliasMatch weight.
 *
 * Returns { signals, totalScore }.
 */
export function buildTelegramReplyScore(incoming, telegramChannel, profile, recentChat) {
  const text = String(incoming?.text || '').trim();
  const lowerText = text.toLowerCase();
  const hasVoiceAttachment = normalizeMessageAttachments(incoming?.attachments).some(
    a => a.kind === 'audio',
  );
  const botUsername = String(telegramChannel?.botUsername || '')
    .trim().replace(/^@+/, '').toLowerCase();

  const isReplyToBot    = Boolean(incoming?.isReplyToBot);
  const mentionUsername = Boolean(botUsername && lowerText.includes(`@${botUsername}`));
  const invokePrefix    = hasTelegramInvokePrefix(text);

  const aliases = collectTelegramBotAliases(profile, telegramChannel);
  const aliasMatch = aliases.some(alias => containsTelegramBotAlias(lowerText, alias));

  // Adjust aliasMatch weight using group relationship graph.
  // If this sender has a low bot-address ratio (rarely talks to bot), their
  // alias hit is more likely coincidental — downgrade to 0.40 from 0.60.
  let aliasWeight = TELEGRAM_SIGNAL_WEIGHTS.aliasMatch;
  if (aliasMatch && recentChat?.groupGraph) {
    const senderEntry = recentChat.groupGraph[String(incoming?.senderId || '')] || {};
    const total = (senderEntry.botAddressCount || 0) + (senderEntry.otherAddressCount || 0);
    if (total >= 5) {
      const ratio = (senderEntry.botAddressCount || 0) / total;
      if (ratio < 0.15) aliasWeight = 0.40; // person almost never addresses bot
    }
  }

  const followUpScore = computeFollowUpScore(incoming, recentChat);
  const implicitScore = detectImplicitAddress(text);

  // Total score: max of strong signals, boosted by co-occurring weak signals.
  let totalScore = Math.max(
    isReplyToBot    ? TELEGRAM_SIGNAL_WEIGHTS.isReplyToBot    : 0,
    mentionUsername ? TELEGRAM_SIGNAL_WEIGHTS.mentionUsername : 0,
    invokePrefix    ? TELEGRAM_SIGNAL_WEIGHTS.invokePrefix    : 0,
    aliasMatch      ? aliasWeight                             : 0,
    followUpScore   * TELEGRAM_SIGNAL_WEIGHTS.followUp,
    implicitScore   * TELEGRAM_SIGNAL_WEIGHTS.implicitAddress,
    // Voice/audio-only messages in group chats: treat as a moderate signal
    // (user deliberately recorded a voice note → likely addressing the bot)
    hasVoiceAttachment && !text ? 0.55 : 0,
  );

  // Synergy boost: alias + strong follow-up together exceed either alone
  if (aliasMatch && followUpScore >= 0.35) {
    totalScore = Math.min(1, totalScore + 0.15);
  }

  // Synergy boost: implicit address + follow-up → very likely talking to bot
  if (implicitScore >= 0.35 && followUpScore >= 0.20) {
    totalScore = Math.min(1, totalScore + 0.15);
  }

  const signals = {
    isReplyToBot,
    mentionUsername,
    invokePrefix,
    aliasMatch,
    followUpScore,
    implicitAddress: implicitScore,
    hasVoiceAttachment,
  };
  return { signals, totalScore };
}

// Archived channels keep their settings. These overrides never enable a channel.
export function replyScoreLimits(config = {}) {
  const raw=config.operationalLimits?.remote || {};
  const number=(value,fallback)=>value == null || !Number.isFinite(Number(value)) ? fallback : Math.max(0,Math.min(1,Number(value)));
  const threshold=number(raw.replyThreshold,REPLY_SCORE_THRESHOLD);
  return {threshold,grayMin:Math.min(threshold,number(raw.grayMin,GRAY_ZONE_MIN))};
}
