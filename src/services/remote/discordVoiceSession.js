// ─── Discord voice session ───────────────────────────────────────────────────
// One instance = one bot sitting in one voice channel.
//
// Pipeline per utterance (cascade mode, no OpenAI Realtime):
//   Discord voice gateway (opus packets)
//     → prism-media opus decoder → 48 kHz stereo s16le PCM
//     → per-user energy VAD (start, end, barge-in)
//     → on utteranceEnd: resample 48k stereo → 16k mono → WAV
//     → extractAudioContentFromBuffer (whisper.cpp / native / OpenAI Whisper)
//     → wake-word check (collect aliases from profile/channel, look in transcript)
//     → if wake hit OR inside 2-min follow-up window:
//         → createOpenAICompatibleReply with short-turn system prompt
//         → rewriteForVoice for persona + language shaping
//         → synthesizeSpeech (MiniMax → Edge → OpenAI TTS fallback chain)
//         → ffmpeg → 48 kHz stereo → @discordjs/voice AudioPlayer
//     → barge-in: if any user's VAD fires utteranceStart while player is
//       playing, player.stop() immediately + abort the current TTS generation
//
// This module owns:
//   - VOICE_MODE_SYSTEM_SUFFIX  — short-reply prompt hint injected for voice
//   - FOLLOW_UP_WINDOW_MS       — 2 min follow-up window (mirrors replyScoreSignals)
//   - DiscordVoiceSession class — per-channel lifecycle + per-user state
//
// Depends on:
//   @discordjs/voice (joinVoiceChannel, AudioPlayer, createAudioResource)
//   prism-media (opus decoder stream)
//   discord.js (passed Guild/Channel/Client from the runtime)
//
// The runtime (discordVoiceRuntime.js) is responsible for creating/owning
// the discord.js Client and handing this class a ready Guild. We don't log
// in here — that's per-agent-token concern.

import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  AudioPlayerStatus,
  EndBehaviorType,
  entersState,
} from '@discordjs/voice';
import prism from 'prism-media';

import { createOpenAICompatibleReply } from '../../openai.js';
import { synthesizeSpeech } from '../../tts.js';
import { rewriteForVoice } from '../media/voiceRewrite.js';
import { extractAudioContentFromBuffer } from '../../media/extractors/audioExtractor.js';
import { collectDiscordBotAliases } from './discordParsing.js';
import { containsTelegramBotAlias } from './telegramAddressHelpers.js';
import {
  stereo48kPcmToMono16kPcm,
  pcmToWavBuffer,
  createEnergyVad,
  createAudioResourceFromBuffer,
  DISCORD_PCM_SAMPLE_RATE,
  DISCORD_PCM_CHANNELS,
} from '../media/discordVoiceAudio.js';

// ─── Tunables ────────────────────────────────────────────────────────────────

// Inject this as a system-prompt suffix when the bot is replying to voice-channel
// speech. The goal is a "sounds like a real person on call" reply: 1-2 sentences,
// no markdown, no lists, no code blocks.
const VOICE_MODE_SYSTEM_SUFFIX =
  '\n\n[Voice Channel Mode] You are speaking out loud in a Discord voice channel. ' +
  'Reply in 1-2 short sentences, conversational and natural, like someone on a phone call. ' +
  'Do not use markdown, lists, headers, code blocks, or URLs. ' +
  'Match the language the user spoke in — if they spoke English, reply in English; if Chinese, reply in Chinese. ' +
  'If you do not understand, ask a short clarifying question instead of guessing.';

// 2-minute follow-up window — if the bot replied less than this ago and no other
// user has spoken in between, we skip the wake-word requirement. Mirrors the text
// channel follow-up score logic in replyScoreSignals.js.
const FOLLOW_UP_WINDOW_MS = 120_000;

// How many of the most recent turns to feed to the LLM as chat history.
// Kept intentionally small for voice-realtime latency — per user guidance
// (see memory: feedback_discord_voice_scope.md), 3-8 turns is the sweet spot
// for low-latency voice dialog. We land on 8 to preserve enough conversational
// reference without ballooning prompt tokens on each utterance.
const IN_MEMORY_HISTORY_TURNS = 8;

