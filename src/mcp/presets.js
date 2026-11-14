import {PUBLIC_MEDIA_SERVER,MEDIA_PLATFORMS} from '../../shared/agent/media/publicPlatforms.js';
// MCP server presets (browser + productivity), their version pins and the
// effective-server merge. Moved out of manager.js (byte-for-byte port,
// 2026-10-22) so lower layers can read presets without reaching the tool
// registry that manager.js imports; manager.js re-exports the public API.

import { socialPresets } from './socialPresets.js';
import { isValidMcpServerId } from './toolId.js';

// ─── First-class browser MCPs ─────────────────────────────────────────────────

/**
 * Built-in MCP server preset for browser automation.
 * Enable via a config flag instead of manual mcpServers config:
 *
 *   config.enablePlaywrightMcp   = true  → @playwright/mcp (official, full browser)
 *
 * It spins up via npx — no install needed (npx handles it).
 * Playwright covers: JS rendering, form fill, click-through, screenshot, PDF.
 *
 * There used to be a second entry, `browserless` (@browserless/mcp). That npm
 * package never existed, so the preset could not be enabled or connected and
 * only showed an "unavailable" row; it was removed on 2026-11-14 together with
 * the `unpinned` state it alone could be in. The hosted Browserless service is
 * added through the HTTP MCP form. A saved `enableBrowserlessMcp` flag is
 * left in the configuration untouched and has no effect.
 */
const BROWSER_MCP_PRESETS = {
  playwright: {
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest'],
    description: 'Full Chromium browser — JS rendering, form fill, screenshot, PDF export.',
  },
};

// Pinned versions for the args above. We DON'T inline `@version` into
// `args` directly because every callsite that wants to spawn one of
// these presets reuses the array — pinning lives here so a single
// place stays the source of truth, with a sweep applied below to
// rewrite each `<package>@latest` (or bare `<package>`) into `<package>@<lock>`.
//
// Every npm package a preset names must have an exact version here: an
// `@latest` that reaches npx is the supply-chain hole the pinning sweep
// closes (Codex 二轮 audit 2026-04-29). presets.test.js fails the gate for a
// preset whose package is missing from this map or not an exact version.
export const PINNED_VERSIONS = Object.freeze({
  '@playwright/mcp':         '0.0.71',
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

for (const preset of Object.values(BROWSER_MCP_PRESETS)) {
  preset.args = preset.args.map(pinPackageArg);
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
// 2026-04-29). The pin map (PINNED_VERSIONS, defined above this preset
// block) is the single source of truth.
for (const preset of Object.values(BUILTIN_MCP_PRESETS)) {
  preset.args = preset.args.map(pinPackageArg);
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
  for (const [id, preset] of Object.entries(BUILTIN_MCP_PRESETS)) {
    out.push({ id, ...preset });
  }
  for (const [id,s] of Object.entries(socialPresets)) out.push({id,flag:s.flag,description:s.description,transport:'managed-http',version:s.tag});
  out.push({id:PUBLIC_MEDIA_SERVER,flag:'enablePublicMediaMcp',transport:'in-process',version:'1.0.0',
    description:MEDIA_PLATFORMS.map(p=>p.site).join(' · ')});
  return out;
}

/**
 * Build the effective MCP server map, merging user config with auto-enabled presets.
 *
 * @param {Object} mcpServers           - user-configured servers from config
 * @param {Object} [flags]              - feature flags from config
 * @param {boolean} [flags.enablePlaywrightMcp]
 * @returns {Object}  - merged server map
 */
export function buildEffectiveMcpServers(mcpServers = {}, flags = {}) {
  const effective = { ...mcpServers };

  if (flags.enablePlaywrightMcp && !effective.playwright) {
    effective.playwright = BROWSER_MCP_PRESETS.playwright;
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

  for (const [id,s] of Object.entries(socialPresets)) {
    if (flags[s.flag] && !Object.hasOwn(effective,id)) effective[id]={managedSocial:id};
  }
  if(flags.enablePublicMediaMcp && !Object.hasOwn(effective,PUBLIC_MEDIA_SERVER))
    effective[PUBLIC_MEDIA_SERVER]={builtinPublicMedia:true};
  return effective;
}

/**
 * Server ids an Agent can actually use under `config`: built-in presets whose
 * flag is on plus the user's own `config.mcpServers`, minus disabled entries.
 * New Agents start with
 * all of them (user decision 2026-10-22); each Agent's MCP whitelist can still
 * add or remove servers.
 *
 * @param {Object} config  loaded config (preset flags + optional mcpServers)
 * @returns {string[]} sorted server ids
 */
export function usableMcpServerIds(config = {}) {
  const user = config?.mcpServers && typeof config.mcpServers === 'object' ? config.mcpServers : {};
  return Object.entries(buildEffectiveMcpServers(user, config || {}))
    .filter(([id, server]) => isValidMcpServerId(id) && !server?.disabled)
    .map(([id]) => id)
    .sort();
}
