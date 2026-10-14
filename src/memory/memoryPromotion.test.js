/**
 * Bug C — memoryPromotion must not retry a just-failed getEmbedding call.
 *
 * Before the fix:
 *   if (hasEmbeddings) {
 *     factEmbedding = await getEmbedding(...).catch(() => null);    // call 1
 *     if (factEmbedding && isSemanticDuplicate(...)) continue;
 *   }
 *   ...upsertMemory...
 *   const emb = factEmbedding ?? await getEmbedding(...).catch(() => null);  // call 2
 *
 * When the provider flapped — returning null on call 1 — the `??` operator
 * fired call 2 with identical odds of failure.  Worst case: every flapped
 * fact paid 2× latency + 2× quota instead of deferring to the background
 * fill-in job.
 *
 * These tests swap `getEmbedding` via the module's test hook and count
 * invocations to prove each scenario now calls it at most once per fact.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  promoteAndPersistFacts,
  scheduleEmbeddingFillIn,
  PROMOTED_KIND,
  _setGetEmbeddingForTests,
} from './memoryPromotion.js';
import {
  upsertMemory,
  saveMemoryEmbedding,
  recallMemories,
  getMemoriesWithoutEmbeddings,
  mergeMemoryInto,
  listMemoriesNeedingReembed,
  _resetStoreForTests,
} from './store.js';
import { EMBEDDING_DIMS } from './embeddings.js';

// ─── helpers ──────────────────────────────────────────────────────────────

function fakeVec(sig) {
  // A normalised-looking vector stamped with a signature in slot 0.  We
  // keep the Euclidean norm == 1 so cosineSimilarity returns the raw dot
  // product (which is what the promoter's isSemanticDuplicate uses).
  const v = new Float32Array(EMBEDDING_DIMS);
  v[0] = sig;
  // fill the rest with a tiny constant so the vector has a predictable,
  // unit-ish norm (good enough for our purposes — the dedup check only
  // needs the cosine to be either >0.88 or far below).
  const rest = Math.sqrt(Math.max(0, 1 - sig * sig) / (EMBEDDING_DIMS - 1));
  for (let i = 1; i < EMBEDDING_DIMS; i++) v[i] = rest;
  return v;
}

function chatWithFact(id, fact) {
  return {
    id: `chat-${id}`,
    title: `chat ${id}`,
    sessionMemory: [{ fact, category: 'test', extractedAt: new Date().toISOString() }],
  };
}

/**
 * Make a counting stub that returns whatever `impl(text)` returns.  Stores
 * both the call count and the order of texts so the test can assert both
 * "how many times" and "with what inputs".
 */
function makeCountingStub(impl) {
  const calls = [];
  const fn = async (text /* , config */) => {
    calls.push(text);
    return impl(text, calls.length);
  };
  fn.calls = calls;
  fn.callCount = () => calls.length;
  return fn;
}

let tempHome = null;
let prevHome = null;

test.beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), 'melo-promotion-'));
  prevHome = process.env.MELO_HOME;
  process.env.MELO_HOME = tempHome;
  _resetStoreForTests?.();
});

// Teardown resets the hook and temp store between tests so a misbehaving test
// can't leak its stub or promoted rows into a neighbour.
test.afterEach(async () => {
  _setGetEmbeddingForTests(null);
  _resetStoreForTests?.();
  if (prevHome === undefined) delete process.env.MELO_HOME;
  else process.env.MELO_HOME = prevHome;
  if (tempHome) {
    await rm(tempHome, { recursive: true, force: true });
  }
  tempHome = null;
  prevHome = null;
});

// ─── scenarios ────────────────────────────────────────────────────────────

test('promote: no prior embeddings → getEmbedding called ONCE per fact (post-upsert branch only)', async () => {
  const agentId = `bugC-none-${Date.now()}`;
  // No prior facts → hasEmbeddings=false → the semantic-dedup branch is
  // skipped entirely.  Only the post-upsert "attach an embedding" branch
  // calls getEmbedding.
  const stub = makeCountingStub(() => fakeVec(0.1));
  _setGetEmbeddingForTests(stub);

  const n = await promoteAndPersistFacts(
    chatWithFact('none', 'bugC no-prior fact alpha'),
    agentId,
    {},
  );
  assert.equal(n, 1, 'one fact promoted');
  assert.equal(stub.callCount(), 1, 'getEmbedding called exactly once');
});

