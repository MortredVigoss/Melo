/**
 * MCP server manager.
 *
 * Manages the lifecycle of MCP server connections defined in user config.
 * Registers discovered tools into the global tool registry with a `mcp:` prefix
 * so they're automatically available to the model's tool loop.
 *
 * Config shape (stored in melo config under `mcpServers`):
 * {
 *   "my-server": {
 *     "command": "npx",
 *     "args": ["-y", "@some/mcp-server"],
 *     "env": { "API_KEY": "..." },
 *     "disabled": false
 *   }
 * }
 *
 * Tool IDs registered from MCP follow the format: `mcp:<serverName>:<toolName>`
 */

import { McpStdioClient, mcpResultToToolResult } from './client.js';
import { registerTool, unregisterTool, getTool } from '../tools/registry.js';

// Active clients: serverName → McpStdioClient
const _clients = new Map();

// Track which tool IDs we registered (so we can clean them up on reload)
const _registeredMcpToolIds = new Set();

// ─── Connect a single server ──────────────────────────────────────────────────

/**
 * Connect to one MCP server, discover its tools, and register them.
 *
 * @param {string} serverName
 * @param {{ command: string, args?: string[], env?: Object, disabled?: boolean }} serverConfig
 * @returns {Promise<{ connected: boolean, toolCount: number, error?: string }>}
 */
export async function connectMcpServer(serverName, serverConfig) {
  if (serverConfig.disabled) {
    return { connected: false, toolCount: 0, error: 'disabled' };
  }

  // Disconnect existing client if re-connecting
  if (_clients.has(serverName)) {
    disconnectMcpServer(serverName);
  }

  const client = new McpStdioClient({
    command: serverConfig.command,
    args: serverConfig.args || [],
    env: serverConfig.env || {},
    name: serverName,
  });

  try {
    await client.connect();
    _clients.set(serverName, client);

    const mcpTools = await client.listTools();
    let registered = 0;

    for (const mcpTool of mcpTools) {
      const toolId = `mcp:${serverName}:${mcpTool.name}`;
      if (getTool(toolId)) continue; // already registered

      const tool = buildMcpTool(serverName, mcpTool, client);
      try {
        registerTool(tool);
        _registeredMcpToolIds.add(toolId);
        registered++;
      } catch {
        // Duplicate or invalid — skip
      }
    }

    return { connected: true, toolCount: registered };
  } catch (err) {
    // Clean up failed client
    try { client.disconnect(); } catch {}
    _clients.delete(serverName);
    return { connected: false, toolCount: 0, error: err.message };
  }
}

// ─── Disconnect a single server ───────────────────────────────────────────────

/**
 * Disconnect from a server and unregister its tools.
 * @param {string} serverName
 */
export function disconnectMcpServer(serverName) {
  const client = _clients.get(serverName);
  if (client) {
    try { client.disconnect(); } catch {}
    _clients.delete(serverName);
  }

  // Unregister all tools belonging to this server
  const prefix = `mcp:${serverName}:`;
  for (const toolId of [..._registeredMcpToolIds]) {
    if (toolId.startsWith(prefix)) {
      try { unregisterTool(toolId); } catch {}
      _registeredMcpToolIds.delete(toolId);
    }
  }
}

// ─── Bootstrap all servers from config ───────────────────────────────────────

// ─── First-class browser MCPs ─────────────────────────────────────────────────

/**
 * Built-in MCP server presets for browser automation.
 * Enable via config flags instead of manual mcpServers config:
 *
 *   config.enablePlaywrightMcp   = true  → @playwright/mcp (official, full browser)
 *   config.enableBrowserlessMcp  = true  → @browserless/mcp (cloud, anti-bot profiles)
 *
 * These spin up via npx — no install needed (npx handles it).
 *
 * Playwright covers: JS rendering, form fill, click-through, screenshot, PDF.
 * Browserless adds: cloud IP pool, stealth mode, better Cloudflare bypass rates.
 */
const BROWSER_MCP_PRESETS = {
  playwright: {
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest'],
    description: 'Full Chromium browser — JS rendering, form fill, screenshot, PDF export.',
  },
  browserless: {
    command: 'npx',
    args: ['-y', '@browserless/mcp@latest'],
    description: 'Cloud browser with stealth profiles — better Cloudflare bypass.',
  },
};

/**
 * Build the effective MCP server map, merging user config with auto-enabled presets.
 *
 * @param {Object} mcpServers           - user-configured servers from config
 * @param {Object} [flags]              - feature flags from config
 * @param {boolean} [flags.enablePlaywrightMcp]
 * @param {boolean} [flags.enableBrowserlessMcp]
 * @returns {Object}  - merged server map
 */
export function buildEffectiveMcpServers(mcpServers = {}, flags = {}) {
  const effective = { ...mcpServers };

  if (flags.enablePlaywrightMcp && !effective.playwright) {
    effective.playwright = BROWSER_MCP_PRESETS.playwright;
  }
  if (flags.enableBrowserlessMcp && !effective.browserless) {
    effective.browserless = BROWSER_MCP_PRESETS.browserless;
  }

  return effective;
}

/**
 * Connect all MCP servers defined in config.
 * Called once at startup (idempotent).
 *
 * @param {Object} mcpServers  - map of serverName → serverConfig
 * @param {Object} [flags]     - feature flags (enablePlaywrightMcp, enableBrowserlessMcp)
 * @returns {Promise<Object>}  - map of serverName → connection result
 */
export async function bootstrapMcpServers(mcpServers = {}, flags = {}) {
  const effective = buildEffectiveMcpServers(mcpServers, flags);
  const results = {};
  await Promise.all(
    Object.entries(effective).map(async ([name, cfg]) => {
      results[name] = await connectMcpServer(name, cfg);
    }),
  );
  return results;
}

/**
 * Disconnect all active MCP servers.
 */
export function shutdownMcpServers() {
  for (const name of [..._clients.keys()]) {
    disconnectMcpServer(name);
  }
}

/**
 * Return all active server names.
 * @returns {string[]}
 */
export function getActiveMcpServers() {
  return [..._clients.keys()];
}

// ─── Build a Melo Tool object wrapping an MCP tool ────────────────────────────

function buildMcpTool(serverName, mcpTool, client) {
  const toolId = `mcp:${serverName}:${mcpTool.name}`;
  // Normalise the MCP inputSchema to our parametersSchema format
  const parametersSchema = mcpTool.inputSchema || { type: 'object', properties: {} };

  return {
    id: toolId,
    name: `${serverName}/${mcpTool.name}`,
    description: mcpTool.description || `MCP tool from ${serverName}`,
    category: 'mcp',
    parametersSchema,
    // MCP tools require permission unless they're clearly read-only
    requiresPermission: true,
    isConcurrencySafe: false,

    async run(args, context = {}) {
      const raw = await client.callTool(mcpTool.name, args);
      return mcpResultToToolResult(raw);
    },
  };
}
