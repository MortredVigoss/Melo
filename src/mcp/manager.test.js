// Tests for the MCP manager preset wiring + per-server cwd sandbox.
// Covers the pure helpers — `connectMcpServer` itself spawns child
// processes and is exercised by the live runtime, not here.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ORIGINAL_MELO_HOME = process.env.MELO_HOME;
const TEST_HOME = mkdtempSync(join(tmpdir(), 'melo-mcp-manager-test-'));
process.env.MELO_HOME = TEST_HOME;

const {
  buildEffectiveMcpServers,
  getBuiltinMcpPresets,
  mcpServerWorkspaceDir,
  buildMcpTool,
  reconcileMcpLifecycle,
} = await import('./manager.js');

after(() => {
  try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
  if (ORIGINAL_MELO_HOME === undefined) delete process.env.MELO_HOME;
  else process.env.MELO_HOME = ORIGINAL_MELO_HOME;
});

// ─── mcpServerWorkspaceDir ──────────────────────────────────────────────────

test('mcpServerWorkspaceDir lives under MELO_HOME/desktop/mcp-workspace/<name>', () => {
  const dir = mcpServerWorkspaceDir('antv-chart');
  assert.ok(dir.startsWith(TEST_HOME), `expected ${dir} under ${TEST_HOME}`);
  assert.ok(dir.endsWith('/desktop/mcp-workspace/antv-chart'));
});

test('mcpServerWorkspaceDir sanitises hostile server names (no path traversal)', () => {
  // Slashes get replaced with underscore so a server named
  // "../../etc/passwd" can't break out of the mcp-workspace subtree.
  // We allow `.` and `_` in the sanitised name (so "antv-chart" /
  // "playwright.local" stay readable), but Node's `path.resolve` of
  // the result must still land inside the workspace root.
  const dir = mcpServerWorkspaceDir('../../etc/passwd');
  const workspaceRoot = join(TEST_HOME, 'desktop', 'mcp-workspace');
  assert.ok(dir.startsWith(workspaceRoot + '/'),
    `sanitised path must stay inside ${workspaceRoot}, got ${dir}`);
  // No `/` survived in the leaf segment.
  const leaf = dir.slice(workspaceRoot.length + 1);
  assert.ok(!leaf.includes('/'), `leaf must be a single directory: ${leaf}`);
});

test('mcpServerWorkspaceDir handles empty / nullish names with a fallback', () => {
  assert.ok(mcpServerWorkspaceDir('').endsWith('/mcp-workspace/mcp-server'));
  assert.ok(mcpServerWorkspaceDir(null).endsWith('/mcp-workspace/mcp-server'));
  assert.ok(mcpServerWorkspaceDir(undefined).endsWith('/mcp-workspace/mcp-server'));
});

test('mcpServerWorkspaceDir refuses dot / double-dot / whitespace-only leaves', () => {
  // After regex sweep the leaf could still be `.` / `..` (Codex 🟠
  // 2026-04-28: those leaked through the previous sanitiser and
  // resolved to the workspace root or its parent).  All collapse to
  // the `mcp-server` fallback directory.
  for (const hostile of ['.', '..', '   ', '\t', '\n', '   ..   ', '... ', '.....', '.. ', ' ..']) {
    const dir = mcpServerWorkspaceDir(hostile);
    assert.ok(dir.endsWith('/mcp-workspace/mcp-server'),
      `expected fallback for ${JSON.stringify(hostile)}, got ${dir}`);
  }
});

test('mcpServerWorkspaceDir keeps resolved path inside the workspace root', () => {
  // Whatever sanitiser bug a future refactor introduces, the final
  // path must still live under <MELO_HOME>/desktop/mcp-workspace/.
  // Probe a stack of progressively nastier inputs.
  const root = mcpServerWorkspaceDir('').replace(/\/mcp-server$/, '');
  for (const hostile of [
    '../../etc/passwd',
    'foo/../../bar',
    'foo/bar/baz',
    ' traversal',
    'a/b/c/d/e',
    '..',
    '.',
    '.../..',
  ]) {
    const dir = mcpServerWorkspaceDir(hostile);
    assert.ok(dir.startsWith(root + '/'),
      `${JSON.stringify(hostile)} escaped workspace root: got ${dir}, root ${root}`);
  }
});

