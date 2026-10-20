import test from 'node:test';
import assert from 'node:assert/strict';
import { capacityChats, distribution } from './capacity-fixture.js';

test('capacity fixtures retain deterministic distinct identities and bounded synthetic content', () => {
  const chats = capacityChats(4, 12, 100);
  assert.deepEqual(chats, capacityChats(4, 12, 100));
  assert.equal(new Set(chats.flatMap(chat => chat.messages.map(row => row.id))).size, 48);
  assert.equal(chats[3].messages[11].content, 'CAPACITY_HIT_3_11 ' + 'Synthetic local history. '.repeat(5).slice(0, 100));
  assert.ok(chats[3].messages[11].attachments[0].path.startsWith('/synthetic/'));
  assert.ok(chats[0].messages.every(row => !row.attachments));
});
test('nearest-rank distributions keep raw samples and reject empty or invalid measurements', () => {
  const samples = Array.from({ length: 20 }, (_, i) => 20 - i);
  const stats = distribution(samples);
  assert.equal(stats.p50, 10); assert.equal(stats.p95, 19); assert.deepEqual(stats.samples, samples);
  assert.throws(() => distribution([])); assert.throws(() => distribution([NaN]));
});

// Exercise the real isolated CLI, storage, fresh children and UI delta decoder.
test('capacity CLI measures production paths and preserves navigation with a deferred index', async () => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const root = await mkdtemp(join(tmpdir(), 'capacity-report-test-'));
  try {
    const output = join(root, 'report.json');
    await promisify(execFile)(process.execPath, ['scripts/bench-capacity.js', '--sizes', '3', '--messages', '12', '--chars', '100', '--cold-samples', '2', '--rounds', '3', '--out', output], { timeout: 60000, maxBuffer: 1024 * 1024 });
    const report = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(report.complete, true);
    assert.equal(report.fixture.network, 'not measured');
    assert.equal(report.sizes[0].cold.buildMs.n, 2);
    assert.equal(report.sizes[0].warm.buildMs.n, 3);
    assert.equal(report.sizes[0].localPreparationMs.n, 3);
    assert.ok(report.sizes[0].storage.deferredRevisions.length > 0);
    assert.ok(report.sizes[0].warm.wireBytes.min < report.sizes[0].warm.fullBytes.min);
    assert.deepEqual(report.sizes[0].semantics, ['current-chat', 'original-text', 'search-conversation-id', 'history-selection', 'delta-round-trip']);
  } finally { await rm(root, { recursive: true, force: true }); }
});
