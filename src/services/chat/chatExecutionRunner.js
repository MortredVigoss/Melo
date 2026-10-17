import {resolveCapabilityContext} from '../agent/capabilityContext.js';
import {scopeAllowsTool,toolsForCapabilityScope,nativeFeaturesForScope,missingCapabilityScope} from '../../domain/agent/capabilityScope.js';
import {retrieveKnowledgeContext} from './knowledgeContext.js';
import { measureStage, measureStageSync, startStage } from '../../runtime/performanceTrace.js';
import { recordMemoryFeedback } from '../../memory/store.js';
import { resolveSessionFacts } from '../../memory/factRecords.js';
import { selectedMaterials } from './conversationSelection.js';
import { runAgentTeam } from '../../agents/team.js';
import { takeSupplements, supplementMessage } from './supplements.js';
import { summarizePricedUsage } from '../../runtime/usage.js';
import { observeModelReplies } from './executionPipeline.js';
import { persistCompactSnapshot } from './derivedState.js';
import { createRequestContext, requestIdentity } from '../../runtime/requestContext.js';
import { currentRequestContext, requestEnvironment, runWithRequestContext } from '../../runtime/requestScope.js';
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
import { buildModelMessagesFromChat, modelMessageSourceIds } from './messageBuilder.js';
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
import { createRepeatGuard } from '../../agents/repeatGuard.js';
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
} from '../../retrieval/searchRouter.js';
import {
  buildToolsSystemPrompt,
  shouldInjectToolsPrompt,
} from '../../tools/systemPrompt.js';
import { projectToolResultForPersist, deriveUnifiedErrorCode } from './toolResultProjection.js';
import { getTool, getAllTools } from '../../tools/registry.js';
import { executeToolCalls } from '../../tools/executor.js';
import { inferImageTask, runImageTask } from './imageTask.js';
import { visionConnection, imageSettings } from '../../images/imageSettings.js';
import { prepareVisionInputs } from '../../media/visionInputs.js';
import { createOpenAICompatibleReply } from '../../openai.js';
import { collectVerificationEvidence } from '../../retrieval/verificationEvidence.js';
import { fitRequestContext, resolveContextBudget, attachTurnContextToMessages } from './contextBudget.js';
import { selectToolContextPolicy, requiresSkillToolContext } from '../../retrieval/requestPolicy.js';
import { createFunctionCallingSession, compactToolChain } from '../../tools/functionCalling.js';
import { createCoreTurn } from '../../runtime/sharedAgentCore.js';
import { createHash } from 'node:crypto';

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
  // Captured once for the whole graph, including tools and verification.
  const turnTimeoutMs = _dependencies.turnTimeoutMs || 600_000;
  signal = AbortSignal.any([signal, context.signal, AbortSignal.timeout(turnTimeoutMs)].filter(Boolean));
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
  const createReply = options => {
    const endFirstToken = typeof options.onDelta === 'function' ? startStage('model.first_token') : null;
    return measureStage('model.request', () => observedReply({
      ...options,
      onDelta: endFirstToken ? (...args) => {
        if (args[0]?.delta || args[0]?.text) endFirstToken();
        return options.onDelta(...args);
      } : options.onDelta,
      onProviderResponse: receipt => { modelResponses.push(receipt); options.onProviderResponse?.(receipt); },
    }));
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
          cacheScope: JSON.stringify([context.home, activeAgentProfile.id, chat.projectId || null]),
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
        let modelMessages = buildModelMessagesFromChat(chat, { windowTokens: contextBudget.windowTokens });
        const searchPlan = buildSearchPlan({
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
        const runCompact = async compactPlan => {
          try {
            const { summary, source } = await compactConversationDetailed(compactPlan.messages, {
              config, signal, previousSummary: compactPlan.previousSummary, _createReply: createReply,
            });
            if (summary) {
              chat.compactSummary = compactPlan.truncated
                ? '[部分历史过长，摘要仅包含可容纳的片段；原文保留在对话记录中。]\n' + summary
                : summary;
              chat.compactBoundaryMessageId = compactPlan.boundaryId;
              chat.compactedMessageCount = compactPlan.compactedCount;
              chat.compactedAt = new Date().toISOString();
              chat.compactFailures = 0;
              // Provenance (audit C-6): a 'rule' summary is a degraded fallback.
              // The chat keeps moving, but the header says so and the next
              // turns retry the model (see upgradeDegradedCompact below).
              chat.compactSummarySource = source || 'cloud';
              chat.compactUpgradeAttempts = 0;
              if (source === 'rule') {
                process.stderr.write(`[compact] chat ${chat.id}: summarising model unavailable, using extractive fallback for ${compactPlan.compactedCount} messages\n`);
                sseEmitter?.('execution_event', { kind: 'pipeline', id: 'compact:degraded', module: 'compute', name: '对话摘要降级', status: 'completed', output: '摘要模型不可用，已使用抽取式摘要；后续轮次会自动重试。' });
              }
              // Persist so the summary survives restarts.
              await persistCompactSnapshot(chat, compactPlan, { home });
              modelMessages = buildModelMessagesFromChat(chat, { windowTokens: contextBudget.windowTokens });
              compactedThisTurn = true;
              return true;
            }
            chat.compactFailures = (chat.compactFailures || 0) + 1;
          } catch (error) {
            if (signal?.aborted) throw signal.reason || error;
            chat.compactFailures = (chat.compactFailures || 0) + 1;
          }
          return false;
        };

        // Retry the model for a degraded (extractive) summary: re-summarise the
        // already-compacted range once per turn, at most 3 times, with a short
        // timeout so a still-unreachable model cannot stall the reply.
        const upgradeDegradedCompact = async () => {
          if (!hasModelConfig || chat.compactSummarySource !== 'rule' || (chat.compactUpgradeAttempts || 0) >= 3) return;
          const boundaryIndex = chat.messages.findIndex(message => message.id === chat.compactBoundaryMessageId);
          if (boundaryIndex < 0) return;
          // Bound the re-summarised range to one compaction chunk (the common
          // case is a single compaction that landed while the model was down).
          const range = buildRecentWindow(chat.messages.slice(0, boundaryIndex + 1), 45_000, 2);
          chat.compactUpgradeAttempts = (chat.compactUpgradeAttempts || 0) + 1;
          const controller = new AbortController();
          const onAbort = () => controller.abort(signal?.reason);
          signal?.addEventListener('abort', onAbort, { once: true });
          const timer = setTimeout(() => controller.abort(new Error('compact upgrade timed out')), 20_000);
          try {
            const { summary, source } = await compactConversationDetailed(range, { config, signal: controller.signal, _createReply: createReply });
            if (summary && source === 'cloud') {
              chat.compactSummary = summary;
              chat.compactSummarySource = 'cloud';
              chat.compactedAt = new Date().toISOString();
              await persistCompactSnapshot(chat, { boundaryId: chat.compactBoundaryMessageId, compactedCount: chat.compactedMessageCount }, { home });
              sseEmitter?.('execution_event', { kind: 'pipeline', id: 'compact:upgraded', module: 'compute', name: '对话摘要已恢复', status: 'completed', output: '摘要模型恢复可用，已用完整摘要替换抽取式摘要。' });
            }
          } catch (error) {
            if (signal?.aborted) throw signal.reason || error;
          } finally {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
          }
          if (chat.compactSummarySource === 'rule') await persistCompactSnapshot(chat, { boundaryId: chat.compactBoundaryMessageId, compactedCount: chat.compactedMessageCount }, { home });
        };
        await upgradeDegradedCompact();

        const compactPlan = hasModelConfig
          ? planIncrementalCompact(chat, { triggerTokens: contextBudget.compactTriggerTokens })
          : null;
        if (compactPlan) await runCompact(compactPlan);

        // ── 5. Assemble system prompt ──────────────────────────────────────
        const compactContext = chat.compactSummary
          ? formatCompactContextBlock(chat.compactSummary, chat.compactedMessageCount || 0, { source: chat.compactSummarySource || 'cloud' })
          : '';

        // Build per-request skill tools for all enabled executable skills this
        // agent has access to. They are NOT registered globally — we pass them
        // through graph state so the invoke-model loop can resolve them by
        // name alongside the registry. This keeps concurrent chats isolated
        // (each chat sees only its own agent's skills).
        const skillTools = listExecutableSkills(enabledSkills)
          .map(buildSkillTool)
          .filter(Boolean);

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
          const allowedTools = filterMcpToolsForAgent(getAllTools(), activeAgentProfile);
          const routedTools = filterToolsForSearchPlan(allowedTools, searchPlan);
          promptTools = toolsForCapabilityScope([...routedTools, ...skillTools],context.capabilityScope).filter(t=>t.id!=='delegate'||activeAgentProfile.collaboration.canDelegate&&activeAgentProfile.collaboration.delegateTargets.length>0);
          visibleToolIds = new Set(promptTools.map(tool => tool.id).filter(Boolean));
        }
        const functionSession = createFunctionCallingSession({ ...config, baseUrl: modelOverrides.baseUrl,
          toolCalling: env.MELO_FUNCTION_CALLING || config.toolCalling }, promptTools);
        toolsPrompt = [toolsPrompt, buildToolsSystemPrompt(promptTools, { includeExamples: false, native: functionSession.native })].filter(Boolean).join('\n\n');
        if (toolContextPolicy.mode === 'none') {
          toolsPrompt = [toolsPrompt, 'This is a self-contained text task. Answer directly from the user-provided context or basic knowledge; no tools are exposed for this turn. If information is missing, say so.'].filter(Boolean).join('\n\n');
        }
        if (promptDebug) process.stdout.write(`[tool-context] ${JSON.stringify(toolContextPolicy)}\n`);

        // Standalone greetings need no retrieval or embedding. A short confirmation
        // in an ongoing task ("好" / "ok") still keeps its full context.
        const skipMemory = activeAgentProfile.contextSources?.memory === false || classification.riskLevel === 'normal' && intent === 'casual' &&
          !(chat.messages?.at(-1)?.attachments?.length) &&
          /^(?:hi|hello|hey|thanks|thank you|你好|嗨|谢谢)[\s!.?。！？]*$/i.test(String(latestUserMessage).trim());
        const sessionFacts = skipMemory ? [] : selectSessionMemoryFacts(resolveSessionFacts(chat,activeAgentProfile?.id));
        const sessionMemoryBlock = formatSessionMemoryBlock(sessionFacts);
        const memoryCandidates = [], memoryRendered = sessionFacts.map(f=>({
          id:f.id,text:f.fact,kind:'session-fact',renderedText:`- [${f.category}] ${f.fact}`,
        }));
        memoryCandidates.push(...memoryRendered);
        // audit C-12: bound the query embedding (worker default is 60s); recall
        // degrades to keyword matching rather than stalling the whole turn.
        const queryEmbedding = skipMemory ? null : await measureStage('memory.embedding', () => Promise.race([
          embedQuery(latestUserMessage,config),
          new Promise(resolve => { const t = setTimeout(() => resolve(null), 2500); t.unref?.(); }),
        ])).catch(()=>null);
        const memoryContext = skipMemory ? '' : measureStageSync('memory.recall', () => buildAgentMemoryNodeContext({
          state,chat,latestUserMessage,activeAgentProfile,project,queryEmbedding,env,
          // audit C-12: exclude from recall only the messages that will actually
          // be sent — a preliminary history-only fit, not the wider pre-fit window.
          includedMessageIds:modelMessageSourceIds(fitRequestContext({ sections: [], messages: modelMessages, ...contextBudget }).messages), excludedFacts:sessionFacts,
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

        const promptSections = buildReActPromptSections({
          config,
          profile: activeAgentProfile,
          modePrompt: modeDef.prompt,
          projectContext,
          selectedMaterials: isRemoteChannel || activeAgentProfile.contextSources?.knowledge === false ? '' : await retrieveKnowledgeContext({state,chat,home:context.home,query:latestUserMessage,signal,onRetrieved:rows=>sseEmitter?.('execution_event',{kind:'pipeline',id:'knowledge:retrieval',module:'compute',name:'知识片段检索',status:'completed',output:rows.map(r=>`${r.title} [${r.start}-${r.end}]`).join('\n')})}),
          channelPrompt,
          memoryContext,
          toolRoutingPrompt,
          connectorPrompts,
          skillsPrompts,
          dynamicContext,
          compactContext,
          toolsPrompt,
          sessionMemoryBlock,
          languageConstraint: buildLanguageConstraint(latestUserMessage),
          vizInstructions,
          citationInstructions,
          kind: 'chat',
          isRemoteChannel,
          intent: classification,
        });
        let preparedRequest = fitRequestContext({ sections: promptSections, messages: modelMessages, toolDefinitions: functionSession.definitions, ...contextBudget, turnContextPlacement });
        // Safety net for P0-2: if the system prompt + tools turned out larger
        // than the window share assumed and the fitter still had to drop
        // history, summarise the overflow now instead of silently losing it.
        // One forced pass per turn; the circuit breaker inside
        // planIncrementalCompact still applies.
        if (preparedRequest.diagnostics.droppedMessages > 0 && hasModelConfig && !compactedThisTurn) {
          const forcedPlan = planIncrementalCompact(chat, { triggerTokens: 0 });
          if (forcedPlan && await runCompact(forcedPlan)) {
            preparedRequest = fitRequestContext({ sections: promptSections, messages: modelMessages, toolDefinitions: functionSession.definitions, ...contextBudget, turnContextPlacement });
          }
        }
        if (preparedRequest.diagnostics.droppedMessages > 0) {
          process.stderr.write(`[prompt-budget] chat ${chat.id}: ${preparedRequest.diagnostics.droppedMessages} history message(s) did not fit the request (inputTokens≈${preparedRequest.diagnostics.inputTokens}, limit ${contextBudget.inputLimit})\n`);
        }
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
          const team = await runAgentTeam({extraTools:graphState.skillTools,plan:teamTask?.execution.teamPlan || teamPlan,task:teamTask?.execution.content || latestUserMessage,config:delegatedModelConfig,workspacePath:workspace?.rootPath,signal,sseEmitter,chatId:chat.id,allowedToolIds:graphState.visibleToolIds || [],capabilities:context.capabilityScope.capabilities,agentProfiles:Object.fromEntries(Object.keys(state.agentProfiles).map(id=>[id,effectiveAgentProfile(state,id,chat.projectId)])),lead:graphState.activeAgentProfile,background:buildMemberBackground({chat,projectContext:graphState.projectContext})});
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
        const attachments = taskMessage?.attachments || [];
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

        const MAX_TOOL_ITERATIONS = 10;
        const functionSession = createFunctionCallingSession({ ...delegatedModelConfig, ...(vision || {}),
          toolCalling: env.MELO_FUNCTION_CALLING || config.toolCalling }, graphState.promptTools);
        const loopSections = graphState.promptSections.map(section => section.id === 'tools' && graphState.promptTools.length
          ? { ...section, text: [buildSearchRoutingPrompt(graphState.searchPlan), buildToolsSystemPrompt(graphState.promptTools,
            { includeExamples: false, native: functionSession.native })].filter(Boolean).join('\n\n') } : section);
        // Running message list for the tool loop — starts from the prepared window.
        let loopMessages = [...graphState.modelMessages];
        let finalReply = '';
        // G-1d slice 2 (2026-05-12): accumulate per-tool-call structured
        // metadata across loop iterations so the persisted assistant
        // message can carry the evidenceTrail history of all tools that
        // ran while producing this reply.  Without this, the trail dies
        // when activeToolCalls is filtered out 1.8s after completion
        // (G-1f window) — users翻 chat history 看不到当时哪条 tier 失败了.
        // Each entry: { toolCallId, toolName, ok, evidenceTrail? }.
        const accumulatedToolResults = [];
        const evidencePairs = [];
        // agent-loop-audit #1: identical failing calls are answered locally
        // after two consecutive failures instead of re-executed.
        const repeatGuard = createRepeatGuard();
        // Per-turn constants for tool dispatch (2026-10-17 tool-path
        // optimisation): these used to be rebuilt on every loop iteration —
        // including an effectiveAgentProfile merge for every agent and the
        // member background text — although none of them change within a turn.
        const skillToolsById = new Map((graphState.skillTools || []).map(t => [t.id, t]));
        const visibleToolIds = new Set(graphState.visibleToolIds || []);
        const allowedToolIdList = [...visibleToolIds];
        const coreTurn = createCoreTurn({ runId: String(context.requestId), turnId: chat.id, allowedTools: allowedToolIdList, limits: { rounds: MAX_TOOL_ITERATIONS, timeoutMs: turnTimeoutMs } });
        let allowedDispatchTools = null;
        let dispatchAgentProfiles = null;
        let dispatchMemberBackground = null;
        const dispatchConstants = () => {
          allowedDispatchTools ??= new Set(filterMcpToolsForAgent(getAllTools(), graphState.activeAgentProfile).map(t => t.id));
          dispatchAgentProfiles ??= Object.fromEntries(Object.keys(state.agentProfiles).map(id=>[id,effectiveAgentProfile(state,id,chat.projectId)]));
          dispatchMemberBackground ??= buildMemberBackground({ chat, projectContext: graphState.projectContext });
          return { allowedDispatchTools, dispatchAgentProfiles, dispatchMemberBackground };
        };

        for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
          signal.throwIfAborted();
          if (coreTurn.update('request') !== 'running') break;
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
            try { recordMemoryFeedback({candidates:graphState.memoryCandidates,usedIds:used.map(row=>row.id),
              requestId:`${chat.id}:${context.requestId}`,query:latestUserMessage}); }
            catch(error) { console.warn(`[memory.feedback] ${error.message}`); }
          }
          const rawReply = await createReply({
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
            nativeWebSearchEnabled: nativeFeaturesForScope(context.capabilityScope).nativeWebSearchEnabled && graphState.searchPlan?.nativeWebSearchEnabled === true,
            nativeImageGenerationEnabled: scopeAllowsTool(context.capabilityScope,'image',{action:'generate'}) && imageSettings(config).engine === 'codex-oauth',
            onExecutionEvent: event => sseEmitter?.('execution_event', { ...event, id: event.id ? `${iteration}:${event.id}` : undefined }),
          });

          signal.throwIfAborted();
          const turn = functionSession.parse(rawReply);
          const { thinking, toolCalls } = turn;

          // No tool calls → this is the final response
          if (!toolCalls.length) {
            coreTurn.update('complete');
            finalReply = turn.text;
            break;
          }
          coreTurn.update('calls', { calls: toolCalls });

          // Emit SSE event so the UI can show tool execution status
          if (typeof sseEmitter === 'function') {
            sseEmitter('tool_calls_start', {
              iteration,
              calls: toolCalls.map(c => ({ id: c.id, name: c.name, arguments: c.arguments })),
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
            const repeated = repeatGuard.check(tc.name, tc.arguments);
            if (repeated) tc.rejectedResult = repeated;
          }
          const executableCalls = toolCalls.map(tc => {
            let tool = tc.rejectedResult ? null : skillToolsById.get(tc.name) || getTool(tc.name);
            if (!coreTurn.permits(tc.id)) tool = null;
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
              extraTools: graphState.skillTools,
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
          for (const execution of execResults) {
            const call = callsById.get(execution.id);
            if (call) repeatGuard.record(call.name, call.arguments, execution.result);
          }
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

          // Emit SSE with results for UI.  G-1d slice 1.5 (2026-05-11):
          // forward `evidenceTrail` to the UI so devtools / debug overlay can
          // inspect which fallback tiers a search tool walked through.  Only
          // attach when a non-empty array was produced (slice 1 invariant
          // from executor.js).  Trail items are small JSON objects — no
          // need to truncate like `output`.
          if (typeof sseEmitter === 'function') {
            sseEmitter('tool_calls_done', {
              iteration,
              results: allResults.map(({ call, result }) => {
                const item = {
                  id: call.id,
                  name: call.name,
                  ok: result.ok,
                  output: result.output?.slice(0, 500), // truncate for SSE
                };
                if (Array.isArray(result.evidenceTrail) && result.evidenceTrail.length > 0) {
                  item.evidenceTrail = result.evidenceTrail;
                }
                // 2026-05-23 架构 audit #2 闭环: forward the unified
                // errorCode (SearchTask taxonomy) on the same debug channel
                // as evidenceTrail, so the live devtools overlay sees the
                // precise failure classification. Additive; null when N/A.
                const errorCode = deriveUnifiedErrorCode(call, result);
                if (errorCode) {
                  item.errorCode = errorCode;
                }
                return item;
              }),
            });
          }

          // Append assistant turn (thinking + tool calls) and tool results
          loopMessages = functionSession.append(loopMessages, turn, allResults);

          // G-1d slice 2: accumulate structured tool-result metadata for
          // persistence on the eventual assistantMessage.  Projection
          // logic lives in `./toolResultProjection.js` so it has direct
          // unit-test coverage (Codex review on commit 1 flagged this as
          // a covered-by-hydration-only test gap — solved by extracting
          // the producer-side helper).
          for (const { call, result } of allResults) {
            accumulatedToolResults.push(projectToolResultForPersist(call, result));
            evidencePairs.push({ call, result, receivedAt: nowIso() });
            coreTurn.update('result', { callId: call.id, ok: result.ok === true,
              progressKey: createHash('sha256').update(call.name + '\n' + String(result.output || result.error || '')).digest('hex') });
          }
          if (evidencePairs.length > 8) evidencePairs.splice(0, evidencePairs.length - 8);
          if (coreTurn.status !== 'running') {
            sseEmitter?.('execution_event', { kind: 'pipeline', id: 'core:stop', module: 'compute', name: '执行已停止', status: 'blocked', output: coreTurn.reason });
            finalReply = /[\u3400-\u9fff]/.test(latestUserMessage)
              ? `本轮已停止（${coreTurn.reason}）。已有操作和回执已保留，尚未确认任务完成；请调整目标或补充信息后继续。`
              : `This turn stopped (${coreTurn.reason}). Existing actions and receipts are preserved; task completion is unverified. Please adjust the request or supply more information.`;
            break;
          }

          // If the last iteration was tool calls only, the next pass will produce
          // the final prose reply. Continue loop.
        }

        // Exhaustion is not success; never publish a tool-call block as an answer.
        if (!finalReply) {
          finalReply = /[\u3400-\u9fff]/.test(latestUserMessage)
            ? '本轮已达到工具执行上限，尚未完成核实。请缩小问题范围后继续；我不会把未完成的尝试当成结果。'
            : 'This turn reached its tool execution limit before verification finished. Please narrow the request; incomplete attempts are not confirmed results.';
        }

        // Only finalize may publish reply_text to the speech channel.
        const hadToolCalls = loopMessages.length > graphState.modelMessages.length;

        // G-1d slice 2: pass accumulated tool metadata through graphState so
        // the finalize node can attach it to normalizedReply → sendChatMessage
        // attaches it to the persisted assistantMessage.  Only emit when
        // non-empty so we don't pollute pure-text replies with empty arrays.
        const out = { reply: finalReply, hadToolCalls, toolEvidence: collectVerificationEvidence(evidencePairs, { query: latestUserMessage }), next: 'finalize' };
        if (accumulatedToolResults.length > 0) {
          out.toolResults = accumulatedToolResults;
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
          parsed.hasMarker &&
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
        normalizedReply.memoryUsage = graphState.memoryUsage || [];
        if (graphState.team) normalizedReply.team = graphState.team;
        if (Array.isArray(graphState.toolResults) && graphState.toolResults.length > 0) {
          normalizedReply.toolResults = graphState.toolResults;
        }
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
