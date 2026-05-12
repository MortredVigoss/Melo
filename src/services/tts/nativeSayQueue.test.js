/**
 * src/services/tts/nativeSayQueue.test.js
 *
 * Pure state-machine tests for the say queue (Bug 1 fix 2026-05-12).
 * spawn is injected as a fake that records args + lets us trigger
 * 'exit' on demand, so tests verify ORDER + KILL semantics without
 * actually running /usr/bin/say.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeSayQueue } from './nativeSayQueue.js';

/**
 * Build a fake spawn that records every call and returns a fake
 * ChildProcess.  The fake proc exposes:
 *   - on(event, cb): records exit/error listeners
 *   - kill(): marks killed=true; triggers exit listeners next tick
 *   - _exit(): test helper — manually fire exit (simulates say finishing)
 */
function makeFakeSpawn() {
  const spawns = [];
  let nextPid = 1000;
  const spawn = (cmd, args, opts) => {
    const listeners = { exit: [], error: [] };
    const proc = {
      pid: nextPid++,
      cmd,
      args,
      opts,
      killed: false,
      on(event, cb) {
        if (listeners[event]) listeners[event].push(cb);
        return proc;
      },
      kill() {
        proc.killed = true;
        // Real `say` proc emits exit shortly after SIGTERM; we fire
        // synchronously here so the queue's awaited promise resolves
        // in tests without a setTimeout wait.
        for (const cb of listeners.exit) cb(0, null);
      },
      _exit() {
        for (const cb of listeners.exit) cb(0, null);
      },
      _error(err) {
        for (const cb of listeners.error) cb(err);
      },
    };
    spawns.push(proc);
    return proc;
  };
  spawn._spawns = spawns;
  return spawn;
}

/** Wait one microtask tick — lets the drain loop advance past `await new Promise`. */
function microtaskTick() {
  return new Promise(r => setImmediate(r));
}

// ─── add() drains items one at a time ────────────────────────────────────────

test('add: single item → one spawn with the args', async () => {
  const spawn = makeFakeSpawn();
  const q = createNativeSayQueue({ spawn });
  q.add(['-v', 'Tingting', '--', 'hello']);
  await microtaskTick();
  assert.equal(spawn._spawns.length, 1);
  assert.deepEqual(spawn._spawns[0].args, ['-v', 'Tingting', '--', 'hello']);
});

test('add: three items in rapid sequence → only ONE spawn at a time', async () => {
  const spawn = makeFakeSpawn();
  const q = createNativeSayQueue({ spawn });
  q.add(['--', 'one']);
  q.add(['--', 'two']);
  q.add(['--', 'three']);
  await microtaskTick();
  // Only the FIRST should be spawned — the rest wait for it to exit.
  assert.equal(spawn._spawns.length, 1);
  assert.deepEqual(spawn._spawns[0].args, ['--', 'one']);
});

test('add: items play in order — each starts only after previous exits', async () => {
  const spawn = makeFakeSpawn();
  const q = createNativeSayQueue({ spawn });
  q.add(['--', 'one']);
  q.add(['--', 'two']);
  q.add(['--', 'three']);
  await microtaskTick();
  assert.equal(spawn._spawns.length, 1);

  // First exits → second should start
  spawn._spawns[0]._exit();
  await microtaskTick();
  assert.equal(spawn._spawns.length, 2);
  assert.deepEqual(spawn._spawns[1].args, ['--', 'two']);

  // Second exits → third should start
  spawn._spawns[1]._exit();
  await microtaskTick();
  assert.equal(spawn._spawns.length, 3);
  assert.deepEqual(spawn._spawns[2].args, ['--', 'three']);

  // Third exits → no more spawns
  spawn._spawns[2]._exit();
  await microtaskTick();
  assert.equal(spawn._spawns.length, 3);
  // Queue empty + drain stopped.
  assert.equal(q._state.running, false);
  assert.equal(q._state.queue.length, 0);
});

// ─── clear() preemption ──────────────────────────────────────────────────────

