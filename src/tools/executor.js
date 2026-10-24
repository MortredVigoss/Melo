import { requestAllowsTool } from '../../shared/agent/retrieval/requestPolicy.js';
import {workspaceForTool,ownedWorkspaceSafety} from '../services/workspace/toolWorkspace.js';
import {trackWorkspaceWork} from '../agents/workspaceScheduling.js';
import {narrowCapabilityScope,scopeAllowsTool,missingCapabilityScope,liveCapabilityScope} from '../domain/agent/capabilityScope.js';
import {resolveCapabilityContext} from '../services/agent/capabilityContext.js';
import {requestCapabilityElevation} from '../services/agent/capabilityElevation.js';
import { recordTaskApproval } from '../services/task/taskApprovalCheckpoint.js';
import { operationScope } from '../safety/permissionContext.js';
import { reserveTaskOperation } from '../services/task/operationLedger.js';
import { randomUUID } from 'node:crypto';
import { observeTool } from './executionObservation.js';
import { toolConcurrencySafe } from './tool.js';
import { currentRequestContext, runWithRequestContext } from '../runtime/requestScope.js';
/**
 * Tool executor.
 *
 * Handles:
 *   - Pre-execution permission checks (via permissions.js)
 *   - Concurrent vs serial execution based on toolConcurrencySafe(tool, args)
 *     (per-call `concurrency` declaration, falling back to tool.isConcurrencySafe)
 *   - Timeout enforcement per-call
 *   - Structured ToolResult output
 *
 * Usage:
 *   const result = await executeTool(tool, args, { sseEmitter, workspacePath, signal, chatId, onOutput });
 */

import { requestPermission } from './permissions.js';
import { emitHook } from '../plugins/hooks.js';
import { finalizeToolResult } from './toolResult.js';
import { resolveRuntimePaths } from '../runtime/paths.js';
import { budgetExhausted, recordUsage, remainingMs } from '../runtime/runBudget.js';
import { AGENT_LOOP_CONTRACT, fillTemplate } from '../runtime/agentLoopContract.js';

const DEFAULT_TOOL_TIMEOUT_MS = AGENT_LOOP_CONTRACT.executionLimits.toolTimeoutMs;

/**
 * Execute a single tool with full permission + error handling.
 *
 * @param {Object}   tool            - validated Tool object
 * @param {Object}   args            - arguments from the model
 * @param {Object}   options
 * @param {Function} [options.sseEmitter]   - (event, payload) => void
 * @param {string}   [options.workspacePath]
 * @param {AbortSignal} [options.signal]
 * @param {string}   [options.chatId]
 * @param {Function} [options.onOutput]     - streaming output (chunk: string) => void
 * @returns {Promise<import('./tool.js').ToolResult>}
 */
