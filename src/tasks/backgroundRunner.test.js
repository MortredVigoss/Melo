import test from 'node:test';
import assert from 'node:assert/strict';
import { BackgroundRunner } from './backgroundRunner.js';

test('Kill actually stops the owned process and closes subscriptions', { timeout: 6000 }, async () => {
  const runner = new BackgroundRunner();
  let done;
  const completion = new Promise(resolve => { done = resolve; });
  const runId = runner.start({ command: 'exec sleep 60', onComplete: done });
  runner.kill(runId);
  const finished = await completion;
  assert.equal(finished.status, 'killed');
  assert.equal(finished._subscribers.length, 0);
  assert.equal(runner._processes.size, 0);
});

test('shutdown waits for all owned tasks; an already cancelled request does not spawn', { timeout: 6000 }, async () => {
  const runner = new BackgroundRunner();
  const one = runner.start({ command: 'exec sleep 60' });
  const two = runner.start({ command: 'exec sleep 60' });
  await runner.shutdown();
  assert.equal(runner.status(one).status, 'killed');
  assert.equal(runner.status(two).status, 'killed');
  const ac = new AbortController();
  ac.abort();
  const cancelled = runner.start({ command: 'exit 99', signal: ac.signal });
  assert.equal(runner.status(cancelled).status, 'killed');
  assert.equal(runner._processes.size, 0);
});

test('completed output is bounded and expires without removing active processes', async t => {
  let now = 1000;
  const runner = new BackgroundRunner({ now: () => now, retentionMs: 1000, maxFinished: 2 });
  t.after(() => runner.shutdown());
  const active = runner.start({ command: 'exec sleep 60' });
  for (let i = 0; i < 4; i++) await new Promise(resolve => runner.start({ command: 'printf done', onComplete: resolve }));
  assert.equal(runner.list().filter(r => r.endedAt != null).length, 2);
  now += 1001;
  assert.deepEqual(runner.list().map(r => r.id), [active]);
  assert.equal(runner.status(active).status, 'running');
  await runner.shutdown();
});
