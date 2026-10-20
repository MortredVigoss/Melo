import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createActionRegistry } from '../registry.js';
import { createSharedApi } from '../../sharedApi.js';
import { settleCommittedSave } from '../../bootstrapPatch.js';
import { installAgentsFeature } from './index.js';
import { scheduleAgentChannelAutosave, scheduleAgentMarkdownAutosave } from './controller.js';

// Architecture plan P2b: the Agent settings page owns its state (drafts, save
// flags, scroll/caret capture), reads the bootstrap only through
// getBootstrap(), saves through the shared api() and is driven through the
// action registry and listener entry points exactly as app.js drives it.
const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
// Timers go through node's globals so node:test mock timers apply.
dom.window.setTimeout = (...args) => setTimeout(...args);
dom.window.clearTimeout = id => clearTimeout(id);
for (const name of ['document', 'FormData', 'HTMLElement', 'HTMLFormElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement']) globalThis[name] = dom.window[name];
globalThis.window = dom.window;
const beacons = [];
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { sendBeacon: (url, blob) => { beacons.push([url, blob]); return true; } } });

const agent = (id, extra = {}) => ({ id, name: id, description: '', instructions: `${id} instructions`, model: '', channels: [{ id: 'discord', enabled: false }], capabilities: null, ...extra });
const page = (extra = {}) => ({
  settings: { activeView: 'agent', selectedAgentId: 'research', selectedAgentScope: 'global', config: {} },
  customize: { agents: [agent('main'), agent('research')], connectors: [], mcpAuthSurface: [] },
  ...extra,
});

