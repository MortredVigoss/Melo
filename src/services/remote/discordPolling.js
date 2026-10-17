import { isAgentChannelAvailable } from '../../shared/channelAvailability.js';
import { createRequestContext } from '../../runtime/requestContext.js';
import { currentRequestContext, runWithRequestContext } from '../../runtime/requestScope.js';
// Discord polling cluster — sub-phase 7d-5ζ commit 2 of the desktopStore
// decomposition. byte-for-byte port (CLAUDE.md §5).
//
// `processDiscordPollingCycle` is the long-poll loop the runtime drives
// every few seconds (per agent) to pull new Discord messages, dispatch
// routing/reply decisions, and persist conversation state. Same
// packaging shape as the Telegram cluster from commit 1 — private
// helpers + the public entry server.js calls.
//
// Members:
//   • DISCORD_DEBUG_LOG_MAX_BYTES / DISCORD_POLL_LIMIT (consts)
//   • discordDebugLogPath() (call-time path resolver — CLAUDE.md §6)
//   • _discordDebugDirReady (per-path dir-ready map)
//   • writeDiscordDebugLine (private)
//   • shouldReplyToDiscordMessage (private routing gate)
//   • ensureDiscordChatRecord / recordDiscordMessageWithoutReply
//   • sendDiscordReply / sendDiscordAudioReply (private)
//   • processDiscordPollingCycle (public)
//   • snowflakeGt (Discord snowflake comparison helper)
//
// `renderTelegramTransportText` is intentionally re-imported from the
// Telegram cluster — the Discord branch comment says "mirrors the
// Telegram branch", and the byte-for-byte rule keeps that decision in
// the original form.
//
// CLAUDE.md §6 compliance (G-6 audit 2026-05-11): mirrors telegramPolling.
// The earlier mechanical adaptation copied desktopStore's module-load
// `DESKTOP_DIR` / `DISCORD_DEBUG_LOG_PATH` freeze pattern verbatim —
// same §6 violation.  Now resolved per-call inside writeDiscordDebugLine
// (capture-at-entry) so a runtime/test MELO_HOME flip routes correctly.

import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { getMeloHome } from '../../config.js';
import { getResolvedConfig } from '../../config.js';
import { enrichMessageWithMediaContext } from '../../media/index.js';
import {
  mergeChannelRuntimeFields,
  normalizeAgentChannels,
} from '../../domain/agent/agentChannels.js';
import { allAgentIdsFromProfiles } from '../../domain/agent/agentLibrary.js';
import { generateChatTitle } from '../chat/providerErrors.js';
import { sendChatMessage } from '../chat/sendChatMessage.js';
import { rewriteForVoice } from '../media/voiceRewrite.js';
import { normalizeMessageBlocks } from '../../domain/message/messageBlocks.js';
import { loadAttachmentBytes } from './attachmentBytes.js';
import {
  discordApiRequest,
  fetchDiscordUpdates as fetchDiscordUpdatesFromApi,
  pingDiscordChannel,
  sendDiscordMediaReply,
} from './discordApi.js';
import {
  buildDiscordThreadKey,
  latestProcessableDiscordMessage,
} from './discordParsing.js';
import { buildDiscordReplyScore } from './discordReplyScore.js';
import { getDiscordVoiceRuntime } from './discordVoiceRuntime.js';
import { classifyGroupMessageAddressal } from './groupAddressalClassifier.js';
import { updateGroupRelationshipGraph } from './groupRelationship.js';
import {
  OFFLINE_BACKLOG_THRESHOLD_MS,
  isBacklogPollCycle,
  passesOfflineBacklogFilter,
} from './offlineBacklogFilter.js';
import { renderTelegramTransportText } from './telegramPolling.js';
import {
  GRAY_ZONE_MIN,
  REPLY_SCORE_THRESHOLD,
} from './telegramReplyScore.js';
import {
  normalizeAgentStorageId,
  normalizeMessageAttachments,
  nowIso,
} from '../../shared/helpers.js';
import {
  normalizeAgentProfile,
  normalizeAgentProfiles,
} from '../../state/agentProfiles.js';
import { refreshChatMemorySummary } from '../../memory/chatThreadContext.js';
import {
  createChatRecord,
  summarizeMessagePreview,
} from '../../state/conversation.js';
import { normalizeChat } from '../../state/stateHydration.js';
import { ensureSelectedEntities } from '../../state/stateSelections.js';
import {
  loadState,
  updateStateAtomically,
} from '../../state/stateStore.js';

