import { completionResult } from '../../../shared/agent/completion.js';
import { usedSupplements } from './supplements.js';
import { hasPerformanceTrace, withPerformanceTrace } from '../../runtime/performanceTrace.js';
import { conversationConfig, selectedMaterials } from './conversationSelection.js';
import { visionConnection } from '../../images/imageSettings.js';
import { createExecutionRecorder } from './executionScenes.js';
import { chatWorkspacePath } from '../workspace/toolWorkspace.js';
import { persistSessionMemorySnapshot } from './derivedState.js';
import { createRequestContext, requestIdentity } from '../../runtime/requestContext.js';
import { runWithRequestContext } from '../../runtime/requestScope.js';
import { validateChatRequest } from './requestContract.js';
import { beginChatRun, completeChatRun, interruptChatRun } from './turnLedger.js';
import { recordFailure } from '../../runtime/failureCounters.js';
import { precompactIfNeeded } from './compactScheduler.js';
import { imageFollowUpAttachments, restoreImageRetry, persistResolvedImageTask, persistImageProgress, finishPartialImageReply } from './imageTurnState.js';
import { persistToolTrace, readToolTraceText, buildToolTraceMessage } from './toolTraceReplay.js';
import { withElevationSurface } from '../../domain/agent/capabilityScope.js';
import { releaseRunGrants } from '../agent/capabilityElevation.js';
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
import { scheduleChatTurn } from './turnScheduler.js';
import { schedulePostTurnTask } from '../../runtime/postTurnTasks.js';
import { join } from 'node:path';
import { getMeloHome, getResolvedConfig } from '../../config.js';
import {
  loadState,
  updateStateAtomically,
} from '../../state/stateStore.js';
import { ensureSelectedEntities } from '../../state/stateSelections.js';
import { findProjectById } from '../../state/stateLookups.js';
import { effectiveAgentProfile } from '../../state/agentProfiles.js';
import { refreshChatMemorySummary } from '../../memory/chatThreadContext.js';
import { getDesktopBootstrap } from '../desktop/bootstrap.js';
import { scanRecentChatsForSkillProposals } from '../skill/proposalScan.js';
import { allAgentIdsFromProfiles } from '../../domain/agent/agentLibrary.js';
import { buildWorkspaceSnapshot } from '../workspace/workspaceSnapshot.js';
import { buildConnectors } from '../connector/connectorRollup.js';
import {
  COMMAND_TEMPLATES,
  commandTemplateDescriptor,
} from '../command/commandTemplates.js';
import { buildSkills } from '../../domain/skill/skillService.js';
import { runChatAgentExecutionGraph } from './chatExecutionRunner.js';
import {
  generateChatTitle,
  formatProviderFailureMessage,
} from './providerErrors.js';
import {
  normalizeAssistantReplyForConversation,
  normalizeMessageBlocks,
} from '../../domain/message/messageBlocks.js';
import { extractArtifacts } from '../../domain/artifact/artifactService.js';
import { summarizeMessagePreview } from '../../state/conversation.js';
import { normalizePromptHistory } from '../../domain/activity/activityLog.js';
import { promoteTextUrlsToAttachments } from '../../media/urlDetector.js';
import { getRequestNetworkPolicy, requestUrls } from '../../retrieval/requestPolicy.js';
import { modelSupportsVision } from '../../media/visionCapability.js';
import { enrichMessageWithMediaContext } from '../../media/index.js';
import { externalizeMessageAttachments, hydrateAttachments, migrateInlineAttachments, applyAttachmentMigration } from '../../media/attachments.js';
import { indexMessage, tagChatScope } from '../../memory/conversationIndex.js';
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

