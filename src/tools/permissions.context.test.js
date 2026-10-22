import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequestContext } from '../runtime/requestContext.js';
import { runWithRequestContext } from '../runtime/requestScope.js';
import { requestPermission, resolvePermission, checkPermissionRule, getPendingPermissions, clearSessionPermissions } from './permissions.js';

test('permissions stay bound to home, chat, tool and originating run', async t => {
  const root = await mkdtemp(join(tmpdir(), 'melo-permission-scope-'));
  t.after(async () => { clearSessionPermissions(); await rm(root, { recursive: true, force: true }); });
  const a = createRequestContext({ home: join(root, 'a'), chatId: 'same-chat', requestId: 'a' });
  const b = createRequestContext({ home: join(root, 'b'), chatId: 'same-chat', requestId: 'b' });
  let report;
  const emitted = new Promise(resolve => { report = resolve; });
  const pending = requestPermission('scope-test', {}, (_event, payload) => report(payload), undefined, 'same-chat', a);
  const payload = await emitted;
  assert.equal(payload.runId, a.runId);
  assert.equal(payload.turnRequestId, a.requestId);
  assert.equal((await runWithRequestContext(b, () => resolvePermission(payload.requestId, true, 'session', 'scope-test'))).ok, false);
  assert.equal((await runWithRequestContext(a, () => resolvePermission(payload.requestId, true, 'session', 'different-tool'))).ok, false);
  assert.equal((await runWithRequestContext(a, () => resolvePermission(payload.requestId, true, 'session', 'scope-test'))).ok, true);
  await pending;
  assert.equal(await runWithRequestContext(a, () => checkPermissionRule('scope-test', {}, 'same-chat')), 'allow');
  assert.equal(await runWithRequestContext(b, () => checkPermissionRule('scope-test', {}, 'same-chat')), 'ask');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(requestPermission('never-start', {}, () => assert.fail('aborted permission was emitted'), controller.signal, 'same-chat', a));
  assert.deepEqual(getPendingPermissions(), []);
});

test('a permission request with no approval surface fails at once instead of waiting 120s', async () => {
  const { requestPermission } = await import('./permissions.js');
  const started = Date.now();
  await assert.rejects(requestPermission('headless-tool', {}, undefined, undefined, 'remote-chat', { requestId: 'r', runId: 'run' }),
    error => error.code === 'PERMISSION_NO_SURFACE' && /desktop app/.test(error.message));
  assert.ok(Date.now() - started < 1000);
});

// Audit 2026-10-22: every chat turn wraps its emitter to record execution, so
// Telegram / Discord turns reached here with a function and waited the full
// 120 s. sendChatMessage now marks such turns `permissionSurface: 'none'`.
test('a wrapped emitter on a turn marked without a live desktop stream still fails at once', async t => {
  const home = await mkdtemp(join(tmpdir(), 'melo-permission-surface-'));
  t.after(async () => { clearSessionPermissions(); await rm(home, { recursive: true, force: true }); });
  const sent = [];
  let prompted;
  const promptShown = new Promise(r => { prompted = r; });
  const wrapped = type => { sent.push(type); prompted(); };
  const remote = Object.freeze({ ...createRequestContext({ home, chatId: 'remote-chat', runId: 'run-remote' }), permissionSurface: 'none' });
  const started = Date.now();
  await assert.rejects(requestPermission('surface-tool', {}, wrapped, undefined, 'remote-chat', remote), error => error.code === 'PERMISSION_NO_SURFACE');
  assert.ok(Date.now() - started < 1000);
  assert.deepEqual(sent, [], 'no prompt is sent to a channel that cannot answer it');
  // An unmarked caller with an emitter (the desktop stream) still gets its prompt.
  const controller = new AbortController();
  const pending = requestPermission('surface-tool', {}, wrapped, controller.signal, 'desktop-chat', createRequestContext({ home, chatId: 'desktop-chat', runId: 'run-desktop' }));
  await promptShown;
  assert.deepEqual(sent, ['tool_permission']);
  controller.abort();
  await assert.rejects(pending);
});
