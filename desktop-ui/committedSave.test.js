import test from 'node:test';
import assert from 'node:assert/strict';
import { committedWithoutBootstrap, settleCommittedSave } from './bootstrapPatch.js';
import { createSharedApi } from './sharedApi.js';

// Architecture plan P1 follow-up: a project/Agent save that committed but
// could not rebuild the page data answers HTTP 200
// { ok: true, receipt, bootstrapError } (src/http/bootstrapAfterCommit.js).
const receiptBody = (receipt = { projectId: 'p', revision: 3 }) => ({ ok: true, receipt, bootstrapError: { code: 'BOOTSTRAP_UNAVAILABLE', message: 'Failed to read config' } });
const page = (extra = {}) => ({ settings: { activeView: 'projects' }, projects: [{ id: 'p' }], ...extra });

test('only a committed-save receipt is treated as missing page data', () => {
  assert.equal(committedWithoutBootstrap(receiptBody()), true);
  assert.equal(committedWithoutBootstrap(page()), false);
  assert.equal(committedWithoutBootstrap({ ok: true }), false, 'plain ok responses (memory, settings…) pass through');
  assert.equal(committedWithoutBootstrap({ ok: false, bootstrapError: {} }), false);
  assert.equal(committedWithoutBootstrap(null), false);
});

test('a normal response is returned untouched without a reload', async () => {
  const body = page();
  let reloads = 0;
  assert.equal(await settleCommittedSave(body, { reload: async () => { reloads++; }, current: () => null, notify: () => assert.fail() }), body);
  assert.equal(reloads, 0);
});

test('a committed save reloads the bootstrap and keeps the Agent export warning', async () => {
  const fresh = page({ marker: 'reloaded' });
  assert.equal(await settleCommittedSave(receiptBody(), { reload: async () => fresh, current: () => page(), notify: () => assert.fail() }), fresh);
  const warned = await settleCommittedSave(receiptBody({ agentId: 'a', agentExportWarning: '已保存，但未能导出 Markdown' }), { reload: async () => fresh, current: () => null, notify: () => assert.fail() });
  assert.equal(warned.marker, 'reloaded');
  assert.equal(warned.agentExportWarning, '已保存，但未能导出 Markdown');
});

test('if the reload fails too, the save is not reported as failed: current data stays, the user is told', async () => {
  const current = page({ marker: 'current' });
  const notes = [];
  const result = await settleCommittedSave(receiptBody(), { reload: async () => { throw new Error('offline'); }, current: () => current, notify: error => notes.push(error.message) });
  assert.equal(result, current);
  assert.deepEqual(notes, ['offline']);
  await assert.rejects(settleCommittedSave(receiptBody(), { reload: async () => { throw new Error('offline'); }, current: () => null, notify: () => {} }), /offline/, 'no page yet: surface the error');
});

// The real shared request layer (sharedApi.js, app.js's api() until P2c) with
// a stubbed fetch: every caller — project create/update/archive/team/default
// Agent, Agent create/update/channel test, autosaves — goes through it.
function loadApi({ uiState, responses, errors }) {
  const requests = [];
  const request = async (path, init) => {
    requests.push([path, init.method]);
    const next = responses.shift();
    return { ok: next.status < 400, json: async () => next.body };
  };
  const api = createSharedApi({ getBootstrap: () => uiState.bootstrap, showError: message => errors.push(message), request });
  return { api, requests };
}

test('shared api(): a committed save with bootstrapError re-fetches GET /api/bootstrap instead of applying the receipt', async () => {
  const errors = [];
  const { api, requests } = loadApi({ uiState: { bootstrap: page({ marker: 'before' }) }, errors, responses: [
    { status: 200, body: receiptBody() },
    { status: 200, body: page({ marker: 'after' }) },
  ] });
  const result = await api('/api/projects/update', { method: 'POST', body: { projectId: 'p', patch: { archived: true } } });
  assert.deepEqual(requests, [['/api/projects/update', 'POST'], ['/api/bootstrap', 'GET']]);
  assert.equal(result.marker, 'after');
  assert.ok(result.settings, 'callers apply a real bootstrap');
  assert.deepEqual(errors, []);
});

test('shared api(): when the reload fails as well the page keeps its data and says the save went through', async () => {
  const errors = [];
  const before = page({ marker: 'before' });
  const { api, requests } = loadApi({ uiState: { bootstrap: before }, errors, responses: [
    { status: 200, body: receiptBody() },
    { status: 500, body: { error: 'Failed to read config' } },
  ] });
  assert.equal(await api('/api/projects', { method: 'POST', body: { name: 'x' } }), before);
  assert.deepEqual(requests.map(([path]) => path), ['/api/projects', '/api/bootstrap']);
  assert.deepEqual(errors, ['已保存 · Failed to read config']);
});

test('shared api(): sends the page-data baseline and turns an error answer into an Error', async () => {
  const seen = [];
  const bootstrap = { ...page(), _snapshot: { token: 'snap-1' } };
  const api = createSharedApi({
    getBootstrap: () => bootstrap,
    showError: () => assert.fail('a plain error is thrown to the caller, not toasted here'),
    request: async (path, init) => { seen.push([path, init.method, init.headers['x-melo-bootstrap-base'], init.body]); return { ok: false, json: async () => ({ error: 'Nope' }) }; },
  });
  await assert.rejects(api('/api/projects/update', { method: 'POST', body: { projectId: 'p' } }), /Nope/);
  assert.deepEqual(seen, [['/api/projects/update', 'POST', 'snap-1', '{"projectId":"p"}']]);
});
