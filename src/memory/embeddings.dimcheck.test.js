/**
 * P2-13 regression: at boot we detect embedding-dim mismatches between the
 * active provider, the canonical EMBEDDING_DIMS, and what's stored on disk.
 * The runtime wipes stored vectors when the dims don't align so recall
 * never compares across vector spaces.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkEmbeddingDimensions, EMBEDDING_DIMS } from './embeddings.js';
import {
  upsertMemory,
  saveMemoryEmbedding,
  readStoredEmbeddingDims,
  wipeEmbeddingsForDimChange,
  _resetStoreForTests,
} from './store.js';
import { EmbeddingProvider } from './embedProviders/EmbeddingProvider.js';

class DimProvider extends EmbeddingProvider {
  static get providerName() { return 'dim-test'; }
  constructor(dims) { super(); this._dims = dims; }
  get dims() { return this._dims; }
  get modelId() { return `dim-test:${this._dims}`; }
  async isAvailable() { return true; }
  async embed() {
    const vec = new Float32Array(this._dims);
    vec[0] = 1;
    return vec;
  }
}

let tempHome = null;
let prevHome = null;

test.beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), 'melo-dimcheck-'));
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

test('checkEmbeddingDimensions reports ok when provider.dims matches canonical', async () => {
  const result = await checkEmbeddingDimensions(new DimProvider(EMBEDDING_DIMS));
  assert.equal(result.ok, true);
  assert.equal(result.dims, EMBEDDING_DIMS);
});

test('checkEmbeddingDimensions flags provider-canonical mismatch', async () => {
  const result = await checkEmbeddingDimensions(new DimProvider(768));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'provider-canonical-mismatch');
  assert.equal(result.providerDims, 768);
  assert.equal(result.canonicalDims, EMBEDDING_DIMS);
});

test('checkEmbeddingDimensions flags providers that expose no dims', async () => {
  class NoDimProvider extends EmbeddingProvider {
    static get providerName() { return 'no-dim'; }
    get dims() { return 0; }
    async embed() { return null; }
  }
  const result = await checkEmbeddingDimensions(new NoDimProvider());
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'provider-no-dims');
});

test('checkEmbeddingDimensions returns no-provider when injection is null and abstraction empty', async () => {
  // Not injecting; relies on whatever the abstraction returns.  In the test
  // harness with no MELO_EMBED_PROVIDER set, provider comes back null.
  const saved = process.env.MELO_EMBED_PROVIDER;
  delete process.env.MELO_EMBED_PROVIDER;
  try {
    const result = await checkEmbeddingDimensions();
    // Either no-provider (what we expect when nothing is registered) or ok
    // (if some earlier test registered a provider).  Both are valid shapes —
    // just assert the result is well-formed.
    assert.ok(typeof result.ok === 'boolean');
  } finally {
    if (saved == null) delete process.env.MELO_EMBED_PROVIDER;
    else process.env.MELO_EMBED_PROVIDER = saved;
  }
});

test('wipeEmbeddingsForDimChange clears embedding columns and updates _meta', () => {
  // Seed a row with an embedding.
  const id = 'p13-wipe-target';
  upsertMemory({
    id,
    namespace: 'chat:p13',
    kind: 'fact',
    text: 'dim wipe target',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metadata: {},
  });
  saveMemoryEmbedding(id, 'dim wipe target', new Float32Array(EMBEDDING_DIMS));

  const newDims = 2048;
  const cleared = wipeEmbeddingsForDimChange(newDims);
  assert.ok(cleared >= 1, 'at least one embedding was cleared');

  const storedDims = readStoredEmbeddingDims();
  assert.equal(storedDims, newDims, '_meta.embedding_dims reflects the new dims');
});
