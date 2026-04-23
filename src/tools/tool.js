/**
 * Tool interface contract for Melo's tool system.
 *
 * Every tool is a plain object (not a class) that satisfies this shape.
 * Validated at registration time.
 *
 * Execution contract:
 *   - run() resolves to a ToolResult
 *   - Errors should throw — the executor wraps them as { ok: false, error }
 *   - Long-running tools should honour the AbortSignal
 *
 * Concurrency contract:
 *   - isConcurrencySafe: true  → may run in parallel with other safe tools
 *   - isConcurrencySafe: false → must run serially (default)
 *
 * Permission contract:
 *   - requiresPermission: true  → executor asks user before running (default for destructive tools)
 *   - requiresPermission: false → runs immediately (read-only, safe tools)
 */

/**
 * @typedef {Object} ToolResult
 * @property {boolean} ok
 * @property {string}  output   - human-readable output (shown in chat)
 * @property {string}  [error]  - error message when ok=false
 * @property {Object}  [meta]   - optional structured metadata (exit codes, paths, etc.)
 */

/**
 * @typedef {Object} ToolRunContext
 * @property {AbortSignal}         signal         - propagated abort signal
 * @property {string}              [workspacePath] - active project workspace root
 * @property {Function}            [onOutput]      - streaming output callback (chunk: string) => void
 * @property {string}              [chatId]        - active chat id (for scoped state)
 */

/**
 * Validate that an object satisfies the Tool interface.
 * @param {Object} tool
 * @returns {{ valid: boolean, reason?: string }}
 */
export function validateTool(tool) {
  if (!tool || typeof tool !== 'object') {
    return { valid: false, reason: 'Tool must be a plain object.' };
  }
  if (typeof tool.id !== 'string' || !tool.id.trim()) {
    return { valid: false, reason: 'Tool must have a non-empty string id.' };
  }
  if (typeof tool.name !== 'string' || !tool.name.trim()) {
    return { valid: false, reason: 'Tool must have a non-empty string name.' };
  }
  if (typeof tool.description !== 'string' || !tool.description.trim()) {
    return { valid: false, reason: 'Tool must have a non-empty string description.' };
  }
  if (typeof tool.parametersSchema !== 'object' || !tool.parametersSchema) {
    return { valid: false, reason: 'Tool must have a parametersSchema object.' };
  }
  if (typeof tool.run !== 'function') {
    return { valid: false, reason: 'Tool must have a run(args, context) function.' };
  }
  return { valid: true };
}

/**
 * Default values for optional tool properties.
 */
export function normalizeToolDefaults(tool) {
  return {
    isConcurrencySafe: false,
    requiresPermission: true,
    category: 'general',
    examples: [],
    ...tool,
  };
}
