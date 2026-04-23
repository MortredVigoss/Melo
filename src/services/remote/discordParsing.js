// ─── Discord message parsing + address helpers ───────────────────────────────
// Turn raw Discord Bot API messages into Melo's own incoming-message shape,
// plus the small helpers that decide whether a message is addressing the bot.
// No state — everything reads from the passed-in `message`/`channel` and
// returns new objects.
//
// This module owns:
//   - buildDiscordThreadKey — deterministic (agentId, guildId, channelId,
//     parentId) → "discord:<agent>:<guild|dm>:<channel>[:parent]" key used
//     as externalThreadKey on the stored chat
//   - normalizeDiscordAttachmentKind — content-type sniffing helper
//   - extractDiscordAttachments — walk attachments + sticker_items, turn
//     each into a normalizeMessageAttachments() entry
//   - isDiscordMessageFromBot — filter self / webhooks out of the polling
//     loop before we do any work on them
//   - latestProcessableDiscordMessage — the gatekeeper: given a Discord
//     message payload, return either null ("ignore this one") or the fully
//     normalized "incoming" envelope used by the routing / scoring layer
//   - hasDiscordInvokePrefix — detect leading "/ask", "/melo", "melo:" etc.
//   - collectDiscordBotAliases — build the set of names the bot answers to,
//     plus the Discord-specific "<@botUserId>" / "<@!botUserId>" mention
//     tokens so buildDiscordReplyScore can detect @mentions via text match
//
// Extracted from desktopStore.js in the Phase 6b refactor (see
// _refactor-backup/REFACTOR_PLAN.md). Pure module: only imports from the
// shared helpers module.

import {
  nowIso,
  normalizeAgentStorageId,
  normalizeMessageAttachments,
} from '../../shared/helpers.js';

export function buildDiscordThreadKey(agentId, guildId, channelId, parentId = '') {
  const parts = [
    'discord',
    normalizeAgentStorageId(agentId),
    String(guildId || 'dm'),
    String(channelId || ''),
  ];
  if (parentId) {
    parts.push(String(parentId));
  }
  return parts.join(':');
}

export function normalizeDiscordAttachmentKind(mimeType = '') {
  const mime = String(mimeType || '').toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'link';
}

export function extractDiscordAttachments(message) {
  if (!message) return [];

  const raw = Array.isArray(message.attachments) ? message.attachments : [];
  const attachments = [];

  for (const att of raw) {
    const url = String(att?.url || '').trim();
    if (!url) continue;
    const mimeType = String(att?.content_type || '').trim();
    attachments.push({
      kind: normalizeDiscordAttachmentKind(mimeType),
      title: att?.filename || 'Discord attachment',
      mimeType,
      fileName: att?.filename || '',
      url,
    });
  }

  // Sticker support — Discord stickers come as a separate field.
  const stickers = Array.isArray(message.sticker_items) ? message.sticker_items : [];
  for (const sticker of stickers) {
    const stickerId = String(sticker?.id || '').trim();
    if (!stickerId) continue;
    attachments.push({
      kind: 'image',
      title: sticker?.name || 'Discord sticker',
      mimeType: 'image/png',
      fileName: `${sticker?.name || 'sticker'}.png`,
      url: `https://media.discordapp.net/stickers/${stickerId}.png`,
    });
  }

  return normalizeMessageAttachments(attachments);
}

export function isDiscordMessageFromBot(message) {
  return Boolean(message?.author?.bot) || Boolean(message?.webhook_id);
}

