// 2026-11-10 agent audit. A tool, task-scope or file-safety prompt that the server stopped waiting
// for (120 s without an answer, or its run was cancelled) left its card on screen until the turn
// ended: it sat in front of every newer prompt, and answering it returned "Unknown or expired
// request.". Each path now announces the closure with the same request id the prompt carried.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWithRequestContext } from '../runtime/requestScope.js';
import { createRequestContext } from '../runtime/requestContext.js';

async function freshModule() { return import(`./permissions.js?closed=${Date.now()}-${Math.random()}`); }
async function withHome(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'melo-perm-closed-'));
  const previous = process.env.MELO_HOME;
  process.env.MELO_HOME = dir;
  try { return await fn(dir); } finally { if (previous === undefined) delete process.env.MELO_HOME; else process.env.MELO_HOME = previous; await rm(dir, { recursive: true, force: true }); }
}
const settle = async (turns = 20) => { for (let i = 0; i < turns; i++) await new Promise(resolve => setImmediate(resolve)); };
const until = async check => { for (let i = 0; i < 400 && !check(); i++) await new Promise(resolve => setImmediate(resolve)); assert.equal(check(), true, 'condition reached'); };
// Holds back only the two-minute prompt timers so a test can fire them; every other timer is real.
function holdPromptTimers() {
  const real = globalThis.setTimeout, held = [];
  globalThis.setTimeout = (callback, delay, ...rest) => delay === 120_000 ? (held.push(callback), { unref() { return this; }, ref() { return this; }, hasRef() { return false; } }) : real(callback, delay, ...rest);
  return { held, restore() { globalThis.setTimeout = real; } };
}
const recorder = () => { const events = []; return { events, emit: (event, payload) => events.push([event, payload]) }; };

test('a tool prompt that is cancelled or times out announces its closure; an answered one does not', async () => {
  await withHome(async () => {
    const perms = await freshModule();
    // Cancelled with its run.
    const cancelled = recorder(), controller = new AbortController();
    const context = createRequestContext({ chatId: 'chat-a', requestId: 'turn-1', signal: controller.signal });
    const waiting = runWithRequestContext(context, () => perms.requestPermission('bash', { command: 'ls' }, cancelled.emit, controller.signal, 'chat-a'));
    await until(() => cancelled.events.length === 1);
    const prompt = cancelled.events[0][1];
    assert.equal(cancelled.events[0][0], 'tool_permission');
    controller.abort();
    await assert.rejects(waiting, /Aborted/);
    assert.deepEqual(cancelled.events[1], ['tool_permission_closed', { requestId: prompt.requestId, reason: 'cancelled' }]);
    assert.deepEqual(perms.getPendingPermissions(), []);

    // Timed out.
    const timers = holdPromptTimers();
    try {
      const expired = recorder();
      const turn = createRequestContext({ chatId: 'chat-a', requestId: 'turn-2' });
      const pending = runWithRequestContext(turn, () => perms.requestPermission('bash', { command: 'ls' }, expired.emit, undefined, 'chat-a'));
      await until(() => expired.events.length === 1 && timers.held.length === 1);
      timers.held[0]();
      await assert.rejects(pending, /timed out after 120s/);
      assert.deepEqual(expired.events[1], ['tool_permission_closed', { requestId: expired.events[0][1].requestId, reason: 'timeout' }]);
      // The late click on that card is answered as expired, as before.
      assert.equal((await perms.resolvePermission(expired.events[0][1].requestId, true)).ok, false);

      // Answered by the user: the UI already removed its own card, nothing is announced.
      for (const granted of [true, false]) {
        const answered = recorder();
        const next = createRequestContext({ chatId: 'chat-a', requestId: 'turn-3-' + granted });
        const decision = runWithRequestContext(next, () => perms.requestPermission('bash', { command: 'ls' }, answered.emit, undefined, 'chat-a'));
        await until(() => answered.events.length === 1);
        await perms.resolvePermission(answered.events[0][1].requestId, granted, 'once');
        if (granted) await decision; else await assert.rejects(decision, /denied/);
        await settle();
        assert.deepEqual(answered.events.map(event => event[0]), ['tool_permission']);
      }
    } finally { timers.restore(); }
  });
});

