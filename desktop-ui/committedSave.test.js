import test from 'node:test';
import assert from 'node:assert/strict';
import { committedWithoutBootstrap, committedSaveReceipt, settleCommittedSave } from './bootstrapPatch.js';
import { createSharedApi } from './sharedApi.js';

const receiptBody = (receipt = { projectId: 'p', revision: 3 }) => ({ ok: true, receipt, bootstrapError: { code: 'BOOTSTRAP_UNAVAILABLE', message: 'Failed to read config' } });
const page = (extra = {}) => ({ settings: { activeView: 'projects' }, projects: [{ id: 'p' }], stateRevision: 3, ...extra });
const tick = () => new Promise(resolve => setImmediate(resolve));

test('only a committed-save receipt is treated as missing page data', () => {
  assert.equal(committedWithoutBootstrap(receiptBody()), true);
  for (const payload of [page(), { ok: true }, { ok: false, bootstrapError: {} }, null]) assert.equal(committedWithoutBootstrap(payload), false);
});

test('normal responses pass through; recovered page data keeps command identity and export warnings outside transport', async () => {
  const fresh = page();
  assert.equal(await settleCommittedSave(fresh, { reload: () => assert.fail(), recover: () => assert.fail() }), fresh);
  const receipt = { agentId: 'a', revision: 3, agentExportWarning: '已保存，但未能导出 Markdown' };
  const result = await settleCommittedSave(receiptBody(receipt), { reload: async () => fresh, recover: () => assert.fail() });
  assert.equal(result.agentExportWarning, receipt.agentExportWarning);
  assert.equal(committedSaveReceipt(result), receipt);
  assert.equal(JSON.stringify(result).includes('agentId'), false, 'recovery metadata never becomes page data or a bootstrap baseline');
});

function harness(responses, bootstrap = page()) {
  const requests = [], changes = [];
  const api = createSharedApi({
    getBootstrap: () => bootstrap,
    onRecoveryChange: () => changes.push(api.pendingSaves()),
    request: async (path, init) => {
      requests.push([path, init.method, init.body]);
      const next = responses.shift();
      assert.ok(next, 'no unexpected request');
      if (next instanceof Error) throw next;
      return { ok: next.status < 400, json: async () => next.body };
    },
  });
  return { api, requests, changes, bootstrap };
}

test('committed save re-fetches GET /api/bootstrap; ordinary failures still reject and allow retrying POST', async () => {
  const fresh = page({ marker: 'after' });
  const h = harness([
    { status: 200, body: receiptBody() }, { status: 200, body: fresh },
    { status: 400, body: { error: 'Invalid name' } }, { status: 200, body: fresh },
  ]);
  const options = { method: 'POST', body: { name: 'x' } };
  assert.equal(await h.api('/api/projects', options), fresh);
  await assert.rejects(h.api('/api/projects', options), /Invalid name/);
  assert.equal(await h.api('/api/projects', options), fresh);
  assert.deepEqual(h.requests.map(([path, method]) => [path, method]), [
    ['/api/projects', 'POST'], ['/api/bootstrap', 'GET'], ['/api/projects', 'POST'], ['/api/projects', 'POST'],
  ]);
  assert.deepEqual(h.changes, []);
});

test('consecutive read failures keep the command pending and coalesce duplicate POSTs; recovery only reads', async () => {
  const responses = [{ status: 200, body: receiptBody() }, { status: 503, body: { error: 'offline' } }];
  const h = harness(responses);
  const before = structuredClone(h.bootstrap);
  const options = { method: 'POST', body: { name: 'x' } };
  const save = h.api('/api/projects', options);
  let finished = false;
  save.then(() => { finished = true; });
  await tick();
  assert.equal(finished, false, 'never resolve with the old bootstrap');
  assert.deepEqual(h.bootstrap, before);
  const [pending] = h.api.pendingSaves();
  assert.equal(pending.receipt.projectId, 'p');
  assert.equal(h.api('/api/projects', options), save, 'duplicate submit shares the same command');
  responses.push({ status: 503, body: { error: 'still offline' } });
  await h.api.retryCommittedSave(pending.id);
  assert.equal(finished, false);
  assert.equal(h.api.pendingSaves()[0].retrying, false);
  assert.equal(h.requests.length, 3, 'no automatic retry loop');
  const fresh = page({ marker: 'recovered' });
  responses.push({ status: 200, body: fresh });
  await Promise.all([h.api.retryCommittedSave(pending.id), h.api.retryCommittedSave(pending.id)]);
  assert.equal(await save, fresh);
  assert.deepEqual(h.api.pendingSaves(), []);
  assert.equal(h.requests.filter(([, method]) => method === 'POST').length, 1);
  assert.equal(h.requests.length, 4, 'double-clicking refresh starts one GET');
});

test('a stale or invalid 200 response cannot complete a committed save', async () => {
  const responses = [{ status: 200, body: receiptBody() }, { status: 200, body: page({ stateRevision: 2 }) }];
  const h = harness(responses);
  const save = h.api('/api/projects', { method: 'POST', body: { name: 'x' } });
  await tick();
  const id = h.api.pendingSaves()[0].id;
  responses.push({ status: 200, body: {} });
  await h.api.retryCommittedSave(id);
  assert.equal(h.api.pendingSaves().length, 1);
  responses.push({ status: 200, body: page({ stateRevision: 4 }) });
  await h.api.retryCommittedSave(id);
  assert.equal((await save).stateRevision, 4);
});

test('independent committed saves keep separate receipts and complete independently', async () => {
  const h = harness([
    { status: 200, body: receiptBody({ agentId: 'a', revision: 3 }) }, { status: 503, body: {} },
    { status: 200, body: receiptBody({ projectId: 'p', revision: 4 }) }, { status: 503, body: {} },
    { status: 200, body: page({ stateRevision: 4 }) }, { status: 200, body: page({ stateRevision: 4 }) },
  ]);
  const agent = h.api('/api/agents/create-custom', { method: 'POST', body: {} }); await tick();
  const project = h.api('/api/projects', { method: 'POST', body: { name: 'p' } }); await tick();
  const [a, p] = h.api.pendingSaves();
  await h.api.retryCommittedSave(p.id);
  assert.equal(committedSaveReceipt(await project).projectId, 'p');
  assert.deepEqual(h.api.pendingSaves().map(row => row.id), [a.id]);
  await h.api.retryCommittedSave(a.id);
  assert.equal(committedSaveReceipt(await agent).agentId, 'a');
});

test('shared api sends the request baseline and does not turn ordinary failures into committed recovery', async () => {
  const seen = [];
  const api = createSharedApi({
    getBootstrap: () => ({ ...page(), _snapshot: { token: 'snap-1' } }),
    onRecoveryChange: () => assert.fail(),
    request: async (path, init) => { seen.push([path, init.method, init.headers['x-melo-bootstrap-base'], init.body]); return { ok: false, json: async () => ({ error: 'Nope' }) }; },
  });
  await assert.rejects(api('/api/projects/update', { method: 'POST', body: { projectId: 'p' } }), /Nope/);
  assert.deepEqual(seen, [['/api/projects/update', 'POST', 'snap-1', '{"projectId":"p"}']]);
});
