import {resolveCapabilityContext} from '../agent/capabilityContext.js';
import {missingCapabilityScope} from '../../domain/agent/capabilityScope.js';
import { measureStage, startStage } from '../../runtime/performanceTrace.js';
import { selectedMaterials } from './conversationSelection.js';
import { observeModelReplies } from './executionPipeline.js';
import { createRequestContext } from '../../runtime/requestContext.js';
import { currentRequestContext, requestEnvironment, runWithRequestContext } from '../../runtime/requestScope.js';
import { armBudget, recordUsage, receiptInputTokens, requestTimeoutMs } from '../../runtime/runBudget.js';
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
// symbols from desktopStore.js). The lone module-private singleton
// `getSharedSkillIndex` is also co-located here: its sole caller was
// always this runner, and Node's module cache keeps the singleton stable.

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


  // Turn-level bindings the graph nodes read (architecture B2). Built after
  // every reassignment above (context, home, onDelta), so each node sees the
  // same values its former closure did.
  const turn = { _dependencies, agentId, background, budget, channelContext, chat, config, connectors, context, contextBudget, createReply, embedQuery, env, home, imageTask, isRemoteChannel, latestUserMessage, modelOverrides, modelResponses, onDelta, onImageProgress, onImageTaskResolved, onReasoningDelta, promptDebug, providerProfile, signal, skills, sseEmitter, state, teamPlan, turnContextPlacement, workspace };

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