function harness({ bootstrap = page(), project = null, api = null, responses = {} } = {}) {
  const calls = [], applied = [], preserved = [], stored = [], errors = [], toasts = [], settings = [], edits = [];
  let renders = 0, refreshes = 0;
  const state = { bootstrap };
  const context = {
    getBootstrap: () => state.bootstrap,
    app: document.body,
    api: api || (async (path, options = {}) => {
      calls.push([path, options.method || 'GET', options.body]);
      const key = Object.keys(responses).find(prefix => path.startsWith(prefix));
      const value = key ? responses[key] : { ...state.bootstrap, marker: path };
      if (value instanceof Error) throw value;
      return structuredClone(value);
    }),
    render: () => { renders++; }, bgRender: () => { renders++; },
    showError: message => errors.push(message), showFlashToast: message => toasts.push(message),
    patchSettings: async patch => { settings.push(patch); },
    applyBootstrap: payload => { applied.push(payload); state.bootstrap = payload; },
    applyBootstrapPreservingDrafts: payload => { preserved.push(payload); state.bootstrap = payload; },
    refreshBootstrap: async () => { refreshes++; },
    storeBootstrap: payload => { stored.push(payload); state.bootstrap = payload; },
    activeProject: () => project,
    agentProfileById: id => state.bootstrap?.customize?.agents?.find(a => a.id === id) || null,
    minimaxTtsConfigPatchForVoice: voiceId => ({ minimaxVoiceId: voiceId }),
    beginFormEdit: form => edits.push(['begin', form.dataset.agentId]),
    formEditToken: () => () => true,
    nativeSettings: async () => ({}),
    isAgentChannelAvailable: () => false,
    escapeHtml: value => String(value ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
    icon: { eye: '', eyeOff: '' },
    renderCapabilityGrants: agentId => `<section data-grants-for="${agentId}"></section>`,
  };
  const feature = installAgentsFeature(context);
  const actions = createActionRegistry('action');
  actions.register(feature.actions, 'agents');
  const forms = createActionRegistry('form');
  forms.register(feature.forms, 'agents');
  return { feature, actions, forms, context, state, calls, applied, preserved, stored, errors, toasts, settings, edits, renders: () => renders, refreshes: () => refreshes };
}
const element = html => { const host = document.createElement('div'); host.innerHTML = html; document.body.replaceChildren(host); return host.firstElementChild; };
const click = (h, action, html) => h.actions.dispatch(action, { action, trigger: html ? element(html) : null, event: null });
const profileForm = (agentId = 'research', fields = '<input name="name" value="Research">') => element(`<form data-form="agent-profile-update" data-agent-id="${agentId}">${fields}</form>`);

test('the Agent feature takes a narrow context (no uiState) and starts from its own state', async () => {
  const { context } = harness();
  assert.throws(() => installAgentsFeature({ ...context, uiState: {} }), /not uiState/);
  const { formEditToken, storeBootstrap, ...rest } = context;
  assert.throws(() => installAgentsFeature(rest), /missing context storeBootstrap, formEditToken/);
  const first = harness();
  await click(first, 'toggle-agent-secret', '<button data-action="toggle-agent-secret" data-agent-id="research" data-channel-id="discord"></button>');
  const firstState = first.feature.getState();
  assert.deepEqual(firstState.agentSecretVisibility, { 'research:discord': true });
  assert.equal(first.renders(), 1);
  const second = harness();
  assert.notEqual(second.feature.getState(), firstState, 'every install starts from its own state object');
  assert.deepEqual(second.feature.getState().agentSecretVisibility, {});
});

test('registry: every Agent action is registered once; scope switch flushes then navigates', async () => {
  const h = harness();
  assert.deepEqual(Object.keys(h.feature.actions).sort(), [
    'clear-agent-avatar', 'confirm-agent-settings', 'create-custom-agent', 'export-agent-document', 'import-agent-preset',
    'reset-agent-connector-whitelist', 'reset-agent-draft', 'reset-agent-skill-whitelist', 'reset-project-agent-override',
    'select-agent-editor-tab', 'switch-agent-channel-tab', 'switch-agent-scope', 'test-agent-channel', 'toggle-agent-connector',
    'toggle-agent-mcp-server', 'toggle-agent-secret', 'toggle-agent-skill', 'toggle-agent-tool',
  ]);
  assert.deepEqual(Object.keys(h.feature.forms), ['agent-profile-update']);
  assert.equal(h.actions.has('select-agent-profile'), false, 'cross-page navigation stays in app.js');
  await click(h, 'switch-agent-scope', '<button data-action="switch-agent-scope" data-scope="project"></button>');
  assert.deepEqual(h.settings, [{ activeView: 'agent', selectedCustomizeSection: 'agents', selectedAgentScope: 'project' }]);
  assert.deepEqual(h.calls, [], 'nothing pending, so the flush sends nothing');
  await click(h, 'confirm-agent-settings', '<button data-action="confirm-agent-settings" data-id="c1" data-expected="fp" data-accept="true"></button>');
  assert.deepEqual(h.calls.map(([path, method, body]) => [path, method, body]), [
    ['/api/agent-settings-sync/confirm', 'POST', { id: 'c1', expected: 'fp', accept: true }],
    ['/api/bootstrap', 'GET', undefined],
  ]);
  assert.equal(h.applied.at(-1).marker, '/api/bootstrap');
});

test('drafts are isolated per Agent, scope and project; cancel discards only the edited one', () => {
  const h = harness({ project: { id: 'P1', name: 'Fixture' } });
  const typeName = value => { const input = profileForm().querySelector('[name=name]'); input.value = value; return h.feature.handleInput(input); };
  assert.equal(typeName('Global name'), true);
  assert.equal(h.feature.formDraftScope(profileForm()), 'global:global:research');
  // The same Agent edited as this project's override keeps a separate draft.
  h.state.bootstrap = page({ settings: { ...page().settings, selectedAgentScope: 'project' } });
  assert.equal(h.feature.formDraftScope(profileForm()), 'project:P1:research');
  typeName('Project name');
  const drafts = h.feature.getState().agentDrafts;
  assert.deepEqual(Object.fromEntries(Object.entries(drafts).map(([key, draft]) => [key, draft.name])), { 'global:global:research': 'Global name', 'project:P1:research': 'Project name' });
  // settingsFormEditors' cancel: another Agent's form leaves both, this one drops the override only.
  h.feature.discardFormDraft(profileForm('main'));
  assert.equal(Object.keys(drafts).length, 2);
  h.feature.discardFormDraft(profileForm());
  assert.deepEqual(Object.keys(drafts), ['global:global:research']);
  assert.equal(h.feature.ownsFormDraft(profileForm()), true);
  assert.equal(h.feature.ownsFormDraft(element('<form data-form="project-update"></form>')), false);
  // Unrelated events are answered synchronously and are never a promise.
  assert.equal(h.feature.handleInput(element('<input id="chat-search">')), false);
  assert.equal(h.feature.handleChange(element('<input name="other">')), false);
  assert.equal(h.feature.handleFileChange(element('<input type="file" name="other">')), false);
});

test('change: select / checkbox fields repaint, text blur does not (the Save click must survive)', () => {
  const h = harness();
  const form = profileForm('research', '<input name="description"><select name="voiceReplyMode"><option value="summary">s</option><option value="off">o</option></select><input type="checkbox" name="context_memory">');
  const text = form.querySelector('[name=description]');
  text.value = 'One line';
  assert.equal(h.feature.handleChange(text), true);
  assert.equal(h.renders(), 0);
  const select = form.querySelector('select');
  select.value = 'off';
  assert.equal(h.feature.handleChange(select), true);
  const box = form.querySelector('[type=checkbox]');
  box.checked = true;
  assert.equal(h.feature.handleChange(box), true);
  assert.equal(h.renders(), 2);
  assert.deepEqual(['description', 'voiceReplyMode', 'context_memory'].map(k => h.feature.getState().agentDrafts['global:global:research'][k]), ['One line', 'off', 'on']);
});

test('save: a project override posts scope + project, clears only that draft and keeps the global one', async () => {
  const project = { id: 'P1', name: 'Fixture' };
  const bootstrap = page({ settings: { ...page().settings, selectedAgentScope: 'project' } });
  const h = harness({ bootstrap, project });
  const state = h.feature.getState();
  state.agentDrafts['global:global:research'] = { name: 'kept' };
  state.agentDrafts['project:P1:research'] = { name: 'override' };
  const form = profileForm('research', '<input name="name" value="Override name"><textarea name="instructions">Project voice</textarea>');
  await h.forms.dispatch('agent-profile-update', { form });
  assert.deepEqual(h.calls[0], ['/api/agents/update', 'POST', { agentId: 'research', scope: 'project', projectId: 'P1', activeView: 'agent', patch: { name: 'Override name', instructions: 'Project voice' } }]);
  assert.deepEqual(Object.keys(state.agentDrafts), ['global:global:research']);
  assert.deepEqual(state.agentSaveStates, {}, 'the saving flag is cleared afterwards');
  assert.equal(h.applied.length, 1);
  h.calls.length = 0;
  state.agentDrafts['project:P1:research'] = { name: 'again' };
  await click(h, 'reset-project-agent-override', '<button data-action="reset-project-agent-override" data-agent-id="research"></button>');
  assert.deepEqual(h.calls, [['/api/agents/update', 'POST', { agentId: 'research', scope: 'project', projectId: 'P1', activeView: 'agent', clearProjectOverride: true }]]);
  assert.deepEqual(Object.keys(state.agentDrafts), ['global:global:research']);
});

test('autosave hooks: flushPending sends the queued channel / Markdown snapshot once; unload uses the beacon', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness();
  h.feature.getState().agentDrafts['global:global:research'] = { ...h.context.agentProfileById('research'), channels: { discord: { id: 'discord', botToken: 'tok' } }, voiceReplyMode: 'full' };
  scheduleAgentChannelAutosave('research');
  assert.deepEqual(h.calls, [], 'nothing is sent before the idle timer or a flush');
  const flushed = h.feature.flushPending();
  await new Promise(resolve => setImmediate(resolve)); // the save is in flight, its 100 ms minimum-visible timer armed
  t.mock.timers.tick(100);
  await flushed;
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0][2], { agentId: 'research', scope: 'global', projectId: null, activeView: 'agent', patch: { channels: { discord: { id: 'discord', botToken: 'tok' } }, voiceReplyMode: 'full' } });
  assert.equal(h.preserved.length, 1, 'the channel autosave keeps the still-typing drafts');
  t.mock.timers.tick(3000);
  assert.equal(h.calls.length, 1, 'the cancelled 3 s timer does not save a second time');
  h.feature.getState().agentDrafts['global:global:research'].identity = 'Who I am';
  scheduleAgentMarkdownAutosave('research');
  await h.feature.flushPending();
  assert.deepEqual(h.calls[1][2].patch, { identity: 'Who I am', 'soul.md': '' });
  assert.equal(h.stored.length, 1, 'the Markdown autosave stores the page data without a render');
  scheduleAgentChannelAutosave('research');
  beacons.length = 0;
  h.feature.flushOnUnload();
  assert.equal(beacons.length, 1);
  assert.equal(beacons[0][0], '/api/agents/update');
  assert.equal(JSON.parse(await beacons[0][1].text()).agentId, 'research');
  await h.feature.flushPending();
  assert.equal(h.calls.length, 2, 'the unload flush consumed the snapshot');
});