export async function latestProcessableDiscordMessage(message, channel) {
  if (!message || isDiscordMessageFromBot(message)) {
    return null;
  }

  const attachments = extractDiscordAttachments(message);
  const content = String(message?.content || '').trim();
  if (!content && !attachments.length) {
    return null;
  }

  const author = message?.author || {};
  const guildId = String(message?.guild_id || '').trim();
  const channelId = String(message?.channel_id || '').trim();
  const senderName =
    [author?.global_name, author?.username].filter(Boolean).join(' ').trim() ||
    (author?.id ? `user_${author.id}` : 'Unknown user');

  // Reply reference (message_reference pointing at the bot's own message).
  const referenced = message?.referenced_message || null;
  const isReplyToBot = referenced ? Boolean(referenced?.author?.bot) : false;
  const repliedToText = String(referenced?.content || '').trim();

  // Discord voice-message heuristic:
  //   (a) IS_VOICE_MESSAGE flag (1 << 13 = 8192) — set when a client records
  //       an in-app voice note. Bots that don't have the voice-message intent
  //       will still see this flag on the raw payload.
  //   (b) an attachment with an audio/* content-type — users who upload a
  //       voice recording as a file. Treated the same for voice-reply
  //       triggering (i.e. "user sent audio → we can reply with audio even
  //       when the channel-level voiceReply toggle is off").
  const rawFlags = Number(message?.flags || 0);
  const IS_VOICE_MESSAGE = 1 << 13;
  const hasAudioAttachment = Array.isArray(message?.attachments)
    ? message.attachments.some(att =>
        typeof att?.content_type === 'string' &&
        att.content_type.toLowerCase().startsWith('audio/'),
      )
    : false;
  const wasVoiceMessage = Boolean(rawFlags & IS_VOICE_MESSAGE) || hasAudioAttachment;

  return {
    text: content,
    attachments,
    wasVoiceMessage,
    chatId: channelId,
    chatType: guildId ? 'group' : 'private', // no guild → DM
    chatTitle: '', // Discord channels don't carry a thread title in the message payload
    senderId: String(author?.id || '').trim(),
    senderName,
    senderUsername: typeof author?.username === 'string' ? author.username.trim() : '',
    isReplyToBot,
    repliedToMessageId: referenced?.id ? String(referenced.id) : null,
    repliedToText,
    messageId: String(message?.id || ''),
    messageThreadId: null, // Discord threads are separate channels; parent_id would live on the channel, not the message
    guildId,
    receivedAt:
      typeof message?.timestamp === 'string' && message.timestamp
        ? message.timestamp
        : nowIso(),
    // Raw mentions array so the scorer can detect @bot directly.
    mentionIds: Array.isArray(message?.mentions)
      ? message.mentions.map(m => String(m?.id || '')).filter(Boolean)
      : [],
  };
}

export function hasDiscordInvokePrefix(text = '') {
  // Same invoke vocabulary as Telegram — /ask, /melo, "melo:" prefix.
  return /^(?:\/(?:ask|melo)\b|melo[:,，\s])/i.test(String(text || '').trim());
}

export function collectDiscordBotAliases(profile, discordChannel, botUserId = '') {
  const aliases = new Set();

  const botUsername = String(discordChannel?.botUsername || '')
    .trim()
    .replace(/^@+/, '')
    .toLowerCase();
  if (botUsername) {
    aliases.add(botUsername);
  }
  if (botUserId) {
    aliases.add(`<@${botUserId}>`.toLowerCase());
    aliases.add(`<@!${botUserId}>`.toLowerCase());
  }

  const agentName = String(profile?.name || '').trim().toLowerCase();
  if (agentName) {
    aliases.add(agentName);
    const firstWord = agentName.split(/\s+/)[0];
    if (
      firstWord &&
      firstWord.length >= 2 &&
      !['main', 'agent', 'research', 'builder', 'reviewer', 'custom'].includes(firstWord)
    ) {
      aliases.add(firstWord);
    }
  }

  aliases.add('melo');

  const nicknames = String(discordChannel?.nicknames || '')
    .split(/[,，;；]/)
    .map(value => value.trim().toLowerCase())
    .filter(Boolean);
  for (const nickname of nicknames) {
    aliases.add(nickname);
  }

  return [...aliases];
}
