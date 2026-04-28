// Integration-level tests for `initMcpServers` — the OUTER glue that
// pulls config + flags and hands them to `bootstrapMcpServers`. The
// inner reconcileMcpLifecycle is already tested as a pure function;
// what these tests pin is the wiring code on top of it, specifically
// the contract Codex caught us breaking in 2026-04-28:
//
//   "When the user toggles the last MCP off (or deletes the last
//    user-configured entry), initMcpServers MUST still call the
//    bootstrap so the reconciler can reap whatever's still active."
//
// The previous code gated on `hasServers` and short-circuited the
// reconcile entirely. We test that path explicitly here, plus the
// healthy-config baseline.

import test from 'node:test';
import assert from 'node:assert/strict';
import { initMcpServers, buildMcpFlags } from './init.js';

function fakeConfig(overrides = {}) {
  return {
    mcpServers: {},
    enablePlaywrightMcp: false,
    enableBrowserlessMcp: false,
    enableAntvChartMcp: false,
    enableMarkdown2PdfMcp: false,
    ...overrides,
  };
}

function spyBootstrap(returns = {}) {
  const calls = [];
  return {
    fn: async (mcpServers, flags) => {
      calls.push({ mcpServers, flags });
      return returns;
    },
    calls,
  };
}

// ─── buildMcpFlags ──────────────────────────────────────────────────────────

test('buildMcpFlags coerces every enable*Mcp field to a boolean', () => {
  const flags = buildMcpFlags({
    enablePlaywrightMcp: 1,
    enableBrowserlessMcp: 'true',
    enableAntvChartMcp: undefined,
    enableMarkdown2PdfMcp: null,
  });
  assert.equal(flags.enablePlaywrightMcp, true);
  assert.equal(flags.enableBrowserlessMcp, true);
  assert.equal(flags.enableAntvChartMcp, false);
  assert.equal(flags.enableMarkdown2PdfMcp, false);
});

test('buildMcpFlags returns all four flags even on an empty config', () => {
  const flags = buildMcpFlags({});
  assert.deepEqual(Object.keys(flags).sort(), [
    'enableAntvChartMcp',
    'enableBrowserlessMcp',
    'enableMarkdown2PdfMcp',
    'enablePlaywrightMcp',
  ]);
  for (const v of Object.values(flags)) assert.equal(v, false);
});

// ─── initMcpServers always reconciles (the regression the test file is for) ──

test('initMcpServers calls bootstrap even when every flag is false and mcpServers is empty', async () => {
  // Codex 🔴 2026-04-28: this is the key contract — a user who turned
  // off the LAST mcp must still trigger the reconciler so already-
  // active children + tools get reaped.
  const { fn: bootstrap, calls } = spyBootstrap({});
  await initMcpServers({
    getConfig: async () => fakeConfig(),
    bootstrap,
    log: () => {},
  });
  assert.equal(calls.length, 1, 'bootstrap must be called even with empty effective config');
  assert.deepEqual(calls[0].mcpServers, {});
  assert.deepEqual(calls[0].flags, buildMcpFlags({}));
});

test('initMcpServers reaps the lone built-in MCP after the user toggles its flag off', async () => {
  // Walk the real "user toggled markdown2pdf off via Advanced" flow:
  // - bootstrap returns the lifecycle reconciler's view (markdown2pdf
  //   was active, now removed); the manager already reaped it.
  // - initMcpServers should pass that result through and log the
  //   reaped server so an operator sees what happened.
  const captured = [];
  const log = msg => captured.push(msg);
  const { fn: bootstrap, calls } = spyBootstrap({
    markdown2pdf: { connected: false, toolCount: 0, error: 'removed' },
  });
  await initMcpServers({
    // markdown2pdf flag is false now (user toggled it off).
    getConfig: async () => fakeConfig({ enableMarkdown2PdfMcp: false }),
    bootstrap,
    log,
  });
  assert.equal(calls.length, 1);
  // Logs include the reap line, NOT a connect line.
  const joined = captured.join('');
  assert.match(joined, /Reaped: markdown2pdf\(removed\)/);
  assert.doesNotMatch(joined, /Connected:/);
});