test('render hooks: list/detail scroll and the editor caret survive a full re-render', async () => {
  const h = harness();
  const markup = '<section class="agent-page"><div class="agent-list-pane" style="height:10px;overflow:auto"><div style="height:100px"></div></div><div class="agent-detail-column" style="height:10px;overflow:auto"><div style="height:100px"></div></div></section>';
  element(markup);
  document.querySelector('.agent-detail-column').scrollTop = 40;
  h.feature.captureBeforeRender();
  element(markup);
  assert.equal(document.querySelector('.agent-detail-column').scrollTop, 0);
  h.feature.restoreScrollAfterRender();
  assert.equal(document.querySelector('.agent-detail-column').scrollTop, 40);
  // Another Agent keeps its own detail scroll position.
  h.state.bootstrap = page({ settings: { ...page().settings, selectedAgentId: 'main' } });
  element(markup);
  h.feature.restoreScrollAfterRender();
  assert.equal(document.querySelector('.agent-detail-column').scrollTop, 0);
  // Off the Agent page the hooks do nothing.
  h.state.bootstrap = page({ settings: { ...page().settings, activeView: 'chat' } });
  h.feature.captureBeforeRender();
  h.feature.restoreEditorAfterRender();
  h.feature.syncRuntimeRefresh();
  assert.equal(h.refreshes(), 0);
});

