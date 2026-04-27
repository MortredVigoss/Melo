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
      plugins: [],
      tasks: [],
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

test('renderAdvancedPage shows the four subsection titles + Experimental chip', () => {
  const html = renderAdvancedPage(freshState());
  assert.match(html, /<h2[^>]*>[\s\S]*?Advanced/);
  assert.match(html, /Experimental/);
  assert.match(html, /External MCP connectors/);
  assert.match(html, /CLI \/ stdio MCP servers/);
  assert.match(html, /Plugins/);
  assert.match(html, /Background shell tasks/);
});

test('renderAdvancedPage exposes the safe-ops actions used by the page', () => {
  const html = renderAdvancedPage(freshState());
  assert.match(html, /data-action="refresh-advanced-status"/);
  assert.match(html, /data-action="reload-mcp-servers"/);
});

// ─── Empty states ───────────────────────────────────────────────────────────

test('all-empty state renders one empty-state per subsection (4 total)', () => {
  const html = renderAdvancedPage(freshState());
  const matches = html.match(/empty-state/g) || [];
  assert.equal(matches.length, 4);
  assert.match(html, /No external MCP connectors configured/);
  assert.match(html, /No active CLI \/ stdio MCP servers/);
  assert.match(html, /No plugins registered/);
  assert.match(html, /No background runs/);
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
  assert.match(html, /Disconnect/);
});

// ─── Plugins ────────────────────────────────────────────────────────────────

test('plugins render with hooks list (empty hooks shows "no hooks")', () => {
  const html = renderAdvancedPage(freshState({
    adv: {
      plugins: [
        { id: 'plug-a', hooks: ['onMessage', 'onTurnEnd'] },
        { id: 'plug-empty', hooks: [] },
      ],
    },
  }));
  assert.match(html, /plug-a/);
  assert.match(html, /onMessage, onTurnEnd/);
  assert.match(html, /plug-empty/);
  assert.match(html, /no hooks/);
});

test('plugins with missing id show "(unnamed)"', () => {
  const html = renderAdvancedPage(freshState({ adv: { plugins: [{ hooks: [] }] } }));
  assert.match(html, /\(unnamed\)/);
});

// ─── Background tasks ───────────────────────────────────────────────────────

test('running task renders the Kill button; finished task does not', () => {
  const html = renderAdvancedPage(freshState({
    adv: {
      tasks: [
        { runId: 'r1', status: 'running', command: 'sleep 100', startedAt: '2026-04-27T10:00:00Z' },
        { runId: 'r2', status: 'exited', exitCode: 0, command: 'echo hi', startedAt: '2026-04-27T09:00:00Z' },
      ],
    },
  }));
  assert.match(html, /sleep 100/);
  assert.match(html, /echo hi/);
  // Kill only attached to the running run.
  assert.match(html, /data-run-id="r1"/);
  assert.doesNotMatch(html, /data-run-id="r2"/);
  // exit code only on the finished one.
  assert.match(html, /exit 0/);
});

// ─── Loading + error transitions ────────────────────────────────────────────

test('loading state flips Refresh button label to "Refreshing…"', () => {
  const html = renderAdvancedPage(freshState({ adv: { loading: true } }));
  assert.match(html, /Refreshing…/);
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

test('hostile connector / task strings are escaped through escapeHtml', () => {
  const html = renderAdvancedPage(freshState({
    data: {
      connectors: [
        { type: 'external-mcp', id: '<id>', name: '<script>alert(1)</script>',
          config: { endpoint: 'http://x?<' } },
      ],
    },
    adv: {
      cliServers: ['<srv>'],
      tasks: [{ runId: '<r>', status: '<status>', command: '<cmd>', startedAt: '2026-04-27T10:00:00Z' }],
    },
  }));
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;srv&gt;/);
  assert.match(html, /&lt;cmd&gt;/);
  // No raw injection slipped through — the literal `<script>` tag must
  // not appear.
  assert.doesNotMatch(html, /<script>alert/);
});