// ─── getBuiltinMcpPresets ───────────────────────────────────────────────────

test('getBuiltinMcpPresets exposes every built-in (browser + productivity)', () => {
  const presets = getBuiltinMcpPresets();
  const ids = presets.map(p => p.id);
  assert.ok(ids.includes('playwright'));
  assert.ok(ids.includes('browserless'));
  assert.ok(ids.includes('antv-chart'));
  assert.ok(ids.includes('markdown2pdf'));
  // mermaid was added 2026-04-29 because @99xio/markdown2pdf-mcp's
  // dependency graph doesn't include mermaid — bare ```mermaid```
  // blocks ship as plain text. mcp-mermaid (hustcc / antv-team
  // author, same as @antv/mcp-server-chart) renders to PNG via
  // mermaid-isomorphic + playwright.
  assert.ok(ids.includes('mermaid'));
});

test('every preset entry carries command + args + flag + description', () => {
  for (const preset of getBuiltinMcpPresets()) {
    assert.equal(typeof preset.command, 'string', `${preset.id} command`);
    assert.ok(Array.isArray(preset.args), `${preset.id} args`);
    assert.equal(typeof preset.flag, 'string', `${preset.id} flag`);
    assert.equal(typeof preset.description, 'string', `${preset.id} description`);
  }
});

// ─── buildEffectiveMcpServers ───────────────────────────────────────────────

test('buildEffectiveMcpServers passes through user mcpServers as-is when no flags set', () => {
  const userServers = {
    'my-mcp': { command: 'python3', args: ['-m', 'my_mcp'] },
  };
  const eff = buildEffectiveMcpServers(userServers, {});
  assert.deepEqual(eff, userServers);
});

test('buildEffectiveMcpServers adds antv-chart preset when flag is set', () => {
  const eff = buildEffectiveMcpServers({}, { enableAntvChartMcp: true });
  assert.ok(eff['antv-chart']);
  assert.equal(eff['antv-chart'].command, 'npx');
  assert.deepEqual(eff['antv-chart'].args, ['-y', '@antv/mcp-server-chart']);
});

test('buildEffectiveMcpServers adds mermaid preset when flag is set', () => {
  const eff = buildEffectiveMcpServers({}, { enableMermaidMcp: true });
  assert.ok(eff.mermaid, 'mermaid preset must be registered when enableMermaidMcp is true');
  assert.equal(eff.mermaid.command, 'npx');
  assert.deepEqual(eff.mermaid.args, ['-y', 'mcp-mermaid']);
});

test('buildEffectiveMcpServers adds markdown2pdf preset when flag is set', () => {
  const eff = buildEffectiveMcpServers({}, { enableMarkdown2PdfMcp: true });
  assert.ok(eff.markdown2pdf);
  assert.equal(eff.markdown2pdf.command, 'npx');
  assert.deepEqual(eff.markdown2pdf.args, ['-y', '@99xio/markdown2pdf-mcp']);
});

test('preset config is stripped of the preset-only `flag` + `description` fields', () => {
  // server config shape is { command, args, env, disabled, cwd } — the
  // preset metadata mustn't leak into the effective server map.
  const eff = buildEffectiveMcpServers({}, { enableMarkdown2PdfMcp: true });
  assert.ok(!('flag' in eff.markdown2pdf));
  assert.ok(!('description' in eff.markdown2pdf));
});

test('user-supplied entry with the same id wins over the preset', () => {
  // Common scenario: user wants the antv-chart name but with their fork.
  const userServers = {
    'antv-chart': { command: 'node', args: ['./my-fork.js'] },
  };
  const eff = buildEffectiveMcpServers(userServers, { enableAntvChartMcp: true });
  assert.equal(eff['antv-chart'].command, 'node');
  assert.deepEqual(eff['antv-chart'].args, ['./my-fork.js']);
});

test('multiple flags + user servers compose without trampling', () => {
  const userServers = {
    custom: { command: 'python3', args: ['-m', 'custom'] },
  };
  const eff = buildEffectiveMcpServers(userServers, {
    enablePlaywrightMcp: true,
    enableMarkdown2PdfMcp: true,
    enableAntvChartMcp: false, // explicitly off — still off
  });
  assert.equal(Object.keys(eff).sort().join(','),
    ['custom', 'markdown2pdf', 'playwright'].sort().join(','));
});

