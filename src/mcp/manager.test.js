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

// ─── getBuiltinMcpPresets ───────────────────────────────────────────────────

test('getBuiltinMcpPresets exposes every built-in (browser + productivity)', () => {
  const presets = getBuiltinMcpPresets();
  const ids = presets.map(p => p.id);
  assert.ok(ids.includes('playwright'));
  assert.ok(ids.includes('browserless'));
  assert.ok(ids.includes('antv-chart'));
  assert.ok(ids.includes('markdown2pdf'));
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
