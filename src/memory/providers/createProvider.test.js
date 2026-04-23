import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createProvider,
  parseRouting,
  buildProviderFromEnv,
  _resetProviderForTests,
  RouterProvider,
  registerProvider,
} from './createProvider.js';
import { MemoryProvider } from './MemoryProvider.js';

test('createProvider returns sqlite-vec by default', async () => {
  const p = await createProvider('sqlite-vec');
  assert.ok(p);
  assert.equal(p.constructor.providerName, 'sqlite-vec');
});

test('createProvider throws on unknown name', async () => {
  await assert.rejects(() => createProvider('nope-provider'));
});

test('parseRouting handles mixed patterns', () => {
  const routes = parseRouting('chat:*=sqlite-vec;skill:*=chroma;fact=http-proxy');
  assert.equal(routes.length, 3);
  assert.deepEqual(routes[0], { prefix: 'chat:', provider: 'sqlite-vec' });
  assert.deepEqual(routes[1], { prefix: 'skill:', provider: 'chroma' });
  assert.deepEqual(routes[2], { prefix: 'fact', provider: 'http-proxy' });
});

test('parseRouting returns [] on empty input', () => {
  assert.deepEqual(parseRouting(''), []);
  assert.deepEqual(parseRouting(null), []);
});

// Mock provider for router test
class MockProvider extends MemoryProvider {
  static get providerName() { return 'mock'; }
  constructor(label, { reassess = [], updates = 0 } = {}) {
    super();
    this.label = label;
    this.calls = [];
    this._reassess = reassess;
    this._updates = updates;
  }
  async upsert(e) { this.calls.push(['upsert', e.id, this.label]); }
  async replaceAll(es) { this.calls.push(['replaceAll', es.length, this.label]); }
  async search(o) { this.calls.push(['search', o, this.label]); return []; }
  async searchTiered(o) { this.calls.push(['searchTiered', o, this.label]); return { scenes: [], frames: [], contents: [] }; }
  async stats() { return { label: this.label }; }
  async listForReassess() { this.calls.push(['listForReassess', this.label]); return this._reassess; }
  async setAtticLevels(u) { this.calls.push(['setAtticLevels', u.length, this.label]); return this._updates; }
  async recordHit(h) { this.calls.push(['recordHit', h?.memoryId, this.label]); return 1; }
}

test('RouterProvider shadow-writes to shadow provider on upsert', async () => {
  const primary = new MockProvider('primary');
  const shadow = new MockProvider('shadow');
  const router = new RouterProvider({ primary, shadow });
  await router.upsert({ id: 'x', namespace: 'chat:1' });
  assert.equal(primary.calls.length, 1);
  assert.equal(shadow.calls.length, 1);
});

test('RouterProvider routes by namespace prefix', async () => {
  const primary = new MockProvider('primary');
  const special = new MockProvider('special');
  const router = new RouterProvider({
    primary,
    routes: [{ prefix: 'skill:', provider: special }],
  });
  await router.upsert({ id: 'a', namespace: 'chat:1' });
  await router.upsert({ id: 'b', namespace: 'skill:matcher' });
  assert.equal(primary.calls.length, 1);
  assert.equal(special.calls.length, 1);
  assert.equal(primary.calls[0][1], 'a');
  assert.equal(special.calls[0][1], 'b');
});

test('buildProviderFromEnv honours MELO_MEMORY_PROVIDER', async () => {
  _resetProviderForTests();
  const saved = process.env.MELO_MEMORY_PROVIDER;
  process.env.MELO_MEMORY_PROVIDER = 'sqlite-vec';
  try {
    const p = await buildProviderFromEnv();
    assert.ok(p);
  } finally {
    if (saved == null) delete process.env.MELO_MEMORY_PROVIDER;
    else process.env.MELO_MEMORY_PROVIDER = saved;
    _resetProviderForTests();
  }
});

