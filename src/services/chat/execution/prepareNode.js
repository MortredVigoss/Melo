import { requestAllowsTool, getRequestNetworkPolicy } from '../../../../shared/agent/retrieval/requestPolicy.js';
import { isStandaloneGreeting } from '../../../../shared/agent/retrieval/intentRouter.js';
import { routingLabel } from '../../../../shared/agent/modelRouting.js';
import { createRoutingSession } from '../../modelRouting/routing.js';
import { resolveContextBudget } from '../contextBudget.js';
import { buildSharedSearchPlan } from '../../../retrieval/sharedSearchPlan.js';
import { resolveHostedSearchCapability } from '../../search/hostedSearchCapability.js';
// Chat execution graph — `prepare` node (architecture B2, 2026-10-20).
// Mechanical move out of chatExecutionRunner.js: the body below is the
// original node body, unchanged except for one indentation level. The
// runner-scoped bindings it closed over arrive through the turn object and
// are destructured under their original names; none is reassigned inside the
// node (checked by scope analysis before the move), so this is equivalent to
// the closure it replaces.
import { readExecutionContext } from '../executionScenes.js';
import { toolsForCapabilityScope, scopeAllowsTool } from '../../../domain/agent/capabilityScope.js';
import { retrieveKnowledgeContext } from '../knowledgeContext.js';
import { measureStage, measureStageSync } from '../../../runtime/performanceTrace.js';
import { resolveSessionFacts } from '../../../memory/factRecords.js';
import { isLocalChat } from '../../../memory/factPolicy.js';
import { listProjectBook, renderProjectBook } from '../../project/projectMemoryBook.js';
import { listPersonalProfile, renderPersonalProfile } from '../../memory/personalProfile.js';
import { persistCompactSnapshot, persistChatRuntimeFields, persistCompactFailure } from '../derivedState.js';
import { requestIdentity } from '../../../runtime/requestContext.js';
import { estimateMessagesTokens } from '../../../memory/tokenEstimate.js';
import { randomUUID } from 'node:crypto';
import { GRAPH_END } from '../../../agentGraph.js';
import { nowIso } from '../../../shared/helpers.js';
import { findProjectById } from '../../../state/stateLookups.js';
import { effectiveAgentProfile } from '../../../state/agentProfiles.js';
import { updateStateAtomically } from '../../../state/stateStore.js';
import { filterConnectorsForAgent, filterSkillsForAgent, filterMcpToolsForAgent, createSharedSkillIndexFactory } from '../../../domain/agent/agentTools.js';
import { buildAgentMemoryNodeContext } from '../../agent/agentMemoryContext.js';
import { buildToolRoutingPrompt } from '../../agent/toolRoutingPrompt.js';
import { buildChannelRoutePrompt } from '../../remote/channelRoutePrompt.js';
import { buildMatcherContextFromChat } from '../matcherContext.js';
import { buildModelMessagesFromChat, modelMessageSourceIds } from '../messageBuilder.js';
import { hydrateMessagesForModel } from '../../../media/attachments.js';
import { buildDynamicContext } from '../dynamicContext.js';
import { planChatGraphAction, buildApprovalResponse } from '../chatActionPlanning.js';
import { buildReActPromptSections, buildLanguageConstraint } from '../systemPrompt.js';
import { MODE_DEFS } from '../../../domain/chat/modeDefs.js';
import { summarizeConnectorPrompts } from '../../connector/connectorPrompts.js';
import { summarizeSkillsPrompts } from '../../skill/skillPrompts.js';
import { listExecutableSkills } from '../../../domain/skill/skillService.js';
import { buildProjectContextSection } from '../../project/projectContext.js';
import { normalizeApproval, normalizeApprovals } from '../../../domain/approval/approvalService.js';
import { normalizeAssistantReplyForConversation } from '../../../domain/message/messageBlocks.js';
import { buildCitationInstructions } from '../../viz/citation.js';
import { buildSkillIndex, defaultSkillMatchCache, matchSkillsForMessage } from '../../../agents/skillMatcher.js';
import { getSkillLastRunMap } from '../../../agents/skillRuns.js';
import { wantedToolGroups, nextActivatedGroups, selectStableTools } from '../../../tools/toolGroups.js';
import { buildSkillTool } from '../../../agents/skillExecutor.js';
import { planIncrementalCompact, compactConversationDetailed, formatCompactContextBlock, buildRecentWindow } from '../../../memory/contextCompact.js';
import { formatSessionMemoryBlock, selectSessionMemoryFacts } from '../../../memory/sessionMemory.js';
import { classifyRequest } from '../../../retrieval/intentRouter.js';
import { buildSearchRoutingPrompt } from '../../../retrieval/searchRouter.js';
import { buildToolsSystemPrompt, shouldInjectToolsPrompt } from '../../../tools/systemPrompt.js';
import { appendCompactCard, replaceCardSummary, ledgerCards, ledgerDigest, renderCompactLedger, degradedCardForUpgrade, noteCardUpgradeAttempt } from '../../../memory/compactLedger.js';
import { buildTopicExcerpts } from '../topicExcerpts.js';
import { buildDateChangeNote } from '../dateContext.js';
import { getAllTools } from '../../../tools/registry.js';
import { toolsForAgent as mcpToolsForAgent } from '../../../tools/mcpRegistry.js';
import { fitRequestContext, requiredPromptTokens, effectiveHistoryWindow } from '../contextBudget.js';
import { selectToolContextPolicy, requiresSkillToolContext } from '../../../retrieval/requestPolicy.js';
import { createFunctionCallingSession, toolProtocolFor } from '../../../tools/functionCalling.js';

