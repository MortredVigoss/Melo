// MCP server presets (browser + productivity), their version pins and the
// effective-server merge. Moved out of manager.js (byte-for-byte port,
// 2026-10-22) so lower layers can read presets without reaching the tool
// registry that manager.js imports; manager.js re-exports the public API.

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
