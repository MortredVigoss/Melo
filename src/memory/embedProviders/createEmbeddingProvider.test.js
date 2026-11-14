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

test('the provider is bound to the model directory of the request that asked for it', async t => {
  const { runWithRequestContext } = await import('../../runtime/requestScope.js');
  const { createRequestContext } = await import('../../runtime/requestContext.js');
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  _resetEmbeddingProviderForTests(); t.after(_resetEmbeddingProviderForTests);
  const modelDir = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'melo-embed-model-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    await mkdir(join(dir, 'onnx'));
    for (const file of ['melo-manifest.json', 'tokenizer.json', 'onnx/model_quantized.onnx']) await writeFile(join(dir, file), '');
    return dir;
  };
  const inRequest = (dir, callback) => runWithRequestContext(createRequestContext({ env: { MELO_EMBED_PROVIDER: '', MELO_EMBED_MODEL_DIR: dir } }), callback);
  const [dirA, dirB] = [await modelDir(), await modelDir()];
  const a = await inRequest(dirA, getEmbeddingProvider);
  const b = await inRequest(dirB, getEmbeddingProvider);
  assert.equal(a.modelDir, dirA);
  assert.equal(b.modelDir, dirB);
  assert.notEqual(a, b);
  assert.equal(await inRequest(dirB, getEmbeddingProvider), b, 'the same request environment reuses the instance');
  // A directory without the model: no provider, and nothing else is tried in its place.
  const empty = await mkdtemp(join(tmpdir(), 'melo-embed-empty-'));
  t.after(() => rm(empty, { recursive: true, force: true }));
  assert.equal(await inRequest(empty, getEmbeddingProvider), null);
});
