import test from 'node:test';
import assert from 'node:assert/strict';
import {
  startMemoryRuntime,
  _resetMemoryRuntimeForTests,
  getMemoryRuntime,
} from './runtime.js';
import { _resetEmbeddingProviderForTests } from './embedProviders/createEmbeddingProvider.js';

function resetAll() {
  _resetMemoryRuntimeForTests();
  _resetEmbeddingProviderForTests();
}

test('startMemoryRuntime returns one handle with the embedder and a stop function', async () => {
  resetAll();
  delete process.env.MELO_MEMORY_RUNTIME;
  process.env.MELO_DREAMING_ENABLED = '0'; // don't actually arm timers

  const handle = await startMemoryRuntime({ skipScheduler: true });
  assert.ok(handle, 'handle returned');
  // 2026-11-14: the handle used to carry a `provider` that nothing read.
  assert.deepEqual(Object.keys(handle).sort(), ['embedder', 'schedulerStarted', 'stop']);
  assert.equal(typeof handle.stop, 'function');
  assert.equal(handle.schedulerStarted, false, 'scheduler skipped by option');

  // Idempotent — second call returns the same handle.
  const again = await startMemoryRuntime({ skipScheduler: true });
  assert.equal(again, handle, 'singleton reused');

  handle.stop();
});

test('startMemoryRuntime short-circuits when MELO_MEMORY_RUNTIME=0', async () => {
  resetAll();
  process.env.MELO_MEMORY_RUNTIME = '0';

  const handle = await startMemoryRuntime();
  assert.equal(handle.embedder, null, 'embedder not resolved');
  assert.equal(handle.schedulerStarted, false);

  delete process.env.MELO_MEMORY_RUNTIME;
  handle.stop();
});

test('startMemoryRuntime still returns a handle when the embedding model cannot be resolved', async () => {
  resetAll();
  delete process.env.MELO_MEMORY_RUNTIME;
  process.env.MELO_DREAMING_ENABLED = '0';

  // A provider name nothing registered: there is no embedder, and the runtime boots anyway.
  process.env.MELO_EMBED_PROVIDER = 'this-does-not-exist';
  const logs = [];
  try {
    const handle = await startMemoryRuntime({ log: msg => logs.push(msg), skipScheduler: true });
    assert.ok(handle, 'handle returned');
    assert.equal(handle.embedder, null);
    assert.equal(typeof handle.stop, 'function');
    handle.stop();
  } finally {
    delete process.env.MELO_EMBED_PROVIDER;
  }
});

test('getMemoryRuntime returns null until started', () => {
  resetAll();
  assert.equal(getMemoryRuntime(), null);
});