test('a task-scope card that is cancelled or times out announces its closure', async () => {
  await withHome(async () => {
    const perms = await freshModule();
    const timers = holdPromptTimers();
    try {
      const expired = recorder();
      const turn = createRequestContext({ chatId: 'chat-b', requestId: 'turn-1' });
      const waiting = runWithRequestContext(turn, () => perms.requestTaskScopeApproval({ toolIds: ['clipboard'], task: 'save', label: '执行成员', chatId: 'chat-b', sseEmitter: expired.emit }));
      await until(() => expired.events.length === 1 && timers.held.length === 1);
      timers.held[0]();
      assert.equal((await waiting).decision, 'timeout');
      assert.deepEqual(expired.events[1], ['tool_permission_closed', { requestId: expired.events[0][1].requestId, reason: 'timeout' }]);

      const cancelled = recorder(), controller = new AbortController();
      const other = createRequestContext({ chatId: 'chat-b', requestId: 'turn-2', signal: controller.signal });
      const pending = runWithRequestContext(other, () => perms.requestTaskScopeApproval({ toolIds: ['clipboard'], task: 'save', chatId: 'chat-b', sseEmitter: cancelled.emit, signal: controller.signal }));
      await until(() => cancelled.events.length === 1);
      controller.abort();
      assert.equal((await pending).decision, 'cancelled');
      assert.deepEqual(cancelled.events[1], ['tool_permission_closed', { requestId: cancelled.events[0][1].requestId, reason: 'cancelled' }]);

      // A decision closes nothing by event.
      const answered = recorder();
      const third = createRequestContext({ chatId: 'chat-b', requestId: 'turn-3' });
      const decided = runWithRequestContext(third, () => perms.requestTaskScopeApproval({ toolIds: ['clipboard'], task: 'save', chatId: 'chat-b', sseEmitter: answered.emit }));
      await until(() => answered.events.length === 1);
      await perms.resolvePermission(answered.events[0][1].requestId, false, 'task');
      assert.equal((await decided).decision, 'denied');
      assert.deepEqual(answered.events.map(event => event[0]), ['tool_permission']);
      perms.endTaskToolPermissions(third);
    } finally { timers.restore(); }
  });
});

test('a file-safety prompt that is cancelled or times out announces its closure', async () => {
  await withHome(async () => {
    const gate = await import('../safety/fileSafetyGate.js');
    gate._clearPendingForTests();
    const root = await realpath(await mkdtemp(join(tmpdir(), 'melo-fsg-closed-')));
    await mkdir(join(root, 'elsewhere'));
    const timers = holdPromptTimers();
    try {
      const expired = recorder();
      const waiting = gate.requestWrite({ path: join(root, 'elsewhere', 'a.txt'), chatId: 'chat-c', sseEmitter: expired.emit, workspacePath: join(root, 'ws') });
      await until(() => expired.events.length === 1 && timers.held.length === 1);
      assert.equal(expired.events[0][1].kind, 'file_safety');
      timers.held[0]();
      await assert.rejects(waiting, error => error.code === 'FILE_SAFETY_DENIED' && /timed out/.test(error.message));
      assert.deepEqual(expired.events[1], ['tool_permission_closed', { requestId: expired.events[0][1].requestId, reason: 'timeout' }]);

      const cancelled = recorder(), controller = new AbortController();
      const pending = gate.requestWrite({ path: join(root, 'elsewhere', 'b.txt'), chatId: 'chat-c', sseEmitter: cancelled.emit, signal: controller.signal, workspacePath: join(root, 'ws') });
      await until(() => cancelled.events.length === 1);
      controller.abort();
      await assert.rejects(pending, error => error.code === 'FILE_SAFETY_DENIED' && /aborted/i.test(error.message));
      assert.deepEqual(cancelled.events[1], ['tool_permission_closed', { requestId: cancelled.events[0][1].requestId, reason: 'cancelled' }]);
      assert.deepEqual(gate.listPendingFileSafetyRequests(), []);
    } finally { timers.restore(); gate._clearPendingForTests(); await rm(root, { recursive: true, force: true }); }
  });
});

test('a closed stream never turns the announcement into an error', async () => {
  const { announcePromptClosed } = await import('../safety/permissionContext.js');
  assert.doesNotThrow(() => announcePromptClosed(() => { throw new Error('stream closed'); }, 'r', 'timeout'));
  assert.doesNotThrow(() => announcePromptClosed(undefined, 'r', 'timeout'));
});
