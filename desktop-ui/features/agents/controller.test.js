// This fixture asserts Chinese copy explicitly; production defaults follow the device.
import { setLanguage as setFixtureLanguage } from '../../i18n.js';
setFixtureLanguage('zh-CN');
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createActionRegistry } from '../registry.js';
import { createSharedApi } from '../../sharedApi.js';
import { settleCommittedSave } from '../../bootstrapPatch.js';
import { installAgentsFeature } from './index.js';

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
  const calls = [], applied = [], preserved = [], errors = [], toasts = [], settings = [], edits = [];
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
    notify: ({level,text}) => (level==='error'?errors:toasts).push(text),
    patchSettings: async patch => { settings.push(patch); },
    applyBootstrap: payload => { applied.push(payload); state.bootstrap = payload; },
    applyBootstrapPreservingDrafts: payload => { preserved.push(payload); state.bootstrap = payload; },
    refreshBootstrap: async () => { refreshes++; },
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
  return { feature, actions, forms, context, state, calls, applied, preserved, errors, toasts, settings, edits, renders: () => renders, refreshes: () => refreshes };
}
const element = html => { const host = document.createElement('div'); host.innerHTML = html; document.body.replaceChildren(host); return host.firstElementChild; };
const click = (h, action, html) => h.actions.dispatch(action, { action, trigger: html ? element(html) : null, event: null });
const profileForm = (agentId = 'research', fields = '<input name="name" value="Research">') => element(`<form data-form="agent-profile-update" data-agent-id="${agentId}">${fields}</form>`);

