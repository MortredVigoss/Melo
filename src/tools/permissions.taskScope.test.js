// Plan A phase A4-1 (2026-11-04): one task-scope card allows a member's gated
// tools for the current turn only; members share the lead's request context.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWithRequestContext } from '../runtime/requestScope.js';
import { createRequestContext } from '../runtime/requestContext.js';

async function freshModule() { return import(`./permissions.js?task=${Date.now()}-${Math.random()}`); }
async function withHome(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'melo-perm-task-'));
  const previous = process.env.MELO_HOME;
  process.env.MELO_HOME = dir;
  try { return await fn(); } finally { process.env.MELO_HOME = previous; await rm(dir, { recursive: true, force: true }); }
}
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

test('a task-scope grant allows the listed tools for this chat and turn only, and the turn end clears it', async () => {
  await withHome(async () => {
    const perms = await freshModule();
    const turn = createRequestContext({ chatId: 'chat-a', requestId: 'turn-1' });
    const other = createRequestContext({ chatId: 'chat-a', requestId: 'turn-2' });
    const events = [];
    const outcome = runWithRequestContext(turn, () => perms.requestTaskScopeApproval({ toolIds: ['reminders_create', 'reminders_create', 'clipboard'], task: 'save the plan', label: '执行成员', chatId: 'chat-a', sseEmitter: (type, payload) => events.push([type, payload]) }));
    await flush();
    assert.equal(events.length, 1);
    const [, payload] = events[0];
    assert.equal(payload.kind, 'task_scope');
    assert.deepEqual(payload.toolIds, ['reminders_create', 'clipboard']);
    assert.equal(payload.turnRequestId, 'turn-1');
    assert.deepEqual(perms.getPendingPermissions(), [payload.requestId]);
    assert.deepEqual(await perms.resolvePermission(payload.requestId, true, 'task'), { ok: true });
    assert.equal((await outcome).decision, 'task');
    assert.equal(await runWithRequestContext(turn, () => perms.checkPermissionRule('reminders_create', {}, 'chat-a')), 'allow');
    assert.equal(await runWithRequestContext(turn, () => perms.checkPermissionRule('clipboard', {}, 'chat-a')), 'allow');
    assert.equal(await runWithRequestContext(turn, () => perms.checkPermissionRule('bash', {}, 'chat-a')), 'ask', 'only the listed tools');
    assert.equal(await runWithRequestContext(other, () => perms.checkPermissionRule('reminders_create', {}, 'chat-a')), 'ask', 'another turn still asks');
    assert.equal(await runWithRequestContext(turn, () => perms.checkPermissionRule('reminders_create', {}, 'chat-b')), 'ask', 'another chat still asks');
    assert.deepEqual(perms.getTaskPermissions('chat-a', 'turn-1'), ['reminders_create', 'clipboard']);
    perms.endTaskToolPermissions(turn);
    assert.equal(await runWithRequestContext(turn, () => perms.checkPermissionRule('reminders_create', {}, 'chat-a')), 'ask', 'cleared with the turn');
    assert.deepEqual(perms.getPendingPermissions(), []);
  });
});

test('denied, session-scoped, cancelled and surfaceless task cards never grant for the turn', async () => {
  await withHome(async () => {
    const perms = await freshModule();
    const turn = createRequestContext({ chatId: 'chat-c', requestId: 'turn-9' });
    const emitter = events => (type, payload) => events.push(payload);
    const denied = []; const pendingDeny = runWithRequestContext(turn, () => perms.requestTaskScopeApproval({ toolIds: ['clipboard'], task: 't', chatId: 'chat-c', sseEmitter: emitter(denied) }));
    await flush();
    assert.deepEqual(await perms.resolvePermission(denied[0].requestId, false, 'task'), { ok: true });
    assert.equal((await pendingDeny).decision, 'denied');
    assert.equal(await runWithRequestContext(turn, () => perms.checkPermissionRule('clipboard', {}, 'chat-c')), 'ask');
    const session = []; const pendingSession = runWithRequestContext(turn, () => perms.requestTaskScopeApproval({ toolIds: ['clipboard'], task: 't', chatId: 'chat-c', sseEmitter: emitter(session) }));
    await flush();
    assert.equal((await perms.resolvePermission(session[0].requestId, true, 'session')).ok, true);
    assert.equal((await pendingSession).decision, 'session');
    assert.deepEqual(perms.getSessionPermissions('chat-c').allow, ['clipboard']);
    assert.deepEqual(perms.getTaskPermissions('chat-c', 'turn-9'), [], 'session scope writes no task rule');
    const controller = new AbortController();
    const cancelled = runWithRequestContext(turn, () => perms.requestTaskScopeApproval({ toolIds: ['bash'], task: 't', chatId: 'chat-c', signal: controller.signal, sseEmitter: () => {} }));
    await flush(); controller.abort();
    assert.equal((await cancelled).decision, 'cancelled');
    assert.equal((await runWithRequestContext(turn, () => perms.requestTaskScopeApproval({ toolIds: ['bash'], task: 't', chatId: 'chat-c' }))).decision, 'no-surface');
    assert.equal((await perms.requestTaskScopeApproval({ toolIds: [], task: 't' })).decision, 'none');
    const bad = []; runWithRequestContext(turn, () => perms.requestTaskScopeApproval({ toolIds: ['bash'], task: 't', chatId: 'chat-c', sseEmitter: emitter(bad) }));
    await flush();
    assert.equal((await perms.resolvePermission(bad[0].requestId, true, 'once-upon')).ok, false, 'unknown scope rejected');
    assert.equal((await perms.resolvePermission(bad[0].requestId, true, 'task', 'other_tool')).ok, false, 'tool outside the card rejected');
    assert.deepEqual(await perms.resolvePermission(bad[0].requestId, false, 'task'), { ok: true }, 'the card is then closed so no timer survives the test');
  });
});