test('initMcpServers reaps the lone user MCP after the user removes it from config', async () => {
  // Same flow but for user-configured rather than built-in: the user
  // deleted `mcpServers["my-tool"]` from config.json. Bootstrap
  // reports `removed`; init logs it.
  const captured = [];
  const log = msg => captured.push(msg);
  const { fn: bootstrap, calls } = spyBootstrap({
    'my-tool': { connected: false, toolCount: 0, error: 'removed' },
  });
  await initMcpServers({
    getConfig: async () => fakeConfig({ mcpServers: {} }),
    bootstrap,
    log,
  });
  assert.equal(calls.length, 1);
  assert.match(captured.join(''), /Reaped: my-tool\(removed\)/);
});

test('initMcpServers reaps a `disabled: true` user MCP without unsetting still-running ones', async () => {
  // Mixed: keep built-in antv-chart healthy + user MCP "extra" was
  // flipped to `disabled: true`. Bootstrap returns one connected,
  // one reaped; init logs both lines independently.
  const captured = [];
  const log = msg => captured.push(msg);
  const { fn: bootstrap } = spyBootstrap({
    'antv-chart': { connected: true, toolCount: 25 },
    'extra':      { connected: false, toolCount: 0, error: 'disabled' },
  });
  await initMcpServers({
    getConfig: async () => fakeConfig({
      enableAntvChartMcp: true,
      mcpServers: { extra: { command: 'npx', args: [], disabled: true } },
    }),
    bootstrap,
    log,
  });
  const joined = captured.join('');
  assert.match(joined, /Connected: antv-chart\(25 tools\)/);
  assert.match(joined, /Reaped: extra\(disabled\)/);
});

// ─── healthy connect path (sanity baseline) ─────────────────────────────────

test('initMcpServers reports connected servers in the connect log', async () => {
  const captured = [];
  const log = msg => captured.push(msg);
  const { fn: bootstrap } = spyBootstrap({
    'antv-chart':   { connected: true, toolCount: 25 },
    'markdown2pdf': { connected: true, toolCount: 1 },
  });
  await initMcpServers({
    getConfig: async () => fakeConfig({
      enableAntvChartMcp: true,
      enableMarkdown2PdfMcp: true,
    }),
    bootstrap,
    log,
  });
  const joined = captured.join('');
  assert.match(joined, /Connected: .*antv-chart\(25 tools\)/);
  assert.match(joined, /markdown2pdf\(1 tools\)/);
  assert.doesNotMatch(joined, /Reaped:/);
});

test('initMcpServers logs hard failures separately from disabled / removed reaps', async () => {
  // A server that genuinely failed to spawn (npm package missing,
  // etc.) gets the "Failed to connect:" line, not "Reaped:".
  const captured = [];
  const log = msg => captured.push(msg);
  const { fn: bootstrap } = spyBootstrap({
    'broken': { connected: false, toolCount: 0, error: 'spawn ENOENT' },
  });
  await initMcpServers({
    getConfig: async () => fakeConfig({
      mcpServers: { broken: { command: 'this-binary-does-not-exist' } },
    }),
    bootstrap,
    log,
  });
  const joined = captured.join('');
  assert.match(joined, /Failed to connect: broken: spawn ENOENT/);
  assert.doesNotMatch(joined, /Reaped:/);
});

// ─── error containment ─────────────────────────────────────────────────────

test('initMcpServers swallows getConfig errors and returns {}', async () => {
  // Server boot must not be blocked by a config read failure — the
  // function logs the error and resolves to an empty result.
  const captured = [];
  const log = msg => captured.push(msg);
  const result = await initMcpServers({
    getConfig: async () => { throw new Error('config disk read failed'); },
    bootstrap: async () => { throw new Error('should not be called'); },
    log,
  });
  assert.deepEqual(result, {});
  assert.match(captured.join(''), /Init error: config disk read failed/);
});

test('initMcpServers swallows bootstrap errors too (never crashes the host)', async () => {
  const captured = [];
  const log = msg => captured.push(msg);
  const result = await initMcpServers({
    getConfig: async () => fakeConfig(),
    bootstrap: async () => { throw new Error('manager exploded'); },
    log,
  });
  assert.deepEqual(result, {});
  assert.match(captured.join(''), /Init error: manager exploded/);
});

test('initMcpServers tolerates a config without mcpServers (defensive default)', async () => {
  const { fn: bootstrap, calls } = spyBootstrap({});
  await initMcpServers({
    getConfig: async () => ({}), // no mcpServers, no flags
    bootstrap,
    log: () => {},
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].mcpServers, {});
});
