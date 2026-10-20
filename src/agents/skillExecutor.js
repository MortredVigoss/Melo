import { createCoreTurn } from '../runtime/sharedAgentCore.js';
import {resolveCapabilityContext} from '../services/agent/capabilityContext.js';
import {currentRequestContext,runWithRequestContext} from '../runtime/requestScope.js';
import {narrowCapabilityScope,missingCapabilityScope,toolsForCapabilityScope,nativeFeaturesForScope} from '../domain/agent/capabilityScope.js';
import {budgetExhausted,narrowBudget,recordUsage,receiptInputTokens,requestTimeoutMs} from '../runtime/runBudget.js';
import {estimateMessagesTokens,estimateTextTokens} from '../memory/tokenEstimate.js';
import { delegatedConfig } from './delegatedConfig.js';
import { redactToolArgs } from '../tools/toolInvocationRecord.js';
/**
 * Skill executor.
 *
 * Runs a skill of `type: 'executable'` as a focused sub-agent: builds a
 * skill-scoped system prompt, intersects the skill's toolWhitelist with
 * the caller's allowedToolIds, and runs the same tool loop as the main
 * agent / sub-agent. Designed to be registered as a tool (see
 * registerSkillTools / buildSkillTool below) so the parent model invokes
 * skills through the normal <tool_call> channel — no special routing.
 *
 * Why a dedicated file instead of reusing runSubAgent?
 *   - Skill has its own systemPrompt (user-authored) that should be
 *     surfaced verbatim, not concatenated into a generic sub-agent prompt
 *   - Skill has its own maxIterations (user-controllable budget)
 *   - Skill has its own toolWhitelist (narrower than the caller's)
 *   - We want skill invocations to be one more nesting level so they
 *     count against SUB_AGENT_MAX_DEPTH and cannot recurse infinitely
 */

import { createOpenAICompatibleReply } from '../openai.js';
import { getAllTools, getTool } from '../tools/registry.js';
import { executeToolCalls } from '../tools/executor.js';
import { parseModelResponse } from '../tools/parser.js';
import { buildToolsSystemPrompt } from '../tools/systemPrompt.js';
import { recordSkillRun } from './skillRuns.js';
import { createFunctionCallingSession } from '../tools/functionCalling.js';
import { fitRequestContext, resolveContextBudget } from '../services/chat/contextBudget.js';
import { requestEnvironment } from '../runtime/requestScope.js';

// Hard ceiling so a misconfigured skill can't burn the whole budget.
const ABSOLUTE_ITERATION_CAP = 16;
// Skills are always at least one nesting level deep — they cannot spawn
// sub-agents themselves (see SKILL_FORBIDDEN_TOOLS).
const SKILL_FORBIDDEN_TOOLS = new Set(['agent']);

/**
 * Resolve the concrete list of Tool objects a skill may use.
 *
 * Precedence (most restrictive wins):
 *   caller.allowedToolIds ∩ skill.toolWhitelist  (if both set)
 *   skill.toolWhitelist                           (if only skill set)
 *   caller.allowedToolIds                         (if only caller set)
 *   all registered tools                           (fallback)
 *
 * The `agent` tool is always removed — skills cannot spawn sub-agents.
 */
function resolveSkillTools(skill, callerAllowedToolIds, extraTools = []) {
  // F3: MCP tools are not in the global registry; the caller's turn passes
  // its own (agent-whitelisted) MCP tools as `extraTools`. Only `mcp:` ids
  // are accepted here — skills still cannot call skills.
  const all = [...getAllTools(), ...(Array.isArray(extraTools) ? extraTools : []).filter(t => typeof t?.id === 'string' && t.id.startsWith('mcp:'))];
  const skillWhitelist = Array.isArray(skill?.toolWhitelist) && skill.toolWhitelist.length > 0
    ? new Set(skill.toolWhitelist)
    : null;
  const callerWhitelist = Array.isArray(callerAllowedToolIds)
    ? new Set(callerAllowedToolIds)
    : null;

  return all.filter(t => {
    if (SKILL_FORBIDDEN_TOOLS.has(t.id)) return false;
    if (skillWhitelist && !skillWhitelist.has(t.id)) return false;
    if (callerWhitelist && !callerWhitelist.has(t.id)) return false;
    return true;
  });
}

