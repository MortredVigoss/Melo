import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createActionRegistry } from '../registry.js';
import { installCustomizeFeature } from './index.js';

// Architecture B3 step 2: the Customize page (skills, connectors, Safety /
// domain cookies, Tools & Tasks) owns its state, takes a narrow context (no
// uiState) and is driven through the registry and the listener entry points
// exactly as app.js drives it.
const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
for (const name of ['document', 'HTMLElement', 'HTMLFormElement', 'HTMLInputElement', 'HTMLSelectElement', 'FormData']) globalThis[name] = dom.window[name];
globalThis.window = dom.window;
dom.window.setTimeout = (...args) => setTimeout(...args);

const page = () => ({
  settings: { activeView: 'customize', selectedCustomizeSection: 'skills', selectedSkillId: 'alpha', selectedConnectorId: null, config: {} },
  customize: {
    skills: [
      { id: 'alpha', name: 'Alpha', description: 'first', tags: ['planning'], enabled: true, source: 'builtin', type: 'executable' },
      { id: 'beta', name: 'Beta', description: 'second', tags: ['research'], enabled: false, source: 'custom', type: 'prompt' },
    ],
    agents: [], connectors: [], mcpPresets: [],
  },
});

function harness({ bootstrap = page(), responses = {} } = {}) {
  const calls = [], applied = [], errors = [], settings = [];
  let renders = 0, bgRenders = 0, refreshes = 0, topError = null, tts = { customVoiceId: '', engine: 'edge' };
  const state = { bootstrap };
  const context = {
    agentsFeature: { renderPage: () => '', renderWorkbench: () => '' }, approvalsFeature: { renderGrants: () => '', renderCapabilityPrompt: () => '' }, memoryFeature: { renderPane: () => '' },
    allChatAgentProfiles: () => [],
    api: async (path, options = {}) => { calls.push([path, options.method || 'GET', options.body]); const key = Object.keys(responses).find(p => path.startsWith(p)); const value = key ? responses[key] : {}; if (value instanceof Error) throw value; return structuredClone(value); },
    applyBootstrap: payload => { applied.push(payload); state.bootstrap = payload; }, applyBootstrapPreservingDrafts: payload => { applied.push(payload); state.bootstrap = payload; },
    bgRender: () => { bgRenders++; }, render: () => { renders++; }, showError: m => errors.push(m), escapeHtml: v => String(v ?? ''),
    patchSettings: async patch => { settings.push(patch); }, minimaxTtsConfigPatchForVoice: id => ({ minimaxVoiceId: id }), effectiveModelSetupDraft: () => ({}),
    renderApprovalPanel: () => '', renderCommandRunner: () => '', renderProjectArtifactShelf: () => '', renderSelectedFilePreview: () => '', renderTaskPanel: () => '',
    getBootstrap: () => state.bootstrap, modelSetupDraft: () => null, refreshBootstrap: async () => { refreshes++; }, resolveActiveMinimaxVoiceId: () => ({ voiceId: '' }),
    setError: m => { topError = m; }, ttsVoice: () => tts, setTtsVoice: patch => { tts = { ...tts, ...patch }; },
  };
  const feature = installCustomizeFeature(context);
  const actions = createActionRegistry('action'); actions.register(feature.actions, 'customize');
  const forms = createActionRegistry('form'); forms.register(feature.forms, 'customize');
  return { feature, actions, forms, context, state, calls, applied, errors, settings, renders: () => renders, bgRenders: () => bgRenders, refreshes: () => refreshes, topError: () => topError, tts: () => tts };
}
const el = html => { const host = document.createElement('div'); host.innerHTML = html; document.body.replaceChildren(host); return host.firstElementChild; };
const click = (h, action, html) => h.actions.dispatch(action, { action, trigger: html ? el(html) : null, event: null });

test('the feature takes a narrow context (no uiState) and starts from its own fresh state', () => {
  const { context, feature } = harness();
  assert.throws(() => installCustomizeFeature({ ...context, uiState: {} }), /not uiState/);
  const { setTtsVoice, getBootstrap, ...rest } = context;
  assert.throws(() => installCustomizeFeature(rest), /missing context getBootstrap, setTtsVoice/);
  const s = feature.getState();
  assert.deepEqual(s.skillFilter, { query: '', tag: null, state: 'all' });
  assert.equal(s.skillDetailTab, 'overview');
  assert.deepEqual(s.domainCookies.hosts, []);
  assert.equal(s.advanced.loaded, false);
});

test('skill filter: search box input, state select and tag chips update feature state and re-render', () => {
  const h = harness();
  const box = el('<input data-action="set-skill-filter-query" value="pla">');
  assert.equal(h.feature.handleInput(box), true);
  assert.equal(h.feature.getState().skillFilter.query, 'pla');
  const sel = el('<select data-action="set-skill-filter-state"><option value="all"></option><option value="enabled" selected></option></select>');
  assert.equal(h.feature.handleSkillFilterStateChange(sel), true);
  assert.equal(h.feature.getState().skillFilter.state, 'enabled');
  sel.value = 'bogus';
  h.feature.handleSkillFilterStateChange(sel);
  assert.equal(h.feature.getState().skillFilter.state, 'all', 'unknown values fall back to all');
  assert.equal(h.feature.handleInput(el('<input name="other">')), false, 'unrelated inputs are not handled');
  assert.equal(h.renders(), 3);
  const html = h.feature.renderPage();
  assert.match(html, /value="pla"/, 'the search box keeps the typed query across the render');
});

