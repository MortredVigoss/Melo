import test from 'node:test';
import assert from 'node:assert/strict';
import { startApprovedBackgroundTask } from './approvedBackgroundTask.js';
import { resolveFileSafety } from '../safety/fileSafetyGate.js';

test('even harmless background commands wait for explicit approval', async () => {
  let started = 0;
  let permission;
  let prompted;
  const prompt = new Promise(resolve => { prompted = resolve; });
  const result = startApprovedBackgroundTask({ start: () => { started++; return 'run-id'; } }, {
    command: 'printf approved', workspacePath: process.cwd(),
  }, { sseEmitter: (event, payload) => { permission = payload; prompted(); } });
  await prompt;
  assert.equal(started, 0);
  assert.equal(permission.kind, 'file_safety');
  assert.equal(permission.command, 'printf approved');
  resolveFileSafety(permission.requestId, 'once');
  assert.equal(await result, 'run-id');
  assert.equal(started, 1);
});

test('deny, disconnect, and destructive commands never start a background process', async () => {
  let started = 0;
  const runner = { start: () => { started++; } };
  await assert.rejects(startApprovedBackgroundTask(runner, { command: 'printf denied' }, {
    sseEmitter: (event, payload) => resolveFileSafety(payload.requestId, 'deny'),
  }));
  const controller = new AbortController();
  await assert.rejects(startApprovedBackgroundTask(runner, { command: 'printf aborted' }, {
    signal: controller.signal, sseEmitter: () => controller.abort(),
  }));
  await assert.rejects(startApprovedBackgroundTask(runner, { command: 'rm important.txt' }));
  assert.equal(started, 0);
});

test('an already-aborted request never waits for a permission response', async () => {
  await assert.rejects(startApprovedBackgroundTask({ start: () => assert.fail('spawned') },
    { command: 'printf aborted' }, { signal: AbortSignal.abort() }));
});

test('accepted HTTP background work outlives its viewing connection', async () => {
  const controller = new AbortController();
  let captured;
  await startApprovedBackgroundTask({ start: options => { captured = options; return 'owned'; } },
    { command: 'printf background' }, { signal: controller.signal, detachAfterApproval: true,
      sseEmitter: (event, payload) => resolveFileSafety(payload.requestId, 'once') });
  controller.abort();
  assert.equal(captured.signal, undefined);
});