test('the Agent feature takes a narrow context (no uiState) and starts from its own state', async () => {
  const { context } = harness();
  assert.throws(() => installAgentsFeature({ ...context, uiState: {} }), /not uiState/);
  const { formEditToken, refreshBootstrap, ...rest } = context;
  assert.throws(() => installAgentsFeature(rest), /missing context refreshBootstrap, formEditToken/);
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
    'toggle-agent-device-permission', 'toggle-agent-mcp-server', 'toggle-agent-secret', 'toggle-agent-skill', 'toggle-agent-tool',
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

// Since 10-17 the Agent page commits only through the explicit Save action
// (settingsEdit). The idle autosave and its flush / unload hooks were dead
// code and are gone (architecture B1, 2026-10-20); this pins that design.
test('Agent edits stay drafts until explicit Save: typing, idle time and navigation send no update', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness();
  const form = profileForm('research', '<input name="discordBotToken" value="">');
  const token = form.querySelector('[name=discordBotToken]');
  token.value = 'tok-123';
  assert.equal(h.feature.handleInput(token), true, 'the channel field is handled by the Agent feature');
  t.mock.timers.tick(10_000);
  await click(h, 'switch-agent-scope', '<button data-scope="global"></button>');
  await click(h, 'select-agent-editor-tab', '<button data-tab="soul"></button>');
  t.mock.timers.tick(10_000);
  assert.deepEqual(h.calls.filter(([path]) => path.startsWith('/api/agents/update')), [], 'no Agent update leaves without the explicit Save action');
  assert.deepEqual(beacons, [], 'nothing is beaconed either');
  assert.equal(h.feature.getState().agentDrafts['global:global:research']?.channels?.discord?.botToken, 'tok-123', 'the typed token stays in the draft');
  assert.equal('flushPending' in h.feature, false);
  assert.equal('flushOnUnload' in h.feature, false);
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
  const api = createSharedApi({ getBootstrap: () => uiState.bootstrap, notify: ({text}) => errors.push(text), request });
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
  // Retired built-in lanes are no starting point (2026-11-07); the selected one still opens.
  assert.deepEqual([...doc.querySelectorAll('[data-agent-create-base] option')].map(o => o.value), ['', 'main']);
  assert.equal(doc.querySelector('[data-agent-create-base]').getAttribute('aria-label'), '新 Agent 的起点');
  assert.equal(doc.querySelector('[data-agent-create-persona]'), null, 'nothing to copy from a read-only start');
  assert.match(doc.querySelector('.agent-create-hint').textContent, /默认开启全部基础能力（「联网」即可网页搜索）.*已启用的技能和 MCP 服务也会默认带上/);
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

// 这台电脑上: the checkbox flips natively on the click, so a saved switch takes
// the server's bootstrap and a failed save turns the box back before reporting.
test('device permission: a saved switch applies the bootstrap; a failed save turns the box back', async () => {
  const saved = page({ settings: { ...page().settings, localPreferences: { agentDevice: { research: { location: true } } } } });
  const ok = harness({ responses: { '/api/settings/local': saved } });
  const box = '<input type="checkbox" data-action="toggle-agent-device-permission" data-agent-id="research" data-permission="location" checked>';
  await click(ok, 'toggle-agent-device-permission', box);
  assert.deepEqual(ok.calls, [['/api/settings/local', 'POST', { preferences: { agentDevice: { research: { location: true } } } }]]);
  assert.deepEqual(ok.applied.at(-1).settings.localPreferences.agentDevice, { research: { location: true } });
  const failing = harness({ responses: { '/api/settings/local': new Error('fixture save failed') } });
  const trigger = element(box);
  assert.equal(trigger.checked, true, 'the click already flipped the box');
  await assert.rejects(failing.actions.dispatch('toggle-agent-device-permission', { action: 'toggle-agent-device-permission', trigger, event: null }), /fixture save failed/);
  assert.equal(trigger.checked, false, 'the box shows what this computer saved, not the click');
  assert.deepEqual(failing.applied, [], 'nothing is applied from a failed save');
});

// ── Settings audit 2026-11-10 ──────────────────────────────────────────────
const CAPABILITY_LABELS = { readFiles: '读取文件', writeFiles: '修改文件', runCommands: '运行命令', network: '联网', knowledgeMemory: '知识与记忆', generateMedia: '生成媒体', delegate: '委派' };
const migrated = (id, extra = {}) => agent(id, {
  capabilities: { version: 1, readFiles: true, writeFiles: true, runCommands: true, network: true, knowledgeMemory: true, generateMedia: true, delegate: false, mcpServers: [], skills: ['on-skill', 'off-skill'], connectors: ['off-connector'] },
  capabilityLabels: CAPABILITY_LABELS, collaboration: { canDelegate: false, delegateTargets: [], maxDelegationDepth: 1, maxIterations: 20, maxTokens: 32000, timeoutMs: 180000 },
  capabilityOptions: [{ id: 'on-skill', name: 'On skill', enabled: true }, { id: 'off-skill', name: 'Off skill', enabled: false }], editingScope: 'global', ...extra });
const migratedPage = (extra = {}, agentExtra = {}) => page({ customize: { agents: [agent('main'), migrated('research', agentExtra)], mcpAuthSurface: [],
  connectors: [{ id: 'on-connector', name: 'On connector', type: 'external-mcp', enabled: true }, { id: 'off-connector', name: 'Off connector', type: 'external-mcp', enabled: false }] }, ...extra });

test('member limits: the two inputs start at the floor and the page says what the numbers mean and whom they govern', async () => {
  const { MEMBER_LIMIT_FLOORS, memberWorkTokens } = await import('../../../src/domain/agent/capabilities.js');
  const doc = new JSDOM(harness({ bootstrap: migratedPage() }).feature.renderPage()).window.document;
  assert.equal(doc.querySelector('input[name=maxTokens]').min, String(MEMBER_LIMIT_FLOORS.maxTokens));
  assert.equal(doc.querySelector('input[name=timeoutMs]').min, String(MEMBER_LIMIT_FLOORS.timeoutMs));
  assert.equal(doc.querySelector('input[name=maxIterations]').min, '1', 'the other limits keep their minimum');
  const text = doc.querySelector('.agent-capabilities').textContent;
  // The numbers come from the run budget's arithmetic, not from a literal.
  assert.match(text, new RegExp(`上限 32,000 时约 ${memberWorkTokens(32000).toLocaleString('zh-CN')} 可用于工作本身，超时里有 60 秒留给收尾`));
  assert.match(text, /限制的是这个 Agent 自己被委派或加入团队时的一次运行，主 Agent 自动分派的内部成员不使用这三项/);
  assert.match(text, /「委派深度」按整条委派链计算，链上每个 Agent 的设置取最小值/);
  // A larger saved cap is what the sentence is computed for.
  const larger = new JSDOM(harness({ bootstrap: migratedPage({}, { collaboration: { maxTokens: 100000, timeoutMs: 180000 } }) }).feature.renderPage()).window.document;
  assert.match(larger.querySelector('.agent-capabilities').textContent, new RegExp(`上限 100,000 时约 ${memberWorkTokens(100000).toLocaleString('zh-CN')} 可用于工作本身`));
});

test('the page says what a switched-off capability does, what location needs, what stays on this computer and where the Agent\'s model applies', () => {
  const doc = new JSDOM(harness({ bootstrap: migratedPage() }).feature.renderPage()).window.document;
  const capabilities = doc.querySelector('.agent-capabilities').textContent;
  assert.match(capabilities, /关闭的能力在需要用到时会先询问你，可以只开启这一次；没有得到允许就不会执行/);
  assert.doesNotMatch(capabilities, /在工具执行时拒绝/);
  assert.match(capabilities, /本机定位在下方「这台电脑上」单独开启，并且需要这里的「联网」同时开启/);
  assert.match(capabilities, /只影响内部成员，不改审批与能力范围；只保存在这台电脑上，不同步/);
  assert.match(doc.querySelector('.agent-device-section').textContent, /定位还需要上方能力范围里的「联网」开启/);
  assert.doesNotMatch(doc.querySelector('.agent-device-section').textContent, /与上方同步的能力范围无关/);
  assert.match(doc.querySelector('select[name=replyLanguage]').closest('label').textContent, /^回复语言（本机）/);
  assert.match(doc.querySelector('input[name=model]').closest('label').nextElementSibling.textContent, /对话里选的模型优先；它被委派或加入团队时使用这里的模型，留空则跟随发起对话的模型/);
});

test('a ticked skill or connector that is switched off for the whole app is marked', () => {
  const doc = new JSDOM(harness({ bootstrap: migratedPage() }).feature.renderPage()).window.document;
  const chipOf = (name, value) => doc.querySelector(`input[name="${name}"][value="${value}"]`).closest('label').querySelector('.chip')?.textContent || '';
  assert.equal(chipOf('cap_skills', 'off-skill'), '全局未启用');
  assert.equal(chipOf('cap_skills', 'on-skill'), '');
  assert.equal(chipOf('cap_connectors', 'off-connector'), '全局未启用');
  assert.equal(chipOf('cap_connectors', 'on-connector'), '');
});

test('project scope says that a save keeps the project\'s own copy of the page', () => {
  const note = /在项目下保存，会为这个项目单独存一份本页的全部设置/;
  const project = { id: 'P1', name: 'Fixture' };
  const scoped = harness({ bootstrap: migratedPage({ settings: { ...page().settings, selectedAgentScope: 'project' } }), project });
  assert.match(new JSDOM(scoped.feature.renderPage()).window.document.body.textContent, note);
  const global = harness({ bootstrap: migratedPage(), project });
  assert.doesNotMatch(new JSDOM(global.feature.renderPage()).window.document.body.textContent, note);
});

test('save: capability edits on an unmigrated Agent are reported instead of vanishing', async () => {
  const fields = '<input name="name" value="Research"><input type="hidden" name="capabilityVersion" value="1"><input type="hidden" name="capabilityMigrationExpected" value="fp"><input type="checkbox" name="confirmCapabilityMigration"><input name="maxIterations" value="9">';
  const h = harness();
  h.feature.getState().agentDrafts['global:global:research'] = { name: 'Research', maxIterations: '9' };
  await h.forms.dispatch('agent-profile-update', { form: profileForm('research', fields) });
  assert.equal('collaboration' in h.calls[0][2].patch, false, 'the section is not part of the save');
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0], /「能力范围与协作」里的修改没有保存.*请先勾选「确认应用这份能力配置」/);
  // The same save without an edit in that section, and a confirmed one, say nothing.
  const quiet = harness();
  quiet.feature.getState().agentDrafts['global:global:research'] = { name: 'Renamed' };
  await quiet.forms.dispatch('agent-profile-update', { form: profileForm('research', fields) });
  assert.deepEqual(quiet.errors, []);
  const confirmed = harness();
  confirmed.feature.getState().agentDrafts['global:global:research'] = { maxIterations: '9' };
  await confirmed.forms.dispatch('agent-profile-update', { form: profileForm('research', fields.replace('name="confirmCapabilityMigration"', 'name="confirmCapabilityMigration" checked')) });
  assert.equal(confirmed.calls[0][2].patch.collaboration.maxIterations, 9);
  assert.deepEqual(confirmed.errors, []);
});