test('registerProvider lets tests inject a fake', async () => {
  registerProvider('mock-fake', () => new MockProvider('mf'));
  const p = await createProvider('mock-fake');
  assert.ok(p);
  assert.equal(p.label, 'mf');
});

// ─── P1-6 regression: dreaming ops fan out across all providers ────────────

test('RouterProvider.listForReassess unions across primary + shadow + routes', async () => {
  const primary = new MockProvider('primary', { reassess: [{ id: 'p1' }, { id: 'shared' }] });
  const shadow = new MockProvider('shadow', { reassess: [{ id: 's1' }, { id: 'shared' }] });
  const routeA = new MockProvider('routeA', { reassess: [{ id: 'ra1' }] });
  const router = new RouterProvider({
    primary,
    shadow,
    routes: [{ prefix: 'skill:', provider: routeA }],
  });
  const rows = await router.listForReassess({ limit: 10 });
  const ids = rows.map(r => r.id).sort();
  // shared is deduped; route goes first in source order, then primary, then shadow
  assert.deepEqual(ids, ['p1', 'ra1', 's1', 'shared']);
  // verify every source was consulted
  assert.ok(primary.calls.some(c => c[0] === 'listForReassess'));
  assert.ok(shadow.calls.some(c => c[0] === 'listForReassess'));
  assert.ok(routeA.calls.some(c => c[0] === 'listForReassess'));
});

test('RouterProvider.setAtticLevels broadcasts to every provider', async () => {
  const primary = new MockProvider('primary', { updates: 2 });
  const shadow = new MockProvider('shadow', { updates: 1 });
  const routeA = new MockProvider('routeA', { updates: 3 });
  const router = new RouterProvider({
    primary,
    shadow,
    routes: [{ prefix: 'skill:', provider: routeA }],
  });
  const updates = [{ id: 'a', attic: 'hot' }, { id: 'b', attic: 'cold' }];
  const n = await router.setAtticLevels(updates);
  assert.equal(n, 6, 'sum of per-provider changed-row counts');
  assert.deepEqual(primary.calls.at(-1), ['setAtticLevels', 2, 'primary']);
  assert.deepEqual(shadow.calls.at(-1), ['setAtticLevels', 2, 'shadow']);
  assert.deepEqual(routeA.calls.at(-1), ['setAtticLevels', 2, 'routeA']);
});

test('RouterProvider.listForReassess tolerates a source that throws', async () => {
  const primary = new MockProvider('primary', { reassess: [{ id: 'p1' }] });
  const shadow = new MockProvider('shadow');
  shadow.listForReassess = async () => { throw new Error('backend offline'); };
  const router = new RouterProvider({ primary, shadow });
  const rows = await router.listForReassess({});
  assert.deepEqual(rows.map(r => r.id), ['p1'], 'failing shadow must not take down reassess');
});

test('RouterProvider.recordHit routes to namespace-matching provider (no broadcast)', async () => {
  const primary = new MockProvider('primary');
  const shadow = new MockProvider('shadow');
  const routeA = new MockProvider('routeA');
  const router = new RouterProvider({
    primary,
    shadow,
    routes: [{ prefix: 'skill:', provider: routeA }],
  });
  await router.recordHit({ memoryId: 'm1', namespace: 'skill:foo' });
  // routeA should have received it; primary/shadow must not
  assert.equal(routeA.calls.filter(c => c[0] === 'recordHit').length, 1);
  assert.equal(primary.calls.filter(c => c[0] === 'recordHit').length, 0);
  assert.equal(shadow.calls.filter(c => c[0] === 'recordHit').length, 0);

  // Unrouted namespace falls back to primary only.
  await router.recordHit({ memoryId: 'm2', namespace: 'chat:1' });
  assert.equal(primary.calls.filter(c => c[0] === 'recordHit').length, 1);
  assert.equal(shadow.calls.filter(c => c[0] === 'recordHit').length, 0, 'shadow must never receive hit broadcasts');
});