export async function executeTool(tool, args, options = {}) {
  // Ambient authority cannot be replaced by an options bag. Options may only
  // narrow it; the scoped implementation is private so callers cannot skip it.
  const ambient=currentRequestContext();
  const resolved=await resolveCapabilityContext(ambient || options.requestContext);
  if (!resolved) return missingCapabilityScope();
  if (!requestAllowsTool(tool, resolved.requestToolPolicy)) return finalizeToolResult({
    ok: false, error: 'REQUEST_TOOL_DENIED', output: 'The user prohibited this tool or network operation for the current turn.',
    meta: { denied: true, executionStarted: false },
  });
  // Grants are never baked into a scope: every call is checked against the
  // grant-free view, and live grants (or a user prompt) are consulted only when
  // that view denies — so a revocation applies to the very next call.
  let capabilityScope=liveCapabilityScope(narrowCapabilityScope(resolved.capabilityScope,{capabilities:options.capabilities,allowedToolIds:options.allowedToolIds}));
  let capabilityElevation=null;
  if (!scopeAllowsTool(capabilityScope,tool,args)) {
    // Capability elevation (2026-10-20): beyond-parent / just-in-time prompts on
    // an interactive surface; otherwise the same CAPABILITY_DENIED as before.
    let outcome;
    try { outcome=await requestCapabilityElevation({scope:capabilityScope,tool,args,context:resolved,sseEmitter:options.sseEmitter,signal:options.signal}); }
    catch { outcome={allowed:false}; }
    if (!outcome.allowed) return finalizeToolResult(outcome.result || {ok:false,error:'CAPABILITY_DENIED',output:`Agent ${capabilityScope.agentId} is not allowed to execute ${tool.id}.`,meta:{denied:true,executionStarted:false}});
    capabilityScope=outcome.scope;
    capabilityElevation=outcome.meta;
  }
  let workspacePath;
  try {workspacePath=await workspaceForTool(resolved,tool,args,options.workspacePath);}
  catch(error) {return finalizeToolResult({ok:false,error:error.code || 'WORKSPACE_UNAVAILABLE',output:error.message,meta:{denied:true,executionStarted:false}});}
  const ownedWorkspace=await ownedWorkspaceSafety(resolved,workspacePath);
  const permissionScope=await operationScope(resolved,workspacePath,capabilityScope.agentId);
  const requestContext=Object.freeze({...resolved,config:options.config || resolved.config,workspacePath,ownedWorkspace,capabilityScope,permissionScope});
  const scopedOptions={...options,workspacePath,requestContext,capabilities:capabilityScope.capabilities,agentId:capabilityScope.agentId,
    allowedToolIds:capabilityScope.allowedToolIds,taskId:resolved.turnBinding?.taskId || null};
  const result=await runWithRequestContext(requestContext,()=>executeScopedTool(tool,args,scopedOptions));
  // Audit (rule 7): the decision travels with the result into the tool record.
  return capabilityElevation && result && typeof result==='object' ? {...result,meta:{...result.meta,capabilityElevation}} : result;
}

async function executeScopedTool(tool,args,options) {
  const requestContext=options.requestContext;
  const id = options.toolCallId || randomUUID();
  let executionStarted = false;
  const observe = (status, result) => {
    if (status === 'running') executionStarted = true;
    try { options.sseEmitter?.('execution_event', observeTool({ id, name: tool.id, args, status, result, tool })); } catch {}
  };
  let waiting = false;
  const emit = (type,payload) => {
    if(type === 'tool_permission' && options.taskId) {
      waiting = true;
      recordTaskApproval(requestContext,options.taskId,id,payload.operation || tool.id,true).catch(()=>{});
    }
    // An event raised inside a member (its prompts bubble up through the parent's
    // delegate call) keeps the member's Agent id; the executing Agent fills it otherwise.
    options.sseEmitter?.(type,{...payload,agentId:payload?.agentId || options.agentId || requestContext?.turnBinding?.role});
  };
  observe('queued');
  try {
    const ticket = reserveTaskOperation({locale:options.config?.replyLanguage,home:requestContext?.home || options.meloHome || resolveRuntimePaths().home,taskId:options.taskId,tool,args,workspacePath:options.workspacePath,invocationId:`${requestContext?.runId || 'direct'}:${id}`});
    let result;
    try { result = ticket?.result || await runObservedTool(tool, args, { ...options, sseEmitter:emit, observe }); }
    catch(error) { ticket?.finish?.({ok:false,meta:{executionStarted}}); throw error; }
    ticket?.finish?.({ ...result, meta: { executionStarted, ...result.meta } });
    observe(null, result);
    return result;
  } catch (error) {
    observe(null, { ok: false, output: error.message, error: error.code, meta: { aborted: !!options.signal?.aborted } });
    throw error;
  } finally { if(waiting) await recordTaskApproval(requestContext,options.taskId,id,tool.id,false).catch(()=>{}); }
}

