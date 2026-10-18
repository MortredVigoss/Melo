/**
 * MCP server manager.
 *
 * Manages the lifecycle of MCP server connections defined in user config.
 * Registers discovered tools into the dedicated MCP registry
 * (`src/tools/mcpRegistry.js`, design F3) with a `mcp:` prefix; the chat
 * runner merges them per agent whitelist at prepare time — they are never
 * placed in the global tool registry.
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
import { join, resolve } from 'node:path';
import { McpStdioClient, mcpResultToToolResult } from './client.js';
import { registerMcpTool, unregisterMcpServer, getMcpTool, mcpFunctionName } from '../tools/mcpRegistry.js';
import { getMeloHome } from '../config.js';
import { formatMcpToolId, isValidMcpServerId } from './toolId.js';

/**
 * Resolve the **default working directory** for a per-server MCP child
 * process: `<MELO_HOME>/desktop/mcp-workspace/<server>/`.
 *
 * NOTE — this is *not* a sandbox.  A child process can still read /
 * write any path it has OS-level permission to via absolute paths,
 * `..`, or fs APIs.  The cwd lowers the default landing spot for
 * artefacts the server creates without an explicit path; real access
 * control is enforced by the three other layers (see config.js):
 * global enable flag, per-agent whitelist, per-call approval.
 *
 * Path safety: server-name segments are sanitised so a name like
 * `../../etc/passwd` can't escape the mcp-workspace root.  Any of the
 * following inputs collapse to the fallback `mcp-server`:
 *   - non-string / null / undefined
 *   - empty / whitespace-only
 *   - `.` or `..` after the regex sweep
 * After sanitisation we re-`resolve` the joined path and assert it's
 * still inside the workspace root; anything that isn't (defence in
 * depth) also falls back to `mcp-server`.
 *
 * Captured at connect time so a mid-flight `MELO_HOME` flip can't
 * desync (CLAUDE.md §6).
 */
