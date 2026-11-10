import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {executeTool} from '../testSupport/directAgentFixture.js';
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

test('a search whose settings allow more than the general tool limit is given that time', async t => {
  // 2026-11-10 agent audit, second pass: the search timeout can be raised to 120 s on the settings page,
  // and the executor ended every tool at 60 s.
  const { toolTimeoutCeiling } = await import('./executor.js');
  const { webSearchTool } = await import('./builtins/webSearchTool.js');
  const { fetchUrlTool } = await import('./builtins/fetchUrlTool.js');
  assert.equal(toolTimeoutCeiling(webSearchTool, {}), 60000, 'the default settings fit the general limit');
  assert.equal(toolTimeoutCeiling(fetchUrlTool, {}), 60000);
  assert.equal(toolTimeoutCeiling(webSearchTool, { agentRuntime: { search: { timeoutMs: 120000 } } }), 120000 + 14000 + 5000, 'the saved search timeout and the result read');
  assert.equal(toolTimeoutCeiling(fetchUrlTool, { operationalLimits: { search: { fetchTimeoutMs: 90000 } } }), 90000 + 20000 + 5000);
  assert.equal(toolTimeoutCeiling({ id: 'plain' }, {}), 60000);
  assert.equal(toolTimeoutCeiling({ id: 'quick', timeout: 20 }, {}), 20, 'a tool\'s own shorter ceiling is kept');
  assert.equal(toolTimeoutCeiling({ id: 'never-less', timeoutFor: () => 5 }, {}), 60000);
  // Through the executor, on a mocked clock: still running at 60 s, ended at its own ceiling.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let aborted = false, begin;
  const begun = new Promise(resolve => { begin = resolve; });
  const slow = { id: 'slow-search', requiresPermission: false, timeoutFor: config => (config.agentRuntime?.search?.timeoutMs || 0) + 5000,
    run: (args, { signal }) => new Promise((resolve, reject) => { begin(); signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true }); }) };
  const pending = executeTool(slow, {}, { config: { agentRuntime: { search: { timeoutMs: 100000 } } } });
  await begun;
  t.mock.timers.tick(60000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(aborted, false, 'the general limit no longer ends it');
  t.mock.timers.tick(45000);
  const result = await pending;
  assert.equal(aborted, true);
  assert.equal(result.meta.timedOut, true);
  assert.match(JSON.stringify(result), /timed out after 105s/);
});
