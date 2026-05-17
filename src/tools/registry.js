/**
 * Tool registry.
 *
 * Central store for all available tools.
 * Tools are registered once at startup; looked up by id at call time.
 *
 * Handles:
 *   - Validation and normalization on registration
 *   - Category grouping for system prompt injection
 *   - Lookup by id
 */

import { validateTool, normalizeToolDefaults } from './tool.js';
import { bashTool } from './builtins/bashTool.js';
import { fileReadTool } from './builtins/fileReadTool.js';
import { fileEditTool } from './builtins/fileEditTool.js';
import { fileWriteTool } from './builtins/fileWriteTool.js';
import { fileDeleteTool } from './builtins/fileDeleteTool.js';
import { fileMoveTool } from './builtins/fileMoveTool.js';
import { fileMkdirTool } from './builtins/fileMkdirTool.js';
import { globTool } from './builtins/globTool.js';
import { grepTool } from './builtins/grepTool.js';
import { agentTool } from '../agents/subAgent.js';
import { fetchUrlTool } from './builtins/fetchUrlTool.js';
import { webSearchTool } from './builtins/webSearchTool.js';
import { mediaInfoTool } from './builtins/mediaInfoTool.js';
import { mediaApiTool } from './builtins/mediaApiTool.js';
import { searchHistoryTool } from './builtins/searchHistoryTool.js';
import { pdfTool } from './builtins/pdfTool.js';
import { calculatorTool } from './builtins/calculatorTool.js';
import { clipboardTool } from './builtins/clipboardTool.js';
import { translateTool } from './builtins/translateTool.js';
import { imageTool } from './builtins/imageTool.js';
import { reminderTool } from './builtins/reminderTool.js';
import { knowledgeTool } from './builtins/knowledgeTool.js';
import { xlsxTool } from './builtins/xlsxTool.js';
import {
  browserOpenTool,
  browserSnapshotTool,
  browserCloseTool,
  browserClickTool,
  browserFillTool,
  browserWaitForTool,
} from './builtins/browserTools.js';

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

// ─── Bootstrap built-in tools ─────────────────────────────────────────────────

let _bootstrapped = false;

/**
 * Register all built-in tools.  Safe to call multiple times (idempotent).
 */
export function bootstrapBuiltinTools() {
  if (_bootstrapped) return;
  _bootstrapped = true;
  registerTools([bashTool, fileReadTool, fileEditTool, fileWriteTool, fileDeleteTool, fileMoveTool, fileMkdirTool, globTool, grepTool, agentTool, fetchUrlTool, webSearchTool, mediaInfoTool, mediaApiTool, searchHistoryTool, pdfTool, xlsxTool, calculatorTool, clipboardTool, translateTool, imageTool, reminderTool, knowledgeTool, browserOpenTool, browserSnapshotTool, browserCloseTool, browserClickTool, browserFillTool, browserWaitForTool]);
}
