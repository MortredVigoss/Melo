import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { createActionRegistry } from '../registry.js';
import { setLanguage } from '../../i18n.js';
import { installApprovalsFeature } from './index.js';
import { atomsLabel, promptText, optionLabel } from './view.js';

// Capability elevation (2026-10-20): the prompt card answers the queued
// `capability_request` entries; the «临时授权» list loads, shows and revokes
// grants. Driven through the action registry exactly like app.js drives it.
const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
for (const name of ['document', 'HTMLElement']) globalThis[name] = dom.window[name];
globalThis.window = dom.window;
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

const contract = JSON.parse(readFileSync(new URL('../../../shared/protocol/agent-loop.json', import.meta.url), 'utf8')).capabilityElevation;

function harness({ responses = {}, queue = [] } = {}) {
  const calls = [], toasts = [];
  let renders = 0, refreshes = 0;
  const state = { queue: [...queue] };
  const bootstrap = { customize: { agents: [{ id: 'main', name: 'Melo' }, { id: 'builder', name: 'Builder' }] } };
  const context = {
    getBootstrap: () => bootstrap,
    app: document.body,
    api: async (path, options = {}) => {
      calls.push([path, options.method || 'GET', options.body]);
      const value = responses[path];
      const resolved = typeof value === 'function' ? value(options.body) : value;
      if (resolved instanceof Error) throw resolved;
      return structuredClone(resolved ?? { ok: true });
    },
    render: () => { renders++; }, bgRender: () => { renders++; },
    showFlashToast: message => toasts.push(message),
    refreshBootstrap: async () => { refreshes++; },
    toolPermissions: () => state.queue,
    setToolPermissions: list => { state.queue = list; },
    escapeHtml: value => String(value ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
    icon: { chip: '<svg></svg>' },
  };
  const feature = installApprovalsFeature(context);
  const actions = createActionRegistry('action');
  actions.register(feature.actions, 'approvals');
  const click = (action, data) => {
    const trigger = document.createElement('button');
    Object.assign(trigger.dataset, data);
    return actions.dispatch(action, { action, trigger, event: null });
  };
  return { feature, context, state, calls, toasts, click, renders: () => renders, refreshes: () => refreshes };
}

const beyond = (extra = {}) => ({ kind: 'capability', requestId: 'req-1', decision: 'elevate-beyond-parent', agentId: 'builder', agentName: 'Builder', parentAgentId: 'main', parentName: 'Melo',
  capabilities: ['writeFiles'], toolId: 'file_write', options: [{ id: 'run' }, { id: 'project' }, { id: 'deny' }], projectOptionScope: 'project', ...extra });
const own = (extra = {}) => ({ kind: 'capability', requestId: 'req-2', decision: 'enable-own', agentId: 'main', agentName: 'Melo', capabilities: ['runCommands'], toolId: 'bash',
  options: [{ id: 'run' }, { id: 'always' }, { id: 'deny' }], settingsScope: 'global', ...extra });
const mount = html => { document.body.innerHTML = html; return document.body; };

test('narrow context, own state, registered actions', () => {
  const h = harness();
  assert.throws(() => installApprovalsFeature({ ...h.context, uiState: {} }), /not uiState/);
  const { refreshBootstrap, ...rest } = h.context;
  assert.throws(() => installApprovalsFeature(rest), /missing context refreshBootstrap/);
  assert.deepEqual(Object.keys(h.feature.actions).sort(), ['capability-grant-revoke', 'capability-grants-refresh', 'capability-request-respond']);
  const first = h.feature.getState();
  assert.notEqual(harness().feature.getState(), first, 'every install starts from its own state object');
});

test('UI source strings are the shared contract texts', () => {
  const texts = contract.texts;
  assert.equal(promptText(beyond()), texts.beyondParentPrompt.replace('{agent}', 'Builder').replace('{capability}', '修改文件').replace('{parent}', 'Melo'));
  assert.equal(promptText(own()), texts.enableOwnPrompt.replace('{agent}', 'Melo').replace('{capability}', '运行命令'));
  for (const [decision, labels] of Object.entries(texts.optionLabels)) {
    for (const [option, label] of Object.entries(labels)) {
      const id = option === 'chat' ? 'project' : option;
      assert.equal(optionLabel(decision, id, option === 'chat' ? 'chat' : 'project'), label, `${decision}.${option}`);
    }
  }
  assert.equal(atomsLabel(['writeFiles', 'network', 'mcpServers:github', 'skills:s', 'connectors:c']),
    ['修改文件', '联网', contract.labels.lists.mcpServers.replace('{id}', 'github'), contract.labels.lists.skills.replace('{id}', 's'), contract.labels.lists.connectors.replace('{id}', 'c')].join(contract.labels.separator));
  for (const [key, label] of Object.entries(contract.labels.capabilities)) assert.equal(atomsLabel([key]), label);
  const view = readFileSync(new URL('./view.js', import.meta.url), 'utf8');
  assert.ok(view.includes(contract.texts.alwaysUnavailable) && view.includes(contract.texts.toolLine));
});

test('beyond-parent prompt: accessible dialog with the offered scopes; a click answers and leaves the queue', async () => {
  const h = harness({ queue: [beyond()], responses: { '/api/capability-requests/respond': { ok: true, decision: 'run', grant: { id: 'cg_x' } } } });
  const root = mount(h.feature.renderCapabilityPrompt(h.state.queue[0]));
  const dialog = root.querySelector('[role=dialog]');
  assert.equal(dialog.getAttribute('aria-modal'), 'true');
  assert.equal(root.querySelector(`#${dialog.getAttribute('aria-labelledby')}`).textContent, '需要临时授权');
  assert.match(root.querySelector(`#${dialog.getAttribute('aria-describedby')}`).textContent, /Builder 需要『修改文件』，Melo 没有这个能力/);
  const buttons = [...root.querySelectorAll('[data-action="capability-request-respond"]')];
  assert.deepEqual(buttons.map(b => [b.dataset.decision, b.textContent, b.type]), [['run', '仅本次任务', 'button'], ['project', '本项目 24 小时', 'button'], ['deny', '拒绝', 'button']]);
  assert.ok(buttons[0].classList.contains('is-primary'));
  assert.ok(root.querySelector('legend'), 'the button group is labelled');
  h.feature.focusPromptAfterRender();
  assert.equal(document.activeElement, buttons[0], 'a new prompt takes focus');
  buttons[1].focus(); h.feature.focusPromptAfterRender();
  assert.equal(document.activeElement, buttons[1], 'focus moves only once per prompt');
  await h.click('capability-request-respond', { requestId: 'req-1', decision: 'run' });
  assert.deepEqual(h.calls[0], ['/api/capability-requests/respond', 'POST', { requestId: 'req-1', decision: 'run' }]);
  assert.deepEqual(h.state.queue, []);
  assert.equal(h.refreshes(), 0);
  const chat = mount(h.feature.renderCapabilityPrompt(beyond({ projectOptionScope: 'chat' })));
  assert.equal(chat.querySelector('[data-decision=project]').textContent, '本对话 24 小时');
});

test('enable-own prompt: "一直开启" reloads the page data; without it the note explains why', async () => {
  const h = harness({ queue: [own()], responses: { '/api/capability-requests/respond': { ok: true, decision: 'always', receipt: { scope: 'global' } } } });
  const root = mount(h.feature.renderCapabilityPrompt(h.state.queue[0]));
  assert.equal(root.querySelector('.tool-permission-title').textContent, '需要开启能力');
  assert.match(root.textContent, /此 Agent（Melo）需要『运行命令』/);
  assert.match(root.textContent, /会修改这个 Agent 的全局设置/);
  assert.equal(root.querySelector('.capability-prompt-note'), null);
  await h.click('capability-request-respond', { requestId: 'req-2', decision: 'always' });
  assert.equal(h.refreshes(), 1);
  const limited = mount(h.feature.renderCapabilityPrompt(own({ options: [{ id: 'run' }, { id: 'deny' }], note: 'x', settingsScope: 'project' })));
  assert.deepEqual([...limited.querySelectorAll('[data-decision]')].map(b => b.dataset.decision), ['run', 'deny']);
  assert.match(limited.querySelector('.capability-prompt-note').textContent, /全局设置没有开启『运行命令』/);
  assert.match(limited.textContent, /在本项目的设置/);
});

test('an ended request leaves the queue with a notice; other failures stay on the card', async () => {
  const ended = harness({ queue: [beyond()], responses: { '/api/capability-requests/respond': new Error('CAPABILITY_REQUEST_NOT_FOUND') } });
  await ended.click('capability-request-respond', { requestId: 'req-1', decision: 'run' });
  assert.deepEqual(ended.state.queue, []);
  assert.match(ended.toasts[0], /已经结束/);
  const failing = harness({ queue: [own()], responses: { '/api/capability-requests/respond': new Error('ALWAYS_UNAVAILABLE') } });
  await failing.click('capability-request-respond', { requestId: 'req-2', decision: 'always' });
  assert.equal(failing.state.queue.length, 1);
  assert.equal(failing.state.queue[0].submitting, false);
  const root = mount(failing.feature.renderCapabilityPrompt(failing.state.queue[0]));
  assert.match(root.querySelector('[role=alert]').textContent, /项目设置不能单独开启/);
  // A click for an unknown request does nothing.
  await failing.click('capability-request-respond', { requestId: 'nope', decision: 'run' });
  assert.equal(failing.calls.length, 1);
});

test('«临时授权» loads once, lists per Agent with accessible revoke buttons, and revokes', async () => {
  const grants = [
    { id: 'cg_1', agentId: 'builder', atoms: ['writeFiles'], kind: 'elevate-beyond-parent', scope: 'project', expiresAt: Date.now() + 3600000 },
    { id: 'cg_2', agentId: 'main', atoms: ['runCommands'], kind: 'enable-own', scope: 'run', expiresAt: Date.now() + 3600000 },
  ];
  let served = grants;
  const h = harness({ responses: { '/api/capability-grants': () => ({ ok: true, grants: served }), '/api/capability-grants/revoke': { ok: true } } });
  let root = mount(h.feature.renderGrantList());
  assert.match(root.textContent, /目前没有临时授权/);
  await flush(); await flush();
  assert.deepEqual(h.calls.map(c => c[0]), ['/api/capability-grants']);
  mount(h.feature.renderGrantList());
  assert.equal(h.calls.length, 1, 'a fresh list is not reloaded on every render');
  root = mount(h.feature.renderGrantList());
  const rows = [...root.querySelectorAll('.capability-grant-row')];
  assert.deepEqual(rows.map(r => r.querySelector('.safety-rule-op').textContent), ['Builder · 修改文件', 'Melo · 运行命令']);
  assert.match(rows[0].textContent, /本项目 24 小时 · 到期 .* · 超出发起者/);
  assert.match(rows[1].textContent, /仅本次 · 任务结束时失效 · 超出自身设置/);
  assert.equal(rows[0].querySelector('button').getAttribute('aria-label'), '撤销 Builder 的『修改文件』临时授权');
  assert.equal(root.querySelector('section').getAttribute('aria-labelledby'), 'capability-grants-title-all');
  const forBuilder = mount(h.feature.renderGrantList({ agentId: 'builder' }));
  assert.equal(forBuilder.querySelectorAll('.capability-grant-row').length, 1);
  served = grants.slice(1);
  await h.click('capability-grant-revoke', { grantId: 'cg_1' });
  assert.deepEqual(h.calls.at(-2), ['/api/capability-grants/revoke', 'POST', { id: 'cg_1' }]);
  assert.match(h.toasts[0], /已撤销临时授权/);
  assert.deepEqual(h.feature.getState().grants.map(g => g.id), ['cg_2']);
  const none = mount(h.feature.renderGrantList({ agentId: 'builder' }));
  assert.match(none.textContent, /这个 Agent 目前没有临时授权/);
});

test('the card follows the interface language', () => {
  const h = harness();
  setLanguage('en');
  try {
    const root = mount(h.feature.renderCapabilityPrompt(beyond()));
    assert.match(root.textContent, /Builder needs “Modify files”, which Melo does not have/);
    assert.deepEqual([...root.querySelectorAll('[data-decision]')].map(b => b.textContent), ['This task only', 'This project for 24 hours', 'Deny']);
  } finally { setLanguage('zh-CN'); }
});
