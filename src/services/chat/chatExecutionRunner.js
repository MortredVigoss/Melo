import { getRequestNetworkPolicy } from '../../../shared/agent/retrieval/requestPolicy.js';
import { resolvedRequestGoal } from '../../../shared/agent/search.js';
import {resolveCapabilityContext} from '../agent/capabilityContext.js';
import {missingCapabilityScope} from '../../domain/agent/capabilityScope.js';
import { measureStage, startStage } from '../../runtime/performanceTrace.js';
import { selectedMaterials } from './conversationSelection.js';
import { observeModelReplies } from './executionPipeline.js';
import { createRequestContext } from '../../runtime/requestContext.js';
import { currentRequestContext, requestEnvironment, runWithRequestContext } from '../../runtime/requestScope.js';
import { armBudget, budgetExhausted, recordUsage, receiptInputTokens, requestTimeoutMs, remainingMs } from '../../runtime/runBudget.js';
import { AGENT_LOOP_CONTRACT } from '../../runtime/agentLoopContract.js';
import { estimateMessagesTokens, estimateTextTokens } from '../../memory/tokenEstimate.js';
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
// symbols from desktopStore.js). Since architecture B2 (2026-10-20) each
// node lives in ./execution/<name>Node.js as a factory over the turn object
// built below; the skill-index singleton moved with its only user,
// prepareNode.js.

import {
  createStateGraph,
  runStateGraph,
} from '../../agentGraph.js';
import { getEmbedding } from '../../memory/embeddings.js';
import {
  filterToolsForSearchPlan,
} from '../../retrieval/searchRouter.js';
import { createOpenAICompatibleReply } from '../../openai.js';
import { resolveContextBudget } from './contextBudget.js';
import { createFinalizeNode } from './execution/finalizeNode.js';
import { createInvokeModelNode } from './execution/invokeModelNode.js';
import { createPrepareNode } from './execution/prepareNode.js';

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
  if (!context.requestToolPolicy) context = Object.freeze({ ...context, requestToolPolicy: Object.freeze(getRequestNetworkPolicy(resolvedRequestGoal(latestUserMessage, chat.messages))) });
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
  const requestedTimeout = Number.isFinite(_dependencies.turnTimeoutMs) ? _dependencies.turnTimeoutMs : AGENT_LOOP_CONTRACT.budget.deadlineMs;
  const turnTimeoutMs = Math.max(1, Math.ceil(Math.min(requestedTimeout, budget ? remainingMs(budget) : requestedTimeout)));
  signal = AbortSignal.any([signal, AbortSignal.timeout(turnTimeoutMs)].filter(Boolean));
  const createReply = async options => {
    if (options.purpose === 'routing-judge') {
      options.signal?.throwIfAborted();
      const exhausted = budgetExhausted(budget);
      if (exhausted) throw Object.assign(new Error('Routing judgment exceeds the remaining turn budget.'), { code: 'BUDGET_EXHAUSTED' });
    }
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
        onProviderResponse: receipt => { modelResponses.push({ ...receipt, ...(options.purpose ? { purpose: options.purpose } : {}), ...(options.routing ? { routing: options.routing } : {}) }); account(receipt); options.onProviderResponse?.(receipt); },
      }));
    } finally {
      if (!accounted && options.purpose === 'routing-judge') modelResponses.push({ requestedModel: options.model, reportedModel: '', purpose: options.purpose, usage: null, failed: true });
      account(null);
    }
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
    verifier: env.MELO_VERIFIER_MODEL || '',
  };
  const isRemoteChannel = background && Boolean(channelContext?.channelId);


  /**
   * Turn-level bindings the graph nodes read (architecture B2). Built after
   * every reassignment above (context, home, onDelta), so each node sees the
   * same values its former closure did. Nodes destructure what they use and
   * never assign back (enforced when they were moved; see B2 in
   * docs/architecture-optimization-plan-20261020.md).
   * @typedef {object} TurnContext
   * @property {*} context request context: env, budget, capability scope, request identity
   * @property {*} home Melo home of this request
   * @property {*} env context.env
   * @property {*} config model / connector configuration snapshot
   * @property {*} state persisted desktop state snapshot
   * @property {*} chat the conversation being answered
   * @property {*} workspace workspace snapshot (root path, files, command templates)
   * @property {*} connectors available connectors (filtered per agent inside prepare)
   * @property {*} skills available skills (filtered per agent inside prepare)
   * @property {*} latestUserMessage text of the turn being answered
   * @property {*} agentId requested agent id
   * @property {*} imageTask pre-resolved image task, or null
   * @property {*} teamPlan pre-resolved team plan, or null
   * @property {*} onImageTaskResolved image task callback
   * @property {*} onImageProgress image progress callback
   * @property {*} background true for remote-channel / background turns
   * @property {*} channelContext remote channel routing context, or null
   * @property {*} isRemoteChannel background && channelContext.channelId
   * @property {*} signal AbortSignal of the request
   * @property {*} onDelta streaming text callback (wrapped to stop the first-token timer)
   * @property {*} onReasoningDelta streaming reasoning callback
   * @property {*} sseEmitter (type, value) => void progress / reply event sink
   * @property {*} providerProfile provider tuning profile name
   * @property {*} _dependencies test injection: createReply, getEmbedding
   * @property {*} budget armed run budget shared by the whole turn
   * @property {*} createReply metered model call (budget accounting, first-token timer, receipts into modelResponses)
   * @property {*} modelResponses provider receipts of this turn (appended by createReply)
   * @property {*} embedQuery embedding function (injectable)
   * @property {*} contextBudget resolved prompt / history token budget
   * @property {*} turnContextPlacement 'message' (default) or 'system'
   * @property {*} promptDebug MELO_PROMPT_DEBUG=1
   * @property {*} modelOverrides { apiKey, baseUrl, model, verifier } after env / profile resolution
   * @type {TurnContext}
   */
  const turn = {
    context,
    home,
    env,
    config,
    state,
    chat,
    workspace,
    connectors,
    skills,
    latestUserMessage,
    agentId,
    imageTask,
    teamPlan,
    onImageTaskResolved,
    onImageProgress,
    background,
    channelContext,
    isRemoteChannel,
    signal,
    onDelta,
    onReasoningDelta,
    sseEmitter,
    providerProfile,
    _dependencies,
    budget,
    createReply,
    modelResponses,
    embedQuery,
    contextBudget,
    turnContextPlacement,
    promptDebug,
    modelOverrides,
  };

  const graph = createStateGraph({
    start: 'prepare',
    nodes: {
      // ── prepare ── moved verbatim to ./execution/prepareNode.js (B2)
      'prepare': createPrepareNode(turn),

      // ── invoke-model ── moved verbatim to ./execution/invokeModelNode.js (B2)
      'invoke-model': createInvokeModelNode(turn),

      // ── finalize ── moved verbatim to ./execution/finalizeNode.js (B2)
      'finalize': createFinalizeNode(turn),
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