// ─── connectMcpServer cwd preparation (smoke) ───────────────────────────────

test('mcpServerWorkspaceDir is the cwd we expect to mkdir before spawn', () => {
  // Smoke check: we can mkdirSync the path and the sandbox lives inside
  // MELO_HOME.  This mirrors what connectMcpServer does internally.
  const dir = mcpServerWorkspaceDir('phase1-smoke');
  mkdirSync(dir, { recursive: true });
  assert.ok(existsSync(dir));
});

// ─── buildMcpTool security-relevant defaults ────────────────────────────────

test('buildMcpTool: every MCP tool carries requiresPermission=true (approval gate)', () => {
  // Defence-in-depth: even with the per-agent whitelist, every MCP
  // dispatch should still trigger the tools/executor permission flow
  // unless the user explicitly approves "Always allow" in the UI.
  // Pinning this default protects against a future refactor that
  // accidentally flips it to false.
  const fakeClient = { callTool: async () => ({}) };
  const tool = buildMcpTool('antv-chart', {
    name: 'line_chart',
    description: 'Render a line chart',
    inputSchema: { type: 'object' },
  }, fakeClient);
  assert.equal(tool.requiresPermission, true);
  assert.equal(tool.category, 'mcp');
  assert.equal(tool.id, 'mcp:antv-chart:line_chart');
  assert.equal(tool.name, 'antv-chart/line_chart');
});

test('buildMcpTool: missing inputSchema falls back to a permissive object', () => {
  const fakeClient = { callTool: async () => ({}) };
  const tool = buildMcpTool('md2pdf', {
    name: 'convert',
    description: 'md → pdf',
  }, fakeClient);
  assert.deepEqual(tool.parametersSchema, { type: 'object', properties: {} });
});

test('buildMcpTool: run() delegates to the injected client', async () => {
  let received = null;
  const fakeClient = {
    async callTool(name, args) {
      received = { name, args };
      return { content: [{ type: 'text', text: 'ok' }] };
    },
  };
  const tool = buildMcpTool('antv-chart', { name: 'pie_chart' }, fakeClient);
  await tool.run({ data: [1, 2, 3] });
  assert.deepEqual(received, { name: 'pie_chart', args: { data: [1, 2, 3] } });
});

// ─── reconcileMcpLifecycle (Codex 🔴 lifecycle audit 2026-04-28) ──────────────
//
// Three paths must lead to a disconnect — global preset toggled off,
// user-configured server flipped to `disabled: true`, server removed
// from `mcpServers` entirely.  The pure half of the reconciler is
// responsible for naming each stale entry; production wires it to
// `disconnectMcpServer` which kills the child process AND unregisters
// the `mcp:<name>:*` tools so an agent's stale whitelist entry can't
// reach a dead tool.

function spyDisconnect() {
  const calls = [];
  return { fn: name => calls.push(name), calls };
}

test('reconcileMcpLifecycle: built-in preset toggled off — server is reaped', () => {
  // antv-chart was running, but the user just flipped the preset off
  // so it no longer appears in `effective`.  reconciler must request
  // disconnect with reason='removed'.
  const dc = spyDisconnect();
  const stale = reconcileMcpLifecycle({
    effective: { 'markdown2pdf': { command: 'npx', args: [] } },
    activeNames: ['antv-chart', 'markdown2pdf'],
    disconnect: dc.fn,
  });
  assert.deepEqual(stale, [{ name: 'antv-chart', reason: 'removed' }]);
  assert.deepEqual(dc.calls, ['antv-chart']);
});

test('reconcileMcpLifecycle: user server flipped to disabled=true — reaped with reason=disabled', () => {
  // The server stays in effective (user kept the entry, just turned it
  // off), but its config now says `disabled: true`.  Disconnect with
  // a different reason so the caller can tell the situations apart in
  // the API response.
  const dc = spyDisconnect();
  const stale = reconcileMcpLifecycle({
    effective: { 'my-mcp': { command: 'python3', args: [], disabled: true } },
    activeNames: ['my-mcp'],
    disconnect: dc.fn,
  });
  assert.deepEqual(stale, [{ name: 'my-mcp', reason: 'disabled' }]);
  assert.deepEqual(dc.calls, ['my-mcp']);
});

