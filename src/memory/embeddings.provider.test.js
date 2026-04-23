/**
 * P2-8 regression: getEmbedding delegates to the embedProviders abstraction
 * instead of going straight to Ollama.  Previously MELO_EMBED_PROVIDER=openai
 * would not affect this code path at all.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { getEmbedding, isEmbeddingAvailable, EMBEDDING_DIMS } from './embeddings.js';
import {
  registerEmbeddingProvider,
  _resetEmbeddingProviderForTests,
} from './embedProviders/createEmbeddingProvider.js';
import { EmbeddingProvider } from './embedProviders/EmbeddingProvider.js';

class FakeEmbedProvider extends EmbeddingProvider {
  static get providerName() { return 'fake'; }
  constructor({ available = true, label = 'fake' } = {}) {
    super();
    this._available = available;
    this.label = label;
    this.embedCalls = [];
  }
  get dims() { return EMBEDDING_DIMS; }
  get modelId() { return `fake:${this.label}`; }
  async isAvailable() { return this._available; }
  async embed(text) {
    this.embedCalls.push(text);
    // Return a deterministic unit vector that encodes the label (not text
    // identity, but good enough to prove the path).
    const vec = new Float32Array(EMBEDDING_DIMS);
    vec[0] = 1;
    return vec;
  }
}

test('getEmbedding routes through embedProviders when MELO_EMBED_PROVIDER is set', async () => {
  _resetEmbeddingProviderForTests();
  const savedProvider = process.env.MELO_EMBED_PROVIDER;
  process.env.MELO_EMBED_PROVIDER = 'p8-fake-primary';

  const fake = new FakeEmbedProvider({ label: 'primary' });
  registerEmbeddingProvider('p8-fake-primary', () => fake);

  try {
    const v = await getEmbedding('hello world');
    assert.ok(v, 'embedding returned');
    assert.equal(v.length, EMBEDDING_DIMS, 'canonical dims');
    assert.equal(v[0], 1, 'fake embedding reached the caller');
    assert.equal(fake.embedCalls.length, 1, 'abstraction provider was called');
    assert.equal(fake.embedCalls[0], 'hello world');
  } finally {
    if (savedProvider == null) delete process.env.MELO_EMBED_PROVIDER;
    else process.env.MELO_EMBED_PROVIDER = savedProvider;
    _resetEmbeddingProviderForTests();
  }
});

test('isEmbeddingAvailable reports true when the abstraction has a usable provider', async () => {
  _resetEmbeddingProviderForTests();
  const saved = process.env.MELO_EMBED_PROVIDER;
  process.env.MELO_EMBED_PROVIDER = 'p8-fake-yes';
  registerEmbeddingProvider('p8-fake-yes', () => new FakeEmbedProvider({ available: true, label: 'yes' }));
  try {
    assert.equal(await isEmbeddingAvailable(), true);
  } finally {
    if (saved == null) delete process.env.MELO_EMBED_PROVIDER;
    else process.env.MELO_EMBED_PROVIDER = saved;
    _resetEmbeddingProviderForTests();
  }
});
