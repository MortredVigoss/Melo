import { runtimeMessage } from '../../../shared/agent/runtimeMessages.js';
import { resolveReplyLocale } from '../../../shared/agent/locale.js';
// ─── Discord voice runtime ───────────────────────────────────────────────────
// Singleton that owns:
//   - one discord.js Client per agent id (lazy, created on first voice join)
//   - one DiscordVoiceSession per (agentId, guildId) tuple
//   - the /join /leave text-command handler invoked from the Discord polling
//     cycle in desktopStore.js
//
// Why a separate runtime rather than wiring discord.js into processDiscord
// PollingCycle directly?
//   - The polling cycle is REST-only and runs once per agent per tick. The
//     voice track needs a persistent Gateway WebSocket that lives as long
//     as the bot is in a voice channel. Coupling the two means the polling
//     loop would have to own the Gateway lifecycle — messy.
//   - Each agent has a different bot token. A single shared Client can't
//     serve all of them; we must keep a Client per token.
//   - Voice is optional — most agents never use it. Lazy creation on first
//     join keeps the cold-start cost off users who only want text.
//
// This module owns:
//   - getDiscordVoiceRuntime() — singleton accessor
//   - runtime.handleTextCommand(incoming, agentId, profile, discordChannel)
//       → returns { handled, reply } if the message was a /join or /leave;
//         the caller should send `reply` as the bot's text response and
//         SKIP the normal LLM pipeline for that message
//   - runtime.shutdown() — used from app-quit handlers
//
// Depends on: discord.js (Client, GatewayIntentBits), @discordjs/voice
// (via DiscordVoiceSession), and the normalized profile/channel objects from
// agentProfiles / agentChannels.

import { assertAgentChannelAvailable } from '../../shared/channelAvailability.js';
import { Client, GatewayIntentBits } from 'discord.js';
import { DiscordVoiceSession } from './discordVoiceSession.js';

const DEBUG = () => process.env.MELO_DC_VOICE_DEBUG === '1';
function writeDebug(line) {
  if (!DEBUG()) return;
  try { process.stdout.write(`${line}\n`); } catch {}
}

// Command regexes. Match the whole message (after trim + alias-strip) so
// "懂王 你好" doesn't accidentally trigger /leave etc. The matcher runs AFTER
// the Discord polling cycle's alias stripping, so a user typing "@Bot join"
// arrives here as just "join".
const JOIN_CMD_RE = /^(?:\/?join|\/?voice|加入语音|进语音|加入|进频道)\s*$/i;
const LEAVE_CMD_RE = /^(?:\/?leave|\/?stop|离开语音|退出语音|离开|退出)\s*$/i;

class DiscordVoiceRuntime {
  constructor() {
    /** @type {Map<string, { client: Client, ready: Promise<void> }>} */
    this.clientsByAgent = new Map();
    /** @type {Map<string, DiscordVoiceSession>} */
    this.sessions = new Map(); // key = `${agentId}:${guildId}`
  }

  // ── Client plumbing ─────────────────────────────────────────────────────────

