import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireTestLock, waitForLoad, lockHeldBy } from './test-run-guards.js';

function clock() {
  let now = 1_000_000;
  const waits = [];
  return { now: () => now, wait: async ms => { waits.push(ms); now += ms; }, waits };
}

test('the machine lock is taken, held against a live holder for the wait budget, and released by its owner only', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'melo-test-lock-'));
  const path = join(dir, 'runner.lock');
  try {
    const c = clock();
    const first = await acquireTestLock({ path, now: c.now, wait: c.wait, pid: 11, isAlive: () => true, label: 'first' });
    assert.equal(first.acquired, true); assert.equal(first.waitedMs, 0);
    assert.equal(lockHeldBy(path).pid, 11);
    const second = await acquireTestLock({ path, now: c.now, wait: c.wait, pid: 22, isAlive: () => true, waitMs: 12_000, pollMs: 5_000 });
    assert.equal(second.acquired, false, 'a live holder is not evicted');
    assert.equal(second.holder.pid, 11);
    assert.deepEqual(c.waits, [5_000, 5_000, 5_000], 'polls until the wait budget is spent, then gives up');
    assert.equal(second.waitedMs, 15_000);
    second.release();
    assert.equal(lockHeldBy(path).pid, 11, 'a non-owner release never removes the lock');
    first.release();
    assert.equal(lockHeldBy(path), null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a lock left by a dead process is stale and taken over without waiting', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'melo-test-lock-'));
  const path = join(dir, 'runner.lock');
  try {
    await writeFile(path, JSON.stringify({ pid: 999999, label: 'crashed run' }));
    const c = clock();
    const taken = await acquireTestLock({ path, now: c.now, wait: c.wait, pid: 33, isAlive: () => false });
    assert.equal(taken.acquired, true); assert.equal(taken.waitedMs, 0);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).pid, 33);
    await writeFile(path, 'not json');
    const garbage = await acquireTestLock({ path, now: c.now, wait: c.wait, pid: 44, isAlive: () => true });
    assert.equal(garbage.acquired, true, 'an unreadable lock file is stale');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('load gate waits while the machine is busy, proceeds when it calms down, and gives up loudly after the budget', async () => {
  const c = clock();
  const loads = [12, 9, 3];
  const messages = [];
  const calm = await waitForLoad({ max: 6, waitMs: 60_000, pollMs: 10_000, now: c.now, wait: c.wait, load: () => loads.shift(), emit: m => messages.push(m) });
  assert.deepEqual(calm.samples, [12, 9, 3]); assert.equal(calm.exceeded, false); assert.equal(calm.waitedMs, 20_000);
  assert.equal(messages.length, 2);
  const d = clock();
  const busy = await waitForLoad({ max: 6, waitMs: 20_000, pollMs: 10_000, now: d.now, wait: d.wait, load: () => 50, emit: m => messages.push(m) });
  assert.equal(busy.exceeded, true); assert.equal(busy.waitedMs, 20_000);
  assert.match(messages.at(-1), /仍高于/);
  const idle = await waitForLoad({ max: 6, now: d.now, wait: d.wait, load: () => 1 });
  assert.equal(idle.waitedMs, 0);
});
