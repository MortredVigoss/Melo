// This fixture asserts Chinese copy explicitly; production defaults follow the device.
import { setLanguage as setFixtureLanguage } from './i18n.js';
setFixtureLanguage('zh-CN');
// Smoke tests for the Advanced pane renderer.  Pure string output —
// no DOM, no `uiState` global — so `node --test` is enough.

import test from 'node:test';
import assert from 'node:assert/strict';
import { renderAdvancedPage } from './advancedPage.js';

// Small escapeHtml stand-in.  Matches the production shape closely
// enough that its output is observable in the page string; tests rely
// on `&lt;` / `&amp;` to detect that a hostile input was actually
// escaped, not just substring-matched.
function escapeHtml(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function freshState(overrides = {}) {
  const base = {
    data: { connectors: [] },
    adv: {
      loaded: true,        // tests opt out of lazy-fetch by default
      loading: false,
      error: null,
      cliServers: [],
    },
    escapeHtml,
    scheduleRefresh: () => {},
  };
  return {
    ...base,
    ...overrides,
    data: { ...base.data, ...(overrides.data || {}) },
    adv: { ...base.adv, ...(overrides.adv || {}) },
  };
}

// ─── Page skeleton + 4 subsections always present ───────────────────────────

test('renderAdvancedPage shows system status and collapsed technical controls', () => {
  const html = renderAdvancedPage(freshState());
  assert.match(html, /<h2[^>]*>[\s\S]*?系统状态/);
  assert.match(html, /本机工作空间/);
  // Authored Chinese keys (translations.js carries the other languages).
  assert.match(html, /内置 MCP 服务/);
  assert.match(html, /读取工具默认对所有 Agent 开放/);
  assert.match(html, /自定义 HTTP 连接器/);
  assert.match(html, /MCP 服务（stdio \/ HTTP）/);
  // 2026-11-14: the plugin list and the background command list are gone. Nothing
  // in the product registers a plugin or starts such a command, so both were
  // always empty.
  assert.doesNotMatch(html, /插件|后台命令任务|kill-background-task/);
});

test('renderAdvancedPage exposes the safe-ops actions used by the page', () => {
  const html = renderAdvancedPage(freshState());
  assert.match(html, /data-action="refresh-advanced-status"/);
  assert.match(html, /data-action="reload-mcp-servers"/);
});

test('system tools page keeps unresolved approvals outside collapsed technical controls', () => {
  const approvalPanelHtml = '<section aria-label="操作审批"><button>已核对，关闭记录</button></section>';
  const html = renderAdvancedPage(freshState({ approvalPanelHtml }));
  assert.ok(html.includes(approvalPanelHtml));
  const beforeApproval = html.slice(0, html.indexOf(approvalPanelHtml));
  assert.equal((beforeApproval.match(/<details\b/g) || []).length, (beforeApproval.match(/<\/details>/g) || []).length);
});

test('renderAdvancedPage never invents a legacy path before diagnostics resolves the home', () => {
  const html = renderAdvancedPage(freshState());
  assert.match(html, /刷新后显示配置文件路径。/);
  assert.doesNotMatch(html, /data-action="copy-melo-state-path"/);
  assert.doesNotMatch(html, /~\/\.melo/);
});

test('renderAdvancedPage honours custom statePathHint (e.g. non-default MELO_HOME)', () => {
  const html = renderAdvancedPage(freshState({ statePathHint: '/tmp/melo-test/desktop/state.json' }));
  assert.match(html, /<code>\/tmp\/melo-test\/desktop\/state\.json<\/code>/);
  assert.match(html, /data-path="\/tmp\/melo-test\/desktop\/state\.json"/);
});

test('renderAdvancedPage escapes hostile statePathHint values', () => {
  const html = renderAdvancedPage(freshState({ statePathHint: '<script>alert(1)</script>' }));
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
});

// ─── Empty states ───────────────────────────────────────────────────────────

test('all-empty state renders one empty-state per subsection (3: presets, connectors, MCP servers)', () => {
  const html = renderAdvancedPage(freshState());
  const matches = html.match(/empty-state/g) || [];
  assert.equal(matches.length, 3);
  assert.match(html, /No built-in MCP server presets registered/);
  assert.match(html, /尚未添加外部连接器/);
  assert.match(html, /No active MCP servers/);
});

test('renderAdvancedPage renders one toggle row per built-in MCP preset', () => {
  const html = renderAdvancedPage(freshState({
    mcpPresets: [
      { id: 'antv-chart', flag: 'enableAntvChartMcp', enabled: false,
        command: 'npx', args: ['-y', '@antv/mcp-server-chart'],
        description: 'AntV chart generator' },
      { id: 'markdown2pdf', flag: 'enableMarkdown2PdfMcp', enabled: true,
        command: 'npx', args: ['-y', '@99xio/markdown2pdf-mcp'],
        description: 'md→pdf converter' },
    ],
  }));
  // Both server ids appear.
  assert.match(html, /antv-chart/);
  assert.match(html, /markdown2pdf/);
  // Disabled row gets the Enable button (will flip on click).
  assert.match(html, /data-action="toggle-mcp-preset"[^>]*data-preset-id="antv-chart"[^>]*data-next-enabled="1"/);
  // Enabled row gets the Disable button.
  assert.match(html, /data-action="toggle-mcp-preset"[^>]*data-preset-id="markdown2pdf"[^>]*data-next-enabled="0"/);
  // Header summary reflects 1-of-2 enabled.
  assert.match(html, /1 \/ 2 已启用/);
});

test('renderAdvancedPage MCP presets section escapes hostile fields', () => {
  const html = renderAdvancedPage(freshState({
    mcpPresets: [
      { id: '<script>', flag: '<flag>', enabled: false,
        command: 'rm', args: ['<arg>'],
        description: '<script>alert(1)</script>' },
    ],
  }));
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /data-preset-id="&lt;script&gt;"/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
});

test('renderAdvancedPage shows enabled count in header even for empty presets', () => {
  const html = renderAdvancedPage(freshState({ mcpPresets: [] }));
  assert.match(html, /0 \/ 0 已启用/);
});

// ─── External MCP rendering ─────────────────────────────────────────────────

test('external-mcp connectors render with chips and Ping button', () => {
  const html = renderAdvancedPage(freshState({
    data: {
      connectors: [
        { type: 'external-mcp', id: 'mcp-a', name: 'Search MCP',
          config: { lastStatus: 'ok', toolCount: 3, resourceCount: 1, promptCount: 2,
                    lastCheckedLabel: '2m ago', endpoint: 'http://localhost:5000' } },
      ],
    },
  }));
  assert.match(html, /Search MCP/);
  assert.match(html, /3 tools/);
  assert.match(html, /1 resources/);
  assert.match(html, /2 prompts/);
  assert.match(html, /2m ago/);
  assert.match(html, /http:\/\/localhost:5000/);
  assert.match(html, /data-action="ping-connector" data-connector-id="mcp-a"/);
  assert.match(html, /Ping \(refresh\)/);
});

test('non-external connectors are filtered out', () => {
  const html = renderAdvancedPage(freshState({
    data: {
      connectors: [
        { type: 'openai-compatible', id: 'oa', name: 'OpenAI' },
        { type: 'external-mcp', id: 'mcp-a', name: 'Real MCP' },
      ],
    },
  }));
  assert.match(html, /Real MCP/);
  assert.doesNotMatch(html, /OpenAI/);
});

test('external-mcp with non-ok status does not get is-accent chip', () => {
  const html = renderAdvancedPage(freshState({
    data: {
      connectors: [
        { type: 'external-mcp', id: 'mcp-x', name: 'Unhealthy',
          config: { lastStatus: 'error' } },
      ],
    },
  }));
  // The status chip class string includes "is-accent" only when ok.
  assert.match(html, /class="chip ">error/);
});

// ─── CLI / stdio MCP servers ────────────────────────────────────────────────

test('cliServers render with mono name + Disconnect button', () => {
  const html = renderAdvancedPage(freshState({ adv: { cliServers: ['srv-a', 'srv-b'] } }));
  assert.match(html, /list-row-title mono">srv-a/);
  assert.match(html, /list-row-title mono">srv-b/);
  assert.match(html, /data-action="disconnect-mcp-server" data-server-name="srv-a"/);
  assert.match(html, /data-action="disconnect-mcp-server"/);
});

// ─── Loading + error transitions ────────────────────────────────────────────

test('loading state flips Refresh button label to "Refreshing…"', () => {
  const html = renderAdvancedPage(freshState({ adv: { loading: true } }));
  assert.match(html, /检查中…/);
  assert.doesNotMatch(html, />Refresh<\/button>/);
});

test('error renders the alert banner with the error text escaped', () => {
  const html = renderAdvancedPage(freshState({
    adv: { error: '<oops>' },
  }));
  assert.match(html, /alert compact-alert/);
  assert.match(html, /&lt;oops&gt;/);
  assert.doesNotMatch(html, /<oops>/);
});

// ─── Lazy first-fetch hook ──────────────────────────────────────────────────

test('first render (loaded=false, loading=false, error=null) calls scheduleRefresh once', () => {
  let calls = 0;
  renderAdvancedPage({
    data: { connectors: [] },
    adv: { loaded: false, loading: false, error: null, cliServers: [], plugins: [], tasks: [] },
    escapeHtml,
    scheduleRefresh: () => { calls += 1; },
  });
  assert.equal(calls, 1);
});

test('subsequent render (loaded=true) does NOT call scheduleRefresh', () => {
  let calls = 0;
  renderAdvancedPage(freshState({
    adv: { loaded: true },
    scheduleRefresh: () => { calls += 1; },
  }));
  assert.equal(calls, 0);
});

test('mid-flight render (loading=true) does NOT call scheduleRefresh', () => {
  let calls = 0;
  renderAdvancedPage(freshState({
    adv: { loaded: false, loading: true },
    scheduleRefresh: () => { calls += 1; },
  }));
  assert.equal(calls, 0);
});

test('previous error short-circuits the lazy refresh', () => {
  let calls = 0;
  renderAdvancedPage(freshState({
    adv: { loaded: false, loading: false, error: 'boom' },
    scheduleRefresh: () => { calls += 1; },
  }));
  assert.equal(calls, 0);
});

// ─── Escape coverage ────────────────────────────────────────────────────────

test('hostile connector and server strings are escaped through escapeHtml', () => {
  const html = renderAdvancedPage(freshState({
    data: {
      connectors: [
        { type: 'external-mcp', id: '<id>', name: '<script>alert(1)</script>',
          config: { endpoint: 'http://x?<' } },
      ],
    },
    adv: {
      cliServers: ['<srv>'],
    },
  }));
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;srv&gt;/);
  // No raw injection slipped through — the literal `<script>` tag must
  // not appear.
  assert.doesNotMatch(html, /<script>alert/);
});