test('promote: similar vectors cannot silently delete a distinct fact from another chat', async () => {
  const agentId = `bugC-hit-${Date.now()}`;
  const ns = `agent:${agentId}`;

  // Seed one prior promoted fact WITH an embedding so hasEmbeddings=true.
  const seedId = `seed-${agentId}`;
  const seedText = 'bugC seed fact';
  upsertMemory({
    id: seedId,
    namespace: ns,
    kind: PROMOTED_KIND,
    text: seedText,
    searchText: seedText,
  });
  // sig=0.9 — when we ask for an embedding during the test we also return
  // sig=0.9, so cosineSimilarity ≈ 1 > DEDUP_THRESHOLD (0.88) and the
  // fact is treated as a duplicate.
  saveMemoryEmbedding(seedId, seedText, fakeVec(0.9));

  const stub = makeCountingStub(() => fakeVec(0.9));
  _setGetEmbeddingForTests(stub);

  const n = await promoteAndPersistFacts(
    chatWithFact('hit', 'totally unrelated surface text so text-dedup misses'),
    agentId,
    {},
  );
  assert.equal(n, 1, 'distinct facts survive even when vectors coincide');
  assert.equal(stub.callCount(), 1, 'getEmbedding called once for semantic check, not retried');
});

test('promote: prior embeddings present + semantic MISS → getEmbedding called ONCE (reused post-upsert)', async () => {
  const agentId = `bugC-miss-${Date.now()}`;
  const ns = `agent:${agentId}`;

  const seedId = `seed-miss-${agentId}`;
  upsertMemory({
    id: seedId,
    namespace: ns,
    kind: PROMOTED_KIND,
    text: 'bugC seed fact for miss',
    searchText: 'bugC seed fact for miss',
  });
  saveMemoryEmbedding(seedId, 'bugC seed fact for miss', fakeVec(0.9));

  // Candidate embedding far from the seed → no semantic dup → fact should
  // be written and its embedding reused on the post-upsert branch.
  const stub = makeCountingStub(() => fakeVec(0.05));
  _setGetEmbeddingForTests(stub);

  const n = await promoteAndPersistFacts(
    chatWithFact('miss', 'bugC candidate totally different topic'),
    agentId,
    {},
  );
  assert.equal(n, 1, 'fact promoted');
  assert.equal(
    stub.callCount(),
    1,
    'getEmbedding called once — post-upsert branch must reuse the dedup-branch result',
  );
});

test('promote: prior embeddings present + FIRST call returns null (provider flap) → NO retry (Bug C regression)', async () => {
  const agentId = `bugC-flap-${Date.now()}`;
  const ns = `agent:${agentId}`;

  const seedId = `seed-flap-${agentId}`;
  upsertMemory({
    id: seedId,
    namespace: ns,
    kind: PROMOTED_KIND,
    text: 'bugC seed flap',
    searchText: 'bugC seed flap',
  });
  saveMemoryEmbedding(seedId, 'bugC seed flap', fakeVec(0.9));

  // Simulate provider flap: ALWAYS return null.  Before the fix this would
  // be called 2× per fact; after the fix it is called exactly 1×.
  const stub = makeCountingStub(() => null);
  _setGetEmbeddingForTests(stub);

  const factText = 'bugC flap candidate text';
  const n = await promoteAndPersistFacts(chatWithFact('flap', factText), agentId, {});
  assert.equal(n, 1, 'fact promoted even though embedding failed');
  assert.equal(stub.callCount(), 1, 'getEmbedding must NOT be retried after a null return');

  // And the fact should show up in the "no embedding yet" queue so the
  // background fill-in job can pick it up later.
  const pending = getMemoriesWithoutEmbeddings().map(r => r.searchText);
  assert.ok(
    pending.some(t => t.includes('bugc flap candidate')),
    'flapped fact is queued for background embed fill-in',
  );
});