test('clear: kills currently-playing say + drains pending queue (sessions bumped, stale items skipped)', async () => {
  const spawn = makeFakeSpawn();
  const q = createNativeSayQueue({ spawn });
  q.add(['--', 'one']);
  q.add(['--', 'two']);
  q.add(['--', 'three']);
  await microtaskTick();
  assert.equal(spawn._spawns.length, 1);
  assert.equal(spawn._spawns[0].killed, false);

  // Mid-playback clear: should kill current AND drop pending.
  q.clear();
  assert.equal(spawn._spawns[0].killed, true,
    'currently-playing say must be SIGTERM\'d by clear()');

  // kill() in our fake fires exit synchronously → drain loop awaits resolved,
  // checks stale, breaks out.  No further spawns.
  await microtaskTick();
  assert.equal(spawn._spawns.length, 1,
    'after clear, neither item 2 nor item 3 should spawn — they were stale');
  assert.equal(q._state.queue.length, 0);
});

test('clear: items added BEFORE clear are stale; items added AFTER clear play normally', async () => {
  const spawn = makeFakeSpawn();
  const q = createNativeSayQueue({ spawn });
  q.add(['--', 'stale-one']);
  q.add(['--', 'stale-two']);
  await microtaskTick();
  assert.equal(spawn._spawns.length, 1);

  q.clear();                          // bumps session, kills stale-one, drops stale-two
  q.add(['--', 'fresh-one']);
  q.add(['--', 'fresh-two']);
  await microtaskTick();

  // After clear, drain restarts.  fresh-one spawned.
  assert.equal(spawn._spawns.length, 2);
  assert.deepEqual(spawn._spawns[1].args, ['--', 'fresh-one']);

  // Fresh-one finishes naturally → fresh-two plays.
  spawn._spawns[1]._exit();
  await microtaskTick();
  assert.equal(spawn._spawns.length, 3);
  assert.deepEqual(spawn._spawns[2].args, ['--', 'fresh-two']);
});

test('clear: idle queue → no-op (no crash)', () => {
  const spawn = makeFakeSpawn();
  const q = createNativeSayQueue({ spawn });
  assert.doesNotThrow(() => q.clear());
  assert.equal(spawn._spawns.length, 0);
});

// ─── error path: spawn 'error' event resolves cleanly ────────────────────────

test('spawn error event resolves drain — next queued item still plays', async () => {
  const spawn = makeFakeSpawn();
  const stderrLines = [];
  const q = createNativeSayQueue({ spawn, stderr: line => stderrLines.push(line) });
  q.add(['--', 'one']);
  q.add(['--', 'two']);
  await microtaskTick();
  assert.equal(spawn._spawns.length, 1);

  // Simulate /usr/bin/say spawn error (e.g. EACCES).
  spawn._spawns[0]._error(new Error('spawn EACCES'));
  await microtaskTick();
  // Drain must NOT hang — item 2 should still spawn.
  assert.equal(spawn._spawns.length, 2);
  assert.deepEqual(spawn._spawns[1].args, ['--', 'two']);
});

// ─── currentItem() introspection ─────────────────────────────────────────────

test('currentItem: reports the item playing right now, null when idle', async () => {
  const spawn = makeFakeSpawn();
  const q = createNativeSayQueue({ spawn });
  assert.equal(q.currentItem(), null);

  q.add(['--', 'inflight']);
  await microtaskTick();
  const current = q.currentItem();
  assert.ok(current);
  assert.deepEqual(current.args, ['--', 'inflight']);

  spawn._spawns[0]._exit();
  await microtaskTick();
  assert.equal(q.currentItem(), null);
});

// ─── concurrent add while drain running (no double-start) ────────────────────

test('add while drain already running does NOT start a second drain loop', async () => {
  const spawn = makeFakeSpawn();
  const q = createNativeSayQueue({ spawn });
  q.add(['--', 'one']);
  await microtaskTick();
  assert.equal(spawn._spawns.length, 1);
  assert.equal(q._state.running, true);

  // Add while drain is running — should just enqueue, not spawn another.
  q.add(['--', 'two']);
  await microtaskTick();
  assert.equal(spawn._spawns.length, 1, 'second add must not start parallel spawn');
  assert.equal(q._state.queue.length, 1);

  // First finishes → second naturally picks up.
  spawn._spawns[0]._exit();
  await microtaskTick();
  assert.equal(spawn._spawns.length, 2);
});
