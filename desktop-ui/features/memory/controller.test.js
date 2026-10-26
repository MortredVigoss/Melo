// This fixture asserts Chinese copy explicitly; production defaults follow the device.
import { setLanguage as setFixtureLanguage } from '../../i18n.js';
setFixtureLanguage('zh-CN');
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createActionRegistry } from '../registry.js';
import { installMemoryFeature } from './index.js';

// Architecture plan P2: the memory feature owns its state, gets a narrow
// context (no uiState) and is driven through the action registry exactly as
// app.js drives it.
const dom = new JSDOM('<!doctype html><body></body>');
globalThis.document = dom.window.document;
globalThis.FormData = dom.window.FormData;

function harness({ responses = {}, activeProject = { id: 'P' }, onRender = null } = {}) {
  const calls = [], errors = [];
  let renders = 0;
  const api = async (path, options = {}) => {
    calls.push([path, options.method || 'GET', options.body]);
    const key = Object.keys(responses).find(prefix => path.startsWith(prefix));
    const value = key ? responses[key] : { ok: true };
    if (value instanceof Error) throw value;
    return typeof value === 'function' ? value(path, options) : structuredClone(value);
  };
  const context = { api, render: () => { renders++; onRender?.(); }, bgRender: () => { renders++; onRender?.(); }, notify: ({text}) => errors.push(text), activeProject: () => activeProject, escapeHtml: value => String(value ?? '') };
  const feature = installMemoryFeature(context);
  const actions = createActionRegistry('action');
  actions.register(feature.actions, 'memory');
  const forms = createActionRegistry('form');
  forms.register(feature.forms, 'memory');
  return { feature, actions, forms, calls, errors, context, renders: () => renders };
}
const element = html => { const host = document.createElement('div'); host.innerHTML = html; document.body.replaceChildren(host); return host.firstElementChild; };
const click = (h, action, html) => h.actions.dispatch(action, { action, trigger: html ? element(html) : null, event: null });

test('the memory feature owns its state and refuses a context carrying uiState', async () => {
  const base = { api: async () => ({}), render() {}, bgRender() {}, notify() {}, activeProject: () => null, escapeHtml: String };
  assert.throws(() => installMemoryFeature({ ...base, uiState: {} }), /not uiState/);
  assert.throws(() => installMemoryFeature({ api: base.api }), /missing context render, bgRender, notify, activeProject, escapeHtml/);
  const first = harness();
  await click(first, 'memory-wipe-open', '<button data-action="memory-wipe-open"></button>');
  const firstState = first.feature.getState();
  assert.equal(firstState.memoryStatus.wipeConfirmOpen, true);
  assert.equal(first.renders(), 1);
  const second = harness();
  assert.notEqual(second.feature.getState(), firstState, 'every install starts from its own state object');
  assert.equal(second.feature.getState().memoryStatus.wipeConfirmOpen, false);
  assert.equal(firstState.memoryStatus.wipeConfirmOpen, true, 'nothing is shared through a global page state');
});

