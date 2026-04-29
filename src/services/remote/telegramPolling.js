// Telegram polling cluster — sub-phase 7d-5ζ commit 1 of the desktopStore
// decomposition. byte-for-byte port (CLAUDE.md §5).
//
// `processTelegramPollingCycle` is the long-poll loop the runtime drives
// every few seconds (per agent) to read incoming Telegram updates,
// dispatch routing/reply decisions, and persist the conversation state.
// All three private record/route helpers and the three module-private
// debug-log helpers ship together as a self-contained leaf — same
// packaging as the chat / approval / project clusters in 7d-5ε.
//
// Members:
//   • TELEGRAM_DEBUG_LOG_PATH / TELEGRAM_DEBUG_LOG_MAX_BYTES (consts)
//   • TELEGRAM_POLL_LIMIT (const)
//   • _telegramCycleCounter / telegramDebugLogDirReady (module state)
//   • nextTelegramCycleId / writeTelegramDebugLine (private helpers)
//   • renderTelegramTransportText (private helper)
//   • shouldReplyToTelegramMessage (private routing gate)
//   • ensureTelegramChatRecord / recordTelegramMessageWithoutReply
//   • processTelegramPollingCycle (the public entry server.js calls)
//
// Mechanical adaptation (CLAUDE.md §5 / §6): the desktopStore version
// computed `DESKTOP_DIR = join(getMeloHome(), 'desktop')` and
// `TELEGRAM_DEBUG_LOG_PATH = join(DESKTOP_DIR, 'telegram-debug.log')` at
// module load. The new module reproduces those same const expressions
// at its own module load — semantics are byte-identical for any
// single-process MELO_HOME (the typical case). Tests that flip
// MELO_HOME mid-process see the same behavior they already saw with
// desktopStore.

