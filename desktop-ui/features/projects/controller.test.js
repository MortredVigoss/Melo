// This fixture asserts Chinese copy explicitly; production defaults follow the device.
import { setLanguage as setFixtureLanguage } from '../../i18n.js';
setFixtureLanguage('zh-CN');
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createActionRegistry } from '../registry.js';
import { installProjectsFeature } from './index.js';

// Architecture plan P2: the projects page owns its state, reads the bootstrap
// only through getBootstrap() and saves through the shared api().
const dom = new JSDOM('<!doctype html><body></body>');
globalThis.document = dom.window.document;
globalThis.FormData = dom.window.FormData;

const card = (id, name, extra = {}) => ({ id, name, summary: '', instructions: '', workspacePath: '', tag: '学习', updatedLabel: 'now', chatCount: 0, artifactCount: 0, archived: false, ...extra });

function harness(bootstrap = { projects: [] }) {
  const calls = [], applied = [], preserved = [], errors = [], settings = [], sessions = [];
  let renders = 0;
  const context = {
    getBootstrap: () => bootstrap,
    api: async (path, options = {}) => { calls.push([path, options.method || 'GET', options.body]); return { settings: {}, marker: path }; },
    render: () => { renders++; }, notify: ({text}) => errors.push(text),
    patchSettings: async patch => { settings.push(patch); }, applyBootstrap: payload => applied.push(payload), applyBootstrapPreservingDrafts: payload => preserved.push(payload),
    startProjectSession: async (projectId, mode) => { sessions.push([projectId, mode]); },
    activeProject: () => bootstrap.activeProject || null, activeProjectChats: () => [], activeProjectArtifacts: () => [],
    renderMemoryBook: project => `<section data-memory-book="${project.id}"></section>`,
    escapeHtml: value => String(value ?? ''), truncate: value => value,
    icon: { folder: '', plus: '', bubble: '', box: '', chevronLeft: '', save: '' },
  };
  const feature = installProjectsFeature(context);
  const actions = createActionRegistry('action');
  actions.register(feature.actions, 'projects');
  const forms = createActionRegistry('form');
  forms.register(feature.forms, 'projects');
  return { feature, actions, forms, context, calls, applied, preserved, errors, settings, sessions, renders: () => renders };
}
const element = html => { const host = document.createElement('div'); host.innerHTML = html; document.body.replaceChildren(host); return host.firstElementChild; };
const click = (h, action, html) => h.actions.dispatch(action, { action, trigger: html ? element(html) : null, event: null });

test('the projects feature takes a narrow context: no uiState, every callback named', () => {
  const { context } = harness();
  assert.throws(() => installProjectsFeature({ ...context, uiState: {} }), /not uiState/);
  const { renderMemoryBook, ...withoutBook } = context;
  assert.throws(() => installProjectsFeature(withoutBook), /missing context renderMemoryBook/);
});

test('new project: the form draft lives in feature state, create posts it once and resets', async () => {
  const h = harness();
  await click(h, 'toggle-project-form', '<button data-action="toggle-project-form"></button>');
  assert.equal(h.feature.getState().showProjectForm, true);
  const form = new JSDOM(h.feature.renderPage()).window.document.querySelector('form[data-form=project-create]');
  assert.ok(form, 'the empty-state page shows the create form once toggled');
  const page = element(`<form data-form="project-create"><input name="name"><input name="summary"></form>`);
  const name = page.querySelector('[name=name]');
  name.value = 'Reading plan';
  assert.equal(h.feature.handleDraftInput(name), true);
  assert.equal(h.feature.handleDraftInput(element('<input id="chat-search">')), false);
  await h.forms.dispatch('project-create', { form: page });
  assert.deepEqual(h.calls, [['/api/projects', 'POST', { name: 'Reading plan', summary: '', instructions: '', tag: '', workspacePath: '' }]]);
  assert.deepEqual(h.applied.map(payload => payload.marker), ['/api/projects']);
  assert.equal(h.feature.getState().showProjectForm, false);
  assert.deepEqual(h.feature.getState().draftProject, { name: '', tag: '', summary: '', instructions: '', workspacePath: '' });
});

test('a nameless project is refused locally without a request', async () => {
  const h = harness();
  await assert.rejects(h.forms.dispatch('project-create', { form: null }), /Project name is required/);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.errors, [], 'the form owner receives the error and retains its edit session');
});