export function mcpServerWorkspaceDir(serverName) {
  const home = getMeloHome();
  const root = join(home, 'desktop', 'mcp-workspace');
  const fallback = join(root, 'mcp-server');

  const raw = typeof serverName === 'string' ? serverName : '';
  const trimmed = raw.trim();
  if (!trimmed) return fallback;

  const sanitised = trimmed.replace(/[^A-Za-z0-9_-]/g, '_');
  // After the regex sweep the leaf must still be a meaningful directory
  // name. Reject empty / dot / dot-dot, but also reject anything that
  // contains no letters or digits (e.g. "..." → "___", "    " → "____",
  // "._.-" → "_____") — those collapse to gibberish dirs we don't want
  // to create.
  if (!sanitised || sanitised === '.' || sanitised === '..') return fallback;
  if (!/[A-Za-z0-9]/.test(sanitised)) return fallback;

  const candidate = resolve(root, sanitised);
  // Defence in depth: even if a future regex tweak lets something odd
  // through, refuse the path unless it actually lives under root.
  const rootWithSep = root.endsWith('/') ? root : `${root}/`;
  if (!candidate.startsWith(rootWithSep)) return fallback;
  return candidate;
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
  // Refuse server ids that don't match `[A-Za-z0-9_-]+`.  Codex
  // 2026-04-28 audit: a server named `safe:evil` produced
  // `mcp:safe:evil:<tool>` tool ids that the agent-whitelist parser
  // misattributed to server `safe`, granting access to a different
  // server's tools.  Pinning the contract at connect time blocks the
  // attack at its earliest reachable surface; bootstrapMcpServers
  // also filters them out + warns so this branch is mostly defensive.
  if (!isValidMcpServerId(serverName)) {
    return {
      connected: false,
      toolCount: 0,
      error: `invalid server id "${serverName}" — must match [A-Za-z0-9_-]+`,
    };
  }

  if (serverConfig.disabled) {
    // Codex 🔴 audit 2026-04-28: a previously-running server that
    // flips to disabled=true must actually be stopped — otherwise the
    // child process keeps going and its mcp:<name>:* tools stay
    // registered, so any agent already on the whitelist can still
    // call them. Disconnect-then-skip closes that gap.
    if (_clients.has(serverName)) {
      disconnectMcpServer(serverName);
    }
    return { connected: false, toolCount: 0, error: 'disabled' };
  }

  if (serverConfig.unpinned) {
    // Codex 二轮 audit 2026-04-29: a preset whose npm package isn't
    // pinned to an exact version (browserless today) must NOT spawn —
    // doing so would let `npx -y @pkg@latest` execute whatever the
    // maintainer pushed up at the moment of boot, defeating the
    // version-lock contract for automatic startup. Same disconnect-
    // existing-then-skip dance as the `disabled` branch above so an
    // earlier-running version doesn't linger after the contract changes.
    if (_clients.has(serverName)) {
      disconnectMcpServer(serverName);
    }
    return { connected: false, toolCount: 0, error: 'unpinned' };
  }

  // Disconnect existing client if re-connecting
  if (_clients.has(serverName)) {
    disconnectMcpServer(serverName);
  }

  // Pin the server's *default* working directory under the per-server
  // subtree so artefacts it writes without an explicit path land in
  // a predictable spot (see mcpServerWorkspaceDir for details — this
  // is not a sandbox).  Real access control comes from the per-agent
  // whitelist + the per-call approval modal.  `serverConfig.cwd: null`
  // opts out (e.g. for an MCP that genuinely needs to operate on the
  // user's full workspace).
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
      // formatMcpToolId enforces the server-id contract so a
      // future buggy caller can't slip an ambiguous prefix in
      // here.  serverName has already passed isValidMcpServerId
      // above; this is just the canonical writer call.
      const toolId = formatMcpToolId(serverName, mcpTool.name);
      if (getMcpTool(toolId)) continue; // already registered

      const tool = buildMcpTool(serverName, mcpTool, client);
      try {
        // F3 (design 2026-10-17): MCP tools live in their own registry;
        // the chat runner merges them per agent at prepare time, so the
        // global registry never exposes them to an unauthorised agent.
        registerMcpTool(tool);
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

  // Unregister all tools belonging to this server (mcpRegistry only —
  // they were never in the global registry).
  const prefix = `mcp:${serverName}:`;
  try { unregisterMcpServer(serverName); } catch {}
  for (const toolId of [..._registeredMcpToolIds]) {
    if (toolId.startsWith(prefix)) _registeredMcpToolIds.delete(toolId);
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

// Pinned versions for the args above. We DON'T inline `@version` into
// `args` directly because every callsite that wants to spawn one of
// these presets reuses the array — pinning lives here so a single
// place stays the source of truth, with a sweep applied below to
// rewrite each `<package>@latest` (or unpinned) into `<package>@<lock>`.
//
// The `null` sentinel means "no pinned version exists yet"; the
// preset gets marked `unpinned: true` and `connectMcpServer` refuses
// to spawn it.  Keeping a placeholder entry here (instead of dropping
// the preset entirely) means the UI can still surface the toggle in
// a disabled state with an explanatory message.  Codex 二轮 audit
// 2026-04-29: an unpinned `@latest` is the supply-chain hole the
// pinning sweep was meant to close — letting browserless silently
// stay on `@latest` would defeat that.
const PINNED_VERSIONS = Object.freeze({
  '@playwright/mcp':         '0.0.71',
  '@browserless/mcp':        null,  // package not on npm yet (404) — preset stays disabled
  '@antv/mcp-server-chart':  '0.9.10',
  '@99xio/markdown2pdf-mcp': '2.2.0',
  'mcp-mermaid':             '0.4.1',
});

function pinPackageArg(arg) {
  // npx args look like `<package>@<spec>` or just `<package>`.  We
  // rewrite to the locked version when we know one. This stops
  // `npx -y latest` supply-chain churn (Codex audit 2026-04-29):
  // the built-in startup policy uses these pinned versions; upgrades
  // happen on a Melo release boundary, not on each new npm tag.
  if (typeof arg !== 'string') return arg;
  const atIdx = arg.lastIndexOf('@');
  // scoped names (`@scope/name`) have an `@` at index 0 we must
  // ignore; only treat `@` as a version separator when it's NOT
  // the very first character.
  const baseName = atIdx > 0 ? arg.slice(0, atIdx) : arg;
  const pinned = PINNED_VERSIONS[baseName];
  if (!pinned) return arg;
  return `${baseName}@${pinned}`;
}

/**
 * Decide whether `/api/mcp/preset-toggle` should refuse a request to
 * ENABLE the preset behind `flag`. Returns a human-readable reason
 * string when the request must be refused, or `null` when it should
 * proceed. Disable requests (enabled=false) are NEVER refused —
 * users must always be able to clear a legacy `enable*Mcp:true`
 * config flag from the UI.
 *
 * Codex 四轮 audit 2026-04-29: extracted from the route handler so
 * node:test can pin the contract without booting the http server.
 *
 * @param {string} flag      one of the ALLOWED_MCP_FLAGS values
 * @param {boolean} enabled  the request body's enabled field
 * @returns {string|null}    reason when refused, null when allowed
 */
export function mcpPresetToggleRefusalReason(flag, enabled) {
  if (enabled !== true) return null; // disable always allowed
  const matched = getBuiltinMcpPresets().find(p => p.flag === flag);
  if (matched?.unpinned) {
    return (
      `Preset "${matched.id}" has no pinned version yet — refuse to enable. ` +
      `(See PINNED_VERSIONS in src/mcp/manager.js. enabled:false is still allowed for cleanup.)`
    );
  }
  return null;
}

function presetHasPinnedVersion(preset) {
  // A preset is "pinned" iff every npm package name in its args is
  // present in PINNED_VERSIONS with a non-null exact-version
  // string. browserless deliberately maps to `null` until its npm
  // package ships — this function returns false for it, the
  // `unpinned` flag below records that, and `connectMcpServer`
  // refuses to spawn it.
  for (const arg of preset.args) {
    if (typeof arg !== 'string') continue;
    const atIdx = arg.lastIndexOf('@');
    const baseName = atIdx > 0 ? arg.slice(0, atIdx) : arg;
    if (baseName in PINNED_VERSIONS) {
      const v = PINNED_VERSIONS[baseName];
      if (typeof v !== 'string' || !v) return false;
    }
  }
  return true;
}

for (const preset of Object.values(BROWSER_MCP_PRESETS)) {
  preset.args = preset.args.map(pinPackageArg);
  if (!presetHasPinnedVersion(preset)) preset.unpinned = true;
}

/**
 * Built-in MCP server presets for productivity tools (charts, document
 * conversion).  Same flag-driven on/off model as `BROWSER_MCP_PRESETS`;
 * each entry surfaces in `getBuiltinMcpPresets()` for the Advanced UI to
 * render a toggle. These no-fee presets start by default; manual disables
 * remain effective. AntV uses a free remote renderer; PDF and Mermaid render
 * locally. Startup alone does not grant tool-call permission to agents.
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
  // mermaid renderer — `markdown2pdf-mcp` deps are remarkable +
  // highlight.js + puppeteer (no mermaid), so ```mermaid``` blocks
  // there ship as plain text. `mcp-mermaid` (hustcc / antv-team
  // author, same shop as @antv/mcp-server-chart) renders the
  // diagram via mermaid-isomorphic + playwright. Adding it as a
  // sibling preset means the agent can either inline a mermaid
  // diagram into chat (rendered to PNG) or — combined with
  // markdown2pdf — embed pre-rendered images into a PDF.
  'mermaid': {
    command: 'npx',
    args: ['-y', 'mcp-mermaid'],
    description: 'Mermaid diagram renderer (flowchart, sequence, ER, state, etc.) → PNG.',
    flag: 'enableMermaidMcp',
  },
};

// Apply the same version-pin sweep as BROWSER_MCP_PRESETS (Codex
// 2026-04-29). Keeping the pin map (PINNED_VERSIONS, defined above
// this preset block) as the single source of truth.  Any preset
// whose npm package isn't pinned to an exact version gets the
// `unpinned: true` marker — `connectMcpServer` will refuse to spawn
// such servers until the version map is updated.
for (const preset of Object.values(BUILTIN_MCP_PRESETS)) {
  preset.args = preset.args.map(pinPackageArg);
  if (!presetHasPinnedVersion(preset)) preset.unpinned = true;
}

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
 * Pure half of the bootstrap reconciler.  Decides which currently-active
 * server names should be disconnected because they're no longer in the
 * effective config (or are now flagged disabled).  No I/O of its own —
 * the caller hands in the `disconnect` side-effect (production passes
 * `disconnectMcpServer`; tests pass a spy).
 *
 * @param {Object} opts
 * @param {Object<string, Object>} opts.effective    server-name → serverConfig
 * @param {string[]}                opts.activeNames currently-connected names
 * @param {(name: string) => void}  opts.disconnect  side-effect; called for
 *                                                   each stale name
 * @returns {Array<{name: string, reason: 'removed'|'disabled'}>}
 */
export function reconcileMcpLifecycle({ effective = {}, activeNames = [], disconnect }) {
  const stale = [];
  for (const name of activeNames) {
    const cfg = effective[name];
    if (!cfg) {
      stale.push({ name, reason: 'removed' });
      if (typeof disconnect === 'function') disconnect(name);
    } else if (cfg.disabled) {
      stale.push({ name, reason: 'disabled' });
      if (typeof disconnect === 'function') disconnect(name);
    }
  }
  return stale;
}

/**
 * Bring the running MCP fleet into agreement with the config.  Acts as a
 * lifecycle reconciler — Codex 🔴 audit 2026-04-28 caught that the
 * previous version only *added* connections from the effective map, so
 * toggling a server off (or removing it from `mcpServers`) didn't stop
 * the running process or unregister its tools, and any agent already on
 * its whitelist could keep calling.
 *
 * The current contract:
 *
 *   1. Compute the effective (built-in presets ∪ user-configured) map.
 *   2. For every currently-connected server name that is either
 *      missing from the effective map OR present-but-disabled, call
 *      `disconnectMcpServer`. That kills the child process AND
 *      unregisters its `mcp:<server>:*` tools so the agent dispatcher
 *      sees nothing to call.
 *   3. For every effective entry, call `connectMcpServer` (which has
 *      its own disabled / already-running guards).
 *
 * Agents' `enabledMcpServerIds` whitelists stay untouched on purpose —
 * they're stale authorisations the user can revoke through the UI; the
 * tools themselves are gone, so a stale entry can't actually be
 * exercised until the global toggle comes back on.
 *
 * @param {Object} mcpServers  - map of serverName → serverConfig
 * @param {Object} [flags]     - feature flags (enable*Mcp)
 * @returns {Promise<Object>}  - map of serverName → connection result
 *                               (disconnected entries report
 *                               `{ connected: false, error: 'removed' }`
 *                               or `'disabled'`)
 */
export async function bootstrapMcpServers(mcpServers = {}, flags = {}) {
  const rawEffective = buildEffectiveMcpServers(mcpServers, flags);

  // Phase 0 — strip entries whose server id violates the contract so
  // they never reach connectMcpServer / the auth surface / the tool
  // registry.  Codex 2026-04-28 audit: a `safe:evil` user-config
  // entry would have masqueraded as `safe` once concatenated into
  // tool ids.  Surfacing the rejection on stderr (not throwing) so a
  // bad config entry doesn't kill the whole boot — the rest of the
  // fleet still comes up.
  const effective = {};
  const results = {};
  for (const [name, cfg] of Object.entries(rawEffective)) {
    if (!isValidMcpServerId(name)) {
      process.stderr.write(
        `[mcp] skipping server "${name}": id must match [A-Za-z0-9_-]+ ` +
        `(rename in config.mcpServers)\n`,
      );
      results[name] = {
        connected: false,
        toolCount: 0,
        error: `invalid server id "${name}"`,
      };
      continue;
    }
    effective[name] = cfg;
  }

  // Phase 1 — reap stale connections.  reconcileMcpLifecycle is the
  // pure half: it inspects effective vs the snapshot of active names
  // and asks the caller to disconnect each stale entry.  We pass
  // disconnectMcpServer as the side-effect, and the helper returns
  // a list of {name, reason} so we can populate `results` uniformly.
  const stale = reconcileMcpLifecycle({
    effective,
    activeNames: [..._clients.keys()],
    disconnect: disconnectMcpServer,
  });
  for (const { name, reason } of stale) {
    results[name] = { connected: false, toolCount: 0, error: reason };
  }

  // Phase 2 — connect / reconnect every effective entry.  connectMcpServer
  // is idempotent: if the same client is already running and the config
  // hasn't materially changed, it disconnects and reconnects (cheap; the
  // listTools roundtrip is the dominant cost, not spawn).
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
  // Use the canonical writer so a malformed serverName can't reach
  // toolRegistry as `mcp:<bad>:<tool>` and confuse the auth parser
  // later.  Throws if serverName violates [A-Za-z0-9_-]+; production
  // callers (connectMcpServer) gate on the same check upstream so
  // this throw is unreachable on the happy path.
  const toolId = formatMcpToolId(serverName, mcpTool?.name);
  // Normalise the MCP inputSchema to our parametersSchema format
  const parametersSchema = mcpTool.inputSchema || { type: 'object', properties: {} };

  return {
    id: toolId,
    name: `${serverName}/${mcpTool.name}`,
    // Readable wire name for the model (F3); the registry re-derives it on
    // registration, this is only so unregistered fixtures carry it too.
    functionName: mcpFunctionName(serverName, mcpTool?.name),
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