test('the Agent page renders from feature state: creating, open sections and the selector', async () => {
  const h = harness();
  const state = h.feature.getState();
  state.agentCreating = true;
  state.agentOpenSections['research:channels'] = true;
  const html = h.feature.renderPage();
  const doc = new JSDOM(html).window.document;
  assert.equal(doc.querySelector('[data-action=create-custom-agent]').disabled, true);
  assert.equal(doc.querySelector('form[data-form=agent-profile-update]').dataset.agentId, 'research');
  assert.equal(doc.querySelector('.agent-channels').hasAttribute('open'), true);
  assert.deepEqual([...doc.querySelectorAll('.agent-select option')].map(o => [o.value, o.selected]), [['main', false], ['research', true]]);
  const details = doc.querySelector('.agent-channels');
  details.open = false;
  h.feature.handleToggle({ target: details });
  assert.equal(state.agentOpenSections['research:channels'], false);
});

// The real shared request layer (sharedApi.js, app.js's api() until P2c) with
// a stubbed fetch: a committed Agent save whose page data could not be rebuilt
// reloads the bootstrap, keeps the export warning and clears the draft.
function sharedApi({ uiState, responses, errors }) {
  const requests = [];
  const request = async (path, init) => {
    requests.push([path, init.method]);
    const next = responses.shift();
    return { ok: next.status < 400, json: async () => next.body };
  };
  const api = createSharedApi({ getBootstrap: () => uiState.bootstrap, showError: message => errors.push(message), request });
  return { api, requests };
}

test('bootstrapError: a committed Agent save goes through the shared api(), reloads the page and keeps the export warning', async () => {
  const apiErrors = [];
  const before = page();
  const after = page({ marker: 'after', stateRevision: 4 });
  const { api, requests } = sharedApi({ uiState: { bootstrap: before }, errors: apiErrors, responses: [
    { status: 200, body: { ok: true, receipt: { agentId: 'research', revision: 4, agentExportWarning: '已保存，但未能导出 Markdown' }, bootstrapError: { code: 'BOOTSTRAP_UNAVAILABLE', message: 'Failed to read config' } } },
    { status: 200, body: after },
  ] });
  const h = harness({ bootstrap: before, api });
  h.feature.getState().agentDrafts['global:global:research'] = { name: 'Edited' };
  await h.forms.dispatch('agent-profile-update', { form: profileForm('research', '<input name="name" value="Edited">') });
  assert.deepEqual(requests, [['/api/agents/update', 'POST'], ['/api/bootstrap', 'GET']]);
  assert.equal(h.applied.length, 1);
  assert.equal(h.applied[0].marker, 'after', 'the page data is the reloaded bootstrap, not the receipt');
  assert.deepEqual(h.errors, ['已保存，但未能导出 Markdown']);
  assert.deepEqual(h.feature.getState().agentDrafts, {}, 'the committed draft is cleared');
  assert.deepEqual(apiErrors, []);
});

