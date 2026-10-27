import { runLimitDelivery } from '../../../runtime/limitDelivery.js';
import { isDeliveryLimit, hostEvidenceReply } from '../../../../shared/agent/limitDelivery.js';
import { resolveLoopLimits } from '../../../../shared/agent/loopLimits.js';
import { extendBudget } from '../../../runtime/runBudget.js';
import { runtimeMessage } from '../../../../shared/agent/runtimeMessages.js';
import { turnStopReply } from '../../../../shared/agent/turn.js';
import { connectionForModel, resolvedModelCapabilities } from '../../../../shared/agent/modelCapabilities.js';
import { toolEffect } from '../../../../shared/agent/toolEffects.js';
import { resolveContextBudget } from '../contextBudget.js';
import { teamCompletion } from '../../../../shared/agent/completion.js';
import { hostedSearchReceipt } from '../../../../shared/agent/hostedSearch.js';
// Chat execution graph — `invoke-model` node (architecture B2, 2026-10-20).
// Mechanical move out of chatExecutionRunner.js: the body below is the
// original node body, unchanged except for one indentation level. The
// runner-scoped bindings it closed over arrive through the turn object and
// are destructured under their original names; none is reassigned inside the
// node (checked by scope analysis before the move), so this is equivalent to
// the closure it replaces.
import { scopeAllowsTool, nativeFeaturesForScope } from '../../../domain/agent/capabilityScope.js';
import { recordMemoryFeedback } from '../../../memory/store.js';
import { runAgentTeam } from '../../../agents/team.js';
import { takeSupplements, supplementMessage } from '../supplements.js';
import { budgetExhausted, budgetExhaustedReply, describeBudgetReason, recordUsage, remainingMs } from '../../../runtime/runBudget.js';
import { AGENT_LOOP_CONTRACT, contractRegExp } from '../../../runtime/agentLoopContract.js';
import { nowIso } from '../../../shared/helpers.js';
import { effectiveAgentProfile } from '../../../state/agentProfiles.js';
import { filterMcpToolsForAgent } from '../../../domain/agent/agentTools.js';
import { hydrateAttachments } from '../../../media/attachments.js';
import { tryImageEditFastPath } from '../imageEditFastPath.js';
import { formatModelMessageForVisionDebug } from '../visionDebug.js';
import { createCoreTurn } from '../../../runtime/sharedAgentCore.js';
import { buildMemberBackground } from '../../../agents/memberBackground.js';
import { buildSearchRoutingPrompt } from '../../../retrieval/searchRouter.js';
import { buildToolsSystemPrompt } from '../../../tools/systemPrompt.js';
import { projectToolResultForPersist, deriveUnifiedErrorCode } from '../toolResultProjection.js';
import { getTool, getAllTools } from '../../../tools/registry.js';
import { toolsForAgent as mcpToolsForAgent, indexMcpTools } from '../../../tools/mcpRegistry.js';
import { executeToolCalls } from '../../../tools/executor.js';
import { buildToolInvocationRecord, appendToolInvocationRecord, modelFacingOutputsFor, redactToolArgs } from '../../../tools/toolInvocationRecord.js';
import { inferImageTask, runImageTask } from '../imageTask.js';
import { visionConnection, imageSettings } from '../../../images/imageSettings.js';
import { prepareVisionInputs } from '../../../media/visionInputs.js';
import { collectVerificationEvidence } from '../../../retrieval/verificationEvidence.js';
import { fitRequestContext, attachTurnContextToMessages } from '../contextBudget.js';
import { createFunctionCallingSession, compactToolChain } from '../../../tools/functionCalling.js';
import { buildToolChainRecord } from '../../../tools/toolProtocol.js';

// Stable prompt blocks rendered on every turn; reported in memoryUsage, never recall feedback (bug audit M8).
const STABLE_MEMORY_KINDS = new Set(['project-book', 'personal-profile']);

