// ─── Discord reply score ─────────────────────────────────────────────────────
// Pure signal-fusion layer for "should the bot reply to this Discord
// message?" — the Discord counterpart to telegramReplyScore.js. Same shape,
// same thresholds (REPLY_SCORE_THRESHOLD / GRAY_ZONE_MIN from telegramReplyScore),
// but with Discord-specific signals:
//   - mentionUsername is a boolean derived from raw `message.mentions` IDs
//     (not a text search) — we pass the bot's user id and check whether the
//     incoming envelope's mentionIds array contains it
//   - the aliasMatch step reuses containsTelegramBotAlias from the Telegram
//     address helpers, which is a channel-agnostic word-boundary alias
//     lookup (kept named after its first home)
//
// This module owns:
//   - DISCORD_SIGNAL_WEIGHTS — per-signal weight table (same shape as Telegram)
//   - buildDiscordReplyScore — (incoming, channel, profile, recentChat,
//     botUserId) → { signals, totalScore }. Reads chat.groupGraph to
//     downgrade aliasMatch weight for senders with a low historical
//     bot-address ratio.
//
// Extracted from desktopStore.js in the Phase 6c refactor (see
// _refactor-backup/REFACTOR_PLAN.md). Pure module — no state deps.

import {
  hasDiscordInvokePrefix,
  collectDiscordBotAliases,
} from './discordParsing.js';
import { containsTelegramBotAlias } from './telegramAddressHelpers.js';
import {
  computeFollowUpScore,
  detectImplicitAddress,
} from './replyScoreSignals.js';
import { normalizeMessageAttachments } from '../../shared/helpers.js';

export const DISCORD_SIGNAL_WEIGHTS = {
  isReplyToBot:    1.00,
  mentionUsername: 0.90,
  invokePrefix:    0.85,
  aliasMatch:      0.60,
  followUp:        0.50,
  implicitAddress: 1.00,
};

export function buildDiscordReplyScore(
  incoming,
  discordChannel,
  profile,
  recentChat,
  botUserId = '',
) {
  const text = String(incoming?.text || '').trim();
  const lowerText = text.toLowerCase();
  const hasVoiceAttachment = normalizeMessageAttachments(incoming?.attachments).some(
    a => a.kind === 'audio',
  );

  const isReplyToBot = Boolean(incoming?.isReplyToBot);
  const mentionUsername = Boolean(
    botUserId && Array.isArray(incoming?.mentionIds) && incoming.mentionIds.includes(botUserId),
  );
  const invokePrefix = hasDiscordInvokePrefix(text);

  const aliases = collectDiscordBotAliases(profile, discordChannel, botUserId);
  const aliasMatch = aliases.some(alias => containsTelegramBotAlias(lowerText, alias));

  let aliasWeight = DISCORD_SIGNAL_WEIGHTS.aliasMatch;
  if (aliasMatch && recentChat?.groupGraph) {
    const senderEntry = recentChat.groupGraph[String(incoming?.senderId || '')] || {};
    const total = (senderEntry.botAddressCount || 0) + (senderEntry.otherAddressCount || 0);
    if (total >= 5) {
      const ratio = (senderEntry.botAddressCount || 0) / total;
      if (ratio < 0.15) aliasWeight = 0.40;
    }
  }

  const followUpScore = computeFollowUpScore(incoming, recentChat);
  const implicitScore = detectImplicitAddress(text);

  let totalScore = Math.max(
    isReplyToBot    ? DISCORD_SIGNAL_WEIGHTS.isReplyToBot    : 0,
    mentionUsername ? DISCORD_SIGNAL_WEIGHTS.mentionUsername : 0,
    invokePrefix    ? DISCORD_SIGNAL_WEIGHTS.invokePrefix    : 0,
    aliasMatch      ? aliasWeight                            : 0,
    followUpScore   * DISCORD_SIGNAL_WEIGHTS.followUp,
    implicitScore   * DISCORD_SIGNAL_WEIGHTS.implicitAddress,
    hasVoiceAttachment && !text ? 0.55 : 0,
  );

  if (aliasMatch && followUpScore >= 0.35) {
    totalScore = Math.min(1, totalScore + 0.15);
  }
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