// The reload can reflect a newer selection (for example another window).
// The create receipt, not whichever form is currently visible, owns auto-edit.
test('recovered create never auto-edits another Agent or a project override', async () => {
  for (const scope of ['global', 'project']) {
    const selectedAgentId = scope === 'project' ? 'custom-new' : 'research';
    const bootstrap = page({ stateRevision: 4, settings: { ...page().settings, selectedAgentId, selectedAgentScope: scope } });
    const recovered = await settleCommittedSave({ ok: true, receipt: { agentId: 'custom-new', revision: 3 }, bootstrapError: {} }, {
      reload: async () => ({ ...bootstrap, customize: { ...bootstrap.customize, agents: [...bootstrap.customize.agents, agent('custom-new')] } }),
      recover: () => assert.fail(),
    });
    const h = harness({ bootstrap, project: scope === 'project' ? { id: 'P1' } : null, responses: { '/api/agents/create-custom': recovered } });
    // Pass through the real recovered object so the local receipt identity is retained.
    h.context.api = async () => recovered;
    const feature = installAgentsFeature(h.context);
    profileForm(selectedAgentId);
    await feature.actions['create-custom-agent']();
    assert.deepEqual(h.edits, [], 'the pre-existing form must remain read-only');
  }
});

test('create flow: read-only start by default; «基于已有 Agent» sends basedOn and the persona tick', async () => {
  const h = harness({ responses: { '/api/agents/create-custom': page() } });
  let doc = new JSDOM(h.feature.renderPage()).window.document;
  assert.deepEqual([...doc.querySelectorAll('[data-agent-create-base] option')].map(o => o.value), ['', 'main', 'research']);
  assert.equal(doc.querySelector('[data-agent-create-base]').getAttribute('aria-label'), '新 Agent 的起点');
  assert.equal(doc.querySelector('[data-agent-create-persona]'), null, 'nothing to copy from a read-only start');
  assert.match(doc.querySelector('.agent-create-hint').textContent, /默认只开启读取文件、联网、知识与记忆/);
  assert.ok(doc.querySelector('[data-grants-for="research"]'), 'the selected Agent shows its temporary grants');
  await h.actions.dispatch('create-custom-agent', { action: 'create-custom-agent', trigger: null, event: null });
  assert.deepEqual(h.calls.at(-1), ['/api/agents/create-custom', 'POST', {}], 'the plain create keeps its empty body');
  assert.equal(h.feature.handleChange(element('<select data-agent-create-base><option value="main" selected>Melo</option></select>')), true);
  doc = new JSDOM(h.feature.renderPage()).window.document;
  assert.equal(doc.querySelector('[data-agent-create-base]').value, 'main');
  assert.ok(doc.querySelector('[data-agent-create-persona]'));
  assert.match(doc.querySelector('.agent-create-hint').textContent, /消息渠道和机器人令牌不会复制/);
  await h.actions.dispatch('create-custom-agent', { action: 'create-custom-agent', trigger: null, event: null });
  assert.deepEqual(h.calls.at(-1)[2], { basedOn: 'main', copyPersona: false });
  assert.equal(h.feature.handleChange(element('<input type="checkbox" data-agent-create-persona checked>')), true);
  await h.actions.dispatch('create-custom-agent', { action: 'create-custom-agent', trigger: null, event: null });
  assert.deepEqual(h.calls.at(-1)[2], { basedOn: 'main', copyPersona: true });
  h.feature.handleChange(element('<select data-agent-create-base><option value="" selected>x</option></select>'));
  assert.equal(h.feature.getState().agentCreateCopyPersona, false, 'going back to the read-only start clears the tick');
});