// Transcripts longer than this are locally truncated (head+tail) before being
// sent to the LLM. Chosen so that typical 1-2 sentence speech always passes
// through raw (user guidance: "短消息直接原文传"), but a 500+ char rant gets
// trimmed so the model — and the user waiting for a spoken reply — aren't
// stuck on a 10-second LLM call. We do NOT run a secondary LLM to summarize;
// that would double the per-utterance latency budget. Local truncation
// preserves the first `HEAD` chars (intent) + last `TAIL` chars (most recent
// clause), which is usually enough context for the model to reply to.
const LONG_UTTERANCE_THRESHOLD_CHARS = 400;
const LONG_UTTERANCE_HEAD_CHARS = 200;
const LONG_UTTERANCE_TAIL_CHARS = 160;

function compactLongUtterance(text) {
  const s = String(text || '');
  if (s.length <= LONG_UTTERANCE_THRESHOLD_CHARS) return s;
  const head = s.slice(0, LONG_UTTERANCE_HEAD_CHARS).trimEnd();
  const tail = s.slice(-LONG_UTTERANCE_TAIL_CHARS).trimStart();
  return `${head} […] ${tail}`;
}

// After player finishes speaking, if no user speaks for this long the session
// is still considered "active" but idle. Only used for debug logging.
const DEBUG = () => process.env.MELO_DC_VOICE_DEBUG === '1';

function writeDebug(line) {
  if (!DEBUG()) return;
  try { process.stdout.write(`${line}\n`); } catch {}
}

// ─── Session class ───────────────────────────────────────────────────────────

export class DiscordVoiceSession {
  /**
   * @param {object} params
   * @param {string} params.agentId
   * @param {object} params.profile        — normalized agent profile (reads minimaxVoiceId,
   *                                         voicePersonality, name, aliases, soulMd …)
   * @param {object} params.discordChannel — the agent's normalized channels.discord config
   * @param {string} params.botUserId      — bot's Discord user id (for alias collection +
   *                                         so we don't STT our own playback bleed-through)
   * @param {import('discord.js').Guild} params.guild
   * @param {() => Promise<object>} params.resolveConfig — lazy config getter
   *                                         (getResolvedConfig from desktopStore)
   * @param {string} [params.inviterUserId] — the Discord user id of whoever
   *                                         ran /join. That user is treated
   *                                         as always-addressed for this
   *                                         session (skips wake-word gate),
   *                                         because typing /join already
   *                                         addresses the bot and cloud STT
   *                                         routinely mangles short wake
   *                                         words on the first utterance.
   */
  constructor({ agentId, profile, discordChannel, botUserId, guild, resolveConfig, inviterUserId }) {
    this.agentId = agentId;
    this.profile = profile;
    this.discordChannel = discordChannel;
    this.botUserId = String(botUserId || '');
    this.inviterUserId = String(inviterUserId || '');
    this.guild = guild;
    this.resolveConfig = resolveConfig;

    this.voiceChannelId = '';
    /** @type {import('@discordjs/voice').VoiceConnection | null} */
    this.connection = null;
    /** @type {import('@discordjs/voice').AudioPlayer | null} */
    this.player = null;
    /** @type {Map<string, { vad: any, opus: any, pcm: any, username: string, lastSpokeAt: number }>} */
    this.perUser = new Map();
    /** @type {Array<{ role: 'user'|'assistant', content: string, senderName?: string }>} */
    this.history = [];

    // Runtime state
    this.isPlaying = false;
    this.lastBotReplyAt = 0;
    this.lastUserSpokeAt = 0;
    this.lastUserBeforeBotReply = ''; // userId tracking for follow-up detection
    this.currentTtsAbort = null;      // AbortController to cancel in-flight TTS
    this.pendingUtterance = null;     // if busy, queue one; drop older on new
    this.shutdownRequested = false;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  async start(voiceChannelId) {
    if (this.connection) {
      if (this.voiceChannelId === voiceChannelId) return; // already in this channel
      await this.stop();
    }
    this.voiceChannelId = String(voiceChannelId || '');
    if (!this.voiceChannelId) throw new Error('DiscordVoiceSession.start: missing voiceChannelId');

    writeDebug(`[dc-voice] join agent=${this.agentId} guild=${this.guild.id} channel=${this.voiceChannelId}`);

    this.connection = joinVoiceChannel({
      channelId: this.voiceChannelId,
      guildId: this.guild.id,
      adapterCreator: this.guild.voiceAdapterCreator,
      selfDeaf: false,  // we need to hear to transcribe
      selfMute: false,
    });

    // If Discord/Gateway is sluggish, wait up to 20s for the connection to go Ready.
    // If it never does we bail so the caller can surface the error.
    try {
      await entersState(this.connection, VoiceConnectionStatus.Ready, 20_000);
    } catch (err) {
      await this.stop();
      throw new Error(`voice connection never became ready: ${err.message || err}`);
    }

    this.player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
    });
    this.player.on('stateChange', (from, to) => {
      this.isPlaying = to.status === AudioPlayerStatus.Playing;
      writeDebug(`[dc-voice] player ${from.status}→${to.status} agent=${this.agentId}`);
    });
    this.player.on('error', err => {
      writeDebug(`[dc-voice] player error agent=${this.agentId} msg=${err?.message || err}`);
    });
    this.connection.subscribe(this.player);

