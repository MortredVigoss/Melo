import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryApi } from './api.js';
import { installMemoryFeature } from './index.js';

// Behaviour versions of the former app.js source guards (memoryPane.source.test.js).
const context = (overrides = {}) => ({
  api: async () => ({}), render() {}, bgRender() {}, showError() {}, activeProject: () => null,
  escapeHtml: value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
  ...overrides,
});

test('Memory pane wipe action sends an object body through the api helper', async () => {
  const calls = [];
  await createMemoryApi(async (path, options) => { calls.push([path, options]); return { cleared: 0, dims: 0 }; }).wipeEmbeddings();
  assert.deepEqual(calls, [['/api/memory/wipe-embeddings', { method: 'POST', body: { confirm: 'YES, WIPE EMBEDDINGS' } }]]);
  assert.equal(typeof calls[0][1].body, 'object', 'api() serialises the body itself; never pre-stringify it');
});

test('Memory pane labels unavailable live provider as unavailable, not uninitialised', () => {
  const feature = installMemoryFeature(context());
  Object.assign(feature.getState().memoryStatus, {
    loaded: true,
    snapshot: {
      counts: { memories: 3, memoriesFts: 3 },
      embedding: { provider: 'local', dimsConfigured: 384, storedModelId: 'm', drift: { probeAttempted: true } },
      store: { path: '/tmp/x', exists: true, sizeBytes: 2048 },
      tuning: { mmrLambda: 0.7, recencyHalfLifeDays: 30 },
      dreams: { dir: '/tmp/d', count: 0, latest: null },
      meta: null,
    },
  });
  const html = feature.renderPane();
  assert.match(html, /\(provider unavailable\)/);
  assert.doesNotMatch(html, /\(provider not initialised\)/);
  assert.match(html, /data-action="memory-wipe-open"/);
});