/**
 * Strip <tool_call> blocks and internal reasoning markers from a raw
 * model reply so the parent agent never sees skill scratch pad.
 */
function cleanReplyForParent(rawReply) {
  const { thinking } = parseModelResponse(rawReply);
  return thinking
    .replace(/<think(ing)?>([\s\S]*?)<\/think(ing)?>/gi, '')
    .replace(/<reflection>([\s\S]*?)<\/reflection>/gi, '')
    .trim();
}

/**
 * Render a skill-scoped system prompt. The skill's user-authored
 * systemPrompt is quoted verbatim so the operator-intent is clear; the
 * standard output constraints and the tool list are appended so the
 * skill can use tools the same way the main loop does.
 */
function buildSkillSystemPrompt(skill, allowedTools, options = {}) {
  const sections = [];

  sections.push(
    `You are the "${skill.name}" skill, a focused sub-agent that specialises in one workflow.`,
  );
  sections.push(
    'Follow the skill operator instructions below. Stay within scope — if the caller asks for something the skill does not cover, say so and stop rather than improvising outside the skill\'s intent.',
  );

  if (skill.systemPrompt && skill.systemPrompt.trim()) {
    sections.push(`Skill operator instructions:\n${skill.systemPrompt.trim()}`);
  }

  sections.push(
    'Final output hard constraints: do NOT use markdown emphasis (** * __ _), headings (# ## ###), blockquotes (>), or horizontal rules. Rely on word choice and sentence structure for emphasis. Backticks are allowed only inside actual code blocks.',
  );

  if (allowedTools.length > 0) {
    sections.push(buildToolsSystemPrompt(allowedTools, options));
  } else {
    sections.push(
      'This skill has no tools available. Produce the answer directly from the caller\'s request.',
    );
  }

  return sections.filter(Boolean).join('\n\n');
}

/**
 * Run an executable skill as a focused sub-agent.
 *
 * @param {Object}   options
 * @param {Object}   options.skill               - normalized skill record (type must be 'executable')
 * @param {Object}   [options.args]              - arguments parsed against skill.parametersSchema
 * @param {string}   [options.task]              - free-form task the caller wants done (defaults to JSON(args))
 * @param {Object}   options.config              - resolved Melo config
 * @param {string}   [options.workspacePath]
 * @param {AbortSignal} [options.signal]
 * @param {Function} [options.sseEmitter]
 * @param {string}   [options.chatId]
 * @param {number}   [options.depth]             - parent agent depth; skill's own loop always counts as depth+1
 * @param {string[]} [options.allowedToolIds]    - caller's whitelist; skill intersects with its own
 * @param {Function} [options.replyFn]           - test-only injection seam for the LLM reply function
 * @returns {Promise<{ ok: boolean, output: string, error?: string, meta?: Object }>}
 */
export async function runSkill(options) {
  if (!options.skill || options.skill.type!=='executable' || !options.config) return runSkillLoop(options);
  const parent=await resolveCapabilityContext(currentRequestContext());
  if (!parent) return missingCapabilityScope();
  const ids=resolveSkillTools(options.skill,options.allowedToolIds,options.extraTools).map(tool=>tool.id);
  const capabilityScope=narrowCapabilityScope(parent.capabilityScope,{capabilities:options.capabilities,allowedToolIds:ids,source:'skill'});
  // Run budget (C1): a skill runs on a child pool of the calling turn; its spending is charged upward.
  const budget=narrowBudget(parent.budget||null);
  return runWithRequestContext(Object.freeze({...parent,capabilityScope,...(budget?{budget}:{})}),()=>runSkillLoop({...options,capabilities:capabilityScope.capabilities,allowedToolIds:capabilityScope.allowedToolIds}));
}

