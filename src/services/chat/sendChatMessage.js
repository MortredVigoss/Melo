// sendChatMessage entry — sub-phase 7d-5δ commit 8f of the desktopStore
// decomposition. byte-for-byte port (CLAUDE.md §5).
//
// `sendChatMessage` is the chat panel's main HTTP entry: it loads state,
// composes the user-message record, persists it, drives the chat
// execution graph, persists the assistant reply, and kicks off three
// fire-and-forget post-reply tasks (memory extraction + skill proposal
// scan + plugin hook). Used by `/api/chat/send(/stream)` in server.js
// (and a couple of internal call sites in desktopStore that proxy
// through it for approval-execution paths).
//
// Members shipped together:
//   • extractUrlAttachmentsFromText (3 lines, sendChatMessage-private)
//   • isAbortError (7 lines, sendChatMessage-private)
//   • sendChatMessage (the export)
//
// All other LOCAL deps from the original desktopStore form were
// extracted to leaf modules in earlier 7d-5δ commits (8a–8e). Nothing
// here imports back from desktopStore.js, so the runner / bootstrap
// extractions stay free of cycles.

import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getResolvedConfig } from '../../config.js';
import {
  loadState,
  updateStateAtomically,
} from '../../state/stateStore.js';
import { ensureSelectedEntities } from '../../state/stateSelections.js';
import { findProjectById } from '../../state/stateLookups.js';
import { effectiveAgentProfile } from '../../state/agentProfiles.js';
import { refreshChatMemorySummary } from '../../state/chatThreadContext.js';
import { getDesktopBootstrap } from '../../state/desktopBootstrap.js';
import { scanRecentChatsForSkillProposals } from '../../state/skillProposalScan.js';
import { allAgentIdsFromProfiles } from '../agent/agentLibrary.js';
import { buildWorkspaceSnapshot } from '../workspace/workspaceSnapshot.js';
import { buildConnectors } from '../connector/connectorRollup.js';
import {
  COMMAND_TEMPLATES,
  commandTemplateDescriptor,
} from '../command/commandTemplates.js';
import { buildSkills } from '../skill/skillService.js';
import { runChatAgentExecutionGraph } from './chatExecutionRunner.js';
import {
  generateChatTitle,
  formatProviderFailureMessage,
} from './providerErrors.js';
import {
  normalizeAssistantReplyForConversation,
  normalizeMessageBlocks,
} from '../message/messageBlocks.js';
import { extractArtifacts } from '../artifact/artifactService.js';
import { summarizeMessagePreview } from '../../state/conversation.js';
import { normalizePromptHistory } from '../activity/activityLog.js';
import { promoteTextUrlsToAttachments } from '../../media/urlDetector.js';
import { modelSupportsVision } from '../../media/visionCapability.js';
import { enrichMessageWithMediaContext } from '../../media/index.js';
import { indexMessage } from '../../memory/conversationIndex.js';
import { maybeExtractSessionMemory } from '../../memory/sessionMemory.js';
import {
  promoteAndPersistFacts,
  scheduleEmbeddingFillIn,
} from '../../memory/memoryPromotion.js';
import { emitHook } from '../../plugins/hooks.js';
import {
  nowIso,
  normalizeMessageAttachments,
} from '../../shared/helpers.js';

// APP_ROOT — original desktopStore.js: `dirname(dirname(fileURLToPath(import.meta.url)))`.
// This module sits two levels deeper at `src/services/chat/`, so the formula
// needs two extra `dirname()` calls to resolve to the same project-root
// directory. Used by the remote-background workspace fallback below (the
// `if (shouldUseBackgroundWorkspace)` branch synthesizes an empty workspace
// rooted at APP_ROOT). Same precedent as workspaceSnapshot.js / connectorRollup.js.
const APP_ROOT = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));

function extractUrlAttachmentsFromText(content = '') {
  return normalizeMessageAttachments(promoteTextUrlsToAttachments(content, []));
}

function isAbortError(error) {
  return Boolean(
    error &&
      typeof error === 'object' &&
      (error.name === 'AbortError' || error.code === 'ABORT_ERR'),
  );
}