  /**
   * Lazily create / fetch the discord.js Client for a given agent + token.
   * The Client stays alive once created; token rotation (unusual) would need
   * an explicit logout via _disposeAgent(agentId).
   */
  async _getClient(agentId, botToken) {
    assertAgentChannelAvailable('discord');
    const existing = this.clientsByAgent.get(agentId);
    if (existing) {
      await existing.ready;
      return existing.client;
    }
    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,        // guild metadata + voice channels
        GatewayIntentBits.GuildVoiceStates, // member.voice.channel resolution
        GatewayIntentBits.GuildMembers,  // fetchMember for command sender's voice state
      ],
    });
    const ready = new Promise((resolve, reject) => {
      client.once('ready', () => {
        writeDebug(`[dc-voice] gateway ready agent=${agentId} user=${client.user?.tag || ''}`);
        resolve(undefined);
      });
      client.once('error', err => reject(err));
    });
    client.login(String(botToken || '')).catch(err => {
      writeDebug(`[dc-voice] login failed agent=${agentId} err=${err?.message || err}`);
    });
    // Silence unhandled error events so a transient websocket hiccup can't crash
    // the whole server process. We rely on explicit stop()/disconnect handling.
    client.on('error', err => {
      writeDebug(`[dc-voice] client error agent=${agentId} err=${err?.message || err}`);
    });
    this.clientsByAgent.set(agentId, { client, ready });
    await ready;
    return client;
  }

  async _disposeAgent(agentId) {
    // Tear down all sessions belonging to this agent first.
    for (const [key, session] of this.sessions.entries()) {
      if (key.startsWith(`${agentId}:`)) {
        await session.stop().catch(() => {});
        this.sessions.delete(key);
      }
    }
    const entry = this.clientsByAgent.get(agentId);
    if (entry) {
      try { await entry.client.destroy(); } catch {}
      this.clientsByAgent.delete(agentId);
    }
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Handle a text-channel message that might be a voice command. Returns
   * either { handled: false } (not a voice command — let the normal reply
   * pipeline take over) or { handled: true, reply: string } (we handled it,
   * caller should send `reply` as text and skip LLM).
   *
   * @param {object} params
   * @param {object} params.incoming         — normalized Discord message
   *   envelope (must have guildId, channelId, senderId, text)
   * @param {string} params.agentId
   * @param {object} params.profile          — normalized agent profile
   * @param {object} params.discordChannel   — normalized channels.discord
   *   config (must carry botToken)
   * @param {string} params.botUserId        — bot's Discord user id
   * @param {() => Promise<object>} params.resolveConfig
   * @returns {Promise<{ handled: boolean, reply?: string }>}
   */
  async handleTextCommand({ incoming, agentId, profile, discordChannel, botUserId, resolveConfig }) {
    assertAgentChannelAvailable('discord');
    const rawText = String(incoming?.text || '').trim();
    if (!rawText) return { handled: false };

    // Strip a leading @bot mention so "@懂王 join" / "懂王 join" both reduce to "join".
    // The Discord polling cycle already computes this via collectDiscordBotAliases
    // upstream, but we re-strip defensively in case this handler is called with
    // raw text.
    const cleaned = stripLeadingMentionAndAliases(rawText, profile, discordChannel);
    const locale = resolveReplyLocale({agentLanguage:profile?.replyLanguage,text:cleaned,channelLanguage:discordChannel?.language});

    if (JOIN_CMD_RE.test(cleaned)) {
      return this._handleJoin({
        incoming, agentId, profile, discordChannel, botUserId, resolveConfig, locale,
      });
    }
    if (LEAVE_CMD_RE.test(cleaned)) {
      return this._handleLeave({ incoming, agentId, locale });
    }
    return { handled: false };
  }

  async _handleJoin({ incoming, agentId, profile, discordChannel, botUserId, resolveConfig, locale = 'zh' }) {
    const guildId = String(incoming?.guildId || '');
    const senderId = String(incoming?.senderId || '');
    if (!guildId) {
      return { handled: true, reply: runtimeMessage('voiceGuild',locale) };
    }
    let client;
    try {
      client = await this._getClient(agentId, discordChannel?.botToken);
    } catch (err) {
      return { handled: true, reply: runtimeMessage('voiceGateway',locale,{error:err?.message || err}) };
    }

    let guild;
    try {
      guild = await client.guilds.fetch(guildId);
    } catch (err) {
      return { handled: true, reply: runtimeMessage('voiceServer',locale,{error:err?.message || err}) };
    }

    let member;
    try {
      member = await guild.members.fetch(senderId);
    } catch {
      return { handled: true, reply: runtimeMessage('voiceMember',locale) };
    }
    const voiceChannel = member.voice?.channel;
    if (!voiceChannel) {
      return { handled: true, reply: runtimeMessage('voiceFirst',locale) };
    }

    const key = `${agentId}:${guildId}`;
    let session = this.sessions.get(key);
    if (session && session.voiceChannelId === voiceChannel.id) {
      return { handled: true, reply: runtimeMessage('voiceAlready',locale) };
    }
    if (session) {
      await session.stop().catch(() => {});
      this.sessions.delete(key);
    }
    session = new DiscordVoiceSession({
      agentId,
      profile,
      discordChannel,
      botUserId: String(botUserId || client.user?.id || ''),
      guild,
      resolveConfig,
      // The person who ran /join is treated as always-addressed for this
      // session — see DiscordVoiceSession constructor doc for why.
      inviterUserId: senderId,
    });
    try {
      await session.start(voiceChannel.id);
    } catch (err) {
      return { handled: true, reply: runtimeMessage('voiceFailed',locale,{error:err?.message || err}) };
    }
    this.sessions.set(key, session);
    writeDebug(`[dc-voice] session registered key=${key}`);
    return {
      handled: true,
      reply: runtimeMessage('voiceJoined',locale,{name:voiceChannel.name}),
    };
  }

  async _handleLeave({ incoming, agentId, locale = 'zh' }) {
    const guildId = String(incoming?.guildId || '');
    if (!guildId) return { handled: true, reply: runtimeMessage('voiceNone',locale) };
    const key = `${agentId}:${guildId}`;
    const session = this.sessions.get(key);
    if (!session) return { handled: true, reply: runtimeMessage('voiceAbsent',locale) };
    await session.stop().catch(() => {});
    this.sessions.delete(key);
    return { handled: true, reply: runtimeMessage('voiceLeft',locale) };
  }

  hasActiveSession(agentId, guildId) {
    return this.sessions.has(`${agentId}:${String(guildId || '')}`);
  }

  async shutdown() {
    for (const session of this.sessions.values()) {
      try { await session.stop(); } catch {}
    }
    this.sessions.clear();
    for (const { client } of this.clientsByAgent.values()) {
      try { await client.destroy(); } catch {}
    }
    this.clientsByAgent.clear();
  }
}

