import test from 'node:test';
import assert from 'node:assert/strict';
import { scheduleChatTurn } from './turnScheduler.js';

const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};

test('same-chat execution stays ordered while another chat runs concurrently', async () => {
  const gate = deferred();
  const started = deferred();
  const events = [];
  const first = scheduleChatTurn({ home: '/tmp/scheduler-a', chatId: 'a' }, async () => {
    events.push('first'); started.resolve(); await gate.promise; events.push('settled');
  });
  await started.promise;
  const second = scheduleChatTurn({ home: '/tmp/scheduler-a', chatId: 'a' }, () => events.push('second'));
  await scheduleChatTurn({ home: '/tmp/scheduler-a', chatId: 'b' }, () => events.push('other'));
  assert.deepEqual(events, ['first', 'other']);
  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['first', 'other', 'settled', 'second']);
});

test('cancelled running turn retains ownership until work settles; cancelled queued turn never executes', async () => {
  const gate = deferred();
  const started = deferred();
  const abort = new AbortController();
  const queuedAbort = new AbortController();
  let nextRan = false;
  const running = scheduleChatTurn({ home: '/tmp/scheduler-b', chatId: 'a', signal: abort.signal }, async () => {
    started.resolve(); await gate.promise;
  });
  await started.promise;
  const cancelled = scheduleChatTurn({ home: '/tmp/scheduler-b', chatId: 'a', signal: queuedAbort.signal }, () => assert.fail('cancelled turn ran'));
  const next = scheduleChatTurn({ home: '/tmp/scheduler-b', chatId: 'a' }, () => { nextRan = true; });
  const rejected = assert.rejects(running, { name: 'AbortError' });
  abort.abort();
  const queuedRejected = assert.rejects(cancelled, { name: 'AbortError' });
  queuedAbort.abort();
  await Promise.all([rejected, queuedRejected]);
  assert.equal(nextRan, false);
  gate.resolve();
  await next;
  assert.equal(nextRan, true);
});
