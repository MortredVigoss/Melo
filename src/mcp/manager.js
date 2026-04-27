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

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { McpStdioClient, mcpResultToToolResult } from './client.js';
import { registerTool, unregisterTool, getTool } from '../tools/registry.js';
import { getMeloHome } from '../config.js';

/**
 * Resolve the per-server working directory under
 * `<MELO_HOME>/desktop/mcp-workspace/<server>/`.  Each MCP server is spawned
 * with its cwd locked to this subtree so a misbehaving stdio MCP can't
 * casually reach into the user's $HOME or melo's own state.  The directory
 * is created lazily — `mkdirSync({ recursive: true })` is idempotent.
 *
 * Captured at connect time so a mid-flight `MELO_HOME` flip in another part
 * of the process can't desync (CLAUDE.md §6).
 */
export function mcpServerWorkspaceDir(serverName) {
  const home = getMeloHome();
  const safe = String(serverName || 'mcp-server').replace(/[^A-Za-z0-9._-]/g, '_');
  return join(home, 'desktop', 'mcp-workspace', safe);
}

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

  // Sandbox the server's working directory.  `serverConfig.cwd` opt-out
  // (e.g. for an MCP that genuinely needs to operate on the user's full
  // workspace) lets advanced users disable the sandbox by setting it to
  // null explicitly; everyone else gets the per-server subtree.
  let cwd = serverConfig.cwd;
  if (cwd === undefined) {
    cwd = mcpServerWorkspaceDir(serverName);
  }
  if (cwd) {
    try { mkdirSync(cwd, { recursive: true }); } catch (err) {
      // mkdir failure isn't fatal; the spawn will surface a more specific
      // error if the path is genuinely unusable.
      process.stderr.write(`[mcp:${serverName}] failed to prepare cwd ${cwd}: ${err?.message || err}\n`);
    }
  }

  const client = new McpStdioClient({
    command: serverConfig.command,
    args: serverConfig.args || [],
    env: serverConfig.env || {},
    name: serverName,
    cwd,
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
 * Built-in MCP server presets for productivity tools (charts, document
 * conversion).  Same flag-driven on/off model as `BROWSER_MCP_PRESETS`;
 * each entry surfaces in `getBuiltinMcpPresets()` for the Advanced UI to
 * render a toggle.  Defaults are tuned for safety: only the document
 * converter is on out of the box (matches user request "默认只启用搜索和
 * PDF"); chart server stays opt-in because it pulls a heavier dep tree
 * + can fetch external resources at render time.
 *
 *   config.enableMarkdown2PdfMcp = true (default)  → @99xio/markdown2pdf-mcp
 *   config.enableAntvChartMcp    = false (default) → @antv/mcp-server-chart
 */
const BUILTIN_MCP_PRESETS = {
  'antv-chart': {
    command: 'npx',
    args: ['-y', '@antv/mcp-server-chart'],
    description: 'AntV chart generator — 25+ chart types for data viz.',
    flag: 'enableAntvChartMcp',
  },
  'markdown2pdf': {
    command: 'npx',
    args: ['-y', '@99xio/markdown2pdf-mcp'],
    description: 'Markdown → PDF converter with syntax highlighting.',
    flag: 'enableMarkdown2PdfMcp',
  },
};

/**
 * Snapshot of every preset (browser + builtin) for UI surfaces — Advanced
 * page renders one toggle per preset using this list.
 *
 * @returns {Array<{ id, command, args, description, flag }>}
 */
export function getBuiltinMcpPresets() {
  const out = [];
  out.push({
    id: 'playwright',
    flag: 'enablePlaywrightMcp',
    ...BROWSER_MCP_PRESETS.playwright,
  });
  out.push({
    id: 'browserless',
    flag: 'enableBrowserlessMcp',
    ...BROWSER_MCP_PRESETS.browserless,
  });
  for (const [id, preset] of Object.entries(BUILTIN_MCP_PRESETS)) {
    out.push({ id, ...preset });
  }
  return out;
}

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

  // Chart + document-conversion presets.  Each preset stores its own flag
  // name so adding a new built-in is a single map entry; no extra
  // branching here.  User-supplied entries with the same id always win.
  for (const [id, preset] of Object.entries(BUILTIN_MCP_PRESETS)) {
    if (flags[preset.flag] && !effective[id]) {
      // Strip the preset-only `flag` field before merging — server config
      // shape only knows about `command` / `args` / `env` / `disabled`.
      const { flag: _flag, description: _desc, ...serverConfig } = preset;
      effective[id] = serverConfig;
    }
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

// Exported so unit tests can pin the security-relevant defaults
// (requiresPermission, category) without spawning an MCP server.  The
// `client` parameter is only used inside the `run` callback, so callers
// in tests can pass a stub.
export function buildMcpTool(serverName, mcpTool, client) {
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
