import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getEmbeddingProvider,
  registerEmbeddingProvider,
  withEmbeddingCache,
  _resetEmbeddingProviderForTests,
} from './createEmbeddingProvider.js';
import { EmbeddingProvider, l2Normalize, toDims } from './EmbeddingProvider.js';

class FakeProvider extends EmbeddingProvider {
  static get providerName() { return 'fake'; }
  constructor({ available = true, dims = 4 } = {}) {
    super();
    this._dims = dims;
    this._available = available;
    this.calls = 0;
  }
  get dims() { return this._dims; }
  async isAvailable() { return this._available; }
  async embed(text) {
    this.calls += 1;
    if (!this._available) return null;
    const v = new Float32Array(this._dims);
    v[0] = text.length;
    return l2Normalize(v);
  }
}

test('toDims pads/trims to target dims and L2-normalizes', () => {
  const short = new Float32Array([1, 0]);
  const out = toDims(short, 4);
  assert.equal(out.length, 4);
  const sumSq = Array.from(out).reduce((s, x) => s + x * x, 0);
  assert.ok(Math.abs(sumSq - 1) < 1e-6);
});

test('withEmbeddingCache memoizes by text', async () => {
  const fake = new FakeProvider();
  const wrapped = withEmbeddingCache(fake);
  await wrapped.embed('hello');
  await wrapped.embed('hello');
  await wrapped.embed('world');
  assert.equal(fake.calls, 2);
});

test('getEmbeddingProvider picks the first available backend', async () => {
  _resetEmbeddingProviderForTests();
  const saved = process.env.MELO_EMBED_PROVIDER;
  process.env.MELO_EMBED_PROVIDER = 'zzz-fake';
  registerEmbeddingProvider('zzz-fake', () => new FakeProvider({ available: true }));
  try {
    const p = await getEmbeddingProvider();
    assert.ok(p);
    const vec = await p.embed('abc');
    assert.ok(vec);
    assert.equal(vec.length, 4);
  } finally {
    if (saved == null) delete process.env.MELO_EMBED_PROVIDER;
    else process.env.MELO_EMBED_PROVIDER = saved;
    _resetEmbeddingProviderForTests();
  }
});

test('getEmbeddingProvider returns null when nothing available', async () => {
  _resetEmbeddingProviderForTests();
  const saved = process.env.MELO_EMBED_PROVIDER;
  process.env.MELO_EMBED_PROVIDER = 'zzz-unavailable';
  registerEmbeddingProvider('zzz-unavailable', () => new FakeProvider({ available: false }));
  try {
    const p = await getEmbeddingProvider();
    assert.equal(p, null);
  } finally {
    if (saved == null) delete process.env.MELO_EMBED_PROVIDER;
    else process.env.MELO_EMBED_PROVIDER = saved;
    _resetEmbeddingProviderForTests();
  }
});

test('EmbeddingProvider abstract methods throw by default', () => {
  const ep = new EmbeddingProvider();
  assert.throws(() => ep.dims);
  assert.rejects(() => ep.embed('x'));
});

test('adapter factory binds each endpoint and credentials to the current request snapshot', async t => {
  const { runWithRequestContext } = await import('../../runtime/requestScope.js');
  const { createRequestContext } = await import('../../runtime/requestContext.js');
  const { OllamaEmbedProvider } = await import('./OllamaEmbedProvider.js');
  _resetEmbeddingProviderForTests(); t.after(_resetEmbeddingProviderForTests);
  const inHome = (url, token, callback) => runWithRequestContext(createRequestContext({
    env: { MELO_EMBED_PROVIDER: 'http', MELO_EMBED_HTTP_URL: url, MELO_EMBED_HTTP_TOKEN: token, MELO_EMBED_DIMS: '4' },
    config: { behavior: { offlineMemory: false } }
  }), callback);
  const a = await inHome('https://a.example/embed', 'token-a', getEmbeddingProvider);
  const b = await inHome('https://b.example/embed', 'token-b', getEmbeddingProvider);
  assert.equal(a.url, 'https://a.example/embed'); assert.equal(a.token, 'token-a');
  assert.equal(b.url, 'https://b.example/embed'); assert.equal(b.token, 'token-b');
  assert.notEqual(a,b);
  const env = { MELO_OLLAMA_URL: 'http://127.0.0.1:23456', MELO_OLLAMA_EMBED_MODEL: 'local-test' };
  const local = new OllamaEmbedProvider({env}); env.MELO_OLLAMA_URL = 'http://127.0.0.1:33333';
  assert.equal(local.baseUrl, 'http://127.0.0.1:23456'); assert.equal(local.modelId, 'local-test');
});