test('project saves, archive, team and default Agent all patch through /api/projects/update', async () => {
  const h = harness({ projects: [card('p', 'Reading plan')], artifacts: [] });
  const form = element('<form data-form="project-update" data-project-id="p"><input name="name" value="Renamed"><input name="tag" value="t"><input name="summary" value="s"><textarea name="instructions">i</textarea><input name="workspacePath" value=""><input type="checkbox" name="knowledgeIds" value="a" checked><input type="checkbox" name="knowledgeIds" value="b"></form>');
  await h.forms.dispatch('project-update', { form });
  await click(h, 'archive-project', '<button data-action="archive-project" data-project-id="p" data-archived="true"></button>');
  await click(h, 'clear-project-team', '<button data-action="clear-project-team" data-project-id="p"></button>');
  const select = element('<select data-project-default-agent="p"><option value="research" selected>R</option></select>');
  const pending = h.feature.handleChange(select);
  assert.ok(pending instanceof Promise, 'the default-Agent save is awaited by the change listener');
  await pending;
  assert.equal(h.feature.handleChange(element('<input name="other">')), false, 'unrelated changes return synchronously');
  assert.deepEqual(h.calls, [
    ['/api/projects/update', 'POST', { projectId: 'p', patch: { name: 'Renamed', tag: 't', summary: 's', instructions: 'i', workspacePath: '', confirmWorkspace: false, knowledgeIds: ['a'] } }],
    ['/api/projects/update', 'POST', { projectId: 'p', patch: { archived: true } }],
    ['/api/projects/update', 'POST', { projectId: 'p', patch: { teamPlan: null } }],
    ['/api/projects/update', 'POST', { projectId: 'p', patch: { defaultAgentId: 'research' } }],
  ]);
  assert.equal(h.applied.length, 3);
  assert.equal(h.preserved.length, 1, 'the default-Agent change keeps other drafts');
  await click(h, 'chat-from-project', '<button data-action="chat-from-project" data-project-id="p"></button>');
  await click(h, 'clear-project-selection', '<button data-action="clear-project-selection"></button>');
  assert.deepEqual(h.sessions, [['p', 'chat']]);
  assert.deepEqual(h.settings, [{ selectedProjectId: null, activeView: 'projects' }]);
});

test('overview search and the archived switch filter the bootstrap projects without app state', async () => {
  const h = harness({ projects: [card('a', 'Reading plan'), card('b', 'Old trip', { archived: true })] });
  const titles = () => [...new JSDOM(h.feature.renderPage()).window.document.querySelectorAll('.project-card__title')].map(el => el.textContent.trim());
  assert.deepEqual(titles(), ['Reading plan']);
  const search = element('<input id="project-search">');
  search.value = 'zzz';
  assert.equal(h.feature.handleSearchInput(search), true);
  assert.equal(h.feature.getState().projectSearch, 'zzz');
  assert.match(h.feature.renderPage(), /没有匹配“zzz”的项目/);
  search.value = '';
  h.feature.handleSearchInput(search);
  await click(h, 'toggle-archived-projects', '<button data-action="toggle-archived-projects"></button>');
  assert.deepEqual(titles(), ['Old trip']);
  assert.equal(h.feature.handleSearchInput(element('<input id="global-search">')), false);
});

test('project deletion needs its own preview; deleted projects have a restore entry and stay out of ordinary lists', async () => {
  const h = harness({ projects: [card('live', 'Live'), card('gone', 'Gone', { archived: true, deletedAt: '2026-10-20T00:00:00Z' })], artifacts: [] });
  await click(h, 'confirm-delete-project', '<button data-project-id="live"></button>');
  assert.equal(h.calls.length, 0, 'no mutation without the matching confirmation');
  await click(h, 'preview-delete-project', '<button data-project-id="live"></button>');
  await click(h, 'cancel-delete-project');
  await click(h, 'confirm-delete-project', '<button data-project-id="live"></button>');
  assert.equal(h.calls.length, 0);
  await click(h, 'preview-delete-project', '<button data-project-id="live"></button>');
  await click(h, 'confirm-delete-project', '<button data-project-id="live"></button>');
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0][0], '/api/projects/lifecycle');
  assert.equal(h.calls[0][2].action, 'delete');
  assert.ok(h.calls[0][2].operationId);
  assert.equal(h.feature.getState().pendingDeleteProjectId, null);
  assert.doesNotMatch(h.feature.renderPage(), /data-project-id="gone"/);
  await click(h, 'toggle-deleted-projects');
  assert.match(h.feature.renderPage(), /restore-deleted-project/);
  assert.match(h.feature.renderPage(), /旧审批不会恢复/);
  await click(h, 'restore-deleted-project', '<button data-project-id="gone"></button>');
  assert.equal(h.calls[1][2].action, 'restore');
  assert.equal(h.calls[1][2].projectId, 'gone');
});