const DISCORD_DEBUG_LOG_MAX_BYTES = 256 * 1024;
const DISCORD_POLL_LIMIT = 50;
const _discordDebugDirReady = new Map(); // desktopDir → true once mkdir succeeded

function discordDebugLogPath() {
  return join(getMeloHome(), 'desktop', 'discord-debug.log');
}

function writeDiscordDebugLine(line) {
  // §6 capture-at-entry: resolve once per call.
  const logPath = discordDebugLogPath();
  const desktopDir = dirname(logPath);
  try {
    if (!_discordDebugDirReady.get(desktopDir)) {
      mkdirSync(desktopDir, { recursive: true });
      _discordDebugDirReady.set(desktopDir, true);
    }
    try {
      const info = statSync(logPath);
      if (info.size > DISCORD_DEBUG_LOG_MAX_BYTES) {
        renameSync(logPath, `${logPath}.old`);
      }
    } catch {
      // File doesn't exist yet, that's fine.
    }
    const stamp = new Date().toISOString();
    appendFileSync(logPath, `${stamp} ${line}\n`, 'utf8');
  } catch {
    // Never let logging errors bubble into the polling loop.
  }
  if (process.env.MELO_DC_DEBUG === '1') {
    // Keep the old stdout mirror for developers who want live output.
    try {
      process.stdout.write(`${line}\n`);
    } catch {}
  }
}

async function shouldReplyToDiscordMessage(
  incoming,
  discordChannel,
  profile,
  recentChat,
  config,
  botUserId = '',
) {
  if (
    !incoming?.chatId ||
    (!String(incoming?.text || '').trim() && !normalizeMessageAttachments(incoming?.attachments).length)
  ) {
    return false;
  }

  if (incoming.chatType === 'private') {
    return true;
  }

  const { signals, totalScore } = buildDiscordReplyScore(
    incoming,
    discordChannel,
    profile,
    recentChat,
    botUserId,
  );

  let decision;
  let method = 'score';

  if (totalScore >= REPLY_SCORE_THRESHOLD) {
    decision = true;
  } else if (totalScore < GRAY_ZONE_MIN) {
    decision = false;
  } else {
    method = 'llm';
    decision = await classifyGroupMessageAddressal(incoming, recentChat, config, profile);
  }

  writeDiscordDebugLine(
    `[dc-route] sender=${incoming?.senderName || 'unknown'} ` +
      `chatType=${incoming?.chatType || 'unknown'} ` +
      `text="${String(incoming?.text || '').slice(0, 60)}" ` +
      `score=${totalScore.toFixed(2)} method=${method} reply=${decision} ` +
      `signals=${JSON.stringify(signals)}`,
  );

  return decision;
}

async function ensureDiscordChatRecord(agentId, incoming) {
  let record;
  await updateStateAtomically(state => {
  const externalThreadKey = buildDiscordThreadKey(
    agentId,
    incoming?.guildId,
    incoming?.chatId,
  );
  const existingChat = state.chats.find(chat => chat.externalThreadKey === externalThreadKey);
  if (existingChat) {
    let needsSave = false;
    if (existingChat.chatType !== (incoming?.chatType || existingChat.chatType)) {
      existingChat.chatType = incoming?.chatType || existingChat.chatType;
      needsSave = true;
    }
    if ((incoming?.chatTitle || '') !== existingChat.chatTitle) {
      existingChat.chatTitle = incoming?.chatTitle || '';
      needsSave = true;
    }
    if (needsSave) {
      existingChat.updatedAt = nowIso();
    }
    record = existingChat;
    return;
  }

  const chat = {
    ...createChatRecord({
      mode: 'chat',
      projectId: null,
    }),
    title: generateChatTitle(incoming?.text || ''),
    agentId: normalizeAgentStorageId(agentId),
    source: 'discord',
    chatType: incoming?.chatType || 'private',
    chatTitle: incoming?.chatTitle || '',
    messageThreadId: null,
    externalThreadKey,
  };
  state.chats.unshift(chat);
  record = chat;
  });
  return record;
}

