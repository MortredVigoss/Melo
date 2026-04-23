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
