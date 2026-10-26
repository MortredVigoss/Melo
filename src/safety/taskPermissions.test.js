import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile, readFile, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequestContext } from '../runtime/requestContext.js';
import { runWithRequestContext } from '../runtime/requestScope.js';
import { resolveFileSafety, endTaskPermissions } from './fileSafetyGate.js';
import { fileWriteTool } from '../tools/builtins/fileWriteTool.js';
import { fileEditTool } from '../tools/builtins/fileEditTool.js';
import { fileDeleteTool } from '../tools/builtins/fileDeleteTool.js';
import { executeTool } from '../tools/executor.js';
import { recommendedCapabilities } from '../domain/agent/capabilities.js';

async function fixture(fn) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'melo-task-grant-')));
  const workspace = join(root, 'workspace'), home = join(root, 'home');
  await mkdir(workspace); await mkdir(home);
  const identity = await stat(workspace);
  const context = { ...createRequestContext({ home, chatId: 'task-chat', workspacePath: workspace }), permissionScope: { role: 'main', project: null, workspace: { path: workspace, device: String(identity.dev), inode: String(identity.ino) } } };
  const calls = [], decisions = [];
  const options = { workspacePath: workspace, chatId: context.chatId, sseEmitter: (event, payload) => {
    if (event !== 'tool_permission') return;
    calls.push(payload);
    const scope = decisions.shift() || 'deny';
    const result = resolveFileSafety(payload.requestId, scope);
    if (result.ok === false) resolveFileSafety(payload.requestId, 'deny');
  } };
  try { await fn({ root, workspace, context, options, calls, decisions }); }
  finally { endTaskPermissions(context); await rm(root, { recursive: true, force: true }); }
}

test('explicit task grant covers ordinary workspace edits and expires at task end', async () => fixture(async f => {
  await writeFile(join(f.workspace, 'a.txt'), 'old'); await writeFile(join(f.workspace, 'b.txt'), 'old');
  f.decisions.push('task');
  await runWithRequestContext(f.context, async () => {
    assert.equal((await fileWriteTool.run({ path: 'a.txt', content: 'new' }, f.options)).ok, true);
    assert.equal((await fileEditTool.run({ path: 'b.txt', old_string: 'old', new_string: 'new' }, f.options)).ok, true);
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].taskScope.kind, 'workspace-write');
    endTaskPermissions(f.context);
    assert.equal((await fileWriteTool.run({ path: 'a.txt', content: 'again' }, f.options)).ok, false);
    assert.equal(f.calls.length, 2);
  });
  assert.equal(await readFile(join(f.workspace, 'b.txt'), 'utf8'), 'new');
}));

test('task grant cannot cross runs, Agents, symlinks or workspace boundaries', async () => fixture(async f => {
  await writeFile(join(f.workspace, 'a.txt'), 'old');
  await writeFile(join(f.root, 'outside.txt'), 'outside');
  await symlink(join(f.root, 'outside.txt'), join(f.workspace, 'link.txt'));
  f.decisions.push('task');
  await runWithRequestContext(f.context, async () => { assert.equal((await fileWriteTool.run({ path: 'a.txt', content: 'first' }, f.options)).ok, true); });
  for (const [context, path] of [
    [{ ...f.context, runId: 'another-run' }, 'a.txt'],
    [{ ...f.context, permissionScope: { ...f.context.permissionScope, role: 'another-agent' } }, 'a.txt'],
    [f.context, join(f.root, 'outside.txt')], [f.context, 'link.txt'],
  ]) await runWithRequestContext(context, async () => { assert.equal((await fileWriteTool.run({ path, content: 'forbidden' }, f.options)).ok, false); });
  assert.equal(f.calls.length, 4, 'the symlink targets an already denied file, so it stays denied without another prompt'); assert.equal(await readFile(join(f.root, 'outside.txt'), 'utf8'), 'outside');
}));

test('denial never adds a grant; delete cannot obtain a task grant', async () => fixture(async f => {
  await writeFile(join(f.workspace, 'a.txt'), 'old');
  await runWithRequestContext(f.context, async () => {
    assert.equal((await fileWriteTool.run({ path: 'a.txt', content: 'denied' }, f.options)).ok, false);
    assert.equal((await fileWriteTool.run({ path: 'a.txt', content: 'again' }, f.options)).ok, false);
    f.decisions.push('task');
    const result = await fileDeleteTool.run({ paths: ['a.txt'] }, f.options);
    assert.equal(result.ok, false); assert.equal(f.calls.at(-1).taskScope, null);
  });
  assert.equal(await readFile(join(f.workspace, 'a.txt'), 'utf8'), 'old');
}));

test('a later task grant cannot override an earlier denied file effect', async () => fixture(async f => {
  await writeFile(join(f.workspace, 'denied.txt'), 'original'); await writeFile(join(f.workspace, 'allowed.txt'), 'old');
  await runWithRequestContext(f.context, async () => {
    assert.equal((await fileWriteTool.run({ path: 'denied.txt', content: 'denied' }, f.options)).ok, false);
    f.decisions.push('task');
    assert.equal((await fileWriteTool.run({ path: 'allowed.txt', content: 'allowed' }, f.options)).ok, true);
    assert.equal((await fileEditTool.run({ path: 'denied.txt', old_string: 'original', new_string: 'bypass' }, f.options)).ok, false);
  });
  assert.equal(f.calls.length, 2, 'denied effect is not prompted again through another write tool');
  assert.equal(await readFile(join(f.workspace, 'denied.txt'), 'utf8'), 'original');
}));

test('production executor uses one file consent and still enforces an explicit tool deny', async () => fixture(async f => {
  await writeFile(join(f.workspace, 'a.txt'), 'old'); await writeFile(join(f.workspace, 'b.txt'), 'old');
  const context = { ...f.context, turnBinding: { role: 'main', project: null }, capabilityScope: { agentId: 'main', capabilities: recommendedCapabilities('main'), source: 'turn' } };
  f.decisions.push('task');
  await runWithRequestContext(context, async () => {
    const result = await executeTool(fileWriteTool, { path: 'a.txt', content: 'new' }, f.options);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal((await executeTool(fileEditTool, { path: 'b.txt', old_string: 'old', new_string: 'new' }, f.options)).ok, true);
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].kind, 'file_safety');
    await writeFile(join(context.home, 'config.json'), JSON.stringify({ toolPermissionRules: [{ toolId: 'file_write', action: 'deny' }] }));
    const denied = await executeTool(fileWriteTool, { path: 'a.txt', content: 'blocked' }, f.options);
    assert.equal(denied.error, 'PERMISSION_DENIED'); assert.equal(f.calls.length, 1);
  });
  assert.equal(await readFile(join(f.workspace, 'a.txt'), 'utf8'), 'new');
}));