    // Receiver fires 'start' when a user begins speaking. We subscribe per-user
    // to their opus stream, decode to PCM, and feed our VAD.
    this.connection.receiver.speaking.on('start', userId => {
      if (userId === this.botUserId) return; // don't listen to ourselves
      this._hookUser(userId);
    });

    // Gateway can flap (network blip, resume). Let @discordjs/voice handle the
    // reconnect — if it gives up we tear down cleanly.
    this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(this.connection, VoiceConnectionStatus.Signalling, 5000),
          entersState(this.connection, VoiceConnectionStatus.Connecting, 5000),
        ]);
      } catch {
        writeDebug(`[dc-voice] disconnect unrecoverable agent=${this.agentId}`);
        await this.stop();
      }
    });
  }

  async stop() {
    this.shutdownRequested = true;
    try { this.currentTtsAbort?.abort(); } catch {}
    try { this.player?.stop(true); } catch {}
    try { this.connection?.destroy(); } catch {}
    for (const entry of this.perUser.values()) {
      try { entry.vad?.end(); } catch {}
      try { entry.opus?.destroy(); } catch {}
      try { entry.pcm?.destroy(); } catch {}
    }
    this.perUser.clear();
    this.connection = null;
    this.player = null;
    this.voiceChannelId = '';
    writeDebug(`[dc-voice] stopped agent=${this.agentId} guild=${this.guild?.id}`);
  }

  // ── Per-user stream plumbing ────────────────────────────────────────────────

  _hookUser(userId) {
    const existing = this.perUser.get(userId);
    if (existing && existing.alive) {
      // Stream still open — just update lastSpokeAt. Discord can fire 'start'
      // back-to-back during continuous speech; we don't want to re-subscribe.
      existing.lastSpokeAt = Date.now();
      return;
    }
    if (existing) {
      // Stale entry — the prior opus stream closed (AfterSilence 2s timeout,
      // or an error). Tear it down fully so we can re-subscribe cleanly.
      // Without this, the next 'start' event early-returns on a dead stream
      // and the user gets no further replies.
      try { existing.vad?.end(); } catch {}
      try { existing.opus?.destroy(); } catch {}
      try { existing.pcm?.destroy(); } catch {}
      this.perUser.delete(userId);
    }
    const username = this._lookupUsername(userId);

    const opus = this.connection.receiver.subscribe(userId, {
      end: {
        // We handle end-of-turn via our own VAD, but keep AfterSilence as a
        // safety net so the stream doesn't dangle forever if we disconnect.
        behavior: EndBehaviorType.AfterSilence,
        duration: 2000,
      },
    });

    // 48 kHz stereo s16le PCM out — matches what @discordjs/voice receiver produces.
    const decoder = new prism.opus.Decoder({
      rate: DISCORD_PCM_SAMPLE_RATE,
      channels: DISCORD_PCM_CHANNELS,
      frameSize: 960, // 20ms @ 48kHz
    });
    const pcm = opus.pipe(decoder);

    const vad = createEnergyVad({
      onUtteranceStart: () => {
        this.lastUserSpokeAt = Date.now();
        // Barge-in: if the bot is playing, stop immediately so the user can
        // take the floor. Also abort in-flight TTS generation if any.
        if (this.isPlaying) {
          writeDebug(`[dc-voice] barge-in agent=${this.agentId} user=${userId}`);
          try { this.player?.stop(true); } catch {}
          try { this.currentTtsAbort?.abort(); } catch {}
        }
      },
      onUtteranceEnd: ({ pcm: utterancePcm, durationMs }) => {
        this._enqueueUtterance(userId, username, utterancePcm, durationMs).catch(err => {
          writeDebug(`[dc-voice] utterance processing failed user=${userId} err=${err?.message || err}`);
        });
      },
    });

    pcm.on('data', chunk => vad.feed(chunk));

    // Mark the entry dead + delete it when the underlying stream closes. The
    // next time this user speaks, `receiver.speaking.on('start')` will fire
    // and _hookUser will create a fresh subscription. Without this, the
    // AfterSilence auto-close silently kills the pipeline after the first
    // utterance — the exact "first reply works, nothing after" symptom.
    const markStreamDead = (why) => {
      try { vad.end(); } catch {}
      const entry = this.perUser.get(userId);
      if (entry && entry.opus === opus) {
        entry.alive = false;
        this.perUser.delete(userId);
        writeDebug(`[dc-voice] stream ${why} user=${userId} — ready to re-hook on next speech`);
      }
    };
    pcm.on('end', () => markStreamDead('ended'));
    pcm.on('error', err => markStreamDead(`pcm-error(${err?.message || err})`));
    opus.on('close', () => markStreamDead('opus-close'));
    opus.on('error', err => markStreamDead(`opus-error(${err?.message || err})`));

    this.perUser.set(userId, { vad, opus, pcm, username, lastSpokeAt: Date.now(), alive: true });
  }

  _lookupUsername(userId) {
    try {
      const member = this.guild?.members?.cache?.get(userId);
      if (member) return member.displayName || member.user?.username || userId;
      const user = this.guild?.client?.users?.cache?.get(userId);
      if (user) return user.username || userId;
    } catch {}
    return userId;
  }

  // ── Utterance → reply pipeline ──────────────────────────────────────────────

  async _enqueueUtterance(userId, username, pcm48Stereo, durationMs) {
    // Busy? Queue one. On a new utterance while something is queued, drop the
    // old one — the latest thing the user said is what matters.
    if (this._busy) {
      this.pendingUtterance = { userId, username, pcm48Stereo, durationMs };
      return;
    }
    this._busy = true;
    try {
      await this._processUtterance({ userId, username, pcm48Stereo, durationMs });
      // Drain one pending if present.
      while (this.pendingUtterance && !this.shutdownRequested) {
        const next = this.pendingUtterance;
        this.pendingUtterance = null;
        await this._processUtterance(next);
      }
    } finally {
      this._busy = false;
    }
  }

  async _processUtterance({ userId, username, pcm48Stereo, durationMs }) {
    if (this.shutdownRequested) return;

    writeDebug(
      `[dc-voice] utterance user=${username} dur=${durationMs}ms bytes=${pcm48Stereo.length}`,
    );

    // 1. Resample + WAV-wrap so the STT helpers can parse it.
    const pcm16Mono = stereo48kPcmToMono16kPcm(pcm48Stereo);
    const wav = pcmToWavBuffer(pcm16Mono, { sampleRate: 16000, channels: 1 });

    // 2. Run STT via the same pipeline Telegram/Discord text channel uses for
    // voice messages. This keeps the provider priority consistent (whisper.cpp
    // → Apple native → OpenAI Whisper). Fallback IS allowed here: if the
    // local engines aren't available (whisper.cpp not built on this machine,
    // Apple native missing, etc.) we let the cloud path take over. Without
    // this, the pipeline silently returns an empty transcript and the user
    // sees "I speak and nothing happens".
    const config = await this.resolveConfig();
    const transcriptResult = await extractAudioContentFromBuffer(
      wav,
      { fileName: 'voice-channel.wav', mimeType: 'audio/wav' },
      { config, suppressFallback: false },
    );
    const transcript = String(transcriptResult?.text || '').trim();
    if (!transcript) {
      writeDebug(`[dc-voice] empty transcript user=${username} — skipping`);
      return;
    }
    writeDebug(`[dc-voice] transcript user=${username} text="${transcript.slice(0, 80)}"`);

    // 3. Addressal: inviter bypass OR wake word match OR inside follow-up window.
    //
    // Inviter bypass: the user who ran /join has already addressed the bot.
    // Making them repeat a wake word on every utterance produces the symptom
    // "I speak in the channel and nothing happens" — especially painful when
    // cloud STT mangles short wake tokens like "melo" / "懂王". We treat the
    // inviter as always-addressed for the lifetime of this session. Other
    // users in the same channel still need the wake word or a follow-up
    // window, so cross-talk from a third party doesn't hijack the bot.
    const isInviter = this.inviterUserId && userId === this.inviterUserId;
    const aliases = collectDiscordBotAliases(this.profile, this.discordChannel, this.botUserId);
    const lowerTranscript = transcript.toLowerCase();
    const wakeHit = aliases.some(a => containsTelegramBotAlias(lowerTranscript, a));

    const sinceBot = Date.now() - this.lastBotReplyAt;
    const inFollowUp =
      this.lastBotReplyAt > 0 &&
      sinceBot < FOLLOW_UP_WINDOW_MS &&
      // If someone else spoke in between, the follow-up context is broken.
      (!this.lastUserBeforeBotReply || this.lastUserBeforeBotReply === userId);

    if (!isInviter && !wakeHit && !inFollowUp) {
      writeDebug(
        `[dc-voice] no-wake user=${username} transcript="${transcript.slice(0, 60)}" aliases=${aliases.join(',')}`,
      );
      // Still remember what the user said — it helps the LLM pick up context
      // when the next wake hit lands.
      this._pushHistory({ role: 'user', content: transcript, senderName: username });
      return;
    }

    // 4. LLM reply with short-form voice system prompt.
    const replyText = await this._generateReply({ transcript, username, config });
    if (!replyText) {
      writeDebug(`[dc-voice] empty reply user=${username}`);
      return;
    }

    // 5. Persona-shape the reply for voice.
    const voicePersonality = String(this.profile?.voicePersonality || '').trim();
    let shaped = replyText;
    try {
      shaped = await rewriteForVoice(replyText, config, voicePersonality, username);
      shaped = String(shaped || replyText).trim();
    } catch (err) {
      writeDebug(`[dc-voice] voice rewrite failed: ${err?.message || err} — using raw reply`);
    }
    if (!shaped) return;

    // 6. Synthesize and play.
    await this._speak(shaped, config);

    // 7. Update conversation state for next turn's follow-up detection.
    this._pushHistory({ role: 'user', content: transcript, senderName: username });
    this._pushHistory({ role: 'assistant', content: shaped });
    this.lastBotReplyAt = Date.now();
    this.lastUserBeforeBotReply = userId;
  }

  async _generateReply({ transcript, username, config }) {
    // System prompt assembly: agent's identity/soul/rolePrompt/systemPrompt
    // concatenated in priority order, then the voice-mode suffix appended.
    const parts = [];
    const add = v => {
      const s = String(v || '').trim();
      if (s) parts.push(s);
    };
    add(this.profile?.identity || this.profile?.identify);
    add(this.profile?.soulMd || this.profile?.['soul.md'] || this.profile?.soul);
    add(this.profile?.rolePrompt);
    add(this.profile?.systemPrompt);
    let systemPrompt = parts.join('\n\n');
    if (!systemPrompt) {
      systemPrompt = `You are ${this.profile?.name || 'a helpful assistant'}.`;
    }
    systemPrompt += VOICE_MODE_SYSTEM_SUFFIX;

    const messages = [];
    for (const turn of this.history.slice(-IN_MEMORY_HISTORY_TURNS)) {
      // Compact every history turn that overflows the threshold — old turns
      // from this session only carry signal value, not verbatim value.
      const compacted = compactLongUtterance(turn.content);
      messages.push({
        role: turn.role,
        content: turn.role === 'user' && turn.senderName
          ? `${turn.senderName}: ${compacted}`
          : compacted,
      });
    }
    // Current user turn: short utterances pass raw (per user guidance); only
    // overflow gets head+tail truncated. This keeps "在吗" / "继续" /
    // "what do you mean" going straight to the model with no massaging.
    const currentContent = compactLongUtterance(transcript);
    messages.push({
      role: 'user',
      content: username ? `${username}: ${currentContent}` : currentContent,
    });

    try {
      const raw = await createOpenAICompatibleReply({
        authMode: config.authMode,
        apiProtocol: config.apiProtocol,
        apiKey: config.activeLlmProfileId ? config.apiKey : process.env.MELO_API_KEY || process.env.OPENAI_API_KEY || config.apiKey,
        baseUrl: config.activeLlmProfileId ? config.baseUrl : process.env.MELO_BASE_URL || process.env.OPENAI_BASE_URL || config.baseUrl,
        model: config.activeLlmProfileId ? config.model : process.env.MELO_MODEL || config.model,
        systemPrompt,
        messages,
        // Voice replies should be short by default; this hard-caps the LLM even
        // if the system prompt fails to constrain it. ~300 tokens ≈ 2 sentences.
        maxTokens: 300,
      });
      return String(raw || '').trim();
    } catch (err) {
      writeDebug(`[dc-voice] LLM call failed: ${err?.message || err}`);
      return '';
    }
  }

  async _speak(text, config) {
    // Kick off TTS. MiniMax is preferred per agent config; the TTS module
    // handles the priority chain + fallbacks internally.
    const voiceId = String(this.profile?.minimaxVoiceId || '').trim();
    const ttsConfig = {
      ...config,
      ...(this.profile?.ttsSpeed != null ? { ttsSpeed: this.profile.ttsSpeed } : {}),
      ...(this.profile?.ttsPitch != null ? { ttsPitch: this.profile.ttsPitch } : {}),
      ...(this.profile?.ttsVol != null ? { ttsVol: this.profile.ttsVol } : {}),
    };
    const abort = new AbortController();
    this.currentTtsAbort = abort;
    let ttsResult;
    try {
      ttsResult = await synthesizeSpeech(text, ttsConfig, {
        voiceId,
        signal: abort.signal,
      });
    } catch (err) {
      if (abort.signal.aborted) {
        writeDebug(`[dc-voice] TTS aborted (barge-in) text="${text.slice(0, 40)}"`);
        return;
      }
      writeDebug(`[dc-voice] TTS failed: ${err?.message || err}`);
      return;
    } finally {
      if (this.currentTtsAbort === abort) this.currentTtsAbort = null;
    }
    if (!ttsResult?.buffer?.length) {
      writeDebug(`[dc-voice] TTS returned no audio for text="${text.slice(0, 40)}"`);
      return;
    }
    if (abort.signal.aborted || this.shutdownRequested) return;

    let resource;
    try {
      resource = createAudioResourceFromBuffer(ttsResult.buffer, {
        createAudioResource,
        StreamType,
      });
    } catch (err) {
      writeDebug(`[dc-voice] audio resource failed: ${err?.message || err}`);
      return;
    }

    try {
      this.player.play(resource);
      // Wait until the player either finishes naturally or is stopped (barge-in).
      await entersState(this.player, AudioPlayerStatus.Playing, 5000).catch(() => {});
      await new Promise(resolve => {
        const onChange = (_from, to) => {
          if (to.status === AudioPlayerStatus.Idle) {
            this.player.off('stateChange', onChange);
            resolve(undefined);
          }
        };
        this.player.on('stateChange', onChange);
      });
    } catch (err) {
      writeDebug(`[dc-voice] play failed: ${err?.message || err}`);
    }
  }

  _pushHistory(turn) {
    this.history.push(turn);
    // Keep the in-memory ring tight — once we pass the slice() window we use
    // at LLM time, older turns are unreachable. Holding 2× was wasted memory
    // and, more importantly, risked accidentally restoring old context if the
    // slice bound ever changed. Cap at IN_MEMORY_HISTORY_TURNS exactly.
    if (this.history.length > IN_MEMORY_HISTORY_TURNS) {
      this.history.splice(0, this.history.length - IN_MEMORY_HISTORY_TURNS);
    }
  }

  // ── Inspection (used by runtime + debug UI if ever added) ──────────────────

  get status() {
    if (!this.connection) return 'idle';
    if (this.isPlaying) return 'speaking';
    if (this._busy) return 'processing';
    return 'listening';
  }
}
