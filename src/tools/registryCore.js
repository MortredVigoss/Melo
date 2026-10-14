// Registry storage and lookup; byte-for-byte port from registry.js.
import { validateTool, normalizeToolDefaults } from './tool.js';

// ─── Internal registry map ────────────────────────────────────────────────────

const _registry = new Map(); // toolId → normalised Tool

// ─── Registration ─────────────────────────────────────────────────────────────

/**
 * Register a tool.  Throws if validation fails or id already exists.
 * @param {Object} tool
 */
export function registerTool(tool) {
  const normalized = normalizeToolDefaults(tool);
  const { valid, reason } = validateTool(normalized);
  if (!valid) throw new Error(`Invalid tool: ${reason}`);
  if (_registry.has(normalized.id)) {
    throw new Error(`Tool "${normalized.id}" is already registered.`);
  }
  _registry.set(normalized.id, normalized);
}

/**
 * Register multiple tools at once (convenience wrapper).
 * @param {Object[]} tools
 */
export function registerTools(tools) {
  for (const tool of tools) registerTool(tool);
}

// ─── Lookup ───────────────────────────────────────────────────────────────────

/**
 * Return a tool by id, or null if not found.
 * @param {string} id
 * @returns {Object|null}
 */
export function getTool(id) {
  return _registry.get(id) ?? null;
}

/**
 * Return all registered tools as an array.
 * @returns {Object[]}
 */
export function getAllTools() {
  return [..._registry.values()];
}

/**
 * Return tools grouped by category.
 * @returns {Map<string, Object[]>}
 */
export function getToolsByCategory() {
  const groups = new Map();
  for (const tool of _registry.values()) {
    const cat = tool.category || 'general';
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(tool);
  }
  return groups;
}

/**
 * Unregister a tool by id (mainly for tests).
 * @param {string} id
 */
export function unregisterTool(id) {
  _registry.delete(id);
}

/**
 * Clear all tools (mainly for tests).
 */
export function clearRegistry() {
  _registry.clear();
}