// `getSharedSkillIndex(skills)` — module-private factory bound to the
// `buildSkillIndex` implementation imported above. It returns a stable
// per-skill-list cache so repeated turns over the same skill set don't
// re-index every time. The factory was originally module-private to
// desktopStore; moving it here keeps the singleton scoped to its sole
// caller (this runner). Node's module cache keeps the binding stable
// across imports.
const getSharedSkillIndex = createSharedSkillIndexFactory({ buildSkillIndex });

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
export function createPrepareNode(turn) {
  const { _dependencies, agentId, channelContext, chat, config, connectors, context, contextBudget, createReply, embedQuery, env, home, isRemoteChannel, latestUserMessage, modelOverrides, modelResponses, promptDebug, signal, skills, sseEmitter, state, teamPlan, turnContextPlacement, workspace } = turn;
  return async function prepare() {
    // ── 1. Sync setup ──────────────────────────────────────────────────
    const modeDef = MODE_DEFS.find(mode => mode.id === chat.mode) || MODE_DEFS[0];
    const project = findProjectById(state, chat.projectId);
    const activeAgentProfile = effectiveAgentProfile(state, agentId, project?.id || null);
    turn.routing = await createRoutingSession({ config, agent: activeAgentProfile, text: latestUserMessage, messages: chat.messages || [], attachments: chat.messages?.at(-1)?.attachments || [], home, signal, createReply,
      onDecision: decision => {
        sseEmitter?.('execution_event', { kind: 'pipeline', id: `model-routing:${decision.escalations}`, name: '智能选模', module: 'compute', status: 'completed', output: routingLabel(decision), metadata: decision });
      } });
    if (turn.routing.current.mode === 'smart') {
      const selected = turn.routing.connection();
      Object.assign(config, selected);
      Object.assign(modelOverrides, { model: selected.model, verifier: selected.model, apiKey: selected.apiKey, baseUrl: selected.baseUrl });
      Object.assign(contextBudget, resolveContextBudget(env, { config: selected }));
    }
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
    const searchCapability = _dependencies.searchCapability || await resolveHostedSearchCapability({ ...config,
      apiKey: modelOverrides.apiKey ?? config.apiKey, baseUrl: modelOverrides.baseUrl || config.baseUrl,
      model: modelOverrides.model || activeAgentProfile.model || config.model });
    let searchPlan = buildSharedSearchPlan({ latestUserMessage, modelMessages, config,
      capabilities: { executors: getAllTools().filter(tool => scopeAllowsTool(context.capabilityScope, tool.id)).map(tool => tool.id),
        grants: getAllTools().filter(tool => scopeAllowsTool(context.capabilityScope, tool.id)).map(tool => tool.id),
        hostedSearch: searchCapability.status, browserSearch: true } });

    // ── 2. Async fan-out ───────────────────────────────────────────────
    // classifyIntent and buildDynamicContext are the only two operations
    // that genuinely await I/O; run them concurrently to eliminate the
    // sequential stall that previously added one full round-trip before
    // invoke-model could start.
    const [classification, dynamicContext] = await Promise.all([
      measureStage('intent.classify', () => classifyRequest(latestUserMessage, {
        config: { ...config, model: modelOverrides.model || activeAgentProfile.model || config.model },
        signal, contextMessages: chat.messages,
      })),
      isRemoteChannel
        ? Promise.resolve('')
        : buildDynamicContext(state, chat, workspace, agentConnectors.filter(c=>c.id!=="artifacts"), latestUserMessage),
    ]);
    const intent = classification.taskType;
    const standaloneGreeting = isStandaloneGreeting({ text: latestUserMessage, messages: chat.messages, compactSummary: chat.compactSummary });
    const allowLiveSpeech = classification.riskLevel === 'normal' && intent === 'casual' && standaloneGreeting;
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
      sseEmitter?.('execution_event', { ...stage, status: 'running', outputMessageId:'output.compactStart',outputMessageParams:{count:compactPlan.compactedCount},output: `正在把最早的 ${compactPlan.compactedCount} 条消息压成摘要（通常后台已完成，这是兜底）。` });
      const fail = async () => {
        // Persisted (audit L5): the MAX_COMPACT_FAILURES breaker only
        // trips when failures survive the turn.
        chat.compactFailures = (chat.compactFailures || 0) + 1;
        await persistCompactFailure(chat, { home }).catch(() => {});
        sseEmitter?.('execution_event', { ...stage, status: 'failed', outputMessageId:'output.compactFailure',outputMessageParams:{count:chat.compactFailures},output: `摘要失败（连续 ${chat.compactFailures} 次）；本轮继续使用原始历史。` });
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
          sseEmitter?.('execution_event', { ...stage, status: 'completed', outputMessageId:'output.compactDone',outputMessageParams:{count:compactPlan.coveredCount || compactPlan.messages.length},output: `已把 ${compactPlan.coveredCount || compactPlan.messages.length} 条消息压成一张话题卡（${source === 'rule' ? '抽取式' : '模型'}摘要）。` });
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
    const toolContextPolicy = selectToolContextPolicy({
      text: latestUserMessage, chat, searchPlan,
      hasExecutableSkills: requiresSkillToolContext(listExecutableSkills(enabledSkills), latestUserMessage),
      highRisk: classification.riskLevel === 'high',
    });
    if (!allowLiveSpeech && toolContextPolicy.mode !== 'none' && shouldInjectToolsPrompt({ mode: chat.mode })) {
      // prepare scope owns the local `activeAgentProfile` (line 150);
      // graphState doesn't exist here (only invoke-model gets that).
      const allowedTools = filterMcpToolsForAgent([...getAllTools(), ...mcpTools], activeAgentProfile);
      const wantedGroups = wantedToolGroups({ searchPlan, env });
      const stableTools = selectStableTools(allowedTools, nextActivatedGroups([], wantedGroups))
        .filter(tool => requestAllowsTool(tool, context.requestToolPolicy || getRequestNetworkPolicy(latestUserMessage)));
      promptTools = toolsForCapabilityScope([...stableTools, ...skillTools].filter(tool => requestAllowsTool(tool, context.requestToolPolicy || getRequestNetworkPolicy(latestUserMessage))),context.capabilityScope).filter(t=>t.id!=='delegate'||activeAgentProfile.collaboration.canDelegate&&activeAgentProfile.collaboration.delegateTargets.length>0);
      visibleToolIds = new Set(promptTools.map(tool => tool.id).filter(Boolean));
    }
    toolsPrompt = buildSearchRoutingPrompt(searchPlan);
    const functionSession = createFunctionCallingSession({ ...config, baseUrl: modelOverrides.baseUrl,
      toolCalling: env.MELO_FUNCTION_CALLING || config.toolCalling }, promptTools);
    toolsPrompt = [toolsPrompt, buildToolsSystemPrompt(promptTools, { includeExamples: false, native: functionSession.native, protocol: functionSession.protocol })].filter(Boolean).join('\n\n');
    if (toolContextPolicy.mode === 'none') {
      toolsPrompt = [toolsPrompt, 'The user explicitly prohibited tools for this turn. Answer from the available context and state any information gaps without executing tools.'].filter(Boolean).join('\n\n');
    }
    if (promptDebug) process.stdout.write(`[tool-context] ${JSON.stringify(toolContextPolicy)}\n`);

    // Standalone greetings need no retrieval or embedding. A short confirmation
    // in an ongoing task ("好" / "ok") still keeps its full context.
    const skipMemory = activeAgentProfile.contextSources?.memory === false || allowLiveSpeech;
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
    const executionHistory = await readExecutionContext(context.home, chat, { excludedRunId: context.runId, enabled: !isRemoteChannel && activeAgentProfile.contextSources?.memory !== false });
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
      languageConstraint: buildLanguageConstraint(latestUserMessage, config.replyLanguage),
      dateContext: buildDateChangeNote(chat.messages),
      vizInstructions,
      citationInstructions,
      kind: 'chat',
      isRemoteChannel,
      intent: classification,
    }).concat(executionHistory ? [{ id: 'execution-history', text: executionHistory, required: false, placement: 'turn', priority: 95, maxTokens: 4000 }] : []);
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
  };
}