async function recordDiscordMessageWithoutReply(agentId, incoming, existingChat = null) {
  const config = await getResolvedConfig();
  const chat = normalizeChat(existingChat || (await ensureDiscordChatRecord(agentId, incoming)));
  let currentChat = null;

  const userMessage = {
    id: randomUUID(),
    role: 'user',
    content: incoming?.text || '',
    blocks: normalizeMessageBlocks([], incoming?.text || ''),
    attachments: normalizeMessageAttachments(incoming?.attachments),
    extractedMedia: [],
    createdAt: incoming?.receivedAt || nowIso(),
    senderId: incoming?.senderId || null,
    senderName: incoming?.senderName || null,
    senderUsername: incoming?.senderUsername || null,
    meta: { bystanderMessage: true },
  };
  await enrichMessageWithMediaContext(userMessage, {
    config,
    modelSupportsVision: false,
  });
  await updateStateAtomically(state => {
  currentChat = state.chats.find(entry => entry.id === chat.id);
  if (!currentChat) return;
  currentChat.messages.push(userMessage);
  currentChat.updatedAt = nowIso();
  currentChat.chatType = incoming?.chatType || currentChat.chatType;
  currentChat.chatTitle = incoming?.chatTitle || currentChat.chatTitle;
  if (!currentChat.title || currentChat.title === 'New chat') {
    currentChat.title = generateChatTitle(incoming?.text || summarizeMessagePreview(userMessage));
  }

  updateGroupRelationshipGraph(currentChat, incoming, false);

  refreshChatMemorySummary(currentChat);
  });
  return currentChat;
}

async function sendDiscordReply(channel, incoming, text) {
  const targetChannelId = String(incoming?.chatId || channel?.channelId || '').trim();
  if (!targetChannelId) {
    throw new Error('Discord reply is missing a channelId.');
  }

  const body = { content: String(text || '').slice(0, 2000) };
  if (incoming?.messageId) {
    // Reply semantics — Discord uses message_reference rather than reply_to_message_id.
    body.message_reference = {
      message_id: String(incoming.messageId),
      channel_id: targetChannelId,
      fail_if_not_exists: false,
    };
  }

  return discordApiRequest(channel, `/channels/${encodeURIComponent(targetChannelId)}/messages`, {
    method: 'POST',
    body,
  });
}

async function sendDiscordAudioReply(channel, incoming, audioBuffer, mimeType = 'audio/mpeg') {
  const ext = mimeType.includes('ogg') ? 'ogg' : mimeType.includes('wav') ? 'wav' : 'mp3';
  // Thin wrapper over sendDiscordMediaReply — the multipart convention is
  // shared across audio / image / document, so the heavy lifting lives in
  // the Discord API layer. Error shape (err.status, err.bodyPreview) is
  // preserved by sendDiscordMediaReply.
  return sendDiscordMediaReply(channel, incoming, audioBuffer, {
    mimeType,
    fileName: `reply.${ext}`,
  });
}