export async function sendChatMessage({
  chatId,
  content,
  mode,
  attachments = [],
  extractedMedia = [],
  signal,
  onDelta,
  onReasoningDelta,
  sseEmitter,
  agentId = null,
  background = false,
  skipBootstrap = false,
  channelContext = null,
  providerProfile = 'default',
  // Demon viz mode flag — piped from the desktop composer's `uiState.demonMode`
  // toggle via `/api/chat/send(/stream)`. Remote channels (background === true
  // with channelContext) always ignore this flag downstream.
  demonMode = false,
}) {
  const [config, rawState] = await Promise.all([getResolvedConfig(), loadState()]);
  const state = ensureSelectedEntities(rawState);
  const chat = state.chats.find(entry => entry.id === chatId);

  if (!chat) {
    throw new Error('Chat not found.');
  }

  const trimmed = content?.trim();
  const textDerivedAttachments = trimmed
    ? promoteTextUrlsToAttachments(trimmed, attachments)
    : [];
  const normalizedAttachments = normalizeMessageAttachments([
    ...(attachments || []),
    ...textDerivedAttachments,
  ]);
  if (!trimmed && !normalizedAttachments.length) {
    throw new Error('Message cannot be empty.');
  }

  const effectiveAgentId = allAgentIdsFromProfiles(state.agentProfiles).includes(agentId)
    ? agentId
    : chat.agentId || 'main';
  const activeProject = chat.projectId
    ? findProjectById(state, chat.projectId)
    : background
      ? null
      : findProjectById(state, state.settings.selectedProjectId);
  const shouldUseBackgroundWorkspace = background && Boolean(channelContext?.channelId);
  const workspace = shouldUseBackgroundWorkspace
    ? {
        rootPath: APP_ROOT,
        exists: false,
        entries: [],
        filePaths: [],
        fileCount: 0,
        selectedFilePath: null,
        selectedFile: null,
        commandTemplates: COMMAND_TEMPLATES.map(commandTemplateDescriptor),
        commandRuns: [],
      }
    : await buildWorkspaceSnapshot(state, activeProject);
  const activeAgentProfile = effectiveAgentProfile(
    state,
    effectiveAgentId,
    activeProject?.id || null,
  );
  const connectors = buildConnectors(state.settings.enabledConnectorIds, config, workspace, state, activeProject);
  const skills = buildSkills(state.settings.enabledSkillIds, state.settings.customSkills);

  chat.mode = mode || chat.mode || state.settings.activeMode;
  chat.agentId = effectiveAgentId;
  const userMessage = {
    id: randomUUID(),
    role: 'user',
    content: trimmed || '',
    blocks: normalizeMessageBlocks([], trimmed || ''),
    attachments: normalizedAttachments,
    // Pre-populate extractedMedia (e.g. from on-device speech recognition) to skip
    // Whisper transcription. enrichMessageWithMediaContext short-circuits when it
    // finds an already-populated extractedMedia array.
    extractedMedia: Array.isArray(extractedMedia) && extractedMedia.length ? extractedMedia : [],
    createdAt: nowIso(),
    senderId: channelContext?.senderId || null,
    senderName: channelContext?.senderName || null,
    senderUsername: channelContext?.senderUsername || null,
  };
  chat.messages.push(userMessage);
  chat.updatedAt = nowIso();
  await enrichMessageWithMediaContext(userMessage, {
    config,
    modelSupportsVision: modelSupportsVision(
      process.env.MELO_MODEL ||
      activeAgentProfile?.model ||
      config.model,
    ),
  });
  refreshChatMemorySummary(chat);
  if (trimmed && !background) {
    state.settings.promptHistory = normalizePromptHistory([
      {
        id: randomUUID(),
        content: trimmed,
        createdAt: userMessage.createdAt,
        chatId: chat.id,
        messageId: userMessage.id,
      },
      ...(state.settings.promptHistory || []),
    ]);
  }
  if (!chat.title || chat.title === 'New chat') {
    chat.title = generateChatTitle(trimmed || summarizeMessagePreview(userMessage));
  }
  if (!background) {
    state.settings.selectedChatId = chat.id;
    state.settings.activeMode = chat.mode;
    state.settings.activeView = 'chat';
  }
  // Persist the user-message append through updateStateAtomically so we
  // merge against the freshest state rather than clobbering whatever
  // other calls wrote between our loadState at the top of this function
  // and now. Mirrors the assistant-reply persistence below.
  await updateStateAtomically(s => {
    const latestState = ensureSelectedEntities(s);
    const latestChat = latestState.chats.find(entry => entry.id === chat.id);
    if (latestChat) {
      latestChat.messages = chat.messages;
      latestChat.updatedAt = chat.updatedAt;
      latestChat.title = chat.title;
      latestChat.agentId = chat.agentId;
      latestChat.mode = chat.mode;
      latestChat.memorySummary = chat.memorySummary;
    }
    if (trimmed && !background) {
      latestState.settings.promptHistory = state.settings.promptHistory;
    }
    if (!background) {
      latestState.settings.selectedChatId = chat.id;
      latestState.settings.activeMode = chat.mode;
      latestState.settings.activeView = 'chat';
    }
    return latestState;
  });

  // Plugin hook: chat:message:before
  await emitHook('chat:message:before', { chat, message: userMessage, config });

  let normalizedReply;
  try {
    const graphResult = await runChatAgentExecutionGraph({
      config,
      state,
      chat,
      workspace,
      connectors,
      skills,
      latestUserMessage: trimmed,
      agentId: effectiveAgentId,
      background,
      channelContext,
      signal,
      onDelta,
      onReasoningDelta,
      sseEmitter,
      providerProfile,
      demonMode,
    });
    normalizedReply = graphResult.normalizedReply;
    // Capture CORRECTED verdicts so they can be written into the assistant
    // message and later re-indexed as verification-correction memory entries.
    if (graphResult.verificationRecord) {
      state._pendingVerificationRecord = graphResult.verificationRecord;
    }
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) {
      throw error;
    }
    const normalizedFailureReply = normalizeAssistantReplyForConversation(
      formatProviderFailureMessage(error),
      {
        channelKind: background && channelContext?.channelId ? 'remote' : 'desktop',
      },
    );
    const assistantMessage = {
      id: randomUUID(),
      role: 'assistant',
      content: normalizedFailureReply.content,
      blocks: normalizedFailureReply.blocks,
      attachments: [],
      createdAt: nowIso(),
    };
    // Persist the failure reply inside the atomic queue so concurrent
    // writes (other chats, poller, UI edits) can't undo the append. We
    // re-find the chat inside the mutator to avoid writing based on a
    // snapshot that's already stale by the time the queue gets to us.
    let latestChat = null;
    await updateStateAtomically(s => {
      const latestState = ensureSelectedEntities(s);
      latestChat = latestState.chats.find(entry => entry.id === chat.id);
      if (!latestChat) {
        throw new Error('Chat not found after provider failure.');
      }
      latestChat.messages.push(assistantMessage);
      latestChat.updatedAt = nowIso();
      refreshChatMemorySummary(latestChat);
      if (activeProject?.id) {
        const latestProject = latestState.projects.find(project => project.id === activeProject.id);
        if (latestProject) {
          latestProject.updatedAt = nowIso();
        }
      }
      if (!background) {
        latestState.settings.selectedChatId = chat.id;
        latestState.settings.activeMode = chat.mode;
        latestState.settings.activeView = 'chat';
      }
      return latestState;
    });

    // Index new messages (fire and forget)
    try {
      indexMessage(latestChat.id, latestChat.title, userMessage);
      indexMessage(latestChat.id, latestChat.title, assistantMessage);
    } catch {}

    return {
      bootstrap: skipBootstrap ? null : await getDesktopBootstrap(),
      assistantMessage,
    };
  }

  const assistantMessage = {
    id: randomUUID(),
    role: 'assistant',
    content: normalizedReply.content,
    blocks: normalizedReply.blocks,
    attachments: extractUrlAttachmentsFromText(normalizedReply.content),
    createdAt: nowIso(),
    // Demon viz-spec — parsed earlier by extractVizSpec in the graph's
    // terminal node. `null` means no visualization was emitted (either the
    // toggle was off, the channel is remote, or the model chose not to
    // emit one for this answer). The desktop renderer keys off this field.
    ...(normalizedReply.viz ? { viz: normalizedReply.viz } : {}),
    // NotebookLM-style source citations. Each entry has { id, src,
    // startLine, endLine, quote } and correlates with a `<cite data-cite-id>`
    // tag embedded in the message text, which the desktop UI turns into an
    // inline pill that opens a side viewer at the cited file span.
    ...(Array.isArray(normalizedReply.citations) && normalizedReply.citations.length
      ? { citations: normalizedReply.citations }
      : {}),
    ...(state._pendingVerificationRecord
      ? { metadata: { verificationRecord: state._pendingVerificationRecord } }
      : {}),
  };
  delete state._pendingVerificationRecord;
  // Persist the assistant reply inside the atomic queue so we always merge
  // against the freshest chat (no lost updates from concurrent message
  // writes or artifact pushes). `latestChat` captures the in-queue chat
  // reference so the post-save indexing below sees the same record we
  // just wrote.
  let latestChat = null;
  await updateStateAtomically(s => {
    const latestState = ensureSelectedEntities(s);
    latestChat = latestState.chats.find(entry => entry.id === chat.id);
    if (!latestChat) {
      throw new Error('Chat not found before persisting assistant reply.');
    }
    latestChat.messages.push(assistantMessage);
    latestChat.updatedAt = nowIso();
    refreshChatMemorySummary(latestChat);

    const artifacts = extractArtifacts(normalizedReply.content, latestChat);
    if (artifacts.length) {
      latestState.artifacts.unshift(...artifacts);
    }

    if (activeProject?.id) {
      const latestProject = latestState.projects.find(project => project.id === activeProject.id);
      if (latestProject) {
        latestProject.updatedAt = nowIso();
      }
    }

    if (!background) {
      latestState.settings.selectedChatId = chat.id;
      latestState.settings.activeMode = chat.mode;
      latestState.settings.activeView = 'chat';
    }
    return latestState;
  });

  // Conversation history indexing (fire and forget — never blocks the response)
  try {
    indexMessage(latestChat.id, latestChat.title, userMessage);
    indexMessage(latestChat.id, latestChat.title, assistantMessage);
  } catch {}

  // Session memory extraction (async, non-blocking — fire and forget).
  // Runs after saveState so it doesn't slow down the response. Previously
  // gated on !background, which meant remote channels (Telegram/Discord)
  // never built up a sessionMemory layer — long-running bots had to rely
  // purely on vector recall. Now runs for every channel; the extraction
  // itself is a best-effort LLM call that never throws to the caller.
  maybeExtractSessionMemory(latestChat, { config }).then(async extracted => {
    if (extracted) {
      // Persist the updated session memory through updateStateAtomically so
      // we don't race with concurrent writes from the chat flow (new
      // messages, artifacts, etc.). The previous load-modify-save cycle
      // was detached from the write queue and could roll back a newer
      // message append. We copy only the three memory fields onto the
      // latest persisted chat rather than overwriting the chat wholesale.
      await updateStateAtomically(s => {
        const c = s.chats?.find(ch => ch.id === latestChat.id);
        if (c) {
          c.sessionMemory = latestChat.sessionMemory;
          c.memoryLastExtractedAt = latestChat.memoryLastExtractedAt;
          c.memoryLastExtractedAtCount = latestChat.memoryLastExtractedAtCount;
        }
        return s;
      }).catch(() => {});

      // Promote new session facts to cross-session long-term memory
      const agentId = latestChat.agentId || 'main';
      promoteAndPersistFacts(latestChat, agentId, config).catch(() => {});

      // Background: fill in any missing embeddings
      scheduleEmbeddingFillIn(config).catch(() => {});
    }
  }).catch(() => {});

  // Phase 3.4.1 — opportunistic skill-proposal scan. Fire-and-forget so it
  // never blocks the response; dedupes naturally via the store's seedId
  // check, so repeated turns in the same chat don't spam proposals.
  if (!background) {
    scanRecentChatsForSkillProposals().catch(() => {});
  }

  // Plugin hook: chat:message:after
  await emitHook('chat:message:after', {
    chat: latestChat,
    userMessage,
    assistantMessage,
    config,
  });

  return {
    bootstrap: skipBootstrap ? null : await getDesktopBootstrap(),
    assistantMessage,
  };
}
