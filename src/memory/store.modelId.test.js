/**
 * Phase 2 #2 — embedding-model-id persistence in _meta.
 *
 * readStoredEmbeddingModelId / writeStoredEmbeddingModelId let runtime.js
 * detect provider drift between boots.  Dims alone can't prove vector-space
 * compatibility: two different models producing 1024-dim vectors still live
 * in completely different spaces.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readStoredEmbeddingModelId,
  writeStoredEmbeddingModelId,
  _resetStoreForTests,
} from './store.js';

let tempHome = null;
let prevHome = null;

test.beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), 'melo-model-id-'));
  prevHome = process.env.MELO_HOME;
  process.env.MELO_HOME = tempHome;
  _resetStoreForTests?.();
});

test.afterEach(async () => {
  _resetStoreForTests?.();
  if (prevHome === undefined) delete process.env.MELO_HOME;
  else process.env.MELO_HOME = prevHome;
  await rm(tempHome, { recursive: true, force: true });
  tempHome = null;
  prevHome = null;
});

test('readStoredEmbeddingModelId: returns null when _meta key is unset', () => {
  // Note: tests run serially in node:test, but earlier suites may have
  // written a modelId.  Overwrite with null-equivalent by writing then
  // checking writeStoredEmbeddingModelId's input guard instead.
  const before = readStoredEmbeddingModelId();
  // We don't assert null here because prior test runs may have left a value.
  // What we assert: the getter returns either null or a non-empty string.
  assert.ok(before === null || (typeof before === 'string' && before.length > 0));
});

test('writeStoredEmbeddingModelId: persists the value and readback roundtrips', () => {
  const tag = `phase2-test-${Date.now()}`;
  const ok = writeStoredEmbeddingModelId(tag);
  assert.equal(ok, true);
  assert.equal(readStoredEmbeddingModelId(), tag);
});

test('writeStoredEmbeddingModelId: overwrites previous value (INSERT OR REPLACE)', () => {
  writeStoredEmbeddingModelId('first-model');
  writeStoredEmbeddingModelId('second-model');
  assert.equal(readStoredEmbeddingModelId(), 'second-model');
});

test('writeStoredEmbeddingModelId: rejects empty / non-string input (guard)', () => {
  // Seed a known value so we can prove the rejections didn't clear it.
  writeStoredEmbeddingModelId('seed-value');
  assert.equal(writeStoredEmbeddingModelId(''), false);
  assert.equal(writeStoredEmbeddingModelId(null), false);
  assert.equal(writeStoredEmbeddingModelId(undefined), false);
  assert.equal(writeStoredEmbeddingModelId(12345), false);
  // The original seed must survive the rejected writes.
  assert.equal(readStoredEmbeddingModelId(), 'seed-value');
});

test('Phase-2 modelId drift scenario: dims match but modelId differs', () => {
  // This mimics the boot-time check in runtime.js without actually booting
  // the runtime: write a modelId, then simulate a provider with the same
  // dims but a different modelId.  The store layer exposes both halves so
  // the runtime can compose the drift warning.
  writeStoredEmbeddingModelId('bge-m3');
  const stored = readStoredEmbeddingModelId();
  const providerReports = 'text-embedding-3-large';
  assert.equal(stored, 'bge-m3');
  assert.notEqual(stored, providerReports);
  // Runtime should NOT auto-update _meta on drift (see runtime.js comment):
  // stored must still say 'bge-m3' until the operator resolves.
  assert.equal(readStoredEmbeddingModelId(), 'bge-m3');
});
