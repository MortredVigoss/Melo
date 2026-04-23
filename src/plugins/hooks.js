/**
 * Plugin lifecycle hook system.
 *
 * Provides a simple publish/subscribe event bus for plugin hooks.
 * Hooks are named lifecycle points where plugins can observe or modify
 * the system's behavior.
 *
 * Available hooks (mirrors key events in the system):
 *
 *   'chat:message:before'   – before a user message is processed
 *   'chat:message:after'    – after the model replies
 *   'tool:before'           – before a tool is executed
 *   'tool:after'            – after a tool executes
 *   'compact:after'         – after a context compact runs
 *   'mcp:connected'         – when an MCP server connects
 *   'mcp:disconnected'      – when an MCP server disconnects
 *
 * Plugin registration:
 *   registerPlugin('my-plugin', {
 *     'chat:message:before': async ({ chat, message }) => { ... },
 *     'tool:after': async ({ toolId, result }) => { ... },
 *   });
 *
 * Emitting (internal):
 *   await emitHook('chat:message:before', { chat, message });
 */

// ─── Registry ─────────────────────────────────────────────────────────────────

/**
 * Map: hookName → Array<{ pluginId, handler }>
 * @type {Map<string, Array<{ pluginId: string, handler: Function }>>}
 */
const _hooks = new Map();

/**
 * Map: pluginId → Set of hookNames (for cleanup)
 * @type {Map<string, Set<string>>}
 */
const _pluginHooks = new Map();

// ─── Registration API ─────────────────────────────────────────────────────────

/**
 * Register a plugin with one or more hook handlers.
 *
 * @param {string} pluginId     - unique plugin identifier
 * @param {Object} handlers     - map of hookName → async function(payload)
 */
export function registerPlugin(pluginId, handlers = {}) {
  if (!pluginId || typeof pluginId !== 'string') {
    throw new Error('pluginId must be a non-empty string.');
  }

  // Unregister old handlers for this plugin (allows hot-reload)
  unregisterPlugin(pluginId);

  const hookNames = new Set();

  for (const [hookName, handler] of Object.entries(handlers)) {
    if (typeof handler !== 'function') continue;
    if (!_hooks.has(hookName)) _hooks.set(hookName, []);
    _hooks.get(hookName).push({ pluginId, handler });
    hookNames.add(hookName);
  }

  _pluginHooks.set(pluginId, hookNames);
}

/**
 * Unregister all hooks for a plugin.
 * @param {string} pluginId
 */
export function unregisterPlugin(pluginId) {
  const hookNames = _pluginHooks.get(pluginId);
  if (!hookNames) return;

  for (const hookName of hookNames) {
    const handlers = _hooks.get(hookName);
    if (!handlers) continue;
    const filtered = handlers.filter(h => h.pluginId !== pluginId);
    if (filtered.length) {
      _hooks.set(hookName, filtered);
    } else {
      _hooks.delete(hookName);
    }
  }

  _pluginHooks.delete(pluginId);
}

/**
 * Return all registered plugin ids.
 * @returns {string[]}
 */
export function getRegisteredPlugins() {
  return [..._pluginHooks.keys()];
}

/**
 * Return all registered hooks for a plugin.
 * @param {string} pluginId
 * @returns {string[]}
 */
export function getPluginHooks(pluginId) {
  return [...(_pluginHooks.get(pluginId) || [])];
}

// ─── Emit API ─────────────────────────────────────────────────────────────────

/**
 * Emit a hook event. All registered handlers are called sequentially.
 * Errors from individual handlers are caught and logged (non-fatal).
 *
 * The payload may be mutated by handlers (observe-and-modify pattern).
 *
 * @param {string} hookName
 * @param {Object} [payload]
 * @returns {Promise<Object>}  – the (potentially mutated) payload
 */
export async function emitHook(hookName, payload = {}) {
  const handlers = _hooks.get(hookName);
  if (!handlers?.length) return payload;

  for (const { pluginId, handler } of handlers) {
    try {
      const result = await handler(payload);
      // If the handler returns an object, merge it back into payload
      if (result && typeof result === 'object' && !Array.isArray(result)) {
        Object.assign(payload, result);
      }
    } catch (err) {
      process.stderr.write(`[plugin:${pluginId}] Hook "${hookName}" error: ${err.message}\n`);
    }
  }

  return payload;
}

/**
 * Clear all hooks (mainly for tests).
 */
export function clearAllPlugins() {
  _hooks.clear();
  _pluginHooks.clear();
}