test('domain cookies: inputs sync into feature state without a render; save posts them and the list reloads', async () => {
  const h = harness({ responses: { '/api/settings/domain-cookies/upsert': { ok: true }, '/api/settings/domain-cookies': { hosts: [{ host: 'example.com', length: 8 }] } } });
  const before = h.renders();
  assert.equal(h.feature.handleInput(el('<input data-domain-cookie-host value="example.com">')), true);
  assert.equal(h.feature.handleInput(el('<input data-domain-cookie-string value="a=1; b=2">')), true);
  assert.equal(h.renders(), before, 'typing a cookie does not re-render (the render guard would fight the caret)');
  // the save action reads the live inputs first, then posts
  document.body.innerHTML = '<input data-domain-cookie-host value="example.com"><input data-domain-cookie-string value="a=1; b=2">';
  await click(h, 'domain-cookie-save');
  const post = h.calls.find(([p]) => p === '/api/settings/domain-cookies/upsert');
  assert.deepEqual(post[2], { host: 'example.com', cookieString: 'a=1; b=2' });
  assert.deepEqual(h.feature.getState().domainCookies.hosts.map(x => x.host), ['example.com']);
  assert.equal(h.feature.getState().domainCookies.addHost, '', 'the form is cleared after a successful save');
});

test('safety allowlist filter selects write feature state and re-render; other selects are left to app.js', () => {
  const h = harness();
  const sel = el('<select data-permission-filter="agent"><option value="all"></option><option value="main" selected></option></select>');
  assert.equal(h.feature.handleChange(sel), true);
  assert.deepEqual(h.feature.getState().safetyAllowlist.filters, { agent: 'main' });
  assert.equal(h.feature.handleChange(el('<select name="unrelated"></select>')), false);
});

test('refreshAdvancedStatus fans out to the five endpoints, fills the cache and reports partial failures', async () => {
  const h = harness({ responses: { '/api/mcp/servers': { servers: [{ name: 's1' }] }, '/api/plugins': { plugins: [] }, '/api/background-tasks/list': { runs: [{ id: 'r1' }] }, '/api/diagnostics': new Error('diag down'), '/api/workspace/retained': { files: [] } } });
  await h.feature.refreshAdvancedStatus();
  const adv = h.feature.getState().advanced;
  assert.equal(adv.loaded, true);
  assert.deepEqual(adv.cliServers, [{ name: 's1' }]);
  assert.deepEqual(adv.tasks, [{ id: 'r1' }]);
  assert.equal(adv.diagnostics, null);
  assert.match(adv.error, /^Partial load: diag down$/);
  assert.equal(adv.loading, false);
  assert.ok(h.bgRenders() >= 1 && h.renders() >= 1, 'a background render while loading and a render when done');
  assert.deepEqual(h.calls.map(c => c[0]).sort(), ['/api/background-tasks/list', '/api/diagnostics?storage=1', '/api/mcp/servers', '/api/plugins', '/api/workspace/retained']);
});

test('skill detail tab and the SKILL.md cache are feature state; the markdown tab fetches once per skill', async () => {
  const h = harness({ responses: { '/api/skills/export': { markdown: '# Alpha' } } });
  await click(h, 'skill-detail-tab', '<button data-tab="markdown"></button>');
  assert.equal(h.feature.getState().skillDetailTab, 'markdown');
  await click(h, 'skill-detail-tab', '<button data-tab="overview"></button>');
  assert.equal(h.feature.getState().skillDetailTab, 'overview');
  await click(h, 'skill-detail-tab', '<button></button>');
  assert.equal(h.feature.getState().skillDetailTab, 'overview', 'a missing data-tab means overview');
  await click(h, 'skill-detail-tab', '<button data-tab="markdown" data-skill-id="alpha"></button>');
  await new Promise(r => setImmediate(r));
  assert.equal(h.calls.filter(([p]) => p.startsWith('/api/skills/export')).length, 1, 'the SKILL.md is fetched for the selected skill');
  assert.equal(h.feature.getState().skillMarkdown.alpha?.markdown, '# Alpha');
  await click(h, 'skill-detail-tab', '<button data-tab="markdown" data-skill-id="alpha"></button>');
  await new Promise(r => setImmediate(r));
  assert.equal(h.calls.filter(([p]) => p.startsWith('/api/skills/export')).length, 1, 'the cache answers the second visit');
});

test('an MCP preset toggle that fails surfaces through setError; a success refreshes the page data and the Tools & Tasks cache', async () => {
  const h = harness({ responses: { '/api/mcp/preset-toggle': new Error('nope') } });
  await click(h, 'toggle-mcp-preset', '<button data-preset-flag="filesystem" data-next-enabled="1"></button>');
  assert.match(h.topError(), /Toggle failed: nope/);
  assert.equal(h.refreshes(), 0);
  const ok = harness({ responses: { '/api/mcp/preset-toggle': { ok: true }, '/api/mcp/servers': { servers: [] }, '/api/plugins': { plugins: [] }, '/api/background-tasks/list': { runs: [] }, '/api/diagnostics': {}, '/api/workspace/retained': {} } });
  await click(ok, 'toggle-mcp-preset', '<button data-preset-flag="filesystem" data-next-enabled="1"></button>');
  assert.equal(ok.refreshes(), 1, 'the page data is reloaded through the context');
  assert.equal(ok.feature.getState().advanced.loaded, true, 'the Tools & Tasks cache is rebuilt');
  assert.equal(ok.topError(), null);
});
