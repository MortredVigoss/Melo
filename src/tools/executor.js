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
  const { sseEmitter, workspacePath, signal, chatId, onOutput, config, agentDepth, allowedToolIds } = options;

  // ── Permission gate ──────────────────────────────────────────────────────────
  if (tool.requiresPermission !== false) {
    try {
      // Pass chatId so session-scope grants don't leak across chats.
      await requestPermission(tool.id, args, sseEmitter, signal, chatId);
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
  await emitHook('tool:before', { toolId: tool.id, args });

  // ── Execution context ────────────────────────────────────────────────────────
  const context = {
    signal,
    workspacePath,
    onOutput,
    chatId,
    config,
    sseEmitter,
    agentDepth: agentDepth || 0,
    // Null means "no restriction" (main model loop); an array means the sub-agent
    // must stay within this whitelist. Tools like `agent` propagate this downward.
    allowedToolIds: Array.isArray(allowedToolIds) ? allowedToolIds : null,
  };

  // ── Run with timeout wrapper ─────────────────────────────────────────────────
  const timeout = tool.timeout ?? DEFAULT_TOOL_TIMEOUT_MS;
  let timeoutId;

  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(`Tool "${tool.id}" timed out after ${timeout / 1000}s.`)),
      timeout,
    );
  });

  try {
    const rawResult = await Promise.race([
      tool.run(args, context),
      timeoutPromise,
    ]);
    clearTimeout(timeoutId);
    // Normalise — ensure ok/output fields exist
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
      meta: {},
    };
    await emitHook('tool:after', { toolId: tool.id, args, result });
    return result;
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

  const results = new Array(calls.length);
  let parallelGroup = []; // indices of queued concurrent-safe calls

  async function flushParallel() {
    if (!parallelGroup.length) return;
    const group = parallelGroup.slice();
    parallelGroup = [];
    await Promise.all(
      group.map(async (idx) => {
        const { id, tool, args } = calls[idx];
        const result = await executeTool(tool, args, options);
        results[idx] = { id, toolId: tool.id, result };
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
      const result = await executeTool(tool, args, options);
      results[i] = { id, toolId: tool.id, result };
    }
  }

  // Flush remaining parallel group
  await flushParallel();

  return results;
}