export function sendChatMessage(options) {
  validateChatRequest(options);
  const context = options.context || createRequestContext({
    requestId: options.requestId || randomUUID(), chatId: options.chatId, signal: options.signal,
  });
  if (!hasPerformanceTrace()) return withPerformanceTrace({
    logPath: context.env.MELO_PERF_LOG === '1' ? join(context.home, 'desktop/logs/performance.jsonl') : null,
    onTiming: row => options.sseEmitter?.('execution_event', { ...requestIdentity(context),
      kind: 'performance', id: `timing:${row.stage}`, name: row.stage, status: row.status,
      metadata: { performance: row }, output: `${row.durationMs} ms` }),
  }, () => sendChatMessage({ ...options, context }));
  return runWithRequestContext(context, () => {
    const configPromise = getResolvedConfig();
    configPromise.catch(() => {});
    return scheduleChatTurn(context, async () => {
      const { record, replay, turnBinding } = await beginChatRun(options, context);
      if (replay) return {
        bootstrap: options.skipBootstrap ? null : await getDesktopBootstrap(),
        assistantMessage: replay, requestId: record.requestId, runId: record.runId, replayed: true,
      };
      const identity = requestIdentity(context);
      const emit = (event, data) => options.sseEmitter?.(event, { ...identity, ...data });
      const executionRecorder = createExecutionRecorder({ ...context,
        workspacePath: turnBinding.workspace?.workspacePath || chatWorkspacePath(context.home, context.chatId),
      }, options.content, emit);
      try {
        // Capability elevation (2026-10-20): only a live desktop stream can show
        // a capability prompt; remote channels, tasks and the JSON route deny as before.
        const capabilityScope=withElevationSurface(turnBinding.capabilityScope, typeof options.sseEmitter === 'function' && !options.background);
        const turnContext=Object.freeze({ ...context, turnBinding:Object.freeze({ ...turnBinding, capabilityScope }), capabilityScope });
        const result = await runWithRequestContext(turnContext,()=>executeChatTurn({ ...options, home: context.home, context: turnContext, configPromise, executionRecorder,
          sseEmitter: (event, data) => {
            if (event === 'tool_record') { executionRecorder.recordTool(data.record); return; }
            if (event === 'execution_event') executionRecorder.event(data);
            emit(event, data);
          },
        }));
        return { ...result, requestId: context.requestId, runId: context.runId };
      } catch (error) {
        const status = context.signal?.aborted ? 'cancelled' : 'failed';
        const partialReply = await finishPartialImageReply(context, status);
        // Design audit D2: the tools this turn already ran are replayed to the
        // next turn as a short text trace (appended to the partial reply when
        // one exists, otherwise a `tool-trace` assistant message). Best
        // effort — the turn's own error is what the caller must see.
        await persistToolTrace(context, { status }).catch(traceError => recordFailure('chat:tool-trace', traceError));
        // If marking the run interrupted fails, the chat stays `running` and
        // rejects retries/deletion until restart (audit A-10): retry once,
        // then count and log it so diagnostics can show the stuck ledger.
        await interruptChatRun(context, error).catch(async firstError => {
          try { await interruptChatRun(context, error); }
          catch (secondError) { recordFailure('chat:interrupt-run', secondError || firstError); }
        });
        const completion = completionResult({ goal: options.content, reply: partialReply?.content || '', terminalReason: status === 'cancelled' ? 'CANCELLED' : error?.code === 'CONTEXT_BUDGET_EXCEEDED' ? error.code : 'REQUEST_FAILED' });
        await executionRecorder.finish(status, { ...partialReply, metadata: { ...partialReply?.metadata, completion } });
        throw error;
      } finally {
        // Run-scoped capability grants end with the run, whatever its outcome;
        // a capability prompt still open for this run is closed.
        releaseRunGrants(context.runId, { home: context.home });
      }
    });
  });
}