import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getMeloHome } from '../../config.js';
import { getResolvedConfig } from '../../config.js';
import { enrichMessageWithMediaContext } from '../../media/index.js';
import {
  mergeChannelRuntimeFields,
  normalizeAgentChannels,
} from '../agent/agentChannels.js';
import { allAgentIdsFromProfiles } from '../agent/agentLibrary.js';
import { generateChatTitle } from '../chat/providerErrors.js';
import { sendChatMessage } from '../chat/sendChatMessage.js';
import { rewriteForVoice } from '../media/voiceRewrite.js';
import {
  aggressivelyStripMarkdownForPlainText,
  normalizeMessageBlocks,
  serializeMessageBlocks,
  stripAllMarkdownForTelegram,
} from '../message/messageBlocks.js';
import { loadAttachmentBytes } from './attachmentBytes.js';
import { classifyGroupMessageAddressal } from './groupAddressalClassifier.js';
import { updateGroupRelationshipGraph } from './groupRelationship.js';
import {
  OFFLINE_BACKLOG_THRESHOLD_MS,
  isBacklogPollCycle,
  passesOfflineBacklogFilter,
} from './offlineBacklogFilter.js';
import {
  fetchTelegramUpdates as fetchTelegramUpdatesFromApi,
  pingTelegramChannel,
  sendTelegramAudioReply,
  sendTelegramPhotoReply,
  telegramApiRequest,
} from './telegramApi.js';
import {
  buildTelegramThreadKey,
  latestProcessableTelegramText,
} from './telegramParsing.js';
import {
  GRAY_ZONE_MIN,
  REPLY_SCORE_THRESHOLD,
  buildTelegramReplyScore,
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
import { refreshChatMemorySummary } from '../../state/chatThreadContext.js';
import {
  createChatRecord,
  summarizeMessagePreview,
} from '../../state/conversation.js';
import { normalizeChat } from '../../state/stateHydration.js';
import { ensureSelectedEntities } from '../../state/stateSelections.js';
import {
  loadState,
  saveState,
  updateStateAtomically,
} from '../../state/stateStore.js';

// Module-level constants and counter. DESKTOP_DIR is recomputed lazily
// inside writeTelegramDebugLine — the only function that needs it — so
// the module load doesn't freeze MELO_HOME. The path constants below
// resolve `getMeloHome()` once at module load (matching desktopStore's
// historical behavior); see the §6 carve-out note in the file header.
const DESKTOP_DIR = join(getMeloHome(), 'desktop');
const TELEGRAM_DEBUG_LOG_PATH = join(DESKTOP_DIR, 'telegram-debug.log');
const TELEGRAM_DEBUG_LOG_MAX_BYTES = 256 * 1024;
const TELEGRAM_POLL_LIMIT = 12;

let telegramDebugLogDirReady = false;
let _telegramCycleCounter = 0;

function nextTelegramCycleId() {
  _telegramCycleCounter = (_telegramCycleCounter + 1) % 1_000_000;
  return `${process.pid}-${_telegramCycleCounter}`;
}

function writeTelegramDebugLine(line) {
  try {
    if (!telegramDebugLogDirReady) {
      mkdirSync(DESKTOP_DIR, { recursive: true });
      telegramDebugLogDirReady = true;
    }
    try {
      const info = statSync(TELEGRAM_DEBUG_LOG_PATH);
      if (info.size > TELEGRAM_DEBUG_LOG_MAX_BYTES) {
        renameSync(TELEGRAM_DEBUG_LOG_PATH, `${TELEGRAM_DEBUG_LOG_PATH}.old`);
      }
    } catch {
      // File doesn't exist yet — first write will create it.
    }
    appendFileSync(TELEGRAM_DEBUG_LOG_PATH, `${nowIso()} ${line}\n`, 'utf8');
  } catch {
    // Never let logging errors break polling.
  }
}

// Exported because the Discord polling cluster (commit 2 of 7d-5ζ)
// reuses this same text-rendering pipeline; the comment in
// processDiscordPollingCycle says "mirrors the Telegram branch". Kept
// the original name byte-for-byte rather than renaming during port.
export function renderTelegramTransportText(message) {
  if (!message) {
    return '';
  }

  const serialized = serializeMessageBlocks(
    normalizeMessageBlocks(message?.blocks, message?.content || ''),
  );

  return stripAllMarkdownForTelegram(
    aggressivelyStripMarkdownForPlainText(serialized || message?.content || ''),
  );
}

async function shouldReplyToTelegramMessage(incoming, telegramChannel, profile, recentChat, config) {
  if (
    !incoming?.chatId ||
    (!String(incoming?.text || '').trim() && !normalizeMessageAttachments(incoming?.attachments).length)
  ) {
    return false;
  }

  if (incoming.chatType === 'private') {
    return true;
  }

  const { signals, totalScore } = buildTelegramReplyScore(
    incoming, telegramChannel, profile, recentChat,
  );

  let decision;
  let method = 'score';

  if (totalScore >= REPLY_SCORE_THRESHOLD) {
    decision = true;
  } else if (totalScore < GRAY_ZONE_MIN) {
    decision = false;
  } else {
    // Gray zone: call LLM classifier
    method = 'llm';
    decision = await classifyGroupMessageAddressal(incoming, recentChat, config, profile);
  }

  if (process.env.MELO_TG_DEBUG === '1') {
    process.stdout.write(
      `[tg-route] sender=${incoming?.senderName || 'unknown'} ` +
      `text="${String(incoming?.text || '').slice(0, 60)}" ` +
      `score=${totalScore.toFixed(2)} method=${method} reply=${decision} ` +
      `signals=${JSON.stringify(signals)}\n`,
    );
  }

  return decision;
}

async function ensureTelegramChatRecord(agentId, incoming) {
  const state = ensureSelectedEntities(await loadState());
  const externalThreadKey = buildTelegramThreadKey(
    agentId,
    incoming?.chatId,
    incoming?.messageThreadId,
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
    if (
      (incoming?.messageThreadId || null) !==
      (existingChat.messageThreadId || null)
    ) {
      existingChat.messageThreadId = incoming?.messageThreadId || null;
      needsSave = true;
    }
    if (needsSave) {
      existingChat.updatedAt = nowIso();
      await saveState(state);
    }
    return existingChat;
  }

  const chat = {
    ...createChatRecord({
      mode: 'chat',
      projectId: null,
    }),
    title: generateChatTitle(incoming?.text || ''),
    agentId: normalizeAgentStorageId(agentId),
    source: 'telegram',
    chatType: incoming?.chatType || 'private',
    chatTitle: incoming?.chatTitle || '',
    messageThreadId: incoming?.messageThreadId || null,
    externalThreadKey,
  };
  state.chats.unshift(chat);
  await saveState(state);
  return chat;
}

async function recordTelegramMessageWithoutReply(agentId, incoming, existingChat = null) {
  const [config, rawState] = await Promise.all([getResolvedConfig(), loadState()]);
  const state = ensureSelectedEntities(rawState);
  const chat = normalizeChat(existingChat || (await ensureTelegramChatRecord(agentId, incoming)));
  const currentChat = state.chats.find(entry => entry.id === chat.id);
  if (!currentChat) {
    return null;
  }

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
    // Tag as bystander so system prompt builder can inject group context
    meta: { bystanderMessage: true },
  };
  await enrichMessageWithMediaContext(userMessage, {
    config,
    modelSupportsVision: false,
  });
  currentChat.messages.push(userMessage);
  currentChat.updatedAt = nowIso();
  currentChat.chatType = incoming?.chatType || currentChat.chatType;
  currentChat.chatTitle = incoming?.chatTitle || currentChat.chatTitle;
  currentChat.messageThreadId = incoming?.messageThreadId || currentChat.messageThreadId || null;
  if (!currentChat.title || currentChat.title === 'New chat') {
    currentChat.title = generateChatTitle(incoming?.text || summarizeMessagePreview(userMessage));
  }

  // Update group relationship graph — this person is NOT addressing the bot
  updateGroupRelationshipGraph(currentChat, incoming, false);

  refreshChatMemorySummary(currentChat);
  await saveState(state);
  return currentChat;
}

