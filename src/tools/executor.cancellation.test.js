import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeTool } from './executor.js';
import { bashTool } from './builtins/bashTool.js';
import { resolveFileSafety } from '../safety/fileSafetyGate.js';

test('timeout aborts the actual tool signal and suppresses late output/results', async () => {
  let signal;
  const output = [];
  const observations = [];
  const tool = { id: 'cancel-test', requiresPermission: false, timeout: 20,
    async run(args, context) {
      signal = context.signal;
      await delay(60);
      context.onOutput('late output');
      context.sseEmitter('late', {});
      return { ok: true, output: 'late success' };
    } };
  const result = await executeTool(tool, {}, { onOutput: chunk => output.push(chunk), sseEmitter: (event, payload) => {
    if (event === 'execution_event') observations.push(payload);
    else output.push(event);
  } });
  assert.equal(result.ok, false);
  assert.equal(result.meta.timedOut, true);
  assert.equal(signal.aborted, true);
  await delay(80);
  assert.deepEqual(output, []);
  assert.deepEqual(observations.map(event => event.status), ['queued', 'running', 'failed']);
  assert.equal(observations.at(-1).errorCode, 'TOOL_TIMEOUT');
});

test('parent cancellation aborts a running cooperative tool, not just the caller', async () => {
  const controller = new AbortController();
  let finished = false;
  const result = await executeTool({ id: 'parent-cancel', requiresPermission: false,
    async run(args, { signal }) {
      controller.abort();
      await delay(50, null, { signal });
      finished = true;
    } }, {}, { signal: controller.signal });
  assert.equal(result.meta.aborted, true);
  assert.equal(finished, false);
});

test('bash cancellation kills the child process group before a delayed file write', async t => {
  const root = await mkdtemp(join(tmpdir(), 'melo-bash-cancel-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const controller = new AbortController();
  const result = await executeTool(bashTool, { command: 'printf STARTED; sleep 0.4; printf late > late.txt' }, {
    workspacePath: root, signal: controller.signal,
    sseEmitter: (event, payload) => {
      if (event === 'tool_permission') resolveFileSafety(payload.requestId, 'once');
    },
    onOutput: () => controller.abort(),
  });
  assert.equal(result.meta.aborted, true);
  await delay(600);
  await assert.rejects(access(join(root, 'late.txt')), { code: 'ENOENT' });
});

test('executor deadline stops a real command even when its own timeout is longer', async t => {
  const root = await mkdtemp(join(tmpdir(), 'melo-bash-timeout-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await executeTool({ ...bashTool, timeout: 80 }, {
    command: 'sleep 0.4; printf late > late.txt', timeout: 30000,
  }, { workspacePath: root, sseEmitter: (event, payload) => resolveFileSafety(payload.requestId, 'once') });
  assert.equal(result.meta.timedOut, true);
  await delay(600);
  await assert.rejects(access(join(root, 'late.txt')), { code: 'ENOENT' });
});
