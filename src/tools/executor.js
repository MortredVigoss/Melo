import {workspaceForTool,ownedWorkspaceSafety} from '../services/workspace/toolWorkspace.js';
import {trackWorkspaceWork} from '../agents/workspaceScheduling.js';
import {narrowCapabilityScope,scopeAllowsTool,missingCapabilityScope} from '../domain/agent/capabilityScope.js';
import {resolveCapabilityContext} from '../services/agent/capabilityContext.js';
import { recordTaskApproval } from '../services/task/taskApprovalCheckpoint.js';
import { operationScope } from '../safety/permissionContext.js';
import { reserveTaskOperation } from '../services/task/operationLedger.js';
import { randomUUID } from 'node:crypto';
import { observeTool } from './executionObservation.js';
import { currentRequestContext, runWithRequestContext } from '../runtime/requestScope.js';
/**
 * Tool executor.
 *
 * Handles:
 *   - Pre-execution permission checks (via permissions.js)
 *   - Concurrent vs serial execution based on tool.isConcurrencySafe
 *   - Timeout enforcement per-call
 *   - Structured ToolResult output
 *
 * Usage:
 *   const result = await executeTool(tool, args, { sseEmitter, workspacePath, signal, chatId, onOutput });
 */

import { requestPermission } from './permissions.js';
import { emitHook } from '../plugins/hooks.js';
import { resolveRuntimePaths } from '../runtime/paths.js';

const DEFAULT_TOOL_TIMEOUT_MS = 60_000;

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
  const capabilityScope=narrowCapabilityScope(resolved.capabilityScope,{capabilities:options.capabilities,allowedToolIds:options.allowedToolIds});
  if (!scopeAllowsTool(capabilityScope,tool.id,args)) {
    return {ok:false,error:'CAPABILITY_DENIED',output:`Agent ${capabilityScope.agentId} is not allowed to execute ${tool.id}.`,meta:{denied:true,executionStarted:false}};
  }
  let workspacePath;
  try {workspacePath=await workspaceForTool(resolved,tool,args,options.workspacePath);}
  catch(error) {return {ok:false,error:error.code || 'WORKSPACE_UNAVAILABLE',output:error.message,meta:{denied:true,executionStarted:false}};}
  const ownedWorkspace=await ownedWorkspaceSafety(resolved,workspacePath);
  const permissionScope=await operationScope(resolved,workspacePath,capabilityScope.agentId);
  const requestContext=Object.freeze({...resolved,workspacePath,ownedWorkspace,capabilityScope,permissionScope});
  const scopedOptions={...options,workspacePath,requestContext,capabilities:capabilityScope.capabilities,agentId:capabilityScope.agentId,
    allowedToolIds:capabilityScope.allowedToolIds,taskId:resolved.turnBinding?.taskId || null};
  return runWithRequestContext(requestContext,()=>executeScopedTool(tool,args,scopedOptions));
}

async function executeScopedTool(tool,args,options) {
  const requestContext=options.requestContext;
  const id = options.toolCallId || randomUUID();
  let executionStarted = false;
  const observe = (status, result) => {
    if (status === 'running') executionStarted = true;
    try { options.sseEmitter?.('execution_event', observeTool({ id, name: tool.id, args, status, result })); } catch {}
  };
  let waiting = false;
  const emit = (type,payload) => {
    if(type === 'tool_permission' && options.taskId) {
      waiting = true;
      recordTaskApproval(requestContext,options.taskId,id,payload.operation || tool.id,true).catch(()=>{});
    }
    options.sseEmitter?.(type,{...payload,agentId:options.agentId || requestContext?.turnBinding?.role});
  };
  observe('queued');
  try {
    const ticket = reserveTaskOperation({home:requestContext?.home || options.meloHome || resolveRuntimePaths().home,taskId:options.taskId,tool,args,workspacePath:options.workspacePath,invocationId:`${requestContext?.runId || 'direct'}:${id}`});
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
      return {
        ok: false,
        output: err.message,
        error: err.message,
        meta: { denied: true },
      };
    }
  }

  // ── Abort guard ──────────────────────────────────────────────────────────────
  if (signal?.aborted) {
    return {
      ok: false,
      output: 'Aborted before execution.',
      error: 'ABORTED',
      meta: { aborted: true },
    };
  }

  // ── Plugin hook: tool:before ────────────────────────────────────────────────
  await emitHook('tool:before', { toolId: tool.id, args, runId: requestContext?.runId, requestId: requestContext?.requestId });

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
    // Null is the legacy unrestricted caller; an array (including []) means the sub-agent
    // must stay within this whitelist. Tools like `agent` propagate this downward.
    allowedToolIds: Array.isArray(allowedToolIds) ? allowedToolIds : null,
  };

  // ── Run with timeout wrapper ─────────────────────────────────────────────────
  const timeout = tool.timeout ?? DEFAULT_TOOL_TIMEOUT_MS;
  let timeoutId;

  timeoutId = setTimeout(() => cancel(Object.assign(
    new Error(`Tool "${tool.id}" timed out after ${timeout / 1000}s.`),
    { code: 'TOOL_TIMEOUT' },
  )), timeout);

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
      // Only attach evidenceTrail when the tool actually produced one;
      // avoids polluting all other tools' results with `evidenceTrail: undefined`.
      if (Array.isArray(rawResult.evidenceTrail) && rawResult.evidenceTrail.length > 0) {
        result.evidenceTrail = rawResult.evidenceTrail;
      }
    }
    // Plugin hook: tool:after
    await emitHook('tool:after', { toolId: tool.id, args, result });
    return result;
  } catch (err) {
    clearTimeout(timeoutId);
    const result = {
      ok: false,
      output: `Tool error: ${err.message}`,
      error: err.message,
      meta: cancelError ? { aborted: true, timedOut: cancelError.code === 'TOOL_TIMEOUT' } : {},
    };
    await emitHook('tool:after', { toolId: tool.id, args, result });
    return result;
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Execute multiple tool calls, respecting concurrency constraints.
 *
 * - Tools with isConcurrencySafe=true run in parallel (grouped together).
 * - Tools with isConcurrencySafe=false run serially, and flush any
 *   pending parallel group first.
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

  async function executeIndex(idx) {
    const { id, tool, args } = calls[idx];
    let result;
    try {
      result = await executeTool(tool, args, { ...options, toolCallId: `${options.executionPrefix || ''}${id}` });
    } catch (error) {
      // A scope/ledger failure is also a result for this call. Await the rest
      // of the batch before any serial write or next model request begins.
      result = { ok: false, error: error.code || 'TOOL_EXECUTION_FAILED', output: error.message,
        meta: { aborted: !!options.signal?.aborted } };
    }
    results[idx] = { id, toolId: tool.id, result };
  }

  async function flushParallel() {
    if (!parallelGroup.length) return;
    const group = parallelGroup.slice();
    parallelGroup = [];
    let cursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(4, group.length) }, async () => {
        while (cursor < group.length) {
          const idx = group[cursor++];
          await executeIndex(idx);
        }
      }),
    );
  }

  for (let i = 0; i < calls.length; i++) {
    const { id, tool, args } = calls[i];

    if (tool.isConcurrencySafe) {
      parallelGroup.push(i);
    } else {
      // Flush any accumulated safe tools first
      await flushParallel();
      // Then run this serial tool
      await executeIndex(i);
    }
  }

  // Flush remaining parallel group
  await flushParallel();

  return results;
}
