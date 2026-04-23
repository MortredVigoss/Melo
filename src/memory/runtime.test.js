import test from 'node:test';
import assert from 'node:assert/strict';
import {
  startMemoryRuntime,
  _resetMemoryRuntimeForTests,
  getMemoryRuntime,
} from './runtime.js';
import { _resetProviderForTests } from './providers/createProvider.js';
import { _resetEmbeddingProviderForTests } from './embedProviders/createEmbeddingProvider.js';

function resetAll() {
  _resetMemoryRuntimeForTests();
  _resetProviderForTests();
  _resetEmbeddingProviderForTests();
}

test('startMemoryRuntime resolves a provider and returns a handle', async () => {
  resetAll();
  delete process.env.MELO_MEMORY_RUNTIME;
  process.env.MELO_DREAMING_ENABLED = '0'; // don't actually arm timers
  process.env.MELO_MEMORY_PROVIDER = 'sqlite-vec';

  const handle = await startMemoryRuntime({ skipScheduler: true });
  assert.ok(handle, 'handle returned');
  assert.ok(handle.provider, 'provider resolved');
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
  assert.equal(handle.provider, null, 'provider not resolved');
  assert.equal(handle.embedder, null, 'embedder not resolved');
  assert.equal(handle.schedulerStarted, false);

  delete process.env.MELO_MEMORY_RUNTIME;
  handle.stop();
});

test('startMemoryRuntime tolerates provider init failure', async () => {
  resetAll();
  delete process.env.MELO_MEMORY_RUNTIME;
  process.env.MELO_DREAMING_ENABLED = '0';

  // Force an unknown provider name — should still boot, with provider=null.
  process.env.MELO_MEMORY_PROVIDER = 'this-does-not-exist';
  const logs = [];
  const handle = await startMemoryRuntime({
    log: (msg) => logs.push(msg),
    skipScheduler: true,
  });

  assert.ok(handle, 'handle returned');
  // The factory falls back to sqlite-vec on unknown primary, so provider
  // should still be non-null even with a bogus env var.  If it does fail,
  // we at least expect a log entry.
  if (!handle.provider) {
    assert.ok(
      logs.some(l => /provider init failed/.test(l)),
      'init failure logged',
    );
  }

  delete process.env.MELO_MEMORY_PROVIDER;
  handle.stop();
});

test('getMemoryRuntime returns null until started', () => {
  resetAll();
  assert.equal(getMemoryRuntime(), null);
});
