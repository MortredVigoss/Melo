/**
 * MCP tool registry (design audit 2026-10-17, F3 "MCP 注册隔离").
 *
 * Stdio MCP servers register their tools HERE, never into the global tool
 * registry (`registryCore.js`). The chat runner's prepare step merges
 * `toolsForAgent(agentProfile)` into that chat's tool list — the same place
 * per-request skill tools are merged — so two agents in parallel chats see
 * disjoint MCP tool sets and a member / sub-agent can only reach the MCP
 * tools its own profile (∩ the parent's) allows.
 *
 * Naming contract:
 *   - `tool.id` stays `mcp:<server>:<tool>` (capability checks, approvals and
 *     the UI keep working unchanged — see `src/mcp/toolId.js`).
 *   - The wire function name the model sees is the readable
 *     `mcp__<server>__<tool>` (sanitised to `[A-Za-z0-9_]`); only when that
 *     would exceed 64 characters does it become `mcp__<server>__<sha1[:10]>`.
 *     `functionNameFor` / `resolveFunctionName` are the writer/reader pair;
 *     `compileFunctionTool` honours `tool.functionName` and the runner's
 *     dispatcher resolves both the id and the function name.
 */

import { createHash } from 'node:crypto';
import { normalizeToolDefaults, validateTool } from './tool.js';
import { filterMcpToolsForAgent } from '../domain/agent/agentTools.js';
import { parseMcpToolId } from '../mcp/toolId.js';

export const MCP_FUNCTION_PREFIX = 'mcp__';
export const MCP_FUNCTION_NAME_MAX = 64;
const HASH_CHARS = 10;

const _tools = new Map();        // toolId → tool (with functionName)
const _byFunction = new Map();   // functionName → toolId

function sanitizeSegment(value) {
  return String(value ?? '').replace(/[^A-Za-z0-9_]/g, '_');
}

/**
 * Readable wire name for an MCP tool. Pure: the same input always yields the
 * same output; collisions after sanitising (`a-b` vs `a_b`) are handled by
 * the registry, not here.
 *
 * @param {string} serverId
 * @param {string} toolName
 * @returns {string} `mcp__<server>__<tool>` or `mcp__<server>__<sha1[:10]>`
 */
export function mcpFunctionName(serverId, toolName) {
  const server = sanitizeSegment(serverId);
  const readable = `${MCP_FUNCTION_PREFIX}${server}__${sanitizeSegment(toolName)}`;
  if (readable.length <= MCP_FUNCTION_NAME_MAX) return readable;
  return hashedFunctionName(server, `${serverId}:${toolName}`);
}

function hashedFunctionName(server, material) {
  const digest = createHash('sha1').update(String(material)).digest('hex').slice(0, HASH_CHARS);
  const budget = MCP_FUNCTION_NAME_MAX - MCP_FUNCTION_PREFIX.length - 2 - HASH_CHARS;
  return `${MCP_FUNCTION_PREFIX}${server.slice(0, budget)}__${digest}`;
}

/**
 * Register one MCP tool (built by `buildMcpTool`). Idempotent for the same
 * id; throws on validation failure like the global registry does.
 *
 * @param {Object} tool — must carry `id` of the form `mcp:<server>:<tool>`
 * @returns {Object} the stored tool (normalised, with `functionName`)
 */
export function registerMcpTool(tool) {
  const normalized = normalizeToolDefaults(tool);
  const { valid, reason } = validateTool(normalized);
  if (!valid) throw new Error(`Invalid MCP tool: ${reason}`);
  const parsed = parseMcpToolId(normalized.id);
  if (!parsed) throw new Error(`Invalid MCP tool id "${normalized.id}"`);
  const existing = _tools.get(normalized.id);
  if (existing) return existing;
  let functionName = mcpFunctionName(parsed.server, parsed.tool);
  // Two different tools may sanitise to the same readable name; the later
  // one falls back to the hashed form so the reverse map stays unambiguous.
  if (_byFunction.has(functionName)) functionName = hashedFunctionName(sanitizeSegment(parsed.server), normalized.id);
  if (_byFunction.has(functionName)) throw new Error(`MCP function name collision for "${normalized.id}"`);
  const stored = { ...normalized, functionName };
  _tools.set(stored.id, stored);
  _byFunction.set(functionName, stored.id);
  return stored;
}

export function registerMcpTools(tools) {
  return (Array.isArray(tools) ? tools : []).map(registerMcpTool);
}

/** Remove one tool by id. */
export function unregisterMcpTool(id) {
  const tool = _tools.get(id);
  if (!tool) return false;
  _tools.delete(id);
  _byFunction.delete(tool.functionName);
  return true;
}

/** Remove every tool a server registered (server disconnect / reload). */
export function unregisterMcpServer(serverId) {
  let removed = 0;
  for (const tool of [..._tools.values()]) {
    const parsed = parseMcpToolId(tool.id);
    if (parsed?.server === serverId && unregisterMcpTool(tool.id)) removed++;
  }
  return removed;
}

export function getMcpTool(id) {
  return _tools.get(id) ?? null;
}

export function getAllMcpTools() {
  return [..._tools.values()];
}

/** Reverse lookup: wire function name (or tool id) → tool. */
export function resolveMcpFunctionName(name) {
  if (typeof name !== 'string' || !name) return null;
  const byId = _tools.get(name);
  if (byId) return byId;
  const id = _byFunction.get(name);
  return id ? _tools.get(id) ?? null : null;
}

/** Wire name for a registered tool id (null when unknown). */
export function functionNameFor(toolId) {
  return _tools.get(toolId)?.functionName ?? null;
}

/**
 * MCP tools the given agent profile may use. Uses the same whitelist rule
 * as `filterMcpToolsForAgent` (`capabilities.mcpServers`, falling back to
 * `enabledMcpServerIds`; default deny-all). Returns a fresh array; the tool
 * objects are shared and must not be mutated by callers.
 *
 * @param {Object|null|undefined} profile
 * @returns {Object[]}
 */
export function toolsForAgent(profile) {
  if (!profile) return [];
  return filterMcpToolsForAgent(getAllMcpTools(), profile);
}

/**
 * Lookup map keyed by id and function name for a tool list. The XML
 * parser normalises names (lowercase, `-`/space → `_`), so those forms are
 * indexed too; exact keys are set last and win.
 */
export function indexMcpTools(tools) {
  const map = new Map();
  const normalized = value => String(value).toLowerCase().replace(/[\s-]+/g, '_');
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (!tool?.id) continue;
    for (const key of [tool.id, tool.functionName].filter(Boolean)) {
      if (!map.has(normalized(key))) map.set(normalized(key), tool);
    }
  }
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (!tool?.id) continue;
    map.set(tool.id, tool);
    if (tool.functionName) map.set(tool.functionName, tool);
  }
  return map;
}

/** Clear everything (tests). */
export function clearMcpRegistry() {
  _tools.clear();
  _byFunction.clear();
}