test('promote: multiple facts + flap → ONE call per fact (no 2× multiplier)', async () => {
  const agentId = `bugC-multi-${Date.now()}`;
  const ns = `agent:${agentId}`;
  const seedId = `seed-multi-${agentId}`;
  upsertMemory({
    id: seedId,
    namespace: ns,
    kind: PROMOTED_KIND,
    text: 'multi seed',
    searchText: 'multi seed',
  });
  saveMemoryEmbedding(seedId, 'multi seed', fakeVec(0.9));

  const stub = makeCountingStub(() => null);
  _setGetEmbeddingForTests(stub);

  const chat = {
    id: 'chat-multi',
    title: 'multi',
    sessionMemory: [
      { fact: 'multi fact one unique-alpha' },
      { fact: 'multi fact two unique-beta' },
      { fact: 'multi fact three unique-gamma' },
    ],
  };
  const n = await promoteAndPersistFacts(chat, agentId, {});
  assert.equal(n, 3, 'all three promoted');
  assert.equal(
    stub.callCount(),
    3,
    'exactly one call per fact; without the fix this would be 6',
  );
});

// ─── fill-in job ──────────────────────────────────────────────────────────

test('scheduleEmbeddingFillIn: consumes the DI hook and persists returned embeddings', async () => {
  const agentId = `bugC-fill-${Date.now()}`;
  const ns = `agent:${agentId}`;
  const targetId = `fill-target-${agentId}`;
  const targetText = `bugC fill target ${Date.now()}`;
  upsertMemory({
    id: targetId,
    namespace: ns,
    kind: PROMOTED_KIND,
    text: targetText,
    searchText: targetText,
  });

  const stub = makeCountingStub(() => fakeVec(0.3));
  _setGetEmbeddingForTests(stub);

  await scheduleEmbeddingFillIn({});

  // Stub was called at least once for our target (could be more for other
  // leftover rows from earlier tests — we only care that our row is gone
  // from the pending queue).
  assert.ok(stub.callCount() >= 1, 'fill-in invoked getEmbedding');
  const stillPending = getMemoriesWithoutEmbeddings().some(r => r.id === targetId);
  assert.equal(stillPending, false, 'target no longer lacks an embedding');

  // And the memory row itself now carries the embedding.  We must opt into
  // includeEmbedding — default recalls (by design) skip the BLOB.
  const rows = recallMemories({
    namespaces: [ns],
    kinds: [PROMOTED_KIND],
    limit: 10,
    includeEmbedding: true,
  });
  const target = rows.find(r => r.id === targetId);
  assert.ok(target, 'target row is readable');
  assert.ok(target.embedding, 'target row has an embedding blob');
});

test('scheduleEmbeddingFillIn: refreshes merge survivors flagged needsReembed', async () => {
  const agentId = `bugC-reembed-${Date.now()}`;
  const ns = `agent:${agentId}`;
  const src = `reembed-src-${agentId}`;
  const tgt = `reembed-tgt-${agentId}`;
  upsertMemory({
    id: src,
    namespace: ns,
    kind: PROMOTED_KIND,
    text: 'source duplicate fact',
    searchText: 'source duplicate fact',
  });
  upsertMemory({
    id: tgt,
    namespace: ns,
    kind: PROMOTED_KIND,
    text: 'target canonical fact',
    searchText: 'target canonical fact',
  });

  mergeMemoryInto({ sourceId: src, targetId: tgt });
  assert.ok(
    listMemoriesNeedingReembed({ limit: 50 }).some(row => row.id === tgt),
    'merged survivor is queued for re-embedding',
  );

  const stub = makeCountingStub(() => fakeVec(0.42));
  _setGetEmbeddingForTests(stub);
  await scheduleEmbeddingFillIn({});

  assert.equal(
    listMemoriesNeedingReembed({ limit: 50 }).some(row => row.id === tgt),
    false,
    'successful fill-in clears needsReembed',
  );
});

test('promoted facts remain scoped to the source chat without deleting history at an agent cap', async () => {
  const agentId = `bugC-cap-${Date.now()}`;
  const chat = {
    id: 'chat-cap',
    title: 'cap',
    sessionMemory: Array.from({ length: 205 }, (_, index) => ({
      fact: `cap fact ${index.toString().padStart(3, '0')}`,
      category: 'cap-test',
      extractedAt: new Date(Date.now() + index).toISOString(),
    })),
  };

  const stub = makeCountingStub(() => null);
  _setGetEmbeddingForTests(stub);

  const promoted = await promoteAndPersistFacts(chat, agentId, {});
  assert.equal(promoted, 205);

  const rows = recallMemories({
    namespaces: ['chat:chat-cap'],
    kinds: [PROMOTED_KIND],
    limit: 300,
    sideEffects: false,
  });
  assert.equal(rows.length, 205, 'canonical records and tombstones survive checkpoint windows');
});
