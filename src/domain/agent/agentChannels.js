// ─── Agent remote-channel normalization ──────────────────────────────────────
// Each agent profile carries a `channels` map keyed by channel id
// ("telegram" | "discord"). This module owns the pure shape + range
// normalization for those channel objects, plus the merge rule that lets
// the polling loop write back runtime status fields without clobbering
// user-editable config (tokens, guild/channel ids, voiceReply, etc.).
//
// This module owns:
//   - AGENT_CHANNEL_LIBRARY — id → { label, description } for the two
//     supported channels (Telegram, Discord).
//   - AGENT_CHANNEL_IDS — derived list of supported channel ids.
//   - CHANNEL_RUNTIME_FIELDS — the allow-list of fields the poller may
//     overwrite on each `saveState` pass. Everything not in this list is
//     user-editable config and is preserved as-is. See
//     feedback_preserve_user_config.md (don't wipe user-configured
//     settings — tokens/checkboxes/IDs must round-trip intact through
//     every edit path).
//   - normalizeAgentChannel(channelId, channel) — coerce one channel
//     blob into the canonical persisted shape (trim strings, clamp
//     enums, normalize lastUpdateId as either string snowflake or number).
//   - normalizeAgentChannels(channels) — call normalizeAgentChannel for
//     every supported channel id so the returned object always has both
//     telegram + discord keys.
//   - mergeChannelRuntimeFields(persistedChannel, runtimeChannel) — take
//     the latest persisted channel as the base and layer only the runtime
//     fields from the poller's in-memory snapshot. `botUsername` is a
//     special case (poller may be first to learn it, so we promote from
//     runtime only when persisted lacks it).
//
// Extracted from desktopStore.js in the Phase 9l refactor (see
// _refactor-backup/REFACTOR_PLAN.md). Pure module — only depends on
// `coerceIso` from shared/helpers.

import { coerceIso } from '../../shared/helpers.js';

export const AGENT_CHANNEL_LIBRARY = {
  telegram: {
    id: 'telegram',
    label: 'Telegram',
    description: 'Connect this agent to a Telegram bot workspace.',
  },
  discord: {
    id: 'discord',
    label: 'Discord',
    description: 'Connect this agent to a Discord bot workspace.',
  },
};

export const AGENT_CHANNEL_IDS = Object.keys(AGENT_CHANNEL_LIBRARY);

export function normalizeAgentChannel(channelId, channel = {}) {
  const definition = AGENT_CHANNEL_LIBRARY[channelId];
  return {
    id: channelId,
    label: definition.label,
    description: definition.description,
    enabled: Boolean(channel?.enabled),
    botToken: typeof channel?.botToken === 'string' ? channel.botToken.trim() : '',
    botUsername: typeof channel?.botUsername === 'string' ? channel.botUsername.trim() : '',
    language: typeof channel?.language === 'string' && /^(zh|en|ja|ko|es)(-[A-Za-z]+)?$/.test(channel.language) ? channel.language : '',
    nicknames: typeof channel?.nicknames === 'string' ? channel.nicknames.trim() : '',
    chatId: typeof channel?.chatId === 'string' ? channel.chatId.trim() : '',
    guildId: typeof channel?.guildId === 'string' ? channel.guildId.trim() : '',
    channelId: typeof channel?.channelId === 'string' ? channel.channelId.trim() : '',
    lastUpdateId:
      // Telegram stores a numeric update_id; Discord stores a snowflake string.
      // Accept either so a single normalize pass serves both channels.
      typeof channel?.lastUpdateId === 'string' && channel.lastUpdateId.trim()
        ? channel.lastUpdateId.trim()
        : Number.isFinite(Number(channel?.lastUpdateId)) && Number(channel.lastUpdateId) > 0
          ? Number(channel.lastUpdateId)
          : 0,
    lastStatus: ['idle', 'connected', 'error'].includes(channel?.lastStatus)
      ? channel.lastStatus
      : 'idle',
    lastError: typeof channel?.lastError === 'string' ? channel.lastError : '',
    lastCheckedAt: channel?.lastCheckedAt ? coerceIso(channel.lastCheckedAt) : null,
    lastPolledAt: channel?.lastPolledAt ? coerceIso(channel.lastPolledAt) : null,
    lastIncomingAt: channel?.lastIncomingAt ? coerceIso(channel.lastIncomingAt) : null,
    lastIncomingPreview:
      typeof channel?.lastIncomingPreview === 'string'
        ? channel.lastIncomingPreview.trim()
        : '',
    lastReplyAt: channel?.lastReplyAt ? coerceIso(channel.lastReplyAt) : null,
    lastReplyPreview:
      typeof channel?.lastReplyPreview === 'string' ? channel.lastReplyPreview.trim() : '',
    lastRemoteChatId:
      typeof channel?.lastRemoteChatId === 'string' ? channel.lastRemoteChatId.trim() : '',
    // When true, the bot also sends a TTS voice message after each text reply.
    voiceReply: Boolean(channel?.voiceReply),
  };
}

export function normalizeAgentChannels(channels = {}) {
  return Object.fromEntries(
    AGENT_CHANNEL_IDS.map(channelId => [
      channelId,
      normalizeAgentChannel(channelId, channels?.[channelId]),
    ]),
  );
}

// Runtime fields the polling loop is allowed to write back over the persisted
// channel. Everything else on a channel is user-editable config (tokens,
// guildId, channelId, voiceReply, nicknames, etc.) and must NOT be touched
// by the poller, or we risk clobbering a UI edit that landed between the
// poller's read and write. See feedback_preserve_user_config.md.
export const CHANNEL_RUNTIME_FIELDS = [
  'lastStatus',
  'lastError',
  'lastUpdateId',
  'lastCheckedAt',
  'lastPolledAt',
  'lastIncomingAt',
  'lastIncomingPreview',
  'lastRemoteChatId',
  'lastReplyAt',
  'lastReplyPreview',
];

// Produce the "channel to persist" object by taking the latest persisted
// channel as the base (so fresh UI edits survive) and layering ONLY the
// runtime fields from the poller's in-memory snapshot. `botUsername` is
// a special case: the poller may be the first to learn it, so we promote
// it from the runtime snapshot only when the persisted channel lacks it.
export function mergeChannelRuntimeFields(persistedChannel, runtimeChannel) {
  const merged = { ...persistedChannel };
  for (const key of CHANNEL_RUNTIME_FIELDS) {
    if (runtimeChannel?.[key] !== undefined) {
      merged[key] = runtimeChannel[key];
    }
  }
  if (!persistedChannel?.botUsername && runtimeChannel?.botUsername) {
    merged.botUsername = runtimeChannel.botUsername;
  }
  return merged;
}