// ── invoke-model ───────────────────────────────────────────────────────
// Implements a ReAct tool loop:
//   1. Call model with current messages
//   2. Read native function calls (or legacy text calls on other providers)
//   3. If tool calls exist: execute them, append results, loop (max 10)
//   4. If no tool calls (or max iterations reached): proceed to finalize
export function createInvokeModelNode(turn) {
  const privateTurn = turn;
  const { agentId, budget, chat, config, context, contextBudget, createReply, env, home, imageTask, latestUserMessage, modelOverrides, modelResponses, onDelta, onImageProgress, onImageTaskResolved, onReasoningDelta, promptDebug, providerProfile, signal, userSignal, sseEmitter, state, teamPlan, turnContextPlacement, workspace } = turn;
  return async function invokeModel(graphState) {
    const routingSession = turn.routing;
    let selectedModel = modelOverrides.model || graphState.activeAgentProfile.model || config.model;
    const delegatedModelConfig = { ...config, ...modelOverrides, model: selectedModel, modelResolvedForTurn: true,
      toolCalling: env.MELO_FUNCTION_CALLING || config.toolCalling };
    const teamTask = state.tasks?.find(t=>t.execution?.requestId===context.requestId && t.execution?.teamPlan);
    if (teamTask || teamPlan) {
      const team = await runAgentTeam({extraTools:[...(graphState.skillTools||[]),...(graphState.mcpTools||[])],plan:teamTask?.execution.teamPlan || teamPlan,task:teamTask?.execution.content || latestUserMessage,config:delegatedModelConfig,workspacePath:workspace?.rootPath,signal,sseEmitter,chatId:chat.id,allowedToolIds:graphState.visibleToolIds || [],capabilities:context.capabilityScope.capabilities,agentProfiles:Object.fromEntries(Object.keys(state.agentProfiles).map(id=>[id,effectiveAgentProfile(state,id,chat.projectId)])),lead:graphState.activeAgentProfile,background:buildMemberBackground({chat,projectContext:graphState.projectContext}),chatSource:chat.source || 'desktop',projectId:chat.projectId});
      modelResponses.push(...team.results.flatMap(r=>r.receipts),...team.summaryReceipts);
      // The lead's summary is the reply; member handoffs stay in the execution record.
      return {reply:team.summary,team,completionForReply:reply=>teamCompletion({goal:latestUserMessage,reply,accepted:team.accepted,cancelled:team.cancelled,budgetExceeded:team.budgetExceeded,members:team.results.map(r=>({id:r.agentId||r.role,ok:r.ok,status:r.handoff?.status,completion:r.meta?.completion}))}),toolResults:[...team.results.map(r=>({toolCallId:`team:${r.role}:${r.round||1}`,toolName:`成员 ${r.name||r.role}`,ok:r.ok,...(!r.ok ? {errorCode:r.cancelled?'ABORTED':'ROLE_FAILED'} : {})})),...team.results.flatMap(r=>(r.meta?.toolResults || []).map(t=>({...t,toolCallId:`team:${r.role}:${t.toolCallId}`})))],next:'finalize'};
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
    const task = context.requestToolPolicy?.toolsForbidden ? null : inferImageTask(latestUserMessage, graphState.modelMessages, imageTask);
    const taskMessage = chat.messages.filter(m => m.role === 'user').at(-1);
    // Image references are matched against model parts by URL, so the task
    // attachments use the same hydrated data URLs as the model window.
    const attachments = await hydrateAttachments(taskMessage?.attachments || [], { home });
    if (task && taskMessage) {
      taskMessage.metadata = {...taskMessage.metadata,imageTask:task};
      await onImageTaskResolved?.(task);
    }
    if (task && task.action !== 'analyze' && !scopeAllowsTool(context.capabilityScope,'image',{action:'generate'})) return {reply:runtimeMessage('mediaDenied', config.replyLanguage),next:'finalize'};
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
    let vision = routingSession?.current.mode === 'smart' ? null : Array.isArray(latestParts) && latestParts.some(p=>p.type==='image_url') ? visionConnection(config,{...modelOverrides,model:selectedModel}) : null;
    const fastPathReply = context.requestToolPolicy?.toolsForbidden || task?.action === 'analyze' || !scopeAllowsTool(context.capabilityScope,'image',{action:'generate'}) ? null : await tryImageEditFastPath({
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
    const loopLimits = resolveLoopLimits({ maxIterations: graphState.activeAgentProfile?.collaboration?.maxTaskIterations, route: routingSession?.current });
    const MAX_TOOL_ITERATIONS = loopLimits.maxIterations;
    if (budget && routingSession?.current.deepTask) extendBudget(budget, { deadlineMs: Math.max(0, budget.startedAt + loopLimits.deadlineMs - budget.now()), maxToolCalls: loopLimits.maxToolCalls });
    const escalationTool = { id: 'melo_escalate', name: 'melo_escalate', description: 'Request one higher configured model tier when the task needs more reasoning. This continues the same task with all results preserved. Do not repeat completed actions.', effect: 'compute', requiresPermission: false,
      parametersSchema: { type: 'object', properties: { reason: { type: 'string', description: 'Why this task requires a stronger model.' } }, required: ['reason'], additionalProperties: false } };
    const routingEnabled = routingSession?.current.mode === 'smart' && config.smartRouting?.allowEscalation !== false;
    if (routingEnabled) graphState.promptTools = [...graphState.promptTools, escalationTool];
    let escalationRequested = false;
    let routingSideEffects = false;
    let functionSession = createFunctionCallingSession({ ...delegatedModelConfig, ...(vision || {}),
      toolCalling: env.MELO_FUNCTION_CALLING || config.toolCalling }, graphState.promptTools);
    let loopSections = graphState.promptSections.map(section => section.id === 'tools' && graphState.promptTools.length
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
    const hostedItems = [];
    let missingHostedEvidence = false;
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
    if (routingEnabled) visibleToolIds.add('melo_escalate');
    const allowedToolIdList = [...visibleToolIds];
    const coreTurn = createCoreTurn({ runId: String(context.requestId), turnId: chat.id,
      goal: graphState.searchPlan.sharedPlan?.resolvedGoal || latestUserMessage, tools: graphState.promptTools,
      allowedTools: allowedToolIdList, requiredTools: graphState.searchPlan.sharedPlan?.requiredTools, toolDependencies: graphState.searchPlan.sharedPlan?.toolDependencies, limits: { rounds: MAX_TOOL_ITERATIONS, timeoutMs: Math.max(1, Math.ceil(remainingMs(budget))) } });
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
      if (signal?.aborted) {
        if (userSignal?.aborted) throw signal.reason;
        terminalReason = 'DEADLINE_EXCEEDED'; break;
      }
      if (coreTurn.reporting) { terminalReason = 'ROUND_LIMIT'; break; }
      // Each answer round can stream, including after tools. Intermediate
      // goal checks below stay buffered and do not receive onDelta.
      const isFirstIteration = iteration === 0;
      // Supplements typed while this turn runs join before the next model call,
      // keeping every step already done.
      if (!isFirstIteration) {
        const supplements = takeSupplements(chat.id);
        if (supplements.length) {
          coreTurn.amend(supplementMessage(supplements));
          loopMessages = [...loopMessages, { role: 'user', content: supplementMessage(supplements), isSupplement: true }];
          for (const entry of supplements) sseEmitter?.('execution_event', { kind: 'pipeline', id: `supplement:${entry.id}`, messageId: 'stage.supplement', module: 'compute', status: 'completed', output: entry.text });
        }
      }

      if (!coreTurn.checking && routingSession?.escalate({ ...coreTurn.routingProgress, requested: escalationRequested, sideEffects: routingSideEffects })) {
        const selected = routingSession.connection();
        selectedModel = selected.model;
        Object.assign(config, selected);
        Object.assign(modelOverrides, { model: selected.model, verifier: selected.model, apiKey: selected.apiKey, baseUrl: selected.baseUrl });
        Object.assign(delegatedModelConfig, selected, { modelResolvedForTurn: true });
        Object.assign(contextBudget, resolveContextBudget(env, { config: selected }));
        functionSession = createFunctionCallingSession({ ...selected, toolCalling: env.MELO_FUNCTION_CALLING || selected.toolCalling }, graphState.promptTools);
        loopSections = loopSections.map(section => section.id === 'tools' ? { ...section, text: [buildSearchRoutingPrompt(graphState.searchPlan), buildToolsSystemPrompt(graphState.promptTools, { includeExamples: false, native: functionSession.native, protocol: functionSession.protocol })].join('\n\n') } : section);
        // Rerouting never resets the budget, goal, tool IDs or successful effects.
        coreTurn.update('reroute');
      }
      escalationRequested = false;
      let request;
      const checkingGoal = coreTurn.checking;
      const toolFree = checkingGoal;
      try {
        const review = checkingGoal ? coreTurn.reviewRequest() : null;
        request = fitRequestContext({ sections: review ? [{ id: 'goal-check', text: review.systemPrompt, required: true }] : loopSections, messages: review?.messages || loopMessages, toolDefinitions: toolFree ? [] : functionSession.definitions, ...contextBudget, turnContextPlacement });
      } catch (error) {
        if (checkingGoal) { coreTurn.stopReview('GOAL_CHECK_CONTEXT'); finalReply = coreTurn.candidateReply; break; }
        // audit C-8: a long tool loop must not die after the tools already
        // ran. Condense older tool outputs in this turn's chain and retry
        // once; only then surface the budget error.
        if (error?.code !== 'CONTEXT_BUDGET_EXCEEDED' || iteration === 0) throw error;
        const condensed = compactToolChain(loopMessages);
        if (!condensed.changed) throw error;
        loopMessages = condensed.messages;
        sseEmitter?.('execution_event', { kind: 'pipeline', id: `tool-chain:condense:${iteration}`, module: 'compute', messageId: 'stage.condense', status: 'completed', outputMessageId: 'output.condensed' });
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
        sseEmitter?.('execution_event', { kind: 'pipeline', id: 'budget:exhausted', module: 'compute', messageId: 'stage.budget', status: 'failed',
          outputMessageId:'output.budget',outputMessageParams:{reason:{messageId:'value.budget_'+exhausted.reason.replaceAll('-','_')},limitText,calls:exhausted.usage.providerCalls,tokens:exhausted.usage.inputTokens,tools:exhausted.usage.toolCalls},
          budget: { code: exhausted.code, reason: exhausted.reason, limit: exhausted.limit, used: exhausted.used, usage: exhausted.usage } });
      };
      const exhausted = budgetExhausted(budget);
      if (exhausted) {
        emitBudgetExhausted(exhausted);
        finalReply = coreTurn.candidateReply || budgetExhaustedReply(exhausted, config.replyLanguage);
        break;
      }
      if (coreTurn.update('request') !== 'running') { finalReply = coreTurn.reply(latestUserMessage, config.replyLanguage); break; }
      let rawReply;
      if (!checkingGoal) privateTurn.answerConnection = {
        authMode: vision?.authMode || config.authMode, apiProtocol: vision?.apiProtocol || config.apiProtocol,
        apiKey: vision?.apiKey ?? modelOverrides.apiKey, baseUrl: vision?.baseUrl || modelOverrides.baseUrl,
        model: vision?.model || selectedModel,
      };
      try {
        rawReply = await createReply({
        ...(toolFree ? { maxTokens: 2048 } : functionSession.requestOptions()),
        authMode: vision?.authMode || config.authMode,
        apiProtocol: vision?.apiProtocol || config.apiProtocol,
        apiKey: vision?.apiKey ?? modelOverrides.apiKey,
        baseUrl: vision?.baseUrl || modelOverrides.baseUrl,
        model: vision?.model || selectedModel,
        modelCapabilities: resolvedModelCapabilities(connectionForModel(vision || config), vision?.model || selectedModel),
        systemPrompt: request.systemPrompt,
        messages: attachTurnContextToMessages(request.messages, request.turnContext),
        cacheScope: `${agentId}:${chat.id}`,
        signal,
        onDelta: !checkingGoal ? onDelta : undefined,
        onReasoningDelta: checkingGoal ? undefined : onReasoningDelta,
        providerProfile,
        routing: routingSession?.current.mode === 'smart' ? { ...routingSession.current, judge: undefined } : undefined,
        // Workspace path enables inline image generation through the
        // Codex OAuth chat stream (createCodexResponsesReply adds the
        // image_generation tool when this is truthy and writes the
        // resulting bytes into <workspace>/generated/). For non-Codex
        // providers this parameter is currently ignored.
        //
        // Native provider features obey the Agent capability snapshot.
        workspacePath: toolFree ? null : workspace?.rootPath || null,
        // Stable across turns (A2): the native web_search definition is
        // present whenever the agent may use the network; whether to use
        // it this turn is said in the routing prompt. Only an explicit
        // user network-off or a non-Codex route keeps it off.
        nativeWebSearchEnabled: !toolFree && nativeFeaturesForScope(context.capabilityScope,context.requestToolPolicy).nativeWebSearchEnabled && graphState.searchPlan?.nativeWebSearchEnabled === true,
        nativeImageGenerationEnabled: !context.requestToolPolicy?.toolsForbidden && (routingSession?.current.mode !== 'smart' || routingSession.current.tier === 'strong') && !toolFree && !coreTurn.repairing && scopeAllowsTool(context.capabilityScope,'image',{action:'generate'}) && imageSettings(config).engine === 'codex-oauth',
        onExecutionEvent: event => {
          const observed = { ...event, id: event.id ? `${iteration}:${event.id}` : undefined };
          if (coreTurn.observeNative(observed)) recordUsage(budget, { toolCalls: 1 });
          sseEmitter?.('execution_event', observed);
        },
      });
      } catch (error) {
        // Bug audit T7: the deadline most often lands in the middle of a
        // model request — the transport's AbortSignal.timeout throws a
        // TimeoutError. That is the budget running out, not a provider
        // failure, so it takes the budget path (event + "continue" reply)
        // instead of the generic "model request failed" card.
        if (signal?.aborted) {
          if (userSignal?.aborted) throw error;
          terminalReason = 'DEADLINE_EXCEEDED'; break;
        }
        const timedOut = error?.name === 'TimeoutError' || error?.code === 'ETIMEDOUT';
        const exhaustedNow = error?.exhausted || budgetExhausted(budget) || (budget && timedOut && remainingMs(budget) <= 1000 ? budgetExhausted(budget, budget.deadlineAt) : null);
        if (checkingGoal && !exhaustedNow) { coreTurn.stopReview(); coreTurn.update('complete'); finalReply = coreTurn.candidateReply; break; }
        if (!exhaustedNow) throw error;
        emitBudgetExhausted(exhaustedNow);
        finalReply = coreTurn.candidateReply || budgetExhaustedReply(exhaustedNow, config.replyLanguage);
        break;
      }

      if (signal?.aborted) {
        if (userSignal?.aborted) throw signal.reason;
        terminalReason = 'DEADLINE_EXCEEDED'; break;
      }
      if (!toolFree && graphState.searchPlan?.nativeWebSearchEnabled) {
        const items = (rawReply?.responseItems || []).filter(item => ['message', 'web_search_call'].includes(item?.type));
        hostedItems.push(...items);
        // The transport may return structured receipts without emitting SSE.
        // This is provider-reported evidence, never an independently read page.
        const receipt = hostedSearchReceipt({ items, text: rawReply?.text });
        if (receipt.verified && coreTurn.observeNative({ id: `hosted:${iteration}`, name: 'native_web_search', status: 'completed', output: receipt.evidence + '\n' + receipt.answer, sources: receipt.sources.map(source => ({ ...source, reading: 'provider', text: rawReply?.text || '' })) })) recordUsage(budget, { toolCalls: 1 });
      }
      const turn = functionSession.parse(rawReply);
      const { thinking, toolCalls } = turn;

      if (checkingGoal) {
        const decision = coreTurn.review(toolCalls.length ? '' : turn.text);
        sseEmitter?.('execution_event', { kind: 'pipeline', id: `goal-check:${iteration}`, module: 'compute', messageId: 'stage.delivery', status: ['complete', 'deliver'].includes(decision.decision) ? 'completed' : 'failed', output: decision.explanation || decision.reason });
        if (decision.decision === 'continue') {
          coreTurn.update('feedback', { repair: true });
          loopMessages.push({ role: 'assistant', content: coreTurn.candidateReply }, { role: 'user', content: decision.feedback });
          continue;
        }
        coreTurn.update('complete');
        finalReply = coreTurn.candidateReply;
        if (hostedItems.length) finalReply = hostedSearchReceipt({ items: hostedItems, text: finalReply }).answer;
        break;
      }

      // No calls is a candidate answer, not proof that the user's goal is done.
      if (!toolCalls.length) {
        if (coreTurn.candidate(turn.text, { research: !!graphState.searchPlan.sharedPlan?.research, nativeSearch: graphState.searchPlan?.nativeWebSearchEnabled === true })) {
          coreTurn.update('feedback');
          continue;
        }
        coreTurn.update('complete');
        finalReply = turn.text || coreTurn.reply(latestUserMessage, config.replyLanguage);
        if (coreTurn.status === 'completed' && graphState.searchPlan?.nativeWebSearchEnabled) {
          const receipt = hostedSearchReceipt({ items: hostedItems, text: turn.text });
          missingHostedEvidence = !receipt.verified || !receipt.sources.length;
          if (!missingHostedEvidence) finalReply = receipt.answer;
        }
        break;
      }

      coreTurn.update('calls', { calls: toolCalls.map(call => ({ ...call, name: mcpToolsByName.get(call.name)?.id || call.name })) });
      if (coreTurn.status !== 'running') { finalReply = coreTurn.reply(latestUserMessage, config.replyLanguage); break; }

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
        else if (routingSession?.current.mode === 'smart' && routingSession.current.tier !== 'strong' && ['write', 'unknown'].includes(toolEffect(tc.name, tc.arguments))) {
          routingSideEffects = true; escalationRequested = true;
          tc.rejectedResult = { ok: false, output: 'This action has not executed. It requires the strong tier. Continue using previous results after the host checks the configured tier; if unavailable ask the user to configure it.', meta: { code: 'ROUTING_REQUIRES_STRONG', executionStarted: false } };
        }
        else if (routingEnabled && tc.name === 'melo_escalate') {
          escalationRequested = true;
          tc.rejectedResult = { ok: true, output: 'Routing request recorded. Continue from existing results; do not repeat successful effects. The host will check the remaining budget and available tiers.', meta: { executionStarted: false } };
        }
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
        sseEmitter?.('tool_record', { record });
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
      coreTurn.results(allResults);
      if (signal?.aborted) {
        if (userSignal?.aborted) throw signal.reason;
        terminalReason = 'DEADLINE_EXCEEDED'; break;
      }
      if (coreTurn.status !== 'running') {
        sseEmitter?.('execution_event', { kind: 'pipeline', id: 'core:stop', module: 'compute', messageId: 'stage.stopped', status: 'failed', output: coreTurn.reason });
        finalReply = coreTurn.reply(latestUserMessage, config.replyLanguage);
        break;
      }

      // If the last iteration was tool calls only, the next pass will produce
      // the final prose reply. Continue loop.
    }

    // Exhaustion is not success; never publish a tool-call block as an answer.
    if (!finalReply) {
      finalReply = turnStopReply('ROUND_LIMIT', latestUserMessage, config.replyLanguage);
    }

    // Only finalize may publish reply_text to the speech channel.
    const hadToolCalls = loopMessages.length > graphState.modelMessages.length;

    // G-1d slice 2: pass accumulated tool metadata through graphState so
    // the finalize node can attach it to normalizedReply → sendChatMessage
    // attaches it to the persisted assistantMessage.  Only emit when
    // non-empty so we don't pollute pure-text replies with empty arrays.
    const limitReason = terminalReason || coreTurn.reason;
    let deliveredAtLimit = false;
    if (isDeliveryLimit(limitReason)) {
      const delivery = await runLimitDelivery({ task: coreTurn.goalState, observations: coreTurn.observations, reason: limitReason,
        fallback: finalReply || coreTurn.reply(latestUserMessage, config.replyLanguage), createReply, budget, signal, locale: config.replyLanguage,
        options: { ...config, ...modelOverrides, model: selectedModel, ...(privateTurn.answerConnection || {}), modelCapabilities: resolvedModelCapabilities(connectionForModel(config), selectedModel) } });
      coreTurn.acceptDelivery(delivery.task); finalReply = delivery.reply; terminalReason = delivery.terminalReason;
      deliveredAtLimit = true;
      sseEmitter?.('execution_event', { kind: 'pipeline', id: 'limit:delivery', module: 'compute', messageId: 'stage.delivery', status: terminalReason === 'LIMIT_DELIVERED' ? 'completed' : 'failed', output: terminalReason });
    }
    const out = { completionForReply: (reply, citations) => coreTurn.receipt(latestUserMessage, reply, terminalReason || coreTurn.reason, undefined, citations), reply: finalReply, hadToolCalls, limitFallback: deliveredAtLimit && !userSignal?.aborted, skipVerification: deliveredAtLimit || (coreTurn.status === 'blocked' && coreTurn.reason !== 'MISSING_TOOL_EVIDENCE') || graphState.searchPlan.sharedPlan?.route === 'unavailable', toolEvidence: collectVerificationEvidence(evidencePairs, { query: latestUserMessage }), next: 'finalize' };
    if (accumulatedToolResults.length > 0) {
      out.toolResults = accumulatedToolResults;
    }
    // Bug audit T15: the chain (≤24 KB per reply) is only persisted when
    // replay is enabled (MELO_TOOL_CHAIN_HISTORY=1 / config.toolChainHistory);
    // with replay off nothing reads it, so storing it only grows threads.
    if (toolChainTurns.length > 0 && (env.MELO_TOOL_CHAIN_HISTORY === '1')) {
      out.toolChain = buildToolChainRecord(toolChainTurns, { protocol: functionSession.protocol });
    }
    return out;
  };
}