export async function processDiscordPollingCycle() {
  if (!isAgentChannelAvailable('discord')) {
    return { archived: true, hasActiveChannel: false, processedUpdateCount: 0, encounteredError: false };
  }
  if (!currentRequestContext()) return runWithRequestContext(createRequestContext(), () => processDiscordPollingCycle(...arguments));
  const state = ensureSelectedEntities(await loadState());
  const agentIds = allAgentIdsFromProfiles(state.agentProfiles);
  let hasActiveChannel = false;
  let processedUpdateCount = 0;
  let encounteredError = false;
  for (const agentId of agentIds) {
    const profile = normalizeAgentProfile(agentId, state.agentProfiles?.[agentId]);
    const discordChannel = normalizeAgentChannels(profile.channels)?.discord;
    if (
      !discordChannel?.enabled ||
      !discordChannel.botToken ||
      !discordChannel.channelId
    ) {
      // Emit a debug line so the user can tell whether the poller is silently
      // skipping their agent because the config didn't persist. Common root
      // cause: the UI form's channels draft hadn't been saved (fixed in
      // desktop-ui/app.js normalizeChannelsForDraft). Without this log the
      // user sees "no reply" with no clue whether the poll even started.
      writeDiscordDebugLine(
        `[dc-poll] skip agent=${agentId} ` +
          `enabled=${Boolean(discordChannel?.enabled)} ` +
          `hasToken=${Boolean(discordChannel?.botToken)} ` +
          `hasChannelId=${Boolean(discordChannel?.channelId)}`,
      );
      continue;
    }
    hasActiveChannel = true;
    // Offline-backlog detection must run BEFORE we refresh lastPolledAt on
    // the runtimeChannel. See OFFLINE_BACKLOG_THRESHOLD_MS doc.
    const isBacklogCycle = isBacklogPollCycle(discordChannel);
    writeDiscordDebugLine(
      `[dc-poll] start agent=${agentId} channelId=${discordChannel.channelId} ` +
        `lastUpdateId=${discordChannel.lastUpdateId || '(none)'} ` +
        `backlogCycle=${isBacklogCycle}`,
    );

    const runtimeChannel = {
      ...discordChannel,
      lastCheckedAt: nowIso(),
      lastPolledAt: nowIso(),
    };

    // Resolve bot identity once — needed for @mention detection.
    let botUserId = '';
    if (!runtimeChannel.botUsername) {
      try {
        const me = await pingDiscordChannel(discordChannel);
        if (me?.username) {
          runtimeChannel.botUsername = String(me.username).trim();
        }
        if (me?.id) {
          botUserId = String(me.id);
        }
      } catch {}
    } else {
      // Still ping once per cycle to get the id if we haven't cached it.
      try {
        const me = await pingDiscordChannel(discordChannel);
        if (me?.id) {
          botUserId = String(me.id);
        }
      } catch {}
    }

    try {
      const messages = await fetchDiscordUpdatesFromApi(runtimeChannel, DISCORD_POLL_LIMIT);
      runtimeChannel.lastStatus = 'connected';
      runtimeChannel.lastError = '';

      writeDiscordDebugLine(
        `[dc-poll] fetched agent=${agentId} count=${messages.length}`,
      );

      // 2026-06-04 audit闭环: advance lastUpdateId PER MESSAGE inside the loop
      // (see the per-message `finally` below), NOT to the batch max up front.
      // Pre-fix, setting the offset to the highest snowflake before processing
      // meant a throw mid-batch still persisted the advanced offset → the next
      // fetch (?after=lastUpdateId) skipped the unprocessed messages and never
      // looked back → silent message loss.
      processedUpdateCount += messages.length;

      for (const rawMessage of messages) {
        // Per-message isolation: one message's processing error must NOT abort
        // the rest of the batch. The `finally` advances the snowflake offset
        // past THIS message regardless of outcome (success / skip / hard
        // error) so the poll always makes forward progress — a hard-failed
        // message is ack-and-logged, never retried forever (poison-safe).
        try {
        // Pre-normalization diagnostics. If content is empty on every message,
        // the bot almost certainly lacks the MESSAGE_CONTENT privileged intent
        // (Discord Developer Portal → Bot → Privileged Gateway Intents).
        // Without it the REST API returns content="" for any message the bot
        // wasn't @mentioned in, and Melo silently drops them below.
        {
          const rawContent = String(rawMessage?.content || '');
          writeDiscordDebugLine(
            `[dc-msg] raw id=${rawMessage?.id || '?'} ` +
              `author=${rawMessage?.author?.username || '?'} ` +
              `isBot=${Boolean(rawMessage?.author?.bot)} ` +
              `contentLen=${rawContent.length} ` +
              `attach=${Array.isArray(rawMessage?.attachments) ? rawMessage.attachments.length : 0}`,
          );
        }
        const incoming = await latestProcessableDiscordMessage(rawMessage, runtimeChannel);
        if (
          !incoming?.chatId ||
          (!String(incoming?.text || '').trim() &&
            !normalizeMessageAttachments(incoming?.attachments).length)
        ) {
          writeDiscordDebugLine(
            `[dc-msg] dropped reason=${!incoming ? 'from-bot-or-missing' : 'empty-content'} id=${rawMessage?.id || '?'}`,
          );
          continue;
        }

        runtimeChannel.lastIncomingAt = incoming.receivedAt || nowIso();
        runtimeChannel.lastIncomingPreview =
          incoming.text ||
          summarizeMessagePreview({
            attachments: incoming.attachments,
            blocks: [],
            content: '',
          });
        runtimeChannel.lastRemoteChatId = incoming.chatId;

        const recentChat = await ensureDiscordChatRecord(agentId, incoming);

        // Offline backlog filter — mirror of the Telegram branch. Discord uses
        // message.mentions[] array for @-mention detection instead of raw
        // "@username" text, so the mentionPredicate resolves botUserId against
        // incoming.mentionIds that latestProcessableDiscordMessage captured.
        if (isBacklogCycle) {
          const passes = passesOfflineBacklogFilter({
            incoming,
            recentChat,
            mentionPredicate: msg => {
              if (!botUserId) return false;
              const ids = Array.isArray(msg?.mentionIds) ? msg.mentionIds : [];
              return ids.includes(String(botUserId));
            },
          });
          if (!passes) {
            writeDiscordDebugLine(
              `[dc-poll] backlog-skip agent=${agentId} ` +
                `id=${incoming.messageId || '?'} chat_id=${incoming.chatId} ` +
                `sender=${incoming.senderName || 'unknown'} ` +
                `reason=no-mention-no-reply-no-recent-bot-context`,
            );
            await recordDiscordMessageWithoutReply(agentId, incoming, recentChat);
            continue;
          }
        }

        const config = await getResolvedConfig();

        // ── Voice-channel control commands ────────────────────────────────
        // Short-circuit /join, /leave, 加入语音, 离开语音 etc. before the normal
        // reply pipeline. The voice runtime owns the discord.js Gateway client
        // lifecycle and voice-session mapping; we just hand it the incoming
        // envelope and echo back its short text reply. This path only fires
        // for messages that (a) passed addressal scoring (via buildDiscord
        // ReplyScore — e.g. @mention or invoke prefix) and (b) are a voice
        // command, so random users in group channels can't hijack the bot.
        try {
          const prelimScore = buildDiscordReplyScore(
            incoming, discordChannel, profile, recentChat, botUserId,
          );
          const isBotAddressed =
            prelimScore?.signals?.isReplyToBot ||
            prelimScore?.signals?.mentionUsername ||
            prelimScore?.signals?.invokePrefix ||
            prelimScore?.signals?.aliasMatch ||
            incoming.chatType === 'dm';
          if (isBotAddressed) {
            const voiceRuntime = getDiscordVoiceRuntime();
            const voiceCmd = await voiceRuntime.handleTextCommand({
              incoming, agentId, profile, discordChannel,
              botUserId,
              resolveConfig: getResolvedConfig,
            });
            if (voiceCmd.handled) {
              await sendDiscordReply(runtimeChannel, incoming, voiceCmd.reply || '');
              await recordDiscordMessageWithoutReply(agentId, incoming, recentChat);
              continue; // skip the LLM pipeline for this message
            }
          }
        } catch (voiceCmdErr) {
          writeDiscordDebugLine(
            `[dc-voice] command handler error agent=${agentId} msg=${(voiceCmdErr?.message || String(voiceCmdErr)).slice(0, 200)}`,
          );
        }

        const shouldReply = await shouldReplyToDiscordMessage(
          incoming,
          discordChannel,
          profile,
          recentChat,
          config,
          botUserId,
        );

        if (!shouldReply) {
          await recordDiscordMessageWithoutReply(agentId, incoming, recentChat);
          continue;
        }

        // Typing indicator — Discord supports POST /channels/{id}/typing.
        await discordApiRequest(
          runtimeChannel,
          `/channels/${encodeURIComponent(incoming.chatId)}/typing`,
          { method: 'POST', timeoutMs: 10000 },
        ).catch(() => null);

        const result = await sendChatMessage({
          chatId: recentChat.id,
          content: incoming.text,
          mode: recentChat.mode,
          attachments: incoming.attachments || [],
          background: true,
          skipBootstrap: true,
          channelContext: {
            channelId: 'discord',
            remoteChatId: incoming.chatId,
            chatType: incoming.chatType,
            senderId: incoming.senderId,
            senderName: incoming.senderName,
            senderUsername: incoming.senderUsername,
            isReplyToBot: incoming.isReplyToBot,
            repliedToText: incoming.repliedToText,
          },
        });

        if (incoming.chatType === 'group' || incoming.chatType === 'supergroup') {
          await updateStateAtomically(s => {
            const targetChat = s.chats?.find(c => c.id === recentChat.id);
            if (targetChat) updateGroupRelationshipGraph(targetChat, incoming, true);
          });
        }

        const replyText = renderTelegramTransportText(result?.assistantMessage);
        if (!replyText) {
          continue;
        }

        // Voice reply eligibility — mirrors the Telegram branch:
        //   • triggers when the agent's voiceReplyMode !== 'off' AND
        //     (channel has the voiceReply tick ON) OR (the user's inbound
        //     message was itself a voice/audio payload).
        //   • 'full' mode reads the reply text verbatim; 'summary' rewrites it
        //     into a concise spoken form via rewriteForVoice.
        // Running the rewrite in parallel with the text reply keeps the
        // end-to-end latency close to the pure-text path.
        const discordTtsConfig = await getResolvedConfig();
        const discordVoiceMode = profile?.voiceReplyMode || 'summary';
        const shouldDiscordVoiceReply =
          discordVoiceMode !== 'off' && (runtimeChannel.voiceReply || incoming.wasVoiceMessage);

        // Unconditional decision log — fires on every Discord reply regardless
        // of outcome so the user can diagnose why voice reply did (or did not)
        // fire. Without this line, a "no voice came through" report has no
        // actionable signal: we can't tell whether the checkbox failed to
        // persist, the agent's voice mode is 'off', or the inbound wasn't
        // detected as a voice message.
        writeDiscordDebugLine(
          `[dc-voice-decision] agent=${agentId} ` +
            `voiceReplyMode=${discordVoiceMode} ` +
            `channelVoiceTick=${Boolean(runtimeChannel.voiceReply)} ` +
            `wasVoiceMessage=${Boolean(incoming.wasVoiceMessage)} ` +
            `minimaxVoiceId=${profile?.minimaxVoiceId ? 'set' : 'empty'} ` +
            `edgeTtsVoice=${profile?.edgeTtsVoice ? 'set' : 'empty'} ` +
            `willVoice=${shouldDiscordVoiceReply}`,
        );

        const discordVoiceRewritePromise = shouldDiscordVoiceReply
          ? (discordVoiceMode === 'full'
              ? Promise.resolve(replyText)
              : rewriteForVoice(
                  replyText,
                  discordTtsConfig,
                  profile?.voicePersonality || '',
                  incoming?.senderName || '',
                ).catch(err => {
                  writeDiscordDebugLine(
                    `[dc-voice] rewrite-failed agent=${agentId} fallback=raw ` +
                      `message=${(err?.message || String(err)).slice(0, 200)}`,
                  );
                  return replyText;
                }))
          : null;

        await sendDiscordReply(runtimeChannel, incoming, replyText);
        runtimeChannel.lastReplyAt = nowIso();
        runtimeChannel.lastReplyPreview = replyText;

        // Image attachments — mirror of the Telegram branch: for every image
        // kind on the assistant message, resolve URL → bytes and upload via
        // multipart. Discord renders image attachments inline; no caption
        // needed because the text reply already went out above. Per-
        // attachment errors are logged and swallowed so one bad URL doesn't
        // break the poll cycle.
        const imageAttachments = Array.isArray(result?.assistantMessage?.attachments)
          ? result.assistantMessage.attachments.filter(a => a && a.kind === 'image' && a.url)
          : [];
        for (const attachment of imageAttachments) {
          try {
            const bytes = await loadAttachmentBytes(attachment, { timeoutMs: 30_000 });
            if (!bytes) continue;
            writeDiscordDebugLine(
              `[dc-send] photo-begin agent=${agentId} chat_id=${incoming.chatId} ` +
                `bytes=${bytes.buffer?.length || 0} mime=${bytes.mimeType}`,
            );
            await sendDiscordMediaReply(runtimeChannel, incoming, bytes.buffer, {
              mimeType: bytes.mimeType,
              fileName: bytes.fileName,
            });
            writeDiscordDebugLine(
              `[dc-send] photo-ok agent=${agentId} chat_id=${incoming.chatId} ` +
                `bytes=${bytes.buffer?.length || 0}`,
            );
          } catch (imgErr) {
            process.stderr.write(`[dc-photo-reply] error: ${imgErr?.message || imgErr}\n`);
            writeDiscordDebugLine(
              `[dc-send] photo-error agent=${agentId} chat_id=${incoming.chatId} ` +
                `status=${imgErr?.status || '?'} ` +
                `url=${String(attachment.url).slice(0, 120)} ` +
                `message=${(imgErr?.message || String(imgErr)).slice(0, 200)} ` +
                `body=${(imgErr?.bodyPreview || '').slice(0, 200)}`,
            );
          }
        }

        if (shouldDiscordVoiceReply) {
          try {
            const voiceText = await discordVoiceRewritePromise;
            writeDiscordDebugLine(
              `[dc-voice] agent=${agentId} mode=${discordVoiceMode} ` +
                `trigger=${runtimeChannel.voiceReply ? 'channel-tick' : 'inbound-voice'} ` +
                `textLen=${String(voiceText || '').length} ` +
                `text="${String(voiceText || '').slice(0, 80)}"`,
            );
            // Same broken-relative-path fix as telegramPolling.js — tts.js
            // is at src/tts.js, not src/services/remote/tts.js. Without
            // this fix every Discord voice reply silently throws
            // ERR_MODULE_NOT_FOUND. (Codex audit 2026-04-29.)
            const { synthesizeSpeech } = await import('../../tts.js');
            const agentVoiceId = profile?.minimaxVoiceId || '';
            const agentEdgeVoice = profile?.edgeTtsVoice || '';
            const agentTtsConfig = { ...discordTtsConfig };
            if (agentVoiceId) agentTtsConfig.minimaxVoiceId = agentVoiceId;
            if (agentEdgeVoice) agentTtsConfig.ttsEdgeVoice = agentEdgeVoice;
            if (profile?.ttsSpeed != null) agentTtsConfig.ttsSpeed = profile.ttsSpeed;
            if (profile?.ttsPitch != null) agentTtsConfig.ttsPitch = profile.ttsPitch;
            if (profile?.ttsVol != null) agentTtsConfig.ttsVol = profile.ttsVol;
            // Surface which TTS backend will actually run — helps distinguish
            // "TTS not configured" from "TTS configured but upload failed".
            const ttsBackend = agentTtsConfig.ttsProvider || agentTtsConfig.ttsBackend || 'default';
            writeDiscordDebugLine(
              `[dc-voice] tts-start agent=${agentId} backend=${ttsBackend} ` +
                `minimaxVoiceId=${agentVoiceId ? 'set' : 'empty'} ` +
                `edgeVoice=${agentEdgeVoice ? 'set' : 'empty'}`,
            );
            const ttsResult = await synthesizeSpeech(voiceText, agentTtsConfig);
            if (ttsResult?.buffer) {
              writeDiscordDebugLine(
                `[dc-voice] tts-ok agent=${agentId} bytes=${ttsResult.buffer?.length || 0} ` +
                  `mime=${ttsResult.mimeType || 'audio/mpeg'}`,
              );
              try {
                await sendDiscordAudioReply(
                  runtimeChannel,
                  incoming,
                  ttsResult.buffer,
                  ttsResult.mimeType,
                );
                writeDiscordDebugLine(
                  `[dc-voice] sent agent=${agentId} bytes=${ttsResult.buffer?.length || 0} ` +
                    `chatId=${incoming.chatId}`,
                );
              } catch (sendErr) {
                // Distinguish upload failures from TTS failures. Include the
                // HTTP status (set by sendDiscordAudioReply) so the user can
                // see 403 vs 404 vs 50035 without hunting through logs.
                writeDiscordDebugLine(
                  `[dc-voice] send-failed agent=${agentId} ` +
                    `status=${sendErr?.status || '?'} ` +
                    `message=${(sendErr?.message || String(sendErr)).slice(0, 200)} ` +
                    `body=${(sendErr?.bodyPreview || '').slice(0, 200)}`,
                );
              }
            } else {
              writeDiscordDebugLine(
                `[dc-voice] tts-null agent=${agentId} — check TTS config ` +
                  `(backend=${ttsBackend}, textLen=${String(voiceText || '').length})`,
              );
            }
          } catch (voiceErr) {
            writeDiscordDebugLine(
              `[dc-voice] error agent=${agentId} message=${(voiceErr?.message || String(voiceErr)).slice(0, 200)}`,
            );
          }
        }
        } catch (perMessageError) {
          // Per-message isolation (2026-06-04 audit闭环): log + ack-and-continue.
          // Do NOT rethrow — the finally below advances the snowflake offset so
          // the batch keeps progressing and the failure isn't retried forever.
          encounteredError = true;
          runtimeChannel.lastStatus = 'error';
          runtimeChannel.lastError = perMessageError?.message || String(perMessageError);
          writeDiscordDebugLine(
            `[dc-poll] message-error agent=${agentId} message_id=${String(rawMessage?.id || '')} ` +
              `message=${(perMessageError?.message || String(perMessageError)).slice(0, 200)}`,
          );
        } finally {
          // Advance past THIS message no matter what — the single source of
          // offset progress now. `continue` inside the try runs this too, so
          // deliberately-skipped messages also advance (correctly acked).
          // Snowflakes are monotonic strings → only advance on a higher id.
          const thisId = String(rawMessage?.id || '');
          if (thisId && snowflakeGt(thisId, String(runtimeChannel.lastUpdateId || ''))) {
            runtimeChannel.lastUpdateId = thisId;
          }
        }
      }
    } catch (error) {
      // Fetch / setup-level error (before/around the loop): the per-message
      // loop's offset advancement didn't run for un-fetched messages, so
      // lastUpdateId stays put and they are re-fetched next cycle — correct.
      encounteredError = true;
      runtimeChannel.lastStatus = 'error';
      runtimeChannel.lastError = error.message || String(error);
      // Surface the underlying error so the user can tell "no reply" apart
      // from "invalid token / forbidden channel / network hiccup". Common
      // cases: 401 (bad token), 403 (bot not in guild / missing Read Message
      // History on this channel), 404 (wrong channelId — often a voice
      // channel ID instead of the text channel).
      writeDiscordDebugLine(
        `[dc-poll] error agent=${agentId} message=${(error?.message || String(error)).slice(0, 200)}`,
      );
    }

    await updateStateAtomically(latestState => {
      const latestProfile = normalizeAgentProfile(agentId, latestState.agentProfiles?.[agentId]);
      // Same story as the Telegram writeback above — don't let the poll
      // clobber a UI edit that raced with the cycle. Merge runtime-only
      // fields onto the latest persisted channel.
      const persistedDiscord =
        normalizeAgentChannels(latestProfile.channels)?.discord;
      const mergedDiscord = mergeChannelRuntimeFields(
        persistedDiscord,
        runtimeChannel,
      );
      latestState.agentProfiles = normalizeAgentProfiles({
        ...latestState.agentProfiles,
        [agentId]: {
          ...latestProfile,
          channels: {
            ...latestProfile.channels,
            discord: mergedDiscord,
          },
        },
      });
      return latestState;
    });
  }

  return {
    hasActiveChannel,
    processedUpdateCount,
    encounteredError,
  };
}

// Exported because desktopStore.js's __discordTesting bundle re-exports
// it for unit tests. Kept private to the cluster otherwise — only the
// processDiscordPollingCycle entry uses it directly.
export function snowflakeGt(a, b) {
  const sa = String(a || '');
  const sb = String(b || '');
  if (!sa) return false;
  if (!sb) return true;
  if (sa.length !== sb.length) return sa.length > sb.length;
  return sa > sb;
}
