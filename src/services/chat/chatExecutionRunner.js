import {resolveCapabilityContext} from '../agent/capabilityContext.js';
import {scopeAllowsTool,toolsForCapabilityScope,nativeFeaturesForScope,missingCapabilityScope} from '../../domain/agent/capabilityScope.js';
import {retrieveKnowledgeContext} from './knowledgeContext.js';
import { measureStage, measureStageSync, startStage } from '../../runtime/performanceTrace.js';
import { recordMemoryFeedback } from '../../memory/store.js';
import { resolveSessionFacts } from '../../memory/factRecords.js';
import { isLocalChat } from '../../memory/factPolicy.js';
import { listProjectBook, renderProjectBook } from '../project/projectMemoryBook.js';
// Stable prompt blocks rendered on every turn; reported in memoryUsage, never recall feedback (bug audit M8).
const STABLE_MEMORY_KINDS = new Set(['project-book', 'personal-profile']);
import { listPersonalProfile, renderPersonalProfile } from '../memory/personalProfile.js';
import { selectedMaterials } from './conversationSelection.js';
import { runAgentTeam } from '../../agents/team.js';
import { takeSupplements, supplementMessage } from './supplements.js';
import { summarizePricedUsage } from '../../runtime/usage.js';
import { observeModelReplies } from './executionPipeline.js';
import { persistCompactSnapshot } from './derivedState.js';
import { createRequestContext, requestIdentity } from '../../runtime/requestContext.js';
import { currentRequestContext, requestEnvironment, runWithRequestContext } from '../../runtime/requestScope.js';
import { armBudget, budgetExhausted, budgetExhaustedReply, describeBudgetReason, recordUsage, receiptInputTokens, requestTimeoutMs, remainingMs } from '../../runtime/runBudget.js';
import { estimateMessagesTokens, estimateTextTokens } from '../../memory/tokenEstimate.js';
import { AGENT_LOOP_CONTRACT, contractRegExp } from '../../runtime/agentLoopContract.js';
// Chat agent execution graph runner — sub-phase 7d-5δ commit 7b of the
// desktopStore decomposition. byte-for-byte port (CLAUDE.md §5).
//
// Owns the chat-side variant of the agent execution graph: a three-node
// pipeline (prepare → invoke-model → finalize) that drives Melo's main
// conversational loop. Used by the desktop chat panel, sendChatMessage,
// the Telegram / Discord bridges, and the approval-execution path.
//
// All upstream dependencies live in dedicated leaf modules (every other
// 7d-5* commit was prep work for exactly this — the runner imports zero
// symbols from desktopStore.js). The lone module-private singleton
// `getSharedSkillIndex` is also co-located here: its sole caller was
// always this runner, and Node's module cache keeps the singleton stable.

import { randomUUID } from 'node:crypto';
import {
  GRAPH_END,
  createStateGraph,
  runStateGraph,
} from '../../agentGraph.js';
import { nowIso } from '../../shared/helpers.js';
import { findProjectById } from '../../state/stateLookups.js';
import { effectiveAgentProfile } from '../../state/agentProfiles.js';
import { updateStateAtomically } from '../../state/stateStore.js';
import {
  filterConnectorsForAgent,
  filterSkillsForAgent,
  filterMcpToolsForAgent,
  createSharedSkillIndexFactory,
} from '../../domain/agent/agentTools.js';
import { buildAgentMemoryNodeContext } from '../agent/agentMemoryContext.js';
import { buildToolRoutingPrompt } from '../agent/toolRoutingPrompt.js';
import { buildChannelRoutePrompt } from '../remote/channelRoutePrompt.js';
import { buildMatcherContextFromChat } from './matcherContext.js';
import { detectImageIntent, buildModelMessagesFromChat, modelMessageSourceIds } from './messageBuilder.js';
import { hydrateMessagesForModel, hydrateAttachments } from '../../media/attachments.js';
import { tryImageEditFastPath } from './imageEditFastPath.js';
import { formatModelMessageForVisionDebug } from './visionDebug.js';
import { buildDynamicContext } from './dynamicContext.js';
import {
  planChatGraphAction,
  buildApprovalResponse,
} from './chatActionPlanning.js';
import {
  buildReActPromptSections,
  buildLanguageConstraint,
} from './systemPrompt.js';
import { MODE_DEFS } from '../../domain/chat/modeDefs.js';
import { summarizeConnectorPrompts } from '../connector/connectorPrompts.js';
import { summarizeSkillsPrompts } from '../skill/skillPrompts.js';
import { listExecutableSkills } from '../../domain/skill/skillService.js';
import { buildProjectContextSection } from '../project/projectContext.js';
import {
  normalizeApproval,
  normalizeApprovals,
} from '../../domain/approval/approvalService.js';
import { normalizeAssistantReplyForConversation } from '../../domain/message/messageBlocks.js';
import {
  extractVizSpec,
} from '../viz/vizSpec.js';
import {
  buildCitationInstructions,
  extractCitations,
} from '../viz/citation.js';
import {
  buildSkillIndex,
  defaultSkillMatchCache,
  matchSkillsForMessage,
} from '../../agents/skillMatcher.js';
import { getSkillLastRunMap } from '../../agents/skillRuns.js';
import { createCoreTurn } from '../../runtime/sharedAgentCore.js';
import { wantedToolGroups, nextActivatedGroups, selectStableTools } from '../../tools/toolGroups.js';
import { persistChatRuntimeFields, persistCompactFailure } from './derivedState.js';
import { buildMemberBackground } from '../../agents/memberBackground.js';
import { buildSkillTool } from '../../agents/skillExecutor.js';
import { getEmbedding } from '../../memory/embeddings.js';
import {
  planIncrementalCompact,
  compactConversationDetailed,
  formatCompactContextBlock,
  buildRecentWindow,
} from '../../memory/contextCompact.js';
import { formatSessionMemoryBlock, selectSessionMemoryFacts } from '../../memory/sessionMemory.js';
import {
  classifyRequest,
  intentRequiresVerification,
} from '../../retrieval/intentRouter.js';
import {
  parseUncertaintyMarker,
  verifyUncertainClaim,
  applyVerificationToReply,
} from '../../retrieval/selfVerification.js';
import {
  buildSearchPlan,
  buildSearchRoutingPrompt,
  filterToolsForSearchPlan,
  constrainSearchPlan,
} from '../../retrieval/searchRouter.js';
import {
  buildToolsSystemPrompt,
  shouldInjectToolsPrompt,
} from '../../tools/systemPrompt.js';
import { projectToolResultForPersist, deriveUnifiedErrorCode } from './toolResultProjection.js';
import { appendCompactCard, replaceCardSummary, ledgerCards, ledgerDigest, renderCompactLedger, degradedCardForUpgrade, noteCardUpgradeAttempt } from '../../memory/compactLedger.js';
import { buildTopicExcerpts } from './topicExcerpts.js';
import { buildDateChangeNote } from './dateContext.js';
import { getTool, getAllTools } from '../../tools/registry.js';
import { toolsForAgent as mcpToolsForAgent, indexMcpTools } from '../../tools/mcpRegistry.js';
import { executeToolCalls } from '../../tools/executor.js';
import { buildToolInvocationRecord, appendToolInvocationRecord, modelFacingOutputsFor, redactToolArgs } from '../../tools/toolInvocationRecord.js';
import { inferImageTask, runImageTask } from './imageTask.js';
import { visionConnection, imageSettings } from '../../images/imageSettings.js';
import { prepareVisionInputs } from '../../media/visionInputs.js';
import { createOpenAICompatibleReply } from '../../openai.js';
import { collectVerificationEvidence } from '../../retrieval/verificationEvidence.js';
import { fitRequestContext, resolveContextBudget, attachTurnContextToMessages, requiredPromptTokens, effectiveHistoryWindow } from './contextBudget.js';
import { selectToolContextPolicy, requiresSkillToolContext } from '../../retrieval/requestPolicy.js';
import { createFunctionCallingSession, compactToolChain, toolProtocolFor } from '../../tools/functionCalling.js';
import { buildToolChainRecord } from '../../tools/toolProtocol.js';

// `getSharedSkillIndex(skills)` — module-private factory bound to the
// `buildSkillIndex` implementation imported above. It returns a stable
// per-skill-list cache so repeated turns over the same skill set don't
// re-index every time. The factory was originally module-private to
// desktopStore; moving it here keeps the singleton scoped to its sole
// caller (this runner). Node's module cache keeps the binding stable
// across imports.
const getSharedSkillIndex = createSharedSkillIndexFactory({ buildSkillIndex });

