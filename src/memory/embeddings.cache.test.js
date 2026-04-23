/**
 * P2-11 regression: the embedding LRU cache must segregate entries by
 * modelId so switching MELO_EMBED_PROVIDER mid-session never returns a
 * Float32Array from the previous provider's vector space.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { getEmbedding, EMBEDDING_DIMS, _resetEmbeddingCacheForTests } from './embeddings.js';
import {
  registerEmbeddingProvider,
  _resetEmbeddingProviderForTests,
} from './embedProviders/createEmbeddingProvider.js';
import { EmbeddingProvider } from './embedProviders/EmbeddingProvider.js';

class MarkedProvider extends EmbeddingProvider {
  static get providerName() { return 'marked'; }
  constructor({ label, markValue }) {
    super();
    this.label = label;
    this.markValue = markValue;
    this.embedCalls = [];
  }
  get dims() { return EMBEDDING_DIMS; }
  get modelId() { return `marked:${this.label}`; }
  async isAvailable() { return true; }
  async embed(text) {
    this.embedCalls.push(text);
    const vec = new Float32Array(EMBEDDING_DIMS);
    // Encode the provider identity as a distinctive signal so the test can
    // tell which provider's vector the cache returned.
    vec[0] = this.markValue;
    return vec;
  }
}

test('cache keys include modelId so a provider swap forces a re-embed', async () => {
  _resetEmbeddingCacheForTests();
  _resetEmbeddingProviderForTests();
  const saved = process.env.MELO_EMBED_PROVIDER;

  const providerA = new MarkedProvider({ label: 'A', markValue: 0.25 });
  const providerB = new MarkedProvider({ label: 'B', markValue: 0.75 });
  registerEmbeddingProvider('p11-a', () => providerA);
  registerEmbeddingProvider('p11-b', () => providerB);

  try {
    process.env.MELO_EMBED_PROVIDER = 'p11-a';
    const vA1 = await getEmbedding('shared text');
    assert.equal(vA1[0], 0.25, 'provider A produced its marker');
    assert.equal(providerA.embedCalls.length, 1);

    // Hit the cache under provider A.
    const vA2 = await getEmbedding('shared text');
    assert.equal(vA2[0], 0.25);
    assert.equal(providerA.embedCalls.length, 1, 'second call served from cache');

    // Swap the provider.  If the cache were text-only this would return A's
    // vector — the bug P2-11 fixes.
    _resetEmbeddingProviderForTests();
    process.env.MELO_EMBED_PROVIDER = 'p11-b';
    const vB1 = await getEmbedding('shared text');
    assert.equal(vB1[0], 0.75, 'provider B produced its own vector — cache was NOT polluted by A');
    assert.equal(providerB.embedCalls.length, 1, 'provider B was actually invoked');

    // Switching back to A should re-use A's cached entry (its model-keyed
    // slot was never touched).
    _resetEmbeddingProviderForTests();
    process.env.MELO_EMBED_PROVIDER = 'p11-a';
    const vA3 = await getEmbedding('shared text');
    assert.equal(vA3[0], 0.25);
    assert.equal(providerA.embedCalls.length, 1, 'A still served from its own cache slot');
  } finally {
    if (saved == null) delete process.env.MELO_EMBED_PROVIDER;
    else process.env.MELO_EMBED_PROVIDER = saved;
    _resetEmbeddingProviderForTests();
    _resetEmbeddingCacheForTests();
  }
});

test('providers with the same modelId share the cache (correct behaviour)', async () => {
  _resetEmbeddingCacheForTests();
  _resetEmbeddingProviderForTests();
  const saved = process.env.MELO_EMBED_PROVIDER;

  class FixedId extends MarkedProvider {
    get modelId() { return 'fixed-id'; }
  }
  // Use 0.25 / 0.75 — both are exactly representable in Float32 so the
  // test asserts bit-for-bit equality without FP32-round-trip slop.
  const p1 = new FixedId({ label: 'A', markValue: 0.25 });
  const p2 = new FixedId({ label: 'B', markValue: 0.75 });
  registerEmbeddingProvider('p11-fixed-1', () => p1);
  registerEmbeddingProvider('p11-fixed-2', () => p2);

  try {
    process.env.MELO_EMBED_PROVIDER = 'p11-fixed-1';
    const v1 = await getEmbedding('same model text');
    assert.equal(v1[0], 0.25);

    _resetEmbeddingProviderForTests();
    process.env.MELO_EMBED_PROVIDER = 'p11-fixed-2';
    const v2 = await getEmbedding('same model text');
    // Because both providers advertise modelId=fixed-id, the cache was
    // allowed to return p1's cached vector (v1).  p2.embed was never
    // called — this is correct: the caller told us the vector space is
    // the same.
    assert.equal(v2[0], 0.25, 'same modelId → shared cache slot');
    assert.equal(p2.embedCalls.length, 0);
  } finally {
    if (saved == null) delete process.env.MELO_EMBED_PROVIDER;
    else process.env.MELO_EMBED_PROVIDER = saved;
    _resetEmbeddingProviderForTests();
    _resetEmbeddingCacheForTests();
  }
});
