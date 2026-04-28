// Single source of truth for MCP server id rules + the
// `mcp:<server>:<tool>` tool-id encoding used across the runtime
// (manager.js, agentTools.filterMcpToolsForAgent, desktopBootstrap
// mcpAuthSurface).
//
// Why this exists: until 2026-04-28 the runtime concatenated server
// names into tool ids with `:` and split them back with `split(':')[1]`.
// Codex audit caught the obvious problem — a user-configured server
// named `safe:evil` collides on parse: an agent authorised for
// `safe` would silently grant access to every `safe:evil:*` tool
// because the parser returns `safe`. Locking the server id grammar +
// routing every read/write through these helpers closes that gap.
//
// Contract: a legal MCP server id is `[A-Za-z0-9_-]+` — same character
// set the cwd sandbox uses (mcpServerWorkspaceDir) so a value that
// passes here is automatically safe as a directory leaf. No `.`, no
// `:` (which would re-introduce the split bug), no whitespace, no
// control characters, no Unicode.

export const MCP_SERVER_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
export const MCP_TOOL_ID_PREFIX = 'mcp:';

/**
 * Reject empty / non-string / out-of-charset server ids before they
 * reach the spawn / register-tool / authorise paths.
 *
 * @param {unknown} id
 * @returns {boolean}
 */
export function isValidMcpServerId(id) {
  return typeof id === 'string' && MCP_SERVER_ID_PATTERN.test(id);
}

/**
 * Compose the canonical tool id for an MCP-registered tool.  Throws
 * on an invalid server id so a caller can't silently produce a
 * malformed `mcp:bad:tool` entry that the parser would later
 * misattribute.  Tool names from the MCP server are not gated
 * because they're consumed verbatim by `client.callTool` — only the
 * server-side prefix matters for auth.
 *
 * @param {string} serverId  must satisfy MCP_SERVER_ID_PATTERN
 * @param {string} toolName  the MCP tool's own name (untouched)
 * @returns {string} `mcp:<serverId>:<toolName>`
 */
export function formatMcpToolId(serverId, toolName) {
  if (!isValidMcpServerId(serverId)) {
    throw new Error(
      `MCP server id "${serverId}" violates the [A-Za-z0-9_-]+ contract — ` +
      `formatMcpToolId refuses to compose an ambiguous tool id.`,
    );
  }
  return `${MCP_TOOL_ID_PREFIX}${serverId}:${String(toolName ?? '')}`;
}

/**
 * Parse `mcp:<server>:<tool>` back into structured form.  Returns
 * null for anything that doesn't match the strict shape — including
 * a tool id whose server segment fails MCP_SERVER_ID_PATTERN, which
 * is how this helper closes the `safe:evil` ambiguity: the only way
 * to reach `parseMcpToolId(...)` returning `{ server: 'safe' }` is
 * for the prefix-encoded server segment to actually be `safe`.
 *
 * @param {unknown} toolId
 * @returns {{ server: string, tool: string } | null}
 */
export function parseMcpToolId(toolId) {
  if (typeof toolId !== 'string') return null;
  if (!toolId.startsWith(MCP_TOOL_ID_PREFIX)) return null;
  const rest = toolId.slice(MCP_TOOL_ID_PREFIX.length);
  // First `:` after the prefix separates server from tool name.
  const sep = rest.indexOf(':');
  if (sep <= 0) return null;
  const server = rest.slice(0, sep);
  const tool = rest.slice(sep + 1);
  if (!isValidMcpServerId(server)) return null;
  if (!tool) return null;
  return { server, tool };
}