test('reconcileMcpLifecycle: user removed server from config entirely — reaped', () => {
  // Effective drops the server (user deleted the mcpServers entry).
  // Same disconnect path; the reason 'removed' is shared with the
  // preset-toggle case because at this layer the cause is
  // indistinguishable.
  const dc = spyDisconnect();
  const stale = reconcileMcpLifecycle({
    effective: {},
    activeNames: ['ghost-server'],
    disconnect: dc.fn,
  });
  assert.deepEqual(stale, [{ name: 'ghost-server', reason: 'removed' }]);
  assert.deepEqual(dc.calls, ['ghost-server']);
});

test('reconcileMcpLifecycle: still-effective + still-enabled servers are NOT disconnected', () => {
  // Healthy steady state: every active name maps to an enabled
  // effective entry.  No stale, no disconnect calls — connectMcpServer
  // is the one that handles "config changed but server name same".
  const dc = spyDisconnect();
  const stale = reconcileMcpLifecycle({
    effective: {
      'antv-chart':   { command: 'npx', args: ['-y', '@antv/mcp-server-chart'] },
      'markdown2pdf': { command: 'npx', args: ['-y', '@99xio/markdown2pdf-mcp'] },
    },
    activeNames: ['antv-chart', 'markdown2pdf'],
    disconnect: dc.fn,
  });
  assert.deepEqual(stale, []);
  assert.deepEqual(dc.calls, []);
});

test('reconcileMcpLifecycle: empty active fleet → nothing to do, no calls', () => {
  // Cold start: nothing is connected yet, so nothing is stale.
  const dc = spyDisconnect();
  const stale = reconcileMcpLifecycle({
    effective: { 'antv-chart': { command: 'npx', args: [] } },
    activeNames: [],
    disconnect: dc.fn,
  });
  assert.deepEqual(stale, []);
  assert.deepEqual(dc.calls, []);
});

test('reconcileMcpLifecycle: reports both reasons when toggling one off + removing another in the same pass', () => {
  // Realistic mixed state: one preset went off (user toggled), one
  // user-server got `disabled: true`, one is healthy.  Reconciler
  // must reap exactly the first two and leave the third alone.
  const dc = spyDisconnect();
  const stale = reconcileMcpLifecycle({
    effective: {
      'my-disabled': { command: 'python3', args: [], disabled: true },
      'still-on':    { command: 'npx', args: [] },
    },
    activeNames: ['preset-was-on', 'my-disabled', 'still-on'],
    disconnect: dc.fn,
  });
  assert.deepEqual(stale.sort((a, b) => a.name.localeCompare(b.name)), [
    { name: 'my-disabled', reason: 'disabled' },
    { name: 'preset-was-on', reason: 'removed' },
  ]);
  assert.deepEqual(dc.calls.sort(), ['my-disabled', 'preset-was-on']);
});

// ─── Server-id contract enforcement (Codex 2026-04-28) ──────────────────────

test('buildMcpTool refuses to compose a tool id for an illegal server name', () => {
  // formatMcpToolId throws on out-of-charset server names so toolRegistry
  // can never end up with `mcp:safe:evil:tool` masquerading under server
  // `safe`. connectMcpServer guards on the same predicate upstream.
  const fakeClient = { callTool: async () => ({}) };
  assert.throws(() => buildMcpTool('safe:evil', { name: 'do_thing' }, fakeClient));
  assert.throws(() => buildMcpTool('has space', { name: 'do_thing' }, fakeClient));
  assert.throws(() => buildMcpTool('', { name: 'do_thing' }, fakeClient));
});

test('reconcileMcpLifecycle: works without a disconnect function (pure read)', () => {
  // If no side-effect is supplied, the helper still computes the
  // stale list — useful for diagnostics or dry-run UI previews.
  const stale = reconcileMcpLifecycle({
    effective: {},
    activeNames: ['orphan'],
  });
  assert.deepEqual(stale, [{ name: 'orphan', reason: 'removed' }]);
});