export async function runChatAgentExecutionGraph({
  context,
  home,
  config,
  state,
  chat,
  workspace,
  connectors,
  skills,
  latestUserMessage,
  imageTask = null,
  teamPlan = null,
  onImageTaskResolved,
  onImageProgress,
  agentId,
  background = false,
  channelContext = null,
  signal,
  onDelta,
  onReasoningDelta,
  sseEmitter,
  providerProfile = 'default',
  _dependencies = {},
}) {
  context ||= createRequestContext({ home, chatId: chat.id, signal, config, workspacePath: workspace?.rootPath });
  if (!context.capabilityScope) {
    context=await resolveCapabilityContext(context,{state,chat,agentId});
    if (!context) throw Object.assign(new Error(missingCapabilityScope().output),{code:'CAPABILITY_SCOPE_MISSING'});
  }
  if (currentRequestContext() !== context) return runWithRequestContext(context, () => runChatAgentExecutionGraph({ ...arguments[0], context }));
  home ||= context.home;
  const env = context.env;
  const firstToken = startStage('turn.prepare_to_first_token');
  const originalDelta = onDelta;
  if (typeof originalDelta === 'function') onDelta = (...args) => {
    if (args[0]?.delta || args[0]?.text) firstToken();
    return originalDelta(...args);
  };
  const modelResponses = [];
  const replyProvider = _dependencies.createReply || createOpenAICompatibleReply;
  const observedReply = observeModelReplies(replyProvider, sseEmitter);
  // Run budget (design audit C1): one deadline / input-token / tool-call pool
  // for the whole turn, shared by this loop, synchronous compaction (it uses
  // the same wrapper), the tool executor and member/skill sub-loops. The
  // context was created when the request arrived; the clock starts here.
  const budget = armBudget(context.budget || null);
  const createReply = async options => {
    const endFirstToken = typeof options.onDelta === 'function' ? startStage('model.first_token') : null;
    let accounted = false;
    // Measured usage when the provider reports it, estimated otherwise —
    // and exactly once per request even if the provider sends no receipt.
    const account = receipt => {
      if (accounted) return; accounted = true;
      const inputTokens = receiptInputTokens(receipt)
        ?? estimateMessagesTokens(options.messages || []) + Math.ceil(estimateTextTokens(options.systemPrompt || '') * 4 / 3);
      recordUsage(budget, { providerCalls: 1, inputTokens });
    };
    try {
      return await measureStage('model.request', () => observedReply({
        ...options,
        timeoutMs: budget ? requestTimeoutMs(budget) : options.timeoutMs,
        onDelta: endFirstToken ? (...args) => {
          if (args[0]?.delta || args[0]?.text) endFirstToken();
          return options.onDelta(...args);
        } : options.onDelta,
        onProviderResponse: receipt => { modelResponses.push(receipt); account(receipt); options.onProviderResponse?.(receipt); },
      }));
    } finally { account(null); }
  };
  const embedQuery = _dependencies.getEmbedding || getEmbedding;
  const contextBudget = resolveContextBudget(env, { config });
  // Per-turn prompt sections ride inside the current user message so the
  // system prompt and earlier history stay cache-stable across turns.
  // MELO_TURN_CONTEXT_IN_SYSTEM=1 restores the pre-2026-10-17 layout.
  const turnContextPlacement = env.MELO_TURN_CONTEXT_IN_SYSTEM === '1' ? 'system' : 'message';
  const promptDebug = env.MELO_PROMPT_DEBUG === '1';
  const modelOverrides = {
    apiKey: config.activeLlmProfileId ? config.apiKey : env.MELO_API_KEY || env.OPENAI_API_KEY || config.apiKey,
    baseUrl: config.activeLlmProfileId ? config.baseUrl : env.MELO_BASE_URL || env.OPENAI_BASE_URL || config.baseUrl,
    model: config.conversationModelSelected ? config.model : config.activeLlmProfileId ? '' : env.MELO_MODEL || '',
    verifier: config.activeLlmProfileId ? config.model : env.MELO_VERIFIER_MODEL || '',
  };
  const isRemoteChannel = background && Boolean(channelContext?.channelId);


  const graph = createStateGraph({
    start: 'prepare',
    nodes: {
      // ── prepare ────────────────────────────────────────────────────────────
      // Combines the old classify-intent / resolve-agent / resolve-channel-route
      // / recall-memory / collect-observations / plan-actions /
      // compose-system-prompt nodes into a single parallel-aware step.
      //
      // Execution order:
      //   1. Resolve the agent, channel and recent message window.
      //   2. Promise.all: classifyIntent + buildDynamicContext run concurrently
      //      – classifyIntent may make a fast API call (rule-based first, API only
      //        for ambiguous messages)
      //      – buildDynamicContext reads workspace files / connectors
      //   3. Inline: plan-actions, optional queue-approval (early exit), then
      //      recall memory only when useful, then compose the final system prompt
      async 'prepare'() {
        // ── 1. Sync setup ──────────────────────────────────────────────────
        const modeDef = MODE_DEFS.find(mode => mode.id === chat.mode) || MODE_DEFS[0];
        const project = findProjectById(state, chat.projectId);
        const activeAgentProfile = effectiveAgentProfile(state, agentId, project?.id || null);
        const agentConnectors = filterConnectorsForAgent(connectors, activeAgentProfile);
        const agentScopedSkills = filterSkillsForAgent(skills, activeAgentProfile);
        // Phase 3.2.2 — rule-based pre-filter. Shrinks both the system prompt
        // and the tool loop by keeping only skills whose triggers/tags/name
        // match the current user message. Skills with no metadata, built-ins,
        // and skills tagged `always-on` pass through unconditionally, so no
        // regression vs the old behavior unless a custom-skill author has
        // explicitly opted in to triggers/tags.
        // Multi-turn context — weight the newest 3 user/assistant messages
        // so intent that lived in a previous turn ("please also save to
        // word") still boosts the right skills on a short follow-up.
        const matcherContext = buildMatcherContextFromChat(chat, latestUserMessage);
        const skillIndex = getSharedSkillIndex(agentScopedSkills);
        const recencyByIdMap = getSkillLastRunMap({ windowDays: 30 });
        const enabledSkills = matchSkillsForMessage(agentScopedSkills, matcherContext, {
          skillIndex,
          cache: defaultSkillMatchCache,
          recencyByIdMap,
        });
        const channelPrompt = buildChannelRoutePrompt({ chat, channelContext, profile: activeAgentProfile });

        const toolRoutingPrompt = buildToolRoutingPrompt({ activeAgentProfile, agentConnectors });

        // Sync context assembly (remote channels skip project/connector detail
        // but DO get a lean skills summary — the desktop owner's skills should
        // be usable from Telegram/Discord as well).
        const projectContext = isRemoteChannel ? '' : buildProjectContextSection(project, activeAgentProfile);
        const connectorPrompts = isRemoteChannel ? '' : summarizeConnectorPrompts(agentConnectors);
        const skillsPrompts = summarizeSkillsPrompts(enabledSkills, { remote: isRemoteChannel });
        // Attachment externalization (design §2.3): file-backed attachments are
        // read back into data URLs once per turn for the model window only. The
        // view spreads `chat` lazily so compaction fields set later in this
        // node are still seen; the persisted chat keeps its small file URLs.
        const modelHistory = await hydrateMessagesForModel(chat.messages, { home });
        const modelChat = () => ({ ...chat, messages: modelHistory });
        // Protocol adapter (design audit E1): earlier replies persist a
        // protocol-neutral tool chain; with MELO_TOOL_CHAIN_HISTORY=1 (or
        // `config.toolChainHistory === true`) it is rendered back into the
        // active protocol's shape so a chat continues after a provider switch.
        // Default off: history stays prose-only, as before.
        const toolChainProtocol = env.MELO_TOOL_CHAIN_HISTORY === '1' || config.toolChainHistory === true
          ? toolProtocolFor({ ...config, baseUrl: modelOverrides.baseUrl, toolCalling: env.MELO_FUNCTION_CALLING || config.toolCalling })
          : null;
        let modelMessages = buildModelMessagesFromChat(modelChat(), { windowTokens: contextBudget.windowTokens, toolChainProtocol });
        let searchPlan = buildSearchPlan({
          latestUserMessage,
          modelMessages,
          authMode: config.authMode,
        });

        // ── 2. Async fan-out ───────────────────────────────────────────────
        // classifyIntent and buildDynamicContext are the only two operations
        // that genuinely await I/O; run them concurrently to eliminate the
        // sequential stall that previously added one full round-trip before
        // invoke-model could start.
        const [classification, dynamicContext] = await Promise.all([
          measureStage('intent.classify', () => classifyRequest(latestUserMessage, {
            config: { ...config, model: modelOverrides.model || activeAgentProfile.model || config.model },
            signal, contextMessages: chat.messages,
            judge: _dependencies.judgeFast,
            onDecision: decision => {
              if (decision.model && decision.source !== 'cache') modelResponses.push({
                requestedModel: decision.model, reportedModel: decision.reportedModel || '',
                usage: decision.usage || null, transport: decision.transport || '', purpose: 'intent-judge',
              });
              sseEmitter?.('execution_event', {
                kind: 'pipeline', id: 'judge:intent', name: '意图判断', module: 'compute', status: 'completed',
                output: decision.source === 'model'
                  ? `${decision.model} · ${decision.latencyMs} ms`
                  : decision.source === 'cache' ? '复用近期相同判断，无新增模型请求' : '快速判断不可用，使用保守规则',
                metadata: decision,
              });
            },
          })),
          isRemoteChannel
            ? Promise.resolve('')
            : buildDynamicContext(state, chat, workspace, agentConnectors.filter(c=>c.id!=="artifacts"), latestUserMessage),
        ]);
        const intent = classification.taskType;
        const allowLiveSpeech = classification.riskLevel === 'normal' && intent === 'casual' &&
          (chat.messages?.length || 0) <= 1 && !chat.compactSummary &&
          !(chat.messages?.at(-1)?.attachments?.length) &&
          /^(?:hi|hello|hey|ok|okay|thanks|thank you|你好|嗨|好的|好|谢谢)[\s!.?。！？]*$/i.test(String(latestUserMessage).trim());
        sseEmitter?.('speech_policy', { allowLiveSpeech });

        // ── 3. Plan actions (needs agentConnectors resolved above) ─────────
        const plannedAction = planChatGraphAction({
          latestUserMessage,
          activeAgentProfile,
          agentConnectors,
          chat,
        });

        if (plannedAction?.requiresApproval) {
          const approval = normalizeApproval({
            id: randomUUID(),
            kind: plannedAction.kind,
            title: plannedAction.title,
            description: plannedAction.description,
            payload: { ...plannedAction.payload, execution: requestIdentity(context) },
            projectId: chat.projectId || null,
            chatId: chat.id,
            status: 'pending',
            createdAt: nowIso(),
            updatedAt: nowIso(),
          });
          await updateStateAtomically(latest => {
            if (!latest.chats.some(entry => entry.id === chat.id)) throw new Error('Chat not found.');
            latest.approvals = normalizeApprovals([approval, ...latest.approvals]);
          }, home ? { home } : {});

          return {
            normalizedReply: normalizeAssistantReplyForConversation(
              buildApprovalResponse(plannedAction, approval),
              { channelKind: isRemoteChannel ? 'remote' : 'desktop' },
            ),
            next: GRAPH_END,
          };
        }

        // ── 4. Auto-compact check ─────────────────────────────────────────
        // Runs for ALL channels once the pending history (after the last
        // compact boundary) would no longer fit the sliding window. The
        // trigger is derived from the same budget as the window and the
        // request fitter (resolveContextBudget), so history can no longer
        // fall into a gap where it is neither sent nor summarised
        // (2026-10-17 audit P0-2). Remote channels are included; the
        // MAX_COMPACT_FAILURES circuit breaker still guards against a
        // hot-loop of failed summaries.
        const hasModelConfig = Boolean(
          config.authMode === 'codex' ||
          config.apiKey ||
          (config.authMode === 'local' && config.baseUrl),
        );

        let compactedThisTurn = false;
        // History window actually available this turn (audit L4): starts at the
        // nominal window and shrinks once the required prompt is measured.
        let historyWindowTokens = contextBudget.windowTokens;
        let compactPasses = 0;
        const runCompact = async compactPlan => {
          // Each pass gets its own stage id: a scene stage is frozen once it
          // reaches a terminal status, so a failed first pass and the forced
          // second pass would otherwise share (and lose) one spinner (audit U2).
          const stageId = compactPasses++ === 0 ? 'compact:running' : `compact:running:${compactPasses}`;
          const stage = { kind: 'pipeline', id: stageId, module: 'compute', name: '压缩早期对话' };
          sseEmitter?.('execution_event', { ...stage, status: 'running', output: `正在把最早的 ${compactPlan.compactedCount} 条消息压成摘要（通常后台已完成，这是兜底）。` });
          const fail = async () => {
            // Persisted (audit L5): the MAX_COMPACT_FAILURES breaker only
            // trips when failures survive the turn.
            chat.compactFailures = (chat.compactFailures || 0) + 1;
            await persistCompactFailure(chat, { home }).catch(() => {});
            sseEmitter?.('execution_event', { ...stage, status: 'failed', output: `摘要失败（连续 ${chat.compactFailures} 次）；本轮继续使用原始历史。` });
          };
          try {
            const { summary, source } = await compactConversationDetailed(compactPlan.messages, {
              config, signal, previousSummary: compactPlan.previousSummary, _createReply: createReply,
            });
            if (summary) {
              // Ledger (design 1D-2): the chunk becomes one appended topic
              // card; compactSummary is re-rendered from the cards. Provenance
              // (audit C-6): a 'rule' card is a degraded fallback — the chat
              // keeps moving, the header says so and the next turns retry the
              // model (see upgradeDegradedCompact below).
              appendCompactCard(chat, compactPlan, { summary, source: source || 'cloud' });
              if (source === 'rule') {
                process.stderr.write(`[compact] chat ${chat.id}: summarising model unavailable, using extractive fallback for ${compactPlan.compactedCount} messages\n`);
                sseEmitter?.('execution_event', { kind: 'pipeline', id: 'compact:degraded', module: 'compute', name: '对话摘要降级', status: 'completed', output: '摘要模型不可用，已使用抽取式摘要；后续轮次会自动重试。' });
              }
              // Persist so the summary survives restarts.
              await persistCompactSnapshot(chat, compactPlan, { home });
              modelMessages = buildModelMessagesFromChat(modelChat(), { windowTokens: historyWindowTokens, toolChainProtocol });
              compactedThisTurn = true;
              sseEmitter?.('execution_event', { ...stage, status: 'completed', output: `已把 ${compactPlan.coveredCount || compactPlan.messages.length} 条消息压成一张话题卡（${source === 'rule' ? '抽取式' : '模型'}摘要）。` });
              return true;
            }
            await fail();
          } catch (error) {
            if (signal?.aborted) {
              sseEmitter?.('execution_event', { ...stage, status: 'cancelled', output: '已中止。' });
              throw signal.reason || error;
            }
            await fail();
          }
          return false;
        };

        // Retry the model for a degraded (extractive) card: re-summarise that
        // card's own message range once per turn, at most 3 times per card,
        // with a short timeout so a still-unreachable model cannot stall the
        // reply (audit L6/L7: the range is the card's, the replacement is that
        // card, and the chat-level source follows the newest card).
        const upgradeDegradedCompact = async () => {
          if (!hasModelConfig) return;
          const target = degradedCardForUpgrade(chat);
          if (!target) return;
          const cards = ledgerCards(chat);
          const fromIndex = target.fromMessageId ? chat.messages.findIndex(message => message.id === target.fromMessageId) : 0;
          const toIndex = chat.messages.findIndex(message => message.id === target.toMessageId);
          if (fromIndex < 0 || toIndex < fromIndex) return;
          const range = chat.messages.slice(fromIndex, toIndex + 1);
          noteCardUpgradeAttempt(chat, target.id);
          const snapshot = { boundaryId: chat.compactBoundaryMessageId, compactedCount: chat.compactedMessageCount };
          // A range the summariser cannot take in one request (a legacy card
          // without a start, or a chunk from a larger budget) stays extractive.
          if (estimateMessagesTokens(range) * 4 / 3 > contextBudget.compactChunkTokens) {
            await persistCompactSnapshot(chat, snapshot, { home, upgrade: true });
            return;
          }
          const controller = new AbortController();
          const onAbort = () => controller.abort(signal?.reason);
          signal?.addEventListener('abort', onAbort, { once: true });
          const timer = setTimeout(() => controller.abort(new Error('compact upgrade timed out')), 20_000);
          try {
            // Earlier cards are background only, so the upgraded card does not
            // restate them.
            const previousSummary = ledgerDigest(cards.slice(0, cards.findIndex(card => card.id === target.id)));
            const { summary, source } = await compactConversationDetailed(range, { config, signal: controller.signal, previousSummary, _createReply: createReply });
            if (summary && source === 'cloud') {
              replaceCardSummary(chat, target.id, { summary, source: 'cloud' });
              sseEmitter?.('execution_event', { kind: 'pipeline', id: 'compact:upgraded', module: 'compute', name: '对话摘要已恢复', status: 'completed', output: '摘要模型恢复可用，已用完整摘要替换抽取式摘要。' });
            }
          } catch (error) {
            if (signal?.aborted) throw signal.reason || error;
          } finally {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
          }
          await persistCompactSnapshot(chat, snapshot, { home, upgrade: true });
        };
        await upgradeDegradedCompact();

        const compactPlan = hasModelConfig
          ? planIncrementalCompact(chat, { triggerTokens: contextBudget.compactTriggerTokens, maxChunkTokens: contextBudget.compactChunkTokens })
          : null;
        if (compactPlan) await runCompact(compactPlan);

        // ── 5. Assemble system prompt ──────────────────────────────────────
        // The ledger is rendered for the prompt at assembly time so the
        // read_history hint only appears when the tool is exposed this turn
        // (audit L18); the persisted compactSummary keeps the full rendering.
        // Re-run after a forced compaction so the new card reaches the prompt.
        let compactContext = '', topicExcerpts = { text: '', cards: [] };
        const refreshCompactContext = ({ readHistory = true } = {}) => {
          const cards = ledgerCards(chat);
          compactContext = cards.length
            ? formatCompactContextBlock(renderCompactLedger(cards, { readHistory }), chat.compactedMessageCount || 0, { source: chat.compactSummarySource || 'cloud' })
            : '';
          // Original text of the ledger cards this message returns to (1D-4).
          topicExcerpts = compactContext ? buildTopicExcerpts(chat, latestUserMessage, { readHistory }) : { text: '', cards: [] };
          if (topicExcerpts.cards.length) sseEmitter?.('execution_event', { kind: 'pipeline', id: 'history:excerpts', module: 'compute', name: '早期话题原文', status: 'completed', output: topicExcerpts.cards.map(card => `${card.title} (#${card.fromMessageId.slice(0, 8)}…#${card.toMessageId.slice(0, 8)})`).join('\n') });
        };

        // Build per-request skill tools for all enabled executable skills this
        // agent has access to. They are NOT registered globally — we pass them
        // through graph state so the invoke-model loop can resolve them by
        // name alongside the registry. This keeps concurrent chats isolated
        // (each chat sees only its own agent's skills).
        const skillTools = listExecutableSkills(enabledSkills)
          .map(buildSkillTool)
          .filter(Boolean);
        // F3 (design 2026-10-17): stdio MCP tools live in their own registry
        // (tools/mcpRegistry.js) and are merged here per agent whitelist, so
        // two agents in parallel chats see disjoint MCP sets. `tool.id` stays
        // `mcp:<server>:<tool>`; the model sees `tool.functionName`
        // (`mcp__server__tool`) and dispatch resolves both.
        const mcpTools = mcpToolsForAgent(activeAgentProfile);

        // Build tools system prompt — remote channels now get all tools.
        // Stdio MCP tools (`mcp:<server>:<tool>`) are gated by the agent's
        // enabledMcpServerIds whitelist; the default is deny-all so a new
        // agent can't call any MCP without explicit opt-in.  Non-MCP tools
        // pass through filterMcpToolsForAgent untouched.
        let toolsPrompt = buildSearchRoutingPrompt(searchPlan);
        let visibleToolIds = new Set();
        let promptTools = [];
        const explicitTeam=teamPlan || state.tasks?.find(t=>t.execution?.requestId===context.requestId)?.execution?.teamPlan;
        const toolContextPolicy = explicitTeam ? {mode:"full",reason:"explicit-team"} : selectToolContextPolicy({
          text: latestUserMessage, chat, searchPlan,
          hasExecutableSkills: requiresSkillToolContext(listExecutableSkills(enabledSkills), latestUserMessage),
          highRisk: classification.riskLevel === 'high',
        });
        if (!allowLiveSpeech && toolContextPolicy.mode !== 'none' && shouldInjectToolsPrompt({ mode: chat.mode })) {
          // prepare scope owns the local `activeAgentProfile` (line 150);
          // graphState doesn't exist here (only invoke-model gets that).
          const allowedTools = filterMcpToolsForAgent([...getAllTools(), ...mcpTools], activeAgentProfile);
          // Stable tool set (design audit A2): core tools always; extension
          // groups (browser / documents / media) activate on a hint and then
          // stay for the rest of the chat, so the definitions array only grows
          // and the provider prefix cache survives routing changes. Search
          // routing is prompt text only (buildSearchRoutingPrompt).
          const latestAttachments = chat.messages?.at(-1)?.attachments || [];
          const wantedGroups = wantedToolGroups({
            text: latestUserMessage, attachments: latestAttachments, history: chat.messages || [], searchPlan, env,
            hasImageIntent: detectImageIntent(latestUserMessage, { hasInputImage: latestAttachments.some(a => a?.kind === 'image') }),
          });
          const activatedGroups = nextActivatedGroups(chat.toolGroupsActivated, wantedGroups);
          if (activatedGroups.join(',') !== (Array.isArray(chat.toolGroupsActivated) ? [...chat.toolGroupsActivated].sort().join(',') : '')) {
            chat.toolGroupsActivated = activatedGroups;
            await persistChatRuntimeFields(chat, ['toolGroupsActivated'], { home }).catch(() => {});
          }
          const stableTools = selectStableTools(allowedTools, activatedGroups)
            // Browser tools keep their CDP gate from the old router.
            .filter(tool => !/^browser_/.test(String(tool.id)) || env.MELO_CDP_ENABLED === '1');
          promptTools = toolsForCapabilityScope([...stableTools, ...skillTools],context.capabilityScope).filter(t=>t.id!=='delegate'||activeAgentProfile.collaboration.canDelegate&&activeAgentProfile.collaboration.delegateTargets.length>0);
          visibleToolIds = new Set(promptTools.map(tool => tool.id).filter(Boolean));
        }
        searchPlan = constrainSearchPlan(searchPlan, { toolIds: [...visibleToolIds],
          nativeSearch: config.authMode === 'codex' && nativeFeaturesForScope(context.capabilityScope).nativeWebSearchEnabled });
        toolsPrompt = buildSearchRoutingPrompt(searchPlan);
        const functionSession = createFunctionCallingSession({ ...config, baseUrl: modelOverrides.baseUrl,
          toolCalling: env.MELO_FUNCTION_CALLING || config.toolCalling }, promptTools);
        toolsPrompt = [toolsPrompt, buildToolsSystemPrompt(promptTools, { includeExamples: false, native: functionSession.native, protocol: functionSession.protocol })].filter(Boolean).join('\n\n');
        if (toolContextPolicy.mode === 'none') {
          toolsPrompt = [toolsPrompt, 'This is a self-contained text task. Answer directly from the user-provided context or basic knowledge; no tools are exposed for this turn. If information is missing, say so.'].filter(Boolean).join('\n\n');
        }
        if (promptDebug) process.stdout.write(`[tool-context] ${JSON.stringify(toolContextPolicy)}\n`);

        // Standalone greetings need no retrieval or embedding. A short confirmation
        // in an ongoing task ("好" / "ok") still keeps its full context.
        const skipMemory = activeAgentProfile.contextSources?.memory === false || classification.riskLevel === 'normal' && intent === 'casual' &&
          !(chat.messages?.at(-1)?.attachments?.length) &&
          /^(?:hi|hello|hey|thanks|thank you|你好|嗨|谢谢)[\s!.?。！？]*$/i.test(String(latestUserMessage).trim());
        // Project memory book + personal profile (design 2B): stable blocks for
        // local chats only — never for a remote channel audience, never when the
        // agent has memory switched off. Their rows are reported in memoryUsage
        // and excluded from the per-turn recall so the corrections group and the
        // Hot Attic do not repeat them; they are NOT recall feedback (bug audit
        // M8: 50 stable rows × every turn made every book row "hot").
        const stableMemoryAllowed = !isRemoteChannel && isLocalChat(chat) && activeAgentProfile.contextSources?.memory !== false;
        const projectBook = stableMemoryAllowed && project?.id
          ? measureStageSync('memory.project-book', () => { try { return renderProjectBook(listProjectBook(project.id)); } catch (error) { console.warn(`[memory.book] ${error.message}`); return { text: '', rows: [] }; } })
          : { text: '', rows: [] };
        const personalProfile = stableMemoryAllowed
          ? measureStageSync('memory.personal-profile', () => { try { return renderPersonalProfile(listPersonalProfile()); } catch (error) { console.warn(`[memory.profile] ${error.message}`); return { text: '', rows: [] }; } })
          : { text: '', rows: [] };
        const stableMemoryRows = [
          ...projectBook.rows.map(row => ({ ...row, kind: 'project-book' })),
          ...personalProfile.rows.map(row => ({ ...row, kind: 'personal-profile' })),
        ];
        // Bug audit M9: a fact of this chat that is rendered in a stable block —
        // promoted to the project book / personal profile, or mirrored there as
        // `book:<id>` — is not repeated in the Session Memory block.
        const stableRenderedIds = new Set(stableMemoryRows.map(row => row.id));
        const inStableBlock = f => stableRenderedIds.has(f.id) || stableRenderedIds.has(`book:${f.id}`);
        const sessionFacts = skipMemory ? [] : selectSessionMemoryFacts(resolveSessionFacts(chat,activeAgentProfile?.id).filter(f => !inStableBlock(f)));
        const sessionMemoryBlock = formatSessionMemoryBlock(sessionFacts);
        const memoryCandidates = [], memoryRendered = sessionFacts.map(f=>({
          id:f.id,text:f.fact,kind:'session-fact',renderedText:`- [${f.category}] ${f.fact}`,
        }));
        memoryCandidates.push(...memoryRendered);
        memoryRendered.push(...stableMemoryRows);
        const excludedFacts = [...sessionFacts, ...stableMemoryRows];
        // audit C-12: bound the query embedding (worker default is 60s); recall
        // degrades to keyword matching rather than stalling the whole turn.
        const queryEmbedding = skipMemory ? null : await measureStage('memory.embedding', () => Promise.race([
          embedQuery(latestUserMessage,config),
          new Promise(resolve => { const t = setTimeout(() => resolve(null), 2500); t.unref?.(); }),
        ])).catch(()=>null);
        // Remote audience boundary (design §3.4 M7): the channel name reaches
        // the store so audience=local rows are dropped in SQL, not only by the
        // JS `canRecallMemory` filter. Desktop/mobile owner chats pass 'desktop'.
        const memoryAudience = isRemoteChannel ? String(channelContext?.channelId || chat.source || 'remote')
          : (isLocalChat(chat) ? 'desktop' : String(chat.source || 'remote'));
        const memoryContext = skipMemory ? '' : measureStageSync('memory.recall', () => buildAgentMemoryNodeContext({
          state,chat,latestUserMessage,activeAgentProfile,project,queryEmbedding,env,audience:memoryAudience,
          // audit C-12: exclude from recall only the messages that will actually
          // be sent — a preliminary history-only fit, not the wider pre-fit window.
          includedMessageIds:modelMessageSourceIds(fitRequestContext({ sections: [], messages: modelMessages, ...contextBudget }).messages), excludedFacts,
          onRecall:rows=>memoryRendered.push(...rows),onCandidates:rows=>memoryCandidates.push(...rows),
        }));

        // Demon authoring is temporarily retired (user request, 2026-10-07).
        // Existing saved visualizations remain readable. File citations are
        // independent of that retired toggle and retain their existing UI.
        const vizInstructions = '';
        const hasProjectFiles =
          !isRemoteChannel &&
          Array.isArray(workspace?.filePaths) &&
          workspace.filePaths.length > 0;
        const citationInstructions = buildCitationInstructions({
          enabled: !isRemoteChannel,
          isRemoteChannel,
          hasProjectFiles,
        });

        const selectedMaterials = isRemoteChannel || activeAgentProfile.contextSources?.knowledge === false ? '' : await retrieveKnowledgeContext({state,chat,home:context.home,query:latestUserMessage,signal,onRetrieved:rows=>sseEmitter?.('execution_event',{kind:'pipeline',id:'knowledge:retrieval',module:'compute',name:'知识片段检索',status:'completed',output:rows.map(r=>`${r.title} [${r.start}-${r.end}]`).join('\n')})});
        refreshCompactContext({ readHistory: visibleToolIds.has('read_history') });
        const buildPromptSections = () => buildReActPromptSections({
          config,
          profile: activeAgentProfile,
          modePrompt: modeDef.prompt,
          projectContext,
          projectMemoryBook: projectBook.text,
          personalProfile: personalProfile.text,
          selectedMaterials,
          channelPrompt,
          memoryContext,
          toolRoutingPrompt,
          connectorPrompts,
          skillsPrompts,
          dynamicContext,
          compactContext,
          topicExcerpts: topicExcerpts.text,
          toolsPrompt,
          sessionMemoryBlock,
          languageConstraint: buildLanguageConstraint(latestUserMessage),
          dateContext: buildDateChangeNote(chat.messages),
          vizInstructions,
          citationInstructions,
          kind: 'chat',
          isRemoteChannel,
          intent: classification,
        });
        let promptSections = buildPromptSections();
        // Budget math (audit L4): measure what the request needs before any
        // history — required sections plus tool definitions — and shrink the
        // history window to what the input limit really leaves. With a local
        // 16k input and ~7.5k of required prompt the nominal 12k window used
        // to be cut back by the fitter, dropping history the compaction
        // trigger had never seen. When the effective window is smaller the
        // pending history is compacted against it now, in the turn, instead
        // of after the loss.
        const requiredTokens = requiredPromptTokens({ sections: promptSections, toolDefinitions: functionSession.definitions });
        historyWindowTokens = effectiveHistoryWindow(contextBudget, requiredTokens);
        if (historyWindowTokens < contextBudget.windowTokens) modelMessages = buildModelMessagesFromChat(modelChat(), { windowTokens: historyWindowTokens, toolChainProtocol });
        const fit = () => fitRequestContext({ sections: promptSections, messages: modelMessages, toolDefinitions: functionSession.definitions, ...contextBudget, turnContextPlacement });
        let preparedRequest = fit();
        // The fitter knows exactly what the optional recall blocks took; the
        // history window is refined to the room that is actually left.
        const historyRoom = () => contextBudget.inputLimit - (preparedRequest.diagnostics.inputTokens - estimateMessagesTokens(preparedRequest.messages)) - 512;
        historyWindowTokens = Math.max(1024, Math.min(historyWindowTokens, historyRoom()));
        // Safety net for P0-2 / audit L4: when the fitter had to drop history
        // (the prompt + tools left less room than the nominal window assumed),
        // summarise the overflow now instead of silently losing it, keeping
        // exactly the recent turns that fit the effective window. One forced
        // pass per turn; the circuit breaker inside planIncrementalCompact
        // still applies. The prompt is rebuilt so the new card is in it.
        if (preparedRequest.diagnostics.droppedMessages > 0 && hasModelConfig && !compactedThisTurn) {
          const keep = Math.max(2, buildRecentWindow(chat.messages, historyWindowTokens, 2).length);
          const forcedPlan = planIncrementalCompact(chat, { triggerTokens: 0, minKeep: keep, maxChunkTokens: contextBudget.compactChunkTokens });
          if (forcedPlan && await runCompact(forcedPlan)) {
            refreshCompactContext({ readHistory: visibleToolIds.has('read_history') });
            promptSections = buildPromptSections();
            preparedRequest = fit();
            historyWindowTokens = Math.max(1024, Math.min(historyWindowTokens, historyRoom()));
          }
        }
        if (preparedRequest.diagnostics.droppedMessages > 0) {
          process.stderr.write(`[prompt-budget] chat ${chat.id}: ${preparedRequest.diagnostics.droppedMessages} history message(s) did not fit the request (inputTokens≈${preparedRequest.diagnostics.inputTokens}, limit ${contextBudget.inputLimit})\n`);
        }
        preparedRequest.diagnostics.requiredTokens = requiredTokens;
        preparedRequest.diagnostics.historyWindowTokens = historyWindowTokens;
        if (promptDebug) process.stdout.write(`[prompt-budget] ${JSON.stringify(preparedRequest.diagnostics)}\n`);

        return {
          intent,
          classification,
          toolContextPolicy,
          allowLiveSpeech,
          promptSections: preparedRequest.sections,
          promptDiagnostics: preparedRequest.diagnostics,
          memoryCandidates, memoryRendered,
          memoryUsage: [],
          systemPrompt: preparedRequest.systemPrompt,
          turnContext: preparedRequest.turnContext,
          modelMessages: preparedRequest.messages,
          memoryContext,
          dynamicContext,
          projectContext,
          activeAgentProfile,
          skillTools,
          mcpTools,
          promptTools,
          searchPlan,
          visibleToolIds: [...visibleToolIds],
          next: 'invoke-model',
        };
      },

      // ── invoke-model ───────────────────────────────────────────────────────
      // Implements a ReAct tool loop:
      //   1. Call model with current messages
      //   2. Read native function calls (or legacy text calls on other providers)
      //   3. If tool calls exist: execute them, append results, loop (max 10)
      //   4. If no tool calls (or max iterations reached): proceed to finalize
      async 'invoke-model'(graphState) {
        const selectedModel = modelOverrides.model || graphState.activeAgentProfile.model || config.model;
        const delegatedModelConfig = { ...config, ...modelOverrides, model: selectedModel, modelResolvedForTurn: true,
          toolCalling: env.MELO_FUNCTION_CALLING || config.toolCalling };
        const teamTask = state.tasks?.find(t=>t.execution?.requestId===context.requestId && t.execution?.teamPlan);
        if (teamTask || teamPlan) {
          const team = await runAgentTeam({extraTools:[...(graphState.skillTools||[]),...(graphState.mcpTools||[])],plan:teamTask?.execution.teamPlan || teamPlan,task:teamTask?.execution.content || latestUserMessage,config:delegatedModelConfig,workspacePath:workspace?.rootPath,signal,sseEmitter,chatId:chat.id,allowedToolIds:graphState.visibleToolIds || [],capabilities:context.capabilityScope.capabilities,agentProfiles:Object.fromEntries(Object.keys(state.agentProfiles).map(id=>[id,effectiveAgentProfile(state,id,chat.projectId)])),lead:graphState.activeAgentProfile,background:buildMemberBackground({chat,projectContext:graphState.projectContext}),chatSource:chat.source || 'desktop',projectId:chat.projectId});
          modelResponses.push(...team.results.flatMap(r=>r.receipts),...team.summaryReceipts);
          // The lead's summary is the reply; member handoffs stay in the execution record.
          return {reply:team.summary,team,toolResults:[...team.results.map(r=>({toolCallId:`team:${r.role}:${r.round||1}`,toolName:`成员 ${r.name||r.role}`,ok:r.ok,...(!r.ok ? {errorCode:r.cancelled?'ABORTED':'ROLE_FAILED'} : {})})),...team.results.flatMap(r=>(r.meta?.toolResults || []).map(t=>({...t,toolCallId:`team:${r.role}:${t.toolCallId}`})))],next:'finalize'};
        }
        if (env.MELO_DEBUG_VISION === '1') {
          for (const [index, message] of graphState.modelMessages.entries()) {
            process.stdout.write(`${formatModelMessageForVisionDebug(message, index)}\n`);
          }
        }

        // ── Image-edit fast path ──────────────────────────────────────────────
        // Short-circuit the agent ReAct loop when the user has uploaded an
        // image AND clearly asked to edit it (Codex auth + workspace required).
        // The dedicated two-stage pipeline (vision analysis → image edit) runs
        // OUTSIDE the agent system prompt so the model isn't drowning in
        // memory/project/retrieval context while trying to edit an image.
        // See imageEditFastPath.js for the gating + pipeline. Failures /
        // gate misses return null; we fall through to the normal loop and
        // the agent decides what to do (apologise, re-route, etc.).
        const task = inferImageTask(latestUserMessage, graphState.modelMessages, imageTask);
        const taskMessage = chat.messages.filter(m => m.role === 'user').at(-1);
        // Image references are matched against model parts by URL, so the task
        // attachments use the same hydrated data URLs as the model window.
        const attachments = await hydrateAttachments(taskMessage?.attachments || [], { home });
        if (task && taskMessage) {
          taskMessage.metadata = {...taskMessage.metadata,imageTask:task};
          await onImageTaskResolved?.(task);
        }
        if (task && task.action !== 'analyze' && !scopeAllowsTool(context.capabilityScope,'image',{action:'generate'})) return {reply:'此 Agent 未开启生成媒体能力。请在 Agent 设置中开启后重试。',next:'finalize'};
        if (task && task.action !== 'analyze') {
          const reply = await runImageTask({task,config,messages:graphState.modelMessages,attachments,workspace,signal,sseEmitter,onDelta,onImageProgress,selectedModel,home});
          return {reply,next:'finalize'};
        }
        if (task?.action === 'analyze') {
          const references = new Map(task.references.map(ref => [attachments.find(a => a.id === ref.attachmentId)?.url,ref]));
          const decorated = graphState.modelMessages.map((message, index, all) => index === all.length-1 && Array.isArray(message.content) ? {...message,content:message.content.map(part=>{
            if(part.type !== 'image_url') return part;
            const ref=references.get(part.image_url.url);
            return {...part,image_url:{...part.image_url,detail:task.detail,ocr:task.ocr,...(ref?{role:ref.role,crop:ref.crop}:{})}};
          })} : message);
          let serial=0;
          graphState.modelMessages = await prepareVisionInputs(decorated,{signal,detail:task.detail,onObservation:e=>sseEmitter?.('execution_event',{kind:'pipeline',id:`vision-prepare:${++serial}`,module:'compute',status:'completed',...e})});
        }
        const latestParts=graphState.modelMessages.filter(m=>m.role==='user').at(-1)?.content;
        const vision = Array.isArray(latestParts) && latestParts.some(p=>p.type==='image_url') ? visionConnection(config,{...modelOverrides,model:selectedModel}) : null;
        const fastPathReply = task?.action === 'analyze' || !scopeAllowsTool(context.capabilityScope,'image',{action:'generate'}) ? null : await tryImageEditFastPath({
          config: { ...config, model:selectedModel },
          messages: graphState.modelMessages,
          workspace,
          signal,
          onDelta,
          sseEmitter,
        });
        if (typeof fastPathReply === 'string' && fastPathReply.trim()) {
          return { reply: fastPathReply, next: 'finalize' };
        }

        // Shared with the iPhone loop (shared/protocol/agent-loop.json).
        const MAX_TOOL_ITERATIONS = AGENT_LOOP_CONTRACT.loop.maxIterations;
        const functionSession = createFunctionCallingSession({ ...delegatedModelConfig, ...(vision || {}),
          toolCalling: env.MELO_FUNCTION_CALLING || config.toolCalling }, graphState.promptTools);
        const loopSections = graphState.promptSections.map(section => section.id === 'tools' && graphState.promptTools.length
          ? { ...section, text: [buildSearchRoutingPrompt(graphState.searchPlan), buildToolsSystemPrompt(graphState.promptTools,
            { includeExamples: false, native: functionSession.native, protocol: functionSession.protocol })].filter(Boolean).join('\n\n') } : section);
        // Running message list for the tool loop — starts from the prepared window.
        let loopMessages = [...graphState.modelMessages];
        let finalReply = '';
        let terminalReason = '';
        // G-1d slice 2 (2026-05-12): accumulate per-tool-call structured
        // metadata across loop iterations so the persisted assistant
        // message can carry the evidenceTrail history of all tools that
        // ran while producing this reply.  Without this, the trail dies
        // when activeToolCalls is filtered out 1.8s after completion
        // (G-1f window) — users翻 chat history 看不到当时哪条 tier 失败了.
        // Each entry: { toolCallId, toolName, ok, evidenceTrail? }.
        const accumulatedToolResults = [];
        // Protocol-neutral IR of every tool turn (design audit E1), persisted
        // as `metadata.toolChain` on the assistant message. Arguments are the
        // redacted projection; outputs are bounded by buildToolChainRecord.
        const toolChainTurns = [];
        const evidencePairs = [];
        // agent-loop-audit #1: identical failing calls are answered locally
        // after two consecutive failures instead of re-executed.
        // Per-turn constants for tool dispatch (2026-10-17 tool-path
        // optimisation): these used to be rebuilt on every loop iteration —
        // including an effectiveAgentProfile merge for every agent and the
        // member background text — although none of them change within a turn.
        const skillToolsById = new Map((graphState.skillTools || []).map(t => [t.id, t]));
        // MCP tools resolve by id (`mcp:s:t`, XML prompt) or wire name (`mcp__s__t`).
        const mcpToolsByName = indexMcpTools(graphState.mcpTools || []);
        const visibleToolIds = new Set(graphState.visibleToolIds || []);
        const allowedToolIdList = [...visibleToolIds];
        const coreTurn = createCoreTurn({ runId: String(context.requestId), turnId: chat.id,
          allowedTools: allowedToolIdList, limits: { rounds: MAX_TOOL_ITERATIONS, timeoutMs: Math.max(1, Math.ceil(remainingMs(budget))) } });
        let allowedDispatchTools = null;
        let dispatchAgentProfiles = null;
        let dispatchMemberBackground = null;
        const dispatchConstants = () => {
          allowedDispatchTools ??= new Set(filterMcpToolsForAgent([...getAllTools(), ...mcpToolsForAgent(graphState.activeAgentProfile)], graphState.activeAgentProfile).map(t => t.id));
          dispatchAgentProfiles ??= Object.fromEntries(Object.keys(state.agentProfiles).map(id=>[id,effectiveAgentProfile(state,id,chat.projectId)]));
          dispatchMemberBackground ??= buildMemberBackground({ chat, projectContext: graphState.projectContext });
          return { allowedDispatchTools, dispatchAgentProfiles, dispatchMemberBackground };
        };

        for (let iteration = 0; ; iteration++) {
          // On subsequent iterations, we're streaming "thinking" not the final
          // reply, so suppress onDelta to avoid emitting partial tool-loop text.
          const isFirstIteration = iteration === 0;
          // Supplements typed while this turn runs join before the next model call,
          // keeping every step already done.
          if (!isFirstIteration) {
            const supplements = takeSupplements(chat.id);
            if (supplements.length) {
              loopMessages = [...loopMessages, { role: 'user', content: supplementMessage(supplements), isSupplement: true }];
              for (const entry of supplements) sseEmitter?.('execution_event', { kind: 'pipeline', id: `supplement:${entry.id}`, name: '收到补充', module: 'compute', status: 'completed', output: entry.text });
            }
          }

          let request;
          try {
            request = fitRequestContext({ sections: loopSections, messages: loopMessages, toolDefinitions: functionSession.definitions, ...contextBudget, turnContextPlacement });
          } catch (error) {
            // audit C-8: a long tool loop must not die after the tools already
            // ran. Condense older tool outputs in this turn's chain and retry
            // once; only then surface the budget error.
            if (error?.code !== 'CONTEXT_BUDGET_EXCEEDED' || iteration === 0) throw error;
            const condensed = compactToolChain(loopMessages);
            if (!condensed.changed) throw error;
            loopMessages = condensed.messages;
            sseEmitter?.('execution_event', { kind: 'pipeline', id: `tool-chain:condense:${iteration}`, module: 'compute', name: '工具结果已压缩', status: 'completed', output: '早期工具输出已压缩以继续本轮。' });
            request = fitRequestContext({ sections: loopSections, messages: loopMessages, toolDefinitions: functionSession.definitions, ...contextBudget, turnContextPlacement });
          }
          if (promptDebug) process.stdout.write(`[prompt-budget] iteration=${iteration} ${JSON.stringify(request.diagnostics)}\n`);
          if (isFirstIteration) {
            signal?.throwIfAborted();
            const used = (graphState.memoryRendered || []).filter(row=>row.renderedText && request.promptText.includes(row.renderedText));
            graphState.memoryUsage = [...new Map(used.map(row=>[row.id,{
              id:row.id,text:String(row.text).slice(0,200),kind:row.kind,
              sourceChatId:row.metadata?.chatId || chat.id,
              sourceMessageId:row.metadata?.sourceMessageId || row.metadata?.messageId || null,
            }])).values()].slice(0,40);
            // Only rows that were actually rendered count as candidates (design
            // audit M6): every recalled row used to be recorded, inflating
            // memory_hits and skewing dreaming's recall gate. Stable blocks
            // (project book / personal profile) are reported in memoryUsage only
            // (bug audit M8): they are on every turn by design, so counting them
            // as hits made every book row hot within five turns.
            const feedbackRows = (graphState.memoryRendered || []).filter(row => !STABLE_MEMORY_KINDS.has(row.kind));
            try { recordMemoryFeedback({candidates:feedbackRows,usedIds:used.filter(row => !STABLE_MEMORY_KINDS.has(row.kind)).map(row=>row.id),
              requestId:`${chat.id}:${context.requestId}`,query:latestUserMessage}); }
            catch(error) { console.warn(`[memory.feedback] ${error.message}`); }
          }
          // Run budget (C1): checked before every provider call so a turn
          // whose tools or earlier rounds ate the pool ends with an explicit
          // reply instead of one more request that times out.
          // Bug audit U13: the scene stage is `failed` (the UI renders it as a
          // warning, not a ✓) and limit/used live in `output`, which the scene
          // keeps; a bare `budget` field would be dropped by applyExecutionEvent.
          const emitBudgetExhausted = exhausted => {
            terminalReason = 'BUDGET_EXHAUSTED';
            const limitText = exhausted.reason === 'deadline' ? `${Math.round(exhausted.used / 1000)}s / ${Math.round(exhausted.limit / 1000)}s` : `${exhausted.used} / ${exhausted.limit}`;
            sseEmitter?.('execution_event', { kind: 'pipeline', id: 'budget:exhausted', module: 'compute', name: '运行预算已用完', status: 'failed',
              output: `已达到运行预算（${describeBudgetReason(exhausted)}，已用 ${limitText}），本轮停止。已用：模型请求 ${exhausted.usage.providerCalls} 次、输入约 ${exhausted.usage.inputTokens} token、工具调用 ${exhausted.usage.toolCalls} 次。`,
              budget: { code: exhausted.code, reason: exhausted.reason, limit: exhausted.limit, used: exhausted.used, usage: exhausted.usage } });
          };
          const exhausted = budgetExhausted(budget);
          if (exhausted) {
            emitBudgetExhausted(exhausted);
            finalReply = budgetExhaustedReply(exhausted);
            break;
          }
          if (coreTurn.update('request') !== 'running') { finalReply = coreTurn.reply(latestUserMessage); break; }
          let rawReply;
          try {
            rawReply = await createReply({
            ...functionSession.requestOptions(),
            authMode: vision?.authMode || config.authMode,
            apiProtocol: vision?.apiProtocol || config.apiProtocol,
            apiKey: vision?.apiKey ?? modelOverrides.apiKey,
            baseUrl: vision?.baseUrl || modelOverrides.baseUrl,
            model: vision?.model || selectedModel,
            systemPrompt: request.systemPrompt,
            messages: attachTurnContextToMessages(request.messages, request.turnContext),
            cacheScope: `${agentId}:${chat.id}`,
            signal,
            onDelta: isFirstIteration ? onDelta : undefined,
            onReasoningDelta,
            providerProfile,
            // Workspace path enables inline image generation through the
            // Codex OAuth chat stream (createCodexResponsesReply adds the
            // image_generation tool when this is truthy and writes the
            // resulting bytes into <workspace>/generated/). For non-Codex
            // providers this parameter is currently ignored.
            //
            // Native provider features obey the Agent capability snapshot.
            workspacePath: workspace?.rootPath || null,
            // Stable across turns (A2): the native web_search definition is
            // present whenever the agent may use the network; whether to use
            // it this turn is said in the routing prompt. Only an explicit
            // user network-off or a non-Codex route keeps it off.
            nativeWebSearchEnabled: nativeFeaturesForScope(context.capabilityScope).nativeWebSearchEnabled && !['user-disabled-network', 'user-disabled-search'].includes(graphState.searchPlan?.reason),
            nativeImageGenerationEnabled: scopeAllowsTool(context.capabilityScope,'image',{action:'generate'}) && imageSettings(config).engine === 'codex-oauth',
            onExecutionEvent: event => {
              const observed = { ...event, id: event.id ? `${iteration}:${event.id}` : undefined };
              coreTurn.observeNative(observed);
              sseEmitter?.('execution_event', observed);
            },
          });
          } catch (error) {
            // Bug audit T7: the deadline most often lands in the middle of a
            // model request — the transport's AbortSignal.timeout throws a
            // TimeoutError. That is the budget running out, not a provider
            // failure, so it takes the budget path (event + "continue" reply)
            // instead of the generic "model request failed" card.
            if (signal?.aborted) throw error;
            const timedOut = error?.name === 'TimeoutError' || error?.code === 'ETIMEDOUT';
            const exhaustedNow = budgetExhausted(budget) || (budget && timedOut && remainingMs(budget) <= 1000 ? budgetExhausted(budget, budget.deadlineAt) : null);
            if (!exhaustedNow) throw error;
            emitBudgetExhausted(exhaustedNow);
            finalReply = budgetExhaustedReply(exhaustedNow);
            break;
          }

          const turn = functionSession.parse(rawReply);
          const { thinking, toolCalls } = turn;

          // No tool calls → this is the final response
          if (!toolCalls.length) {
            coreTurn.update('complete');
            finalReply = coreTurn.status === 'completed' ? turn.text : coreTurn.reply(latestUserMessage);
            break;
          }

          coreTurn.update('calls', { calls: toolCalls.map(call => ({ ...call, name: mcpToolsByName.get(call.name)?.id || call.name })) });
          if (coreTurn.status !== 'running') { finalReply = coreTurn.reply(latestUserMessage); break; }

          // Emit SSE event so the UI can show tool execution status
          if (typeof sseEmitter === 'function') {
            // Design audit D1: the UI gets the same redacted args the
            // ToolInvocationRecord stores — raw secrets never leave the loop.
            sseEmitter('tool_calls_start', {
              iteration,
              calls: toolCalls.map(c => ({ id: c.id, name: c.name, arguments: redactToolArgs(c.arguments) })),
            });
          }

          // Resolve tool objects: first check per-request skill tools built
          // in prepare (scoped to this agent), then fall back to the global
          // registry. Skill tools are prefixed `skill:` so they cannot
          // collide with regular tool ids.
          // Defence-in-depth: even though the prompt-level filter
          // already hides non-whitelisted MCP tools, a hallucinated
          // `mcp:<server>:<tool>` call must not slip through to the
          // dispatcher.  filterMcpToolsForAgent(...) returns the
          // allowed tools; we drop any tool call whose target was
          // filtered out.
          //
          // Phase 6 follow-up (2026-05-05): use `graphState.activeAgentProfile`
          // — `activeAgentProfile` was a bare reference to the variable
          // declared in the `'prepare'` node at line 150, which is a
          // separate async-method scope. Bare reference threw
          // ReferenceError "activeAgentProfile is not defined" the
          // moment the model emitted any tool call (text-only replies
          // skipped this branch and stayed silent). User-facing surface
          // was the providerErrors fallback "Melo could not complete
          // the model request right now. Details: …". Same fact also
          // accessible at lines 407 / 580 of this file via graphState.
          const { allowedDispatchTools, dispatchAgentProfiles, dispatchMemberBackground } = dispatchConstants();
          for (const tc of toolCalls) {
            if (tc.rejectedResult) continue;
            if (!coreTurn.permits(tc.id)) tc.rejectedResult = coreTurn.rejectionResult(tc.id);
          }
          const executableCalls = toolCalls.map(tc => {
            let tool = tc.rejectedResult ? null : skillToolsById.get(tc.name) || mcpToolsByName.get(tc.name) || getTool(tc.name);
            if (tool && !visibleToolIds.has(tool.id)) {
              tool = null;
            }
            if (tool && tool.id?.startsWith('mcp:') && !allowedDispatchTools.has(tool.id)) {
              tool = null;
            }
            return { id: tc.id, tool, args: tc.arguments, callRef: tc };
          });

          // Execute all calls (serial/parallel as per tool.isConcurrencySafe)
          const execResults = await executeToolCalls(
            executableCalls.filter(c => c.tool !== null),
            {
              sseEmitter,
              requestContext: context,
              executionPrefix: `${iteration}:`,
              meloHome: context.home,
              workspacePath: workspace?.rootPath,
              signal,
              chatId: chat.id,
              config: delegatedModelConfig,
              allowedToolIds: allowedToolIdList,
              agentDepth: 0,
              capabilities: context.capabilityScope.capabilities,
              extraTools: [...(graphState.skillTools || []), ...(graphState.mcpTools || [])],
              collaboration: graphState.activeAgentProfile.collaboration,
              agentProfiles: dispatchAgentProfiles,
              projectId: chat.projectId,
              chatSource: chat.source || 'desktop',
              agentId: graphState.activeAgentProfile?.id || agentId,
              // Delegated members get bounded conversation background with
              // their task (audit B-6); see agents/memberBackground.js.
              memberBackground: dispatchMemberBackground,
              onOutput: typeof sseEmitter === 'function'
                ? chunk => sseEmitter('tool_output', { chunk })
                : undefined,
            },
          );

          const callsById = new Map(toolCalls.map(tc => [tc.id, tc]));
          const resultsById = new Map(execResults.map(r => [r.id, r]));
          for(const execution of execResults) if(execution.result?.meta?.receipts) modelResponses.push(...execution.result.meta.receipts);
          // Also handle unresolved tool names (not in registry)
          const allResults = toolCalls.map(tc => {
            if (tc.rejectedResult) return { call: tc, result: tc.rejectedResult };
            const found = resultsById.get(tc.id);
            if (found) return { call: tc, result: found.result };
            return {
              call: tc,
              result: {
                ok: false,
                output: `Unknown tool: "${tc.name}". Available tools: ${
                  [...visibleToolIds].filter(Boolean).join(', ') || 'none'
                }`,
                error: 'UNKNOWN_TOOL',
              },
            };
          });

          // Append assistant turn (thinking + tool calls) and tool results.
          // Appending first lets the records below capture the exact
          // model-facing output string instead of re-deriving it.
          loopMessages = functionSession.append(loopMessages, turn, allResults);
          const toolResultMessage = loopMessages[loopMessages.length - 1];
          // Tool images (web_screenshot `meta.modelImage`): shown to the model
          // as one extra user message after this batch's results on native
          // protocols; the XML protocol gets the text output only. Transient —
          // the persisted tool chain never carries the base64.
          const toolImages = functionSession.imagesOf(allResults);
          loopMessages = functionSession.appendToolImages(loopMessages, toolImages);
          toolChainTurns.push(functionSession.turnRecord(turn, allResults, { argumentsFor: call => redactToolArgs(call.arguments), images: toolImages }));

          // Design audit D1: one ToolInvocationRecord per call, written to
          // `<home>/desktop/execution-scenes/<runId>.tools.jsonl`. The SSE
          // `tool_calls_done` payload and the persisted toolResults entry
          // below are projections of this record; the jsonl line is the
          // only place the full model-facing output is kept.
          const modelFacingOutputs = modelFacingOutputsFor(toolResultMessage, allResults);
          const batchFinishedAt = Date.now();
          const toolRecords = allResults.map(({ call, result }) => {
            const execution = resultsById.get(call.id);
            const record = buildToolInvocationRecord({
              runId: context.runId, iteration, call, args: call.arguments, result,
              modelFacingOutput: modelFacingOutputs.get(call.id) || '',
              startedAt: execution?.startedAt ?? batchFinishedAt, finishedAt: execution?.finishedAt ?? batchFinishedAt,
              parallelGroup: execution?.parallelGroup ?? null,
            });
            appendToolInvocationRecord(record, { home: context.home });
            return { call, result, record };
          });

          // Emit SSE with results for UI.  G-1d slice 1.5 (2026-05-11):
          // forward `evidenceTrail` to the UI so devtools / debug overlay can
          // inspect which fallback tiers a search tool walked through.  Only
          // attach when a non-empty array was produced (slice 1 invariant
          // from executor.js).  Trail items are small JSON objects — no
          // need to truncate like `output`.
          if (typeof sseEmitter === 'function') {
            sseEmitter('tool_calls_done', {
              iteration,
              results: toolRecords.map(({ call, result, record }) => {
                const item = {
                  id: record.callId,
                  name: record.toolId,
                  ok: result.ok,
                  status: record.resultEnvelope.status,
                  output: result.output?.slice(0, 500), // truncate for SSE
                  argsHash: record.argsHash,
                  durationMs: record.durationMs,
                };
                if (Array.isArray(result.evidenceTrail) && result.evidenceTrail.length > 0) {
                  item.evidenceTrail = result.evidenceTrail;
                }
                // 2026-05-23 架构 audit #2 闭环: forward the unified
                // errorCode (SearchTask taxonomy) on the same debug channel
                // as evidenceTrail, so the live devtools overlay sees the
                // precise failure classification. Additive; null when N/A.
                const errorCode = deriveUnifiedErrorCode(call, result) || record.resultEnvelope.code;
                if (errorCode && !result.ok) {
                  item.errorCode = errorCode;
                }
                return item;
              }),
            });
          }

          // G-1d slice 2: accumulate structured tool-result metadata for
          // persistence on the eventual assistantMessage.  Projection
          // logic lives in `./toolResultProjection.js` so it has direct
          // unit-test coverage (Codex review on commit 1 flagged this as
          // a covered-by-hydration-only test gap — solved by extracting
          // the producer-side helper).
          for (const { call, result, record } of toolRecords) {
            accumulatedToolResults.push(projectToolResultForPersist(call, result, record));
            evidencePairs.push({ call, result, receivedAt: nowIso() });
          }
          if (evidencePairs.length > 8) evidencePairs.splice(0, evidencePairs.length - 8);
          // A cancelled turn stops here: its records are on disk for the
          // tool-trace replay (D2) and no further model request is sent.
          signal?.throwIfAborted();
          coreTurn.results(allResults);
          if (coreTurn.status !== 'running') {
            sseEmitter?.('execution_event', { kind: 'pipeline', id: 'core:stop', module: 'compute', name: '执行已停止', status: 'failed', output: coreTurn.reason });
            finalReply = coreTurn.reply(latestUserMessage);
            break;
          }

          // If the last iteration was tool calls only, the next pass will produce
          // the final prose reply. Continue loop.
        }

        // Exhaustion is not success; never publish a tool-call block as an answer.
        if (!finalReply) {
          finalReply = contractRegExp(AGENT_LOOP_CONTRACT.cjkPattern).test(latestUserMessage)
            ? AGENT_LOOP_CONTRACT.loop.toolLimitReply.zh
            : AGENT_LOOP_CONTRACT.loop.toolLimitReply.en;
        }

        // Only finalize may publish reply_text to the speech channel.
        const hadToolCalls = loopMessages.length > graphState.modelMessages.length;

        // G-1d slice 2: pass accumulated tool metadata through graphState so
        // the finalize node can attach it to normalizedReply → sendChatMessage
        // attaches it to the persisted assistantMessage.  Only emit when
        // non-empty so we don't pollute pure-text replies with empty arrays.
        const out = { completionForReply: reply => coreTurn.receipt(latestUserMessage, reply, terminalReason || coreTurn.reason), reply: finalReply, hadToolCalls, skipVerification: coreTurn.status === 'blocked', toolEvidence: collectVerificationEvidence(evidencePairs, { query: latestUserMessage }), next: 'finalize' };
        if (accumulatedToolResults.length > 0) {
          out.toolResults = accumulatedToolResults;
        }
        // Bug audit T15: the chain (≤24 KB per reply) is only persisted when
        // replay is enabled (MELO_TOOL_CHAIN_HISTORY=1 / config.toolChainHistory);
        // with replay off nothing reads it, so storing it only grows threads.
        if (toolChainTurns.length > 0 && (env.MELO_TOOL_CHAIN_HISTORY === '1' || config.toolChainHistory === true)) {
          out.toolChain = buildToolChainRecord(toolChainTurns, { protocol: functionSession.protocol });
        }
        return out;
      },

      // ── finalize ───────────────────────────────────────────────────────────
      // Combines the old parse-uncertainty / verify-uncertain-claim /
      // normalize-reply nodes.
      //
      // Verification sees fresh tool evidence and stays enabled for all channels.
      async 'finalize'(graphState) {
        sseEmitter?.('execution_event', { kind: 'pipeline', id: 'reply:format', name: '整理回答与引用', status: 'running', output: '处理返回文字、引用与消息格式' });
        const channelKind = isRemoteChannel ? 'remote' : 'desktop';
        const parsed = parseUncertaintyMarker(graphState.reply);
        const shouldVerify =
          !graphState.skipVerification && parsed.hasMarker &&
          intentRequiresVerification(graphState.classification || graphState.intent);

        if (env.MELO_VERIFY_DEBUG === '1') {
          process.stdout.write(
            `[verify] intent=${graphState.intent} hasMarker=${parsed.hasMarker} source=${parsed.source} background=${background}\n`,
          );
        }

        let finalReplyText = parsed.cleanReply;
        let verificationRecord = null;

        if (shouldVerify) {
          const verification = await verifyUncertainClaim({
            userMessage: latestUserMessage,
            assistantReply: parsed.cleanReply,
            uncertainClaim: parsed.uncertainClaim,
            contextBlocks: [graphState.memoryContext, graphState.dynamicContext, graphState.projectContext],
            toolEvidence: graphState.toolEvidence || [],
            config: { ...config, apiKey: modelOverrides.apiKey, baseUrl: modelOverrides.baseUrl },
            model:
              modelOverrides.verifier ||
              modelOverrides.model ||
              graphState.activeAgentProfile.model ||
              config.model,
            signal,
            _createReply: createReply,
          });

          if (env.MELO_VERIFY_DEBUG === '1') {
            process.stdout.write(
              `[verify] verdict=${verification.verdict} reason=${verification.reason}\n`,
            );
          }

          finalReplyText = applyVerificationToReply(parsed.cleanReply, verification, { channelKind });

          // Persist CORRECTED verdicts so future turns can recall past mistakes.
          // UNVERIFIED is not stored — it carries no actionable information.
          if (verification.verdict === 'CORRECTED' && verification.correction) {
            verificationRecord = {
              verdict: verification.verdict,
              claim: parsed.uncertainClaim,
              correction: verification.correction,
            };
          }
        }

        // Demon viz-spec extraction:
        //   - Runs BEFORE normalization so the `<viz-spec>` trailer never
        //     leaks through the markdown strip passes or ends up in the
        //     message history.
        //   - Never attaches a viz on remote channels — `isRemoteChannel`
        //     forces extractVizSpec to strip-only mode. New requests also
        //     use strip-only mode while Demon authoring is retired.
        const preNormalizeText = finalReplyText || graphState.reply || '';
        const vizExtraction = extractVizSpec(preNormalizeText, { enabled: false, isRemoteChannel });

        // Source-citation extraction:
        //   - Runs on the text AFTER legacy viz trailer
        //     removal so a viz block can't accidentally be parsed as cite.
        //   - On remote channels, every `<cite>` tag is collapsed to its
        //     inner quote text — TG/DC has no side drawer to open.
        //   - On desktop, the tags are kept (re-emitted in canonical form)
        //     so the frontend can render inline pills.
        const citationExtraction = extractCitations(
          vizExtraction.text,
          { isRemoteChannel },
        );
        const textForNormalization = citationExtraction.text;

        const rawNormalized = normalizeAssistantReplyForConversation(
          textForNormalization,
          { channelKind },
        );

        // Guard: if the model returned an empty or blank response, substitute a
        // safe fallback so the user never sees a silent blank message bubble.
        const normalizedReply =
          rawNormalized.content.trim()
            ? rawNormalized
            : normalizeAssistantReplyForConversation(
                isRemoteChannel
                  ? 'Sorry, I could not generate a response. Please try again.'
                  : 'I wasn\'t able to generate a response for this message. Please try again.',
                { channelKind },
              );

        // Attach the parsed viz to the normalized reply so sendChatMessage
        // can persist it on the assistantMessage. `null` when no viz was
        // emitted or the channel blocks visualizations.
        normalizedReply.viz = vizExtraction.viz || null;

        // Same for source citations (NotebookLM pins). Remote channels never
        // get citations — they are either empty (tags collapsed to text
        // before arriving here) or dropped for safety.
        normalizedReply.citations = isRemoteChannel
          ? []
          : citationExtraction.citations || [];
        // Retain the verified source form without changing existing channel renderers.
        if (textForNormalization.trim() !== normalizedReply.content) {
          normalizedReply.canonicalReply = textForNormalization.trim();
        }

        // G-1d slice 2: forward accumulated tool metadata (set by the
        // tool-loop node above) onto the normalized reply.  sendChatMessage
        // does the conditional spread onto the persisted assistantMessage —
        // empty / absent arrays produce no `toolResults` key on the message.
        normalizedReply.completion = graphState.completionForReply?.(preNormalizeText);
        normalizedReply.memoryUsage = graphState.memoryUsage || [];
        if (graphState.team) normalizedReply.team = graphState.team;
        if (Array.isArray(graphState.toolResults) && graphState.toolResults.length > 0) {
          normalizedReply.toolResults = graphState.toolResults;
        }
        if (graphState.toolChain) normalizedReply.toolChain = graphState.toolChain;
        // Budget diagnostics (audit L4): the background pre-compaction follows
        // the history window this turn actually had, not the nominal one.
        if (graphState.promptDiagnostics) normalizedReply.promptDiagnostics = graphState.promptDiagnostics;
        if (signal?.aborted) throw signal.reason || new Error('Request aborted');
        if (modelResponses.length) {
          normalizedReply.modelResponses = modelResponses;
          normalizedReply.usage = summarizePricedUsage(modelResponses, config.modelPricing);
        }
        sseEmitter?.('execution_event', { kind: 'pipeline', id: 'reply:format', status: 'completed', output: '回答格式与引用整理完成' });
        sseEmitter?.('reply_text', { text: normalizedReply.content, final: true });

        return {
          normalizedReply,
          verificationRecord,
          next: GRAPH_END,
        };
      },
    },
  });

  return runStateGraph(graph, {
    config,
    state,
    chat,
    workspace,
    connectors,
    skills,
    latestUserMessage,
    agentId,
    channelContext,
  });
}