async function executeChatTurn({
  executionRecorder,
  context,
  home,
  configPromise,
  chatId,
  content,
  mode,
  attachments = [],
  imageTask = null,
  teamPlan = null,
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

}) {
  const [defaultConfig, rawState] = await Promise.all([configPromise, loadState({ home })]);
  const state = ensureSelectedEntities(rawState);
  const chat = state.chats.find(entry => entry.id === chatId);

  if (!chat) {
    throw new Error('Chat not found.');
  }
  const config = conversationConfig(defaultConfig, chat.modelSelection);
  if (!channelContext?.channelId) selectedMaterials(state, chat);
  executionRecorder?.setSearchContext?.(chat.messages);

  if (imageTask?.retryOf) {
    ({content, attachments, imageTask} = restoreImageRetry(chat, imageTask));
  }
  attachments = await imageFollowUpAttachments({chat, content, attachments, imageTask, home});
  const trimmed = content?.trim();
  const networkPolicy = getRequestNetworkPolicy(trimmed);
  const textDerivedAttachments = trimmed && !networkPolicy.fetchForbidden
    ? promoteTextUrlsToAttachments(requestUrls(trimmed).join('\n'), attachments)
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
    : null;
  const shouldUseBackgroundWorkspace = background && Boolean(channelContext?.channelId);
  const workspace = shouldUseBackgroundWorkspace
    ? {
        rootPath: null,
        exists: false,
        entries: [],
        filePaths: [],
        fileCount: 0,
        selectedFilePath: null,
        selectedFile: null,
        commandTemplates: COMMAND_TEMPLATES.map(commandTemplateDescriptor),
        commandRuns: [],
      }
    : await buildWorkspaceSnapshot(state, activeProject,{chat,home:context.home});
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
    metadata: { ...requestIdentity(context), ...(imageTask ? {imageTask} : {}) },
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
  signal?.throwIfAborted();
  chat.messages.push(userMessage);
  chat.updatedAt = nowIso();
  const visualConnection=userMessage.attachments.some(a=>a.kind==='image') ? visionConnection(config,{model:context.env.MELO_MODEL || activeAgentProfile?.model || config.model}) : config;
  const visualTest=visualConnection.visionTest || config.llmProfiles?.[config.activeLlmProfileId]?.visionTest;
  // Re-sent file-backed attachments (image retry, API clients echoing a stored
  // URL) are read back inline so extraction sees the bytes; externalization
  // below maps them onto the same file again.
  userMessage.attachments = await hydrateAttachments(userMessage.attachments, { home });
  await enrichMessageWithMediaContext(userMessage, {
    config,
    allowRemoteExtraction: !networkPolicy.fetchForbidden,
    modelSupportsVision: modelSupportsVision(
      visualConnection.model, visualTest,
    ),
  });
  // Attachment externalization (design §2.3): large inline data URLs move to
  // <home>/desktop/attachments and the stored message keeps a small
  // /api/media/attachments URL. Runs after media extraction, which still
  // reads the inline bytes. Older inline attachments in this chat migrate
  // once (chat.attachmentsExternalized) and the patches are replayed onto
  // the freshly loaded chat inside the atomic write below.
  const externalizedUserMessage = await externalizeMessageAttachments(userMessage, { home });
  userMessage.attachments = externalizedUserMessage.attachments;
  userMessage.extractedMedia = externalizedUserMessage.extractedMedia;
  const attachmentMigration = await migrateInlineAttachments(chat, { home });
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
    if (!latestChat) throw new Error('Chat not found before persisting user message.');
    signal?.throwIfAborted();
    {
      latestChat.messages.push(userMessage);
      applyAttachmentMigration(latestChat, attachmentMigration);
      latestChat.updatedAt = chat.updatedAt;
      if (!latestChat.title || latestChat.title === 'New chat') latestChat.title = chat.title;
      latestChat.agentId = chat.agentId;
      latestChat.mode = chat.mode;
      refreshChatMemorySummary(latestChat);
      Object.assign(chat, latestChat);
    }
    if (trimmed && !background) {
      latestState.settings.promptHistory = normalizePromptHistory([
        state.settings.promptHistory[0], ...(latestState.settings.promptHistory || []),
      ]);
    }
    if (!background) {
      latestState.settings.selectedChatId = chat.id;
      latestState.settings.activeMode = chat.mode;
      latestState.settings.activeView = 'chat';
    }
    return latestState;
  }, { home });

  // Plugin hook: chat:message:before
  await emitHook('chat:message:before', { chat, message: userMessage, config });
  signal?.throwIfAborted();

  let normalizedReply;
  let partialImageMessage;
  try {
    const graphResult = await runChatAgentExecutionGraph({
      config,
      home,
      context: { ...context, config, workspacePath: workspace.rootPath },
      state,
      chat,
      workspace,
      connectors,
      skills,
      latestUserMessage: trimmed,
      imageTask,
      teamPlan,
      onImageTaskResolved: task => persistResolvedImageTask(context, task),
      onImageProgress: async progress => {
        partialImageMessage = await persistImageProgress(context, progress, {id:effectiveAgentId,name:activeAgentProfile.name});
      },
      agentId: effectiveAgentId,
      background,
      channelContext,
      signal,
      onDelta,
      onReasoningDelta,
      sseEmitter,
      providerProfile,
    });
    signal?.throwIfAborted();
    normalizedReply = graphResult.normalizedReply;
    // Capture CORRECTED verdicts so they can be written into the assistant
    // message and later re-indexed as verification-correction memory entries.
    if (graphResult.verificationRecord) {
      state._pendingVerificationRecord = graphResult.verificationRecord;
    }
  } catch (error) {
    if (signal?.aborted || isAbortError(error) || partialImageMessage) {
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
      metadata: { ...requestIdentity(context), agent:{id:activeAgentProfile.id, name:activeAgentProfile.name}, executionError: error.code || error.name || 'PROVIDER_ERROR' },
      content: normalizedFailureReply.content,
      blocks: normalizedFailureReply.blocks,
      attachments: [],
      createdAt: nowIso(),
    };
    // Design audit D2: the failure text itself is filtered out of future
    // prompts (contextFilters), so the tools this turn already ran travel as
    // a separate plain-text `tool-trace` message written in the same commit.
    const failureTrace = await readToolTraceText(context, { status: 'failed' }).catch(() => '');
    const traceMessage = failureTrace ? buildToolTraceMessage(context, failureTrace, { status: 'failed', agent: { id: activeAgentProfile.id, name: activeAgentProfile.name } }) : null;
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
      signal?.throwIfAborted();
      if (traceMessage) latestChat.messages.push(traceMessage);
      latestChat.messages.push(assistantMessage);
      completeChatRun(latestState, context, assistantMessage);
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
    }, { home });

    await executionRecorder?.finish('failed', assistantMessage);

    // Index new messages (fire and forget)
    try {
      tagChatScope(latestChat.id, { audience: latestChat.source || 'desktop', projectId: latestChat.projectId || '' });
      indexMessage(latestChat.id, latestChat.title, userMessage, { audience: latestChat.source || 'desktop', projectId: latestChat.projectId || '' });
      indexMessage(latestChat.id, latestChat.title, assistantMessage, { audience: latestChat.source || 'desktop', projectId: latestChat.projectId || '' });
    } catch {}

    return {
      bootstrap: skipBootstrap ? null : await getDesktopBootstrap(),
      assistantMessage,
    };
  }

  executionRecorder?.event({ kind: 'pipeline', id: 'reply:save', name: '保存回答', status: 'running', output: '写入聊天记录' });
  const assistantMessage = {
    id: partialImageMessage?.id || randomUUID(),
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
    // G-1d slice 2 (2026-05-12): tool execution metadata (toolCallId, toolName,
    // ok, optional evidenceTrail) accumulated by chatExecutionRunner across
    // tool-loop iterations.  Persisted on the assistantMessage so chat
    // history can show the fallback trail past the 1.8s active-chip window.
    // Conditional spread — pure-text replies (no tools fired) produce no
    // `toolResults` key on the message.
    ...(Array.isArray(normalizedReply.toolResults) && normalizedReply.toolResults.length
      ? { toolResults: normalizedReply.toolResults }
      : {}),
    ...{ metadata: {
          ...requestIdentity(context),
          memoryUsage: normalizedReply.memoryUsage || [],
          ...(normalizedReply.completion ? { completion: normalizedReply.completion } : {}),
          ...(partialImageMessage ? {imageDelivery:{...partialImageMessage.metadata.imageDelivery,status:'completed'}} : {}),
          agent: {id:effectiveAgentId, name:activeAgentProfile.name},
          ...(normalizedReply.team ? {team:normalizedReply.team} : {}),
          ...(normalizedReply.usage ? {usage:normalizedReply.usage} : {}),
          ...(normalizedReply.modelResponses?.length ? { modelResponses: normalizedReply.modelResponses } : {}),
          ...(state._pendingVerificationRecord ? { verificationRecord: state._pendingVerificationRecord } : {}),
          ...(normalizedReply.canonicalReply ? { canonicalReply: normalizedReply.canonicalReply } : {}),
          // Protocol-neutral tool chain (design audit E1): bounded IR of this
          // reply's tool turns; rendered back into any protocol by messageBuilder.
          ...(normalizedReply.toolChain ? { toolChain: normalizedReply.toolChain } : {}),
        } },
  };
  delete state._pendingVerificationRecord;
  // Design audit D2 (optional): MELO_TOOL_TRACE_ALWAYS=1 also replays the
  // tool trace of successful turns that ran at least one tool.
  const successTrace = context.env.MELO_TOOL_TRACE_ALWAYS === '1' && Array.isArray(normalizedReply.toolResults) && normalizedReply.toolResults.length
    ? await readToolTraceText(context, { status: 'completed' }).catch(() => '') : '';
  const successTraceMessage = successTrace ? buildToolTraceMessage(context, successTrace, { status: 'completed', agent: { id: effectiveAgentId, name: activeAgentProfile.name } }) : null;
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
    signal?.throwIfAborted();
    const existingIndex = latestChat.messages.findIndex(m => m.id === assistantMessage.id);
    if (successTraceMessage && !latestChat.messages.some(m => m.id === successTraceMessage.id)) {
      if (existingIndex >= 0) latestChat.messages.splice(existingIndex, 0, successTraceMessage);
      else latestChat.messages.push(successTraceMessage);
    }
    const replyIndex = latestChat.messages.findIndex(m => m.id === assistantMessage.id);
    if (replyIndex >= 0) latestChat.messages[replyIndex] = assistantMessage;
    else latestChat.messages.push(assistantMessage);
    // Supplements used during the turn become part of the question in the transcript.
    const used = usedSupplements(chat.id);
    const question = used.length ? latestChat.messages.find(m => m.id === userMessage.id) : null;
    if (question) {
      question.content = `${question.content}\n\n补充：${used.map(entry => entry.text).join('\n')}`;
      // Blocks are what the UI and the next turn's model history read
      // (messageVisibleText prefers them); rebuild them from the amended
      // content or the supplement is invisible from the next turn on (audit L1).
      question.blocks = normalizeMessageBlocks([], question.content);
    }
    completeChatRun(latestState, context, assistantMessage);
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
  }, { home });

  executionRecorder?.event({ kind: 'pipeline', id: 'reply:save', status: 'completed', output: '回答与引用已保存，可交付界面' });
  await executionRecorder?.finish('completed', assistantMessage);

  // Conversation history indexing (fire and forget — never blocks the response)
  try {
    tagChatScope(latestChat.id, { audience: latestChat.source || 'desktop', projectId: latestChat.projectId || '' });
    // The stored question (with any mid-turn supplement) is what gets
    // indexed; conversationIndex re-indexes a message whose text changed
    // (audit L19).
    indexMessage(latestChat.id, latestChat.title, latestChat.messages.find(m => m.id === userMessage.id) || userMessage, { audience: latestChat.source || 'desktop', projectId: latestChat.projectId || '' });
    indexMessage(latestChat.id, latestChat.title, assistantMessage, { audience: latestChat.source || 'desktop', projectId: latestChat.projectId || '' });
  } catch {}

  // Snapshot sync writes new message/media/frame rows without embeddings.
  // Kick the bounded fill-in worker after every completed chat turn so
  // semantic recall catches up even when session-memory extraction does not
  // happen on this particular turn.
  schedulePostTurnTask(home, () => scheduleEmbeddingFillIn(config), { label: 'embedding-fill-in' });

  // Background pre-compaction (design audit L4): summarise the oldest chunk
  // once pending history passes 70% of the window, so the next turn does not
  // stall on a synchronous summarising request.
  schedulePostTurnTask(home, () => precompactIfNeeded(latestChat, { config, home, historyWindowTokens: normalizedReply.promptDiagnostics?.historyWindowTokens || 0 }), { label: 'precompact' });

  // Session memory extraction (async, non-blocking — fire and forget).
  // Runs after saveState so it doesn't slow down the response. Previously
  // gated on !background, which meant remote channels (Telegram/Discord)
  // never built up a sessionMemory layer — long-running bots had to rely
  // purely on vector recall. Now runs for every channel; the extraction
  // itself is a best-effort LLM call that never throws to the caller.
  schedulePostTurnTask(home, () => maybeExtractSessionMemory(latestChat, { config }).then(async extracted => {
    if (extracted) {
      // Persist the updated session memory through updateStateAtomically so
      // we don't race with concurrent writes from the chat flow (new
      // messages, artifacts, etc.). The previous load-modify-save cycle
      // was detached from the write queue and could roll back a newer
      // message append. We copy only the three memory fields onto the
      // latest persisted chat rather than overwriting the chat wholesale.
      const applied = await persistSessionMemorySnapshot(latestChat, { home }).catch(() => false);
      if (!applied) return;

      // Promote new session facts to cross-session long-term memory
      const agentId = latestChat.agentId || 'main';
      await promoteAndPersistFacts(latestChat, agentId, config).catch(() => {});

      // Background: fill in any missing embeddings
      await scheduleEmbeddingFillIn(config).catch(() => {});
    }
  }), { label: 'session-memory' });

  // Phase 3.4.1 — opportunistic skill-proposal scan. Fire-and-forget so it
  // never blocks the response; dedupes naturally via the store's seedId
  // check, so repeated turns in the same chat don't spam proposals.
  if (!background) {
    schedulePostTurnTask(home, () => scanRecentChatsForSkillProposals(), { label: 'skill-proposals' });
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
