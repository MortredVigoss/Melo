// MCP runtime initialiser.
//
// `initMcpServers()` is what the desktop server calls at boot, after a
// config write, and after the Advanced page's preset toggle.  Its job
// is dead-simple — pull the current resolved config, build the
// `enable*Mcp` flag set, and hand both off to `bootstrapMcpServers`
// so the manager can reconcile (connect new, disconnect stale,
// reconnect changed).
//
// Lifted out of `src/desktopStore.js` in 2026-04-28 so the lifecycle
// can be exercised end-to-end without booting the desktop store —
// the dependencies are injectable via `opts.getConfig` /
// `opts.bootstrap` / `opts.log` for `node:test`.  Production callers
// pass nothing and get the real wiring.
//
// Codex 2026-04-28 audit: this function used to gate the
// `bootstrapMcpServers` call on `hasServers`, which meant toggling the
// last MCP off (or removing the last user-configured entry) silently
// skipped the reconciler.  The contract now is **always sync** — even
// the empty-map case must run so the reconciler can reap whatever's
// still active in `_clients`.

import { getResolvedConfig as defaultGetConfig } from '../config.js';
import { bootstrapMcpServers as defaultBootstrap } from './manager.js';

/**
 * Build the `flags` map the manager expects from a resolved config.
 * Pure — exposed for tests.
 */
export function buildMcpFlags(config = {}) {
  return {
    enablePlaywrightMcp:   Boolean(config.enablePlaywrightMcp),
    enableBrowserlessMcp:  Boolean(config.enableBrowserlessMcp),
    enableAntvChartMcp:    Boolean(config.enableAntvChartMcp),
    enableMarkdown2PdfMcp: Boolean(config.enableMarkdown2PdfMcp),
    enableMermaidMcp:      Boolean(config.enableMermaidMcp),
  };
}

/**
 * @param {Object} [opts]
 * @param {() => Promise<Object>} [opts.getConfig]    fetch resolved config;
 *   defaults to `getResolvedConfig` from src/config.js
 * @param {(mcpServers: Object, flags: Object) => Promise<Object>} [opts.bootstrap]
 *   reconcile + connect; defaults to `bootstrapMcpServers` from manager.js
 * @param {(message: string) => void} [opts.log]      stderr-shaped logger;
 *   tests can capture
 * @returns {Promise<Object>} the bootstrap result map (or `{}` when an
 *   error short-circuits the run; the error is logged but never thrown).
 */
export async function initMcpServers(opts = {}) {
  const getConfig = typeof opts.getConfig === 'function' ? opts.getConfig : defaultGetConfig;
  const bootstrap = typeof opts.bootstrap === 'function' ? opts.bootstrap : defaultBootstrap;
  const log = typeof opts.log === 'function' ? opts.log : msg => {
    try { process.stderr.write(msg); } catch {}
  };

  try {
    const config = await getConfig();
    const mcpServers = (config && typeof config.mcpServers === 'object' && config.mcpServers) || {};
    const flags = buildMcpFlags(config);

    // ALWAYS sync — even an empty effective map must run the
    // reconciler so previously-active servers get reaped when the
    // user turns off the last MCP / deletes the last entry.
    const results = await bootstrap(mcpServers, flags);

    const connected = Object.entries(results)
      .filter(([, r]) => r?.connected)
      .map(([name, r]) => `${name}(${r.toolCount} tools)`)
      .join(', ');
    if (connected) log(`[mcp] Connected: ${connected}\n`);

    const reaped = Object.entries(results)
      .filter(([, r]) => !r?.connected && (r?.error === 'disabled' || r?.error === 'removed'))
      .map(([name, r]) => `${name}(${r.error})`)
      .join(', ');
    if (reaped) log(`[mcp] Reaped: ${reaped}\n`);

    const errors = Object.entries(results)
      .filter(([, r]) => !r?.connected && r?.error && r.error !== 'disabled' && r.error !== 'removed')
      .map(([name, r]) => `${name}: ${r.error}`)
      .join(', ');
    if (errors) log(`[mcp] Failed to connect: ${errors}\n`);

    return results;
  } catch (err) {
    log(`[mcp] Init error: ${err?.message || err}\n`);
    return {};
  }
}