export async function processTelegramPollingCycle() {
  const state = ensureSelectedEntities(await loadState());
  const agentIds = allAgentIdsFromProfiles(state.agentProfiles);
  let hasActiveChannel = false;
  let processedUpdateCount = 0;
  let encounteredError = false;
  const cycleId = nextTelegramCycleId();

  for (const agentId of agentIds) {
    const profile = normalizeAgentProfile(agentId, state.agentProfiles?.[agentId]);
    const telegramChannel = normalizeAgentChannels(profile.channels)?.telegram;
    if (!telegramChannel?.enabled || !telegramChannel.botToken) {
      continue;
    }
    hasActiveChannel = true;
    // Offline-backlog detection must run BEFORE we stamp a fresh lastPolledAt
    // onto runtimeChannel — otherwise the comparison would always be ~0ms.
    const isBacklogCycle = isBacklogPollCycle(telegramChannel);
    writeTelegramDebugLine(
      `[tg-cycle] start cycle=${cycleId} agent=${agentId} username=${telegramChannel.botUsername || ''} ` +
        `persistedLastUpdateId=${telegramChannel.lastUpdateId || 0} ` +
        `backlogCycle=${isBacklogCycle}`,
    );

    const runtimeChannel = {
      ...telegramChannel,
      lastCheckedAt: nowIso(),
      lastPolledAt: nowIso(),
    };

    // Ensure botUsername is populated (needed for @mention detection in groups)
    if (!runtimeChannel.botUsername) {
      try {
        const meResult = await pingTelegramChannel(telegramChannel);
        if (meResult?.result?.username) {
          runtimeChannel.botUsername = meResult.result.username.trim();
        }
      } catch {}
    }

    try {
      const updatePayload = await fetchTelegramUpdatesFromApi(telegramChannel, TELEGRAM_POLL_LIMIT);
      const updates = Array.isArray(updatePayload?.result) ? updatePayload.result : [];
      writeTelegramDebugLine(
        `[tg-cycle] fetched cycle=${cycleId} agent=${agentId} count=${updates.length} ` +
          `update_ids=${updates.map(u => u?.update_id).join(',')}`,
      );
      runtimeChannel.lastStatus = 'connected';
      runtimeChannel.lastError = '';
      if (updates.length) {
        runtimeChannel.lastUpdateId = Math.max(
          Number(runtimeChannel.lastUpdateId || 0),
          ...updates.map(update => Number(update?.update_id || 0)),
        );
      }
      processedUpdateCount += updates.length;

      for (const update of updates) {
        const incoming = await latestProcessableTelegramText(update, telegramChannel);
        if (
          !incoming?.chatId ||
          (!String(incoming?.text || '').trim() &&
            !normalizeMessageAttachments(incoming?.attachments).length)
        ) {
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
        const recentChat = await ensureTelegramChatRecord(agentId, incoming);

        // Offline backlog filter — see OFFLINE_BACKLOG_THRESHOLD_MS doc. Only
        // runs when the runtime was offline long enough that the fetched
        // updates look like a catch-up sweep rather than live traffic.
        if (isBacklogCycle) {
          const tgBotUsernameLower = String(telegramChannel?.botUsername || '')
            .trim().replace(/^@+/, '').toLowerCase();
          const passes = passesOfflineBacklogFilter({
            incoming,
            recentChat,
            mentionPredicate: msg => {
              if (!tgBotUsernameLower) return false;
              return String(msg?.text || '')
                .toLowerCase()
                .includes(`@${tgBotUsernameLower}`);
            },
          });
          if (!passes) {
            writeTelegramDebugLine(
              `[tg-cycle] backlog-skip cycle=${cycleId} agent=${agentId} ` +
                `update_id=${update?.update_id} chat_id=${incoming.chatId} ` +
                `sender=${incoming.senderName || 'unknown'} ` +
                `reason=no-mention-no-reply-no-recent-bot-context`,
            );
            await recordTelegramMessageWithoutReply(agentId, incoming, recentChat);
            continue;
          }
        }

        // shouldReplyToTelegramMessage is now async (may call LLM gray-zone classifier)
        const config = await getResolvedConfig();
        const shouldReply = await shouldReplyToTelegramMessage(
          incoming,
          telegramChannel,
          profile,
          recentChat,
          config,
        );

        if (!shouldReply) {
          await recordTelegramMessageWithoutReply(agentId, incoming, recentChat);
          continue;
        }

        await telegramApiRequest(telegramChannel, 'sendChatAction', {
          body: {
            chat_id: incoming.chatId,
            action: 'typing',
          },
          timeoutMs: 10000,
        }).catch(() => null);

        const result = await sendChatMessage({
          chatId: recentChat.id,
          content: incoming.text,
          mode: recentChat.mode,
          attachments: incoming.attachments || [],
          background: true,
          skipBootstrap: true,
          channelContext: {
            channelId: 'telegram',
            remoteChatId: incoming.chatId,
            chatType: incoming.chatType,
            senderId: incoming.senderId,
            senderName: incoming.senderName,
            senderUsername: incoming.senderUsername,
            isReplyToBot: incoming.isReplyToBot,
            repliedToText: incoming.repliedToText,
          },
        });

        // Update group relationship graph — this person WAS addressing the bot
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

        // Determine voice reply eligibility early so we can start rewrite in parallel
        const ttsConfig = await getResolvedConfig();
        const agentVoiceMode = profile?.voiceReplyMode || 'summary';
        const shouldVoiceReply =
          agentVoiceMode !== 'off' && (telegramChannel.voiceReply || incoming.wasVoiceMessage);

        // Fire off voice rewrite in parallel — it runs while the text reply is being sent.
        // 'summary' mode: concise oral summary; 'full' mode: read original text as-is.
        const voiceRewritePromise = shouldVoiceReply
          ? (agentVoiceMode === 'full'
              ? Promise.resolve(replyText)
              : rewriteForVoice(replyText, ttsConfig, profile?.voicePersonality || '', incoming?.senderName || '').catch(() => replyText))
          : null;

        writeTelegramDebugLine(
          `[tg-send] text-begin cycle=${cycleId} agent=${agentId} update_id=${update?.update_id} ` +
            `chat_id=${incoming.chatId} reply_to=${incoming.messageId || ''} len=${replyText.length}`,
        );
        let sentText = null;
        try {
          sentText = await telegramApiRequest(telegramChannel, 'sendMessage', {
            body: {
              chat_id: incoming.chatId,
              text: replyText,
              message_thread_id: incoming.messageThreadId || undefined,
              reply_to_message_id: incoming.messageId || undefined,
            },
          });
          writeTelegramDebugLine(
            `[tg-send] text-ok cycle=${cycleId} agent=${agentId} update_id=${update?.update_id} ` +
              `chat_id=${incoming.chatId} out_message_id=${sentText?.result?.message_id || ''}`,
          );
        } catch (sendErr) {
          writeTelegramDebugLine(
            `[tg-send] text-error cycle=${cycleId} agent=${agentId} update_id=${update?.update_id} ` +
              `message=${String(sendErr?.message || sendErr).slice(0, 180)}`,
          );
          throw sendErr;
        }
        runtimeChannel.lastReplyAt = nowIso();
        runtimeChannel.lastReplyPreview = replyText;

        // Image attachments: forward any image the assistant embedded in its
        // reply (e.g. from the image-generation tool). We already sent the
        // text portion above; the photos arrive as separate sendPhoto calls
        // so we don't hit Telegram's 1024-char caption limit.
        //
        // Each attachment is loaded via attachmentBytes.js — that module takes
        // the fast path (signed workspace URL → local readFile) when the URL
        // was minted by this same process, or falls back to HTTP fetch. We
        // swallow per-attachment errors so a single bad URL doesn't bork the
        // whole poll cycle.
        const imageAttachments = Array.isArray(result?.assistantMessage?.attachments)
          ? result.assistantMessage.attachments.filter(a => a && a.kind === 'image' && a.url)
          : [];
        for (const attachment of imageAttachments) {
          try {
            const bytes = await loadAttachmentBytes(attachment, { timeoutMs: 30_000 });
            if (!bytes) continue;
            writeTelegramDebugLine(
              `[tg-send] photo-begin cycle=${cycleId} agent=${agentId} update_id=${update?.update_id} ` +
                `chat_id=${incoming.chatId} bytes=${bytes.buffer?.length || 0} mime=${bytes.mimeType}`,
            );
            const sentPhoto = await sendTelegramPhotoReply(telegramChannel, incoming, bytes.buffer, {
              mimeType: bytes.mimeType,
              fileName: bytes.fileName,
            });
            writeTelegramDebugLine(
              `[tg-send] photo-ok cycle=${cycleId} agent=${agentId} update_id=${update?.update_id} ` +
                `chat_id=${incoming.chatId} out_message_id=${sentPhoto?.result?.message_id || ''}`,
            );
          } catch (imgErr) {
            process.stderr.write(`[tg-photo-reply] error: ${imgErr?.message || imgErr}\n`);
            writeTelegramDebugLine(
              `[tg-send] photo-error cycle=${cycleId} agent=${agentId} update_id=${update?.update_id} ` +
                `url=${String(attachment.url).slice(0, 120)} message=${String(imgErr?.message || imgErr).slice(0, 180)}`,
            );
          }
        }

        // Voice reply: synthesize TTS with the rewritten spoken-form text.
        if (shouldVoiceReply) {
          try {
            const voiceText = await voiceRewritePromise;
            process.stderr.write(`[tg-voice] voiceText="${String(voiceText||'').slice(0,120)}"\n`);
            // `tts.js` lives at src/tts.js, not under src/services/remote/.
            // The previous './tts.js' relative import resolved to a file
            // that doesn't exist; voice replies silently failed with
            // ERR_MODULE_NOT_FOUND for every Telegram message that hit
            // this path. discordVoiceSession.js uses '../../tts.js'
            // correctly — match that. (Codex audit 2026-04-29.)
            const { synthesizeSpeech } = await import('../../tts.js');
            const agentVoiceId = profile?.minimaxVoiceId || '';
            const agentEdgeVoice = profile?.edgeTtsVoice || '';
            const agentTtsConfig = { ...ttsConfig };
            if (agentVoiceId) agentTtsConfig.minimaxVoiceId = agentVoiceId;
            if (agentEdgeVoice) agentTtsConfig.ttsEdgeVoice = agentEdgeVoice;
            if (profile?.ttsSpeed != null) agentTtsConfig.ttsSpeed = profile.ttsSpeed;
            if (profile?.ttsPitch != null) agentTtsConfig.ttsPitch = profile.ttsPitch;
            if (profile?.ttsVol != null) agentTtsConfig.ttsVol = profile.ttsVol;
            const ttsResult = await synthesizeSpeech(
              voiceText,
              agentTtsConfig,
            );
            if (ttsResult?.buffer) {
              writeTelegramDebugLine(
                `[tg-send] voice-begin cycle=${cycleId} agent=${agentId} update_id=${update?.update_id} ` +
                  `chat_id=${incoming.chatId} voice_text_len=${String(voiceText || '').length}`,
              );
              const sentVoice = await sendTelegramAudioReply(telegramChannel, incoming, ttsResult.buffer, ttsResult.mimeType);
              writeTelegramDebugLine(
                `[tg-send] voice-ok cycle=${cycleId} agent=${agentId} update_id=${update?.update_id} ` +
                  `chat_id=${incoming.chatId} out_message_id=${sentVoice?.result?.message_id || ''}`,
              );
            } else {
              process.stderr.write('[tg-voice-reply] TTS synthesis returned null — check TTS config\n');
              writeTelegramDebugLine(
                `[tg-send] voice-skip-null cycle=${cycleId} agent=${agentId} update_id=${update?.update_id}`,
              );
            }
          } catch (e) {
            process.stderr.write(`[tg-voice-reply] error: ${e?.message || e}\n`);
            writeTelegramDebugLine(
              `[tg-send] voice-error cycle=${cycleId} agent=${agentId} update_id=${update?.update_id} ` +
                `message=${String(e?.message || e).slice(0, 180)}`,
            );
          }
        }
      }
    } catch (error) {
      encounteredError = true;
      runtimeChannel.lastStatus = 'error';
      runtimeChannel.lastError = error.message || String(error);
    }

    await updateStateAtomically(latestState => {
      const latestProfile = normalizeAgentProfile(agentId, latestState.agentProfiles?.[agentId]);
      // Preserve whatever the UI may have written into this channel while
      // the poll cycle was in flight (token / guildId / voiceReply edits).
      // Only the runtime fields (lastStatus, lastUpdateId, lastIncoming*,
      // lastReply*) may ride on top of the persisted channel. See
      // feedback_preserve_user_config.md + regression tests in
      // desktopStore.updateAgentProfile.test.js.
      const persistedTelegram =
        normalizeAgentChannels(latestProfile.channels)?.telegram;
      const mergedTelegram = mergeChannelRuntimeFields(
        persistedTelegram,
        runtimeChannel,
      );
      latestState.agentProfiles = normalizeAgentProfiles({
        ...latestState.agentProfiles,
        [agentId]: {
          ...latestProfile,
          channels: {
            ...latestProfile.channels,
            telegram: mergedTelegram,
          },
        },
      });
      return latestState;
    });
    writeTelegramDebugLine(
      `[tg-cycle] end cycle=${cycleId} agent=${agentId} newLastUpdateId=${runtimeChannel.lastUpdateId || 0} ` +
        `error=${Boolean(encounteredError)}`,
    );
  }

  return {
    hasActiveChannel,
    processedUpdateCount,
    encounteredError,
  };
}
