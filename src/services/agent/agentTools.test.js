// Tests for the per-agent MCP whitelist + filter helper introduced when
// melo started shipping built-in stdio MCP servers (AntV chart,
// markdown2pdf).  The helpers live in agentTools.js so they're a single
// source of truth — every MCP-capable code path (chatExecutionRunner
// prompt assembly + tool dispatch, future UI selectors) must funnel
// through `filterMcpToolsForAgent` rather than reading
// `profile.enabledMcpServerIds` directly.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeMcpServerWhitelist,
  filterMcpToolsForAgent,
} from './agentTools.js';

// ─── normalizeMcpServerWhitelist ────────────────────────────────────────────

test('normalizeMcpServerWhitelist: missing input → [] (deny-all default)', () => {
  // Unlike enabledConnectorIds / enabledSkillIds where null = "no
  // restriction", MCP defaults to deny-all because stdio MCPs run
  // arbitrary local processes.
  assert.deepEqual(normalizeMcpServerWhitelist(undefined), []);
  assert.deepEqual(normalizeMcpServerWhitelist(null), []);
});

test('normalizeMcpServerWhitelist: non-array input → []', () => {
  assert.deepEqual(normalizeMcpServerWhitelist('antv-chart'), []);
  assert.deepEqual(normalizeMcpServerWhitelist({ 'antv-chart': true }), []);
  assert.deepEqual(normalizeMcpServerWhitelist(42), []);
});

test('normalizeMcpServerWhitelist: trims, drops empty, preserves order', () => {
  assert.deepEqual(
    normalizeMcpServerWhitelist(['antv-chart', '  markdown2pdf  ', '', null, undefined, 'antv-chart']),
    ['antv-chart', 'markdown2pdf', 'antv-chart'], // dedupe is the caller's job
  );
});

test('normalizeMcpServerWhitelist: empty array stays empty (explicit deny-all)', () => {
  assert.deepEqual(normalizeMcpServerWhitelist([]), []);
});

// ─── filterMcpToolsForAgent ─────────────────────────────────────────────────

const NON_MCP_TOOL = { id: 'bash', name: 'Bash' };
const MCP_ANTV_TOOL = { id: 'mcp:antv-chart:line_chart', name: 'antv-chart/line_chart' };
const MCP_MD2PDF_TOOL = { id: 'mcp:markdown2pdf:convert', name: 'markdown2pdf/convert' };
const MCP_OTHER_TOOL = { id: 'mcp:rogue-server:do_thing', name: 'rogue-server/do_thing' };

test('filterMcpToolsForAgent: non-MCP tools always pass through', () => {
  const out = filterMcpToolsForAgent([NON_MCP_TOOL, MCP_ANTV_TOOL], { enabledMcpServerIds: [] });
  assert.deepEqual(out, [NON_MCP_TOOL]);
});

test('filterMcpToolsForAgent: empty whitelist drops every MCP tool', () => {
  const out = filterMcpToolsForAgent(
    [NON_MCP_TOOL, MCP_ANTV_TOOL, MCP_MD2PDF_TOOL, MCP_OTHER_TOOL],
    { enabledMcpServerIds: [] },
  );
  assert.deepEqual(out, [NON_MCP_TOOL]);
});

test('filterMcpToolsForAgent: whitelist passes only the named server\'s tools', () => {
  const out = filterMcpToolsForAgent(
    [NON_MCP_TOOL, MCP_ANTV_TOOL, MCP_MD2PDF_TOOL, MCP_OTHER_TOOL],
    { enabledMcpServerIds: ['markdown2pdf'] },
  );
  assert.deepEqual(out.map(t => t.id), ['bash', 'mcp:markdown2pdf:convert']);
});

test('filterMcpToolsForAgent: profile undefined → deny-all (defence in depth)', () => {
  const out = filterMcpToolsForAgent(
    [NON_MCP_TOOL, MCP_ANTV_TOOL],
    undefined,
  );
  assert.deepEqual(out, [NON_MCP_TOOL]);
});

test('filterMcpToolsForAgent: profile.enabledMcpServerIds = null → deny-all', () => {
  // null does NOT mean "allow everything" for MCP — that would defeat
  // the "no implicit trust" design.  Empty whitelist always wins.
  const out = filterMcpToolsForAgent(
    [NON_MCP_TOOL, MCP_ANTV_TOOL],
    { enabledMcpServerIds: null },
  );
  assert.deepEqual(out, [NON_MCP_TOOL]);
});

test('filterMcpToolsForAgent: tools array can be empty / missing', () => {
  assert.deepEqual(filterMcpToolsForAgent([], { enabledMcpServerIds: ['antv-chart'] }), []);
  assert.deepEqual(filterMcpToolsForAgent(undefined, { enabledMcpServerIds: ['antv-chart'] }), []);
});

test('filterMcpToolsForAgent: handles malformed tool ids without throwing', () => {
  // `mcp:` with no server segment shouldn't grant access to anything.
  const malformed = { id: 'mcp:', name: 'badly-formed' };
  const out = filterMcpToolsForAgent(
    [malformed],
    { enabledMcpServerIds: [''] }, // empty server in whitelist
  );
  // Empty server id was filtered out by normalize, so whitelist is
  // effectively [] → mcp tool dropped.
  assert.deepEqual(out, []);
});

test('filterMcpToolsForAgent: user-configured MCP servers are whitelistable too (not just built-in presets)', () => {
  // Codex 🔴 audit 2026-04-28: the chat path filters every `mcp:*`
  // tool, but the UI used to expose only built-in presets — meaning a
  // server the user added under `config.mcpServers` would register
  // tools and then be invisibly deny-listed.  The filter itself must
  // not care about preset vs user; only the server id matters.
  const userTool = { id: 'mcp:my-custom-server:do_thing', name: 'my/custom' };
  // Explicit allow → tool passes.
  const allowed = filterMcpToolsForAgent([userTool], { enabledMcpServerIds: ['my-custom-server'] });
  assert.deepEqual(allowed.map(t => t.id), ['mcp:my-custom-server:do_thing']);
  // Default deny-all → tool dropped.
  const denied = filterMcpToolsForAgent([userTool], { enabledMcpServerIds: [] });
  assert.deepEqual(denied, []);
});