async function runSkillLoop({
  skill,
  args = {},
  task = '',
  config,
  workspacePath,
  signal,
  sseEmitter,
  chatId,
  depth = 0,
  allowedToolIds = null,
  capabilities = null,
  extraTools = [],
  replyFn = createOpenAICompatibleReply,
  // Bug audit T5: conversation audience / project, forwarded to the tools.
  chatSource, projectId,
}) {
  const runStartedAt = Date.now();
  const skillIdForTelemetry = (skill && typeof skill === 'object') ? String(skill.id || '') : '';
  const recordTelemetry = (ok, error) => {
    if (!skillIdForTelemetry) return;
    recordSkillRun({
      skillId: skillIdForTelemetry,
      chatId: chatId || null,
      startedAt: runStartedAt,
      durationMs: Date.now() - runStartedAt,
      ok,
      errorType: error?.error || null,
      errorMessage: error?.output ? String(error.output).slice(0, 500) : null,
    });
  };

  if (!skill || typeof skill !== 'object') {
    const result = { ok: false, output: 'runSkill: missing skill.', error: 'MISSING_SKILL' };
    recordTelemetry(false, result);
    return result;
  }
  if (skill.type !== 'executable') {
    const result = {
      ok: false,
      output: `Skill "${skill.id}" is not executable (type="${skill.type || 'prompt'}").`,
      error: 'SKILL_NOT_EXECUTABLE',
    };
    recordTelemetry(false, result);
    return result;
  }
  if (!config || typeof config !== 'object') {
    const result = {
      ok: false,
      output: 'Skill cannot start: missing resolved config (config.authMode / apiKey / baseUrl / model).',
      error: 'MISSING_CONFIG',
    };
    recordTelemetry(false, result);
    return result;
  }

  const providerConfig = delegatedConfig(config);
  const allowedTools = toolsForCapabilityScope(resolveSkillTools(skill, allowedToolIds, extraTools),currentRequestContext().capabilityScope);
  const functionSession = createFunctionCallingSession(providerConfig, allowedTools);
  const contextBudget = resolveContextBudget(requestEnvironment());
  const systemPrompt = buildSkillSystemPrompt(skill, allowedTools, { native: functionSession.native, protocol: functionSession.protocol });

  // Compose the first user turn. We include both the structured args (for
  // machine-readable invocation) and any task text the caller supplied.
  const taskBody = task && String(task).trim()
    ? String(task).trim()
    : null;
  const argsBody = args && Object.keys(args).length > 0
    ? `Arguments:\n${JSON.stringify(args, null, 2)}`
    : null;
  const firstUserContent = [taskBody, argsBody].filter(Boolean).join('\n\n')
    || '(no task body provided — use the skill\'s default workflow)';

  let loopMessages = [{ role: 'user', content: firstUserContent }];

  const maxIterations = Math.max(
    1,
    Math.min(
      ABSOLUTE_ITERATION_CAP,
      Number.isFinite(Number(skill.maxIterations)) ? Math.floor(Number(skill.maxIterations)) : 6,
    ),
  );

  let finalOutput = '';
  let totalToolCalls = 0;
  const coreTurn = createCoreTurn({ allowedTools: allowedTools.map(t => t.id), limits: { rounds: maxIterations } });
  let completed = false;
  let iterations = 0;

  for (let iteration = 0; ; iteration++) {
    if (signal?.aborted) {
      const aborted = { ok: false, output: 'Skill aborted.', error: 'ABORTED', meta: { aborted: true, iteration, completion: coreTurn.receipt(task, '', 'CANCELLED') } };
      recordTelemetry(false, aborted);
      return aborted;
    }

    if (coreTurn.update('request') !== 'running') break;
    iterations++;
    const request = fitRequestContext({ sections: [{ id: 'instructions', text: systemPrompt, required: true }],
      messages: loopMessages, toolDefinitions: functionSession.definitions, ...contextBudget });
    // Run budget (C1): stop before another request once the turn's pool is gone.
    const runBudget = currentRequestContext()?.budget || null;
    const exhausted = budgetExhausted(runBudget);
    if (exhausted) {
      const stopped = { ok: false, output: `Run budget exhausted (${exhausted.reason}) before another request; the skill is incomplete.`, error: 'BUDGET_EXHAUSTED',
        meta: { skillId: skill.id, iterations, toolCalls: totalToolCalls, depth, completion: coreTurn.receipt(task, '', 'BUDGET_EXHAUSTED'), budget: { reason: exhausted.reason, limit: exhausted.limit, used: exhausted.used } } };
      recordTelemetry(false, stopped);
      return stopped;
    }
    let accounted = false;
    const account = receipt => {
      if (accounted) return; accounted = true;
      recordUsage(runBudget, { providerCalls: 1, inputTokens: receiptInputTokens(receipt)
        ?? estimateMessagesTokens(request.messages) + Math.ceil(estimateTextTokens(systemPrompt) * 4 / 3) });
    };
    let rawReply;
    try { rawReply = await replyFn({
      ...functionSession.requestOptions(),
      timeoutMs: runBudget ? requestTimeoutMs(runBudget) : undefined,
      onProviderResponse: account,
      authMode: config.authMode,
      apiProtocol: config.apiProtocol,
      apiKey: providerConfig.apiKey,
      baseUrl: providerConfig.baseUrl,
      model: providerConfig.model,
      systemPrompt,
      messages: request.messages,
      nativeWebSearchEnabled: nativeFeaturesForScope(currentRequestContext().capabilityScope).nativeWebSearchEnabled,
      nativeImageGenerationEnabled: nativeFeaturesForScope(currentRequestContext().capabilityScope).nativeImageGenerationEnabled,
      signal,
    }); }
    finally { account(null); }

    const turn = functionSession.parse(rawReply);
    const { toolCalls } = turn;

    if (!toolCalls.length) {
      coreTurn.update('complete');
      if (coreTurn.status !== 'completed') break;
      finalOutput = cleanReplyForParent(turn.text);
      completed = true;
      break;
    }

    coreTurn.update('calls', { calls: toolCalls });
    if (coreTurn.status !== 'running') break;

    if (typeof sseEmitter === 'function') {
      sseEmitter('tool_calls_start', {
        iteration,
        depth,
        skillId: skill.id,
        calls: toolCalls.map(c => ({
          id: c.id,
          name: `[skill:${skill.id}] ${c.name}`,
          // Bug audit T9: same redacted projection as the main loop.
          arguments: redactToolArgs(c.arguments),
        })),
      });
    }

    const allowSet = new Set(allowedTools.map(t => t.id));
    for (const tc of toolCalls) {
      if (tc.rejectedResult) continue;
      if (!coreTurn.permits(tc.id) && coreTurn.rejection(tc.id) !== 'UNKNOWN_TOOL') tc.rejectedResult = coreTurn.rejectionResult(tc.id);
    }
    const executableCalls = toolCalls.map(tc => {
      if (tc.rejectedResult) return { id: tc.id, tool: null, args: tc.arguments, callRef: tc };
      if (!allowSet.has(tc.name)) {
        return { id: tc.id, tool: null, args: tc.arguments, callRef: tc, denied: true };
      }
      const tool = allowedTools.find(t => t.id === tc.name) || getTool(tc.name);
      return { id: tc.id, tool, args: tc.arguments, callRef: tc };
    });
    totalToolCalls += executableCalls.filter(c => c.tool).length;

    const execResults = await executeToolCalls(
      executableCalls.filter(c => c.tool !== null),
      {
        sseEmitter,
        workspacePath,
        signal,
        chatId,
        config: providerConfig,
        // Skills count as one additional agent-depth level so
        // SUB_AGENT_MAX_DEPTH still caps nesting if a tool call inside the
        // skill happens to be the agent tool.
        agentDepth: (depth || 0) + 1,
        // Downstream nested tool calls cannot widen the skill's whitelist.
        allowedToolIds: allowedTools.map(t => t.id),
        capabilities,
        extraTools,
        chatSource, projectId,
      },
    );

    const allResults = toolCalls.map(tc => {
      if (tc.rejectedResult) return { call: tc, result: tc.rejectedResult };
      const call = executableCalls.find(c => c.id === tc.id);
      if (call?.denied) {
        return {
          call: tc,
          result: {
            ok: false,
            output: `Tool "${tc.name}" is not in skill "${skill.id}"'s whitelist. Allowed: ${[...allowSet].join(', ') || '(none)'}.`,
            error: 'TOOL_NOT_WHITELISTED',
          },
        };
      }
      const found = execResults.find(r => r.id === tc.id);
      if (found) return { call: tc, result: found.result };
      return {
        call: tc,
        result: { ok: false, output: `Unknown tool: "${tc.name}"`, error: 'UNKNOWN_TOOL' },
      };
    });

    if (typeof sseEmitter === 'function') {
      // G-1d slice 1.5: forward evidenceTrail to UI (same pattern as
      // chatExecutionRunner / subAgent).  3-site wire compat invariant.
      sseEmitter('tool_calls_done', {
        iteration,
        depth,
        skillId: skill.id,
        results: allResults.map(({ call, result }) => {
          const item = {
            id: call.id,
            name: call.name,
            ok: result.ok,
            output: result.output?.slice(0, 500),
          };
          if (Array.isArray(result.evidenceTrail) && result.evidenceTrail.length > 0) {
            item.evidenceTrail = result.evidenceTrail;
          }
          return item;
        }),
      });
    }

    loopMessages = functionSession.append(loopMessages, turn, allResults);
    if (coreTurn.results(allResults) !== 'running') break;
  }

  const completion = coreTurn.receipt(task, finalOutput);
  const finalResult = {
    ok: completed && Boolean(finalOutput),
    output: finalOutput || (coreTurn.status === 'blocked' ? coreTurn.reply(task) : completed ? 'Skill returned no answer.' : 'Skill reached its tool iteration limit before producing a final answer; the task is incomplete.'),
    ...(!completed ? { error: coreTurn.reason === 'ROUND_LIMIT' ? 'SKILL_ITERATION_LIMIT' : coreTurn.reason || 'SKILL_ITERATION_LIMIT' } : !finalOutput ? { error: 'EMPTY_SKILL_REPLY' } : {}),
    meta: {
      skillId: skill.id,
      completion,
      iterations,
      toolCalls: totalToolCalls,
      depth,
    },
  };
  recordTelemetry(finalResult.ok, finalResult.ok ? null : finalResult);
  return finalResult;
}