test('fact edit → field input → save goes through the registry and posts only the draft', async () => {
  const h = harness({ responses: {
    '/api/memory/status': { counts: {} },
    '/api/memory/facts?': { records: [{ id: 'f1', text: 'old', scope: 'chat', category: 'general', pinned: false }], total: 1, offset: 0, turns: [] },
  } });
  await click(h, 'refresh-memory-status');
  const state = h.feature.getState();
  assert.deepEqual(h.calls.map(([path]) => path), ['/api/memory/status', '/api/memory/facts?q=&offset=0']);
  await click(h, 'memory-fact-edit', '<button data-action="memory-fact-edit" data-id="f1"></button>');
  assert.equal(state.memoryFactEditing, 'f1');
  assert.deepEqual(state.memoryFactDraft, { text: 'old', scope: 'chat', category: 'technical_detail', pinned: false }, 'legacy categories start on a valid one (M5)');
  element('<div><div class="settings-edit-toolbar" data-edit-status="editing"><span class="settings-save-status"></span><button data-action="memory-fact-save" disabled></button></div><textarea id="memory-fact-text"></textarea></div>');
  const textarea = document.getElementById('memory-fact-text');
  textarea.value = 'new text';
  assert.equal(h.feature.handleFieldInput(textarea), true);
  assert.equal(state.memoryFactDraft.text, 'new text');
  assert.equal(document.querySelector('[data-action=memory-fact-save]').disabled, false);
  assert.equal(document.querySelector('.settings-edit-toolbar').dataset.editStatus, 'dirty');
  assert.equal(h.feature.handleFieldInput(element('<input id="chat-search">')), false);
  h.calls.length = 0;
  await click(h, 'memory-fact-save', '<button data-action="memory-fact-save" data-id="f1"></button>');
  assert.deepEqual(h.calls[0], ['/api/memory/facts/update', 'POST', { id: 'f1', patch: { text: 'new text', scope: 'chat', category: 'technical_detail', pinned: false } }]);
  assert.equal(state.memoryFactEditing, null);
  assert.deepEqual(state.memoryFactFeedback, { id: 'f1', message: '已保存' });
  assert.ok(h.calls.some(([path]) => path === '/api/memory/status'), 'the list is re-read after the save');
  assert.deepEqual(h.errors, []);
});

test('reply footer: 记成个人 on a book mirror promotes the underlying fact; the feedback clears after 8 s', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness();
  const button = element('<div data-message-memory-refs="m1"><button data-action="memory-ref-scope" data-memory-id="book:f9" data-scope="personal" data-kind="project-book"></button></div>').querySelector('button');
  await h.actions.dispatch('memory-ref-scope', { action: 'memory-ref-scope', trigger: button });
  assert.deepEqual(h.calls, [['/api/memory/facts/update', 'POST', { id: 'f9', patch: { scope: 'personal' } }]]);
  const state = h.feature.getState();
  assert.deepEqual(state.memoryRefFeedback, { id: 'book:f9', messageId: 'm1', message: '已记成个人' });
  const message = { id: 'm1', role: 'assistant', metadata: { memoryUsage: [{ id: 'book:f9', kind: 'project-book', text: 'x' }] } };
  assert.match(h.feature.renderMessageRefs(message), /data-message-memory-refs="m1" open/);
  t.mock.timers.tick(8000);
  assert.equal(state.memoryRefFeedback, null);
});

test('opening a reply footer is remembered per message across renders (U3)', () => {
  const h = harness();
  const details = element('<details data-message-memory-refs="m2"></details>');
  details.open = true;
  h.feature.handleToggle({ target: details });
  assert.deepEqual(h.feature.getState().memoryRefsOpen, { m2: true });
  assert.match(h.feature.renderMessageRefs({ id: 'm2', role: 'assistant', metadata: { memoryUsage: [{ id: 'f', kind: 'session-fact', text: 'y' }] } }), / open>/);
  details.open = false;
  h.feature.handleToggle({ target: details });
  assert.deepEqual(h.feature.getState().memoryRefsOpen, {});
});

test('project memory book: entering the page loads it once, leaving drops the draft, writing posts the form', async () => {
  let loads = 0;
  const h = harness({ responses: { '/api/projects/memory-book?': () => { loads++; return { records: [] }; } } });
  const onProject = { settings: { activeView: 'projects' }, activeProject: { id: 'P' } };
  h.feature.onBootstrap(onProject);
  await new Promise(resolve => setImmediate(resolve));
  h.feature.onBootstrap(onProject);
  assert.equal(loads, 1, 'a fresh book is not re-read on every bootstrap');
  const form = element('<form id="project-book-create" data-form="project-book-create" data-project-id="P"><textarea name="text"></textarea><select name="section" data-book-section-select="1"><option value="convention">c</option><option value="decision" selected>d</option></select></form>');
  form.querySelector('textarea').value = 'Use pnpm';
  assert.equal(h.feature.handleInput(form.querySelector('textarea')), true);
  assert.equal(h.feature.handleChange(form.querySelector('select')), true, 'a draft section change is handled synchronously');
  assert.deepEqual(h.feature.getState().projectBookDraft, { text: 'Use pnpm', section: 'decision', projectId: 'P' });
  assert.match(h.feature.renderProjectBook({ id: 'P', name: 'P' }), /Use pnpm/);
  h.feature.onBootstrap({ settings: { activeView: 'chat' }, activeProject: { id: 'P' } });
  assert.equal(h.feature.getState().projectBookDraft, null, 'leaving the project page drops its draft (U8)');
  form.querySelector('textarea').value = 'Ship Friday';
  h.calls.length = 0;
  await h.forms.dispatch('project-book-create', { form });
  assert.deepEqual(h.calls[0], ['/api/projects/memory-book', 'POST', { projectId: 'P', text: 'Ship Friday', section: 'decision' }]);
  assert.equal(h.feature.getState().projectBookFeedback, '已写入记忆本');
  assert.equal(h.feature.handleChange(element('<input name="other">')), false, 'unrelated changes return synchronously, never a promise');
});