async function runObservedTool(tool, args, options = {}) {
  const requestContext = options.requestContext || currentRequestContext();
  const meloHome = options.meloHome || requestContext?.home || resolveRuntimePaths().home;
  const { sseEmitter, workspacePath, signal, chatId, onOutput, config, agentDepth, allowedToolIds } = options;

  // ── Permission gate ──────────────────────────────────────────────────────────
  if (tool.requiresPermission !== false) {
    options.observe?.('waiting');
    try {
      // Pass chatId so session-scope grants don't leak across chats.
      await requestPermission(tool.id, args, sseEmitter, signal, chatId, requestContext);
    } catch (err) {
      return finalizeToolResult({
        ok: false,
        output: err.message,
        error: err.code === 'PERMISSION_NO_SURFACE' ? 'PERMISSION_NO_SURFACE' : 'PERMISSION_DENIED',
        meta: { denied: true, detail: err.message },
      });
    }
  }

  // ── Abort guard ──────────────────────────────────────────────────────────────
  if (signal?.aborted) {
    return finalizeToolResult({
      ok: false,
      output: 'Aborted before execution.',
      error: 'ABORTED',
      meta: { aborted: true },
    });
  }

  // ── Run budget gate (design audit C1) ────────────────────────────────────────
  // The turn's deadline / token / tool-call pool lives on the request context.
  // A call past the limit is answered locally so the model gets an explicit
  // code instead of another timeout; every call that does run is counted.
  const budget = requestContext?.budget || null;
  const exhausted = budgetExhausted(budget);
  if (exhausted) {
    return finalizeToolResult({
      ok: false,
      output: fillTemplate(AGENT_LOOP_CONTRACT.budget.toolSkippedTemplate, { reason: exhausted.reason, tool: tool.id }),
      error: 'BUDGET_EXHAUSTED',
      meta: { executionStarted: false, budget: { reason: exhausted.reason, limit: exhausted.limit, used: exhausted.used } },
    });
  }
  recordUsage(budget, { toolCalls: 1 });

  // ── Plugin hook: tool:before ────────────────────────────────────────────────
  // Bounded (agent-loop-audit #2): a stuck plugin cannot block the tool or the
  // chat queue; the caller's abort also cancels the wait.
  await emitHook('tool:before', { toolId: tool.id, args, runId: requestContext?.runId, requestId: requestContext?.requestId }, { signal });

  const controller = new AbortController();
  let cancelError = null;
  let rejectCancelled;
  const cancelled = new Promise((_, reject) => { rejectCancelled = reject; });
  const cancel = error => {
    if (controller.signal.aborted) return;
    cancelError = error;
    rejectCancelled(error);
    controller.abort(error);
  };
  const onAbort = () => cancel(Object.assign(new Error('Tool execution aborted.'), { code: 'ABORTED' }));
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();

  // ── Execution context ────────────────────────────────────────────────────────
  const context = {
    requestContext,
    runId: requestContext?.runId,
    requestId: requestContext?.requestId,
    meloHome,
    signal: controller.signal,
    workspacePath,
    onOutput: typeof onOutput === 'function' ? (...values) => {
      if (!controller.signal.aborted) onOutput(...values);
    } : onOutput,
    chatId,
    config,
    onExecutionState: status => { if (!controller.signal.aborted && ['waiting', 'running'].includes(status)) options.observe?.(status); },
    sseEmitter: typeof sseEmitter === 'function' ? (...values) => {
      if (!controller.signal.aborted) sseEmitter(...values);
    } : sseEmitter,
    agentDepth: agentDepth || 0,
    agentId: options.agentId,
    capabilities: options.capabilities,
    capabilityScope: requestContext.capabilityScope,
    collaboration: options.collaboration,
    agentProfiles: options.agentProfiles,
    extraTools: options.extraTools,
    projectId: options.projectId,
    ancestry: options.ancestry,
    maxDelegationDepth: options.maxDelegationDepth,
    memberBackground: options.memberBackground,
    chatSource: options.chatSource,
    // Null is the legacy unrestricted caller; an array (including []) means the sub-agent
    // must stay within this whitelist. Tools like `agent` propagate this downward.
    allowedToolIds: Array.isArray(allowedToolIds) ? allowedToolIds : null,
  };

  // ── Run with timeout wrapper ─────────────────────────────────────────────────
  // The tool's own ceiling, cut to whatever run time is left (C1).
  const timeout = Math.max(1, Math.min(tool.timeout ?? DEFAULT_TOOL_TIMEOUT_MS, remainingMs(budget)));
  let timeoutId;

  timeoutId = setTimeout(() => {
    // Bug audit T7: a cut caused by the run deadline is reported as
    // BUDGET_EXHAUSTED, so the model stops instead of retrying "the tool".
    const byBudget = budget && remainingMs(budget) <= 0;
    cancel(Object.assign(
      new Error(byBudget
        ? `Run budget (deadline) ran out while tool "${tool.id}" was running (${timeout / 1000}s in); the run budget, not the tool's own time limit, was exhausted.`
        : `Tool "${tool.id}" timed out after ${timeout / 1000}s.`),
      { code: byBudget ? 'BUDGET_EXHAUSTED' : 'TOOL_TIMEOUT' },
    ));
  }, timeout);

  try {
    const rawResult = await Promise.race([
      trackWorkspaceWork(Promise.resolve().then(() => {
        if (controller.signal.aborted) throw cancelError;
        if (!tool.observesOwnLifecycle) options.observe?.('running');
        return tool.run(args, context);
      })),
      cancelled,
    ]);
    if (cancelError) throw cancelError;
    clearTimeout(timeoutId);
    // Normalise — ensure ok/output fields exist.  G-1d (2026-05-11):
    // preserve `evidenceTrail` (3 search tools' fallback diagnostic structure
    // from Phase G-1a/b/c) through normalization.  Without this preservation
    // step, every tool result reaching `chatExecutionRunner` / `subAgent` /
    // `skillExecutor` silently lost the trail — the data was produced but
    // never reachable by downstream consumers.  This is the smallest slice
    // of G-1d (chat thread state 写 trail): once the executor preserves
    // the field, callers CAN store/surface it; previously they couldn't.
    let result;
    if (!rawResult || typeof rawResult !== 'object') {
      result = { ok: true, output: String(rawResult ?? ''), meta: {} };
    } else {
      result = {
        ok: rawResult.ok !== false,
        output: typeof rawResult.output === 'string' ? rawResult.output : JSON.stringify(rawResult),
        error: rawResult.error,
        meta: rawResult.meta ?? {},
      };
      // Ephemeral page bodies for completion evidence; trace/persistence use
      // their existing allowlists and deliberately never store this field.
      if (tool.id === 'web_search' && Array.isArray(rawResult.completionSources)) result.completionSources = rawResult.completionSources;
      // Bug audit T1 (2026-10-18): the B1 envelope fields a tool sets itself
      // (`status:'empty'`, `code:'NO_RESULTS'`) must survive normalisation,
      // otherwise finalizeToolResult sees a plain `ok:true` and the model
      // never gets the NO_RESULTS hint for grep/glob/search_history/read_history.
      if (typeof rawResult.status === 'string') result.status = rawResult.status;
      if (typeof rawResult.code === 'string') result.code = rawResult.code;
      // Only attach evidenceTrail when the tool actually produced one;
      // avoids polluting all other tools' results with `evidenceTrail: undefined`.
      if (Array.isArray(rawResult.evidenceTrail) && rawResult.evidenceTrail.length > 0) {
        result.evidenceTrail = rawResult.evidenceTrail;
      }
    }
    // Envelope (design audit B1): status ok|empty|error + canonical code.
    result = finalizeToolResult(result);
    // Plugin hook: tool:after (bounded; a cancelled tool does not wait for it)
    await emitHook('tool:after', { toolId: tool.id, args, result }, { signal });
    return result;
  } catch (err) {
    clearTimeout(timeoutId);
    const byBudget = cancelError?.code === 'BUDGET_EXHAUSTED';
    const result = finalizeToolResult({
      ok: false,
      output: `Tool error: ${err.message}`,
      error: err.code && /^[A-Z][A-Z0-9_]{1,63}$/.test(String(err.code)) ? err.code : err.message,
      ...(byBudget ? { code: 'BUDGET_EXHAUSTED' } : {}),
      meta: cancelError
        ? { aborted: true, timedOut: cancelError.code === 'TOOL_TIMEOUT' || byBudget,
          ...(byBudget ? { budget: { reason: 'deadline', limit: budget.deadlineAt - budget.startedAt, used: (typeof budget.now === 'function' ? budget.now() : Date.now()) - budget.startedAt } } : {}) }
        : {},
    });
    if (!cancelError) await emitHook('tool:after', { toolId: tool.id, args, result }, { signal });
    return result;
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Execute multiple tool calls, respecting concurrency constraints.
 *
 * - Calls judged concurrency-safe (toolConcurrencySafe(tool, args): the tool's
 *   `concurrency` declaration evaluated for these args, else isConcurrencySafe)
 *   run in parallel (grouped together).
 * - Serial calls flush any pending parallel group first, then run alone.
 *
 * Returns an array of { toolCallId, toolId, result } in original order.
 *
 * @param {Array<{ id: string, tool: Object, args: Object }>} calls
 *   Each entry: { id: toolCallId, tool: Tool object, args: parsed args }
 * @param {Object} options  - same as executeTool options
 * @returns {Promise<Array<{ id: string, toolId: string, result: import('./tool.js').ToolResult }>>}
 */
export async function executeToolCalls(calls, options = {}) {
  if (!calls.length) return [];
  if (calls.length > 32 || new Set(calls.map(call => call.id)).size !== calls.length) {
    return calls.map(call => ({ id: call.id, toolId: call.tool?.id,
      result: { ok: false, error: 'INVALID_TOOL_BATCH', output: 'Too many calls or duplicate call IDs; no tools in this batch were executed.' } }));
  }

  const results = new Array(calls.length);
  let parallelGroup = []; // indices of queued concurrent-safe calls
  // Design audit D1: every entry also reports wall-clock timing and the
  // scheduling group it ran in (one number per parallel flush or serial call)
  // so the runner can build the ToolInvocationRecord without re-timing.
  let groupSequence = 0;

  async function executeIndex(idx, group) {
    const { id, tool, args } = calls[idx];
    const startedAt = Date.now();
    let result;
    try {
      result = await executeTool(tool, args, { ...options, toolCallId: `${options.executionPrefix || ''}${id}` });
    } catch (error) {
      // A scope/ledger failure is also a result for this call. Await the rest
      // of the batch before any serial write or next model request begins.
      result = finalizeToolResult({ ok: false, error: error.code || 'TOOL_EXECUTION_FAILED', output: error.message,
        meta: { aborted: !!options.signal?.aborted } });
    }
    results[idx] = { id, toolId: tool.id, result, startedAt, finishedAt: Date.now(), parallelGroup: group };
  }

  async function flushParallel() {
    if (!parallelGroup.length) return;
    const group = parallelGroup.slice();
    parallelGroup = [];
    const groupId = groupSequence++;
    let cursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(4, group.length) }, async () => {
        while (cursor < group.length) {
          const idx = group[cursor++];
          await executeIndex(idx, groupId);
        }
      }),
    );
  }

  for (let i = 0; i < calls.length; i++) {
    const { id, tool, args } = calls[i];

    if (toolConcurrencySafe(tool, args)) {
      parallelGroup.push(i);
    } else {
      // Flush any accumulated safe tools first
      await flushParallel();
      // Then run this serial tool
      await executeIndex(i, groupSequence++);
    }
  }

  // Flush remaining parallel group
  await flushParallel();

  return results;
}