/**
 * Build a Tool object that wraps an executable skill, so it can be
 * registered in the tool registry and invoked by the model via
 * <tool_call>. The tool's id is `skill:<skillId>` to guarantee no clash
 * with the regular tool namespace.
 */
export function buildSkillTool(skill) {
  if (!skill || skill.type !== 'executable') return null;
  const toolId = `skill:${skill.id}`;
  return {
    id: toolId,
    name: toolId,
    description:
      (skill.description && skill.description.trim())
        ? `[Skill] ${skill.description.trim()}`
        : `[Skill] Run the "${skill.name}" skill.`,
    category: 'skill',
    allowedAgentIds: skill.allowedAgentIds || [],
    requiresPermission: false,
    // Skills run their own tool loop and can do side-effectful things;
    // never run two in parallel under the same caller.
    isConcurrencySafe: false,
    parametersSchema: (skill.parametersSchema && skill.parametersSchema.type === 'object')
      ? skill.parametersSchema
      : { type: 'object', properties: {}, required: [] },
    async run(args, context = {}) {
      return runSkill({
        skill,
        args: args || {},
        task: typeof args?.task === 'string' ? args.task : '',
        config: context.config,
        workspacePath: context.workspacePath,
        signal: context.signal,
        sseEmitter: context.sseEmitter,
        chatId: context.chatId,
        depth: context.agentDepth || 0,
        allowedToolIds: context.allowedToolIds || null,
      capabilities: context.capabilities,
        extraTools: context.extraTools || [],
        chatSource: context.chatSource,
        projectId: context.projectId,
      });
    },
  };
}