// ─── Mention stripping helper ─────────────────────────────────────────────────

function escapeRe(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Strip a leading @-style mention of the bot (Discord `<@userId>` or `<@!userId>`
 * forms, plus raw alias names) so the command regex matches cleanly.
 *
 * Lives here rather than in telegramAddressHelpers because the Discord polling
 * cycle already handles alias matching for *reply scoring*, but doesn't
 * normalize the text before routing. Voice commands need that normalization.
 */
function stripLeadingMentionAndAliases(text, profile, discordChannel) {
  let s = String(text || '').trim();

  // Discord id-based mention: <@123> or <@!123>
  s = s.replace(/^<@!?\d+>\s*,?\s*/g, '').trim();

  // Alias-prefix stripping. Collect plausible names and strip any that appear
  // at the start. Kept generous — if nothing matches we just pass the raw
  // text through.
  const aliases = new Set();
  const addAlias = v => {
    const t = String(v || '').trim();
    if (t && t.length <= 60) aliases.add(t);
  };
  addAlias(profile?.name);
  addAlias(discordChannel?.botUsername);
  const aliasField = profile?.aliases;
  if (Array.isArray(aliasField)) {
    for (const a of aliasField) addAlias(a);
  } else if (typeof aliasField === 'string') {
    for (const a of aliasField.split(/[,\s]+/)) addAlias(a);
  }

  for (const alias of aliases) {
    const pat = new RegExp(`^${escapeRe(alias)}\\s*[,，:：]?\\s*`, 'i');
    if (pat.test(s)) { s = s.replace(pat, '').trim(); break; }
  }
  return s;
}

// ─── Singleton ────────────────────────────────────────────────────────────────

let _singleton = null;
export function getDiscordVoiceRuntime() {
  if (!_singleton) _singleton = new DiscordVoiceRuntime();
  return _singleton;
}

// For tests / teardown only.
export function _resetDiscordVoiceRuntimeForTests() {
  _singleton = null;
}