test('手写一条: the row is read before the busy repaint disables the form, and the box is emptied once saved', async () => {
  // Mirrors render(): while the book is busy its controls are disabled, and
  // the page update keeps a textarea's typed value when the declared markup
  // did not change. Before the fix the busy repaint made FormData skip the
  // textarea (an empty row was posted) and a saved row stayed in the box.
  let state = null, form = null;
  const repaint = () => { if (form && state) for (const control of form.elements) control.disabled = state.projectBookBusy; };
  const h = harness({ onRender: repaint, responses: { '/api/projects/memory-book?': { records: [] } } });
  state = h.feature.getState();
  form = element('<form id="project-book-create" data-form="project-book-create" data-project-id="P"><textarea name="text"></textarea><select name="section" data-book-section-select="1"><option value="convention">c</option><option value="goal">g</option></select><button type="submit">写入记忆本</button></form>');
  const text = form.querySelector('textarea');
  text.value = 'Release on Friday';
  h.feature.handleInput(text);
  form.querySelector('select').value = 'goal';
  h.feature.handleChange(form.querySelector('select'));
  await h.forms.dispatch('project-book-create', { form });
  assert.deepEqual(h.calls[0], ['/api/projects/memory-book', 'POST', { projectId: 'P', text: 'Release on Friday', section: 'goal' }], 'the typed row is posted, not an empty one');
  assert.equal(text.value, '', 'the saved row no longer sits in the box');
  assert.equal(text.disabled, false);
  assert.equal(state.projectBookDraft, null);
  assert.equal(state.projectBookFeedback, '已写入记忆本');
  assert.deepEqual(h.errors, []);
});

test('手写一条: a failed save keeps the text and its draft; another project\'s box is never emptied', async () => {
  const failing = harness({ responses: { '/api/projects/memory-book': new Error('offline') } });
  const form = element('<form id="project-book-create" data-form="project-book-create" data-project-id="P"><textarea name="text"></textarea><select name="section" data-book-section-select="1"><option value="convention">c</option></select></form>');
  const text = form.querySelector('textarea');
  text.value = 'Keep me';
  failing.feature.handleInput(text);
  await assert.rejects(failing.forms.dispatch('project-book-create', { form }), /offline/);
  assert.equal(text.value, 'Keep me');
  assert.deepEqual(failing.feature.getState().projectBookDraft, { text: 'Keep me', projectId: 'P' });
  assert.deepEqual(failing.errors, [], 'the form owner handles the rejected save');
  // The save resolves after the same form element was re-rendered for project Q.
  let release;
  const slow = harness({ responses: { '/api/projects/memory-book?': { records: [] }, '/api/projects/memory-book': () => new Promise(resolve => { release = resolve; }) } });
  const other = element('<form id="project-book-create" data-form="project-book-create" data-project-id="P"><textarea name="text">Row for P</textarea><select name="section"><option value="convention">c</option></select></form>');
  const pending = slow.forms.dispatch('project-book-create', { form: other });
  other.dataset.projectId = 'Q';
  other.querySelector('textarea').value = 'Typing for Q';
  release({ ok: true });
  await pending;
  assert.equal(other.querySelector('textarea').value, 'Typing for Q');
});
