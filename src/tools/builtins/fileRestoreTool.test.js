/**
 * file_restore: the way back for file_delete.
 *
 * Every test deletes real files with the real file_delete tool (two-stage
 * approval through the FileSafetyGate), then lists and restores them with the
 * real file_restore tool, in a Melo home and workspaces of its own. Prompts
 * are counted, so "the gate was asked" and "nothing was asked" are facts of
 * the run, not assumptions.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtemp, realpath, rm, writeFile, readFile, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { fileDeleteTool } from './fileDeleteTool.js';
import { fileRestoreTool, trashEntryInScope } from './fileRestoreTool.js';
import { toolEffect } from '../../../shared/agent/toolEffects.js';
import { validateTool, toolConcurrencySafe } from '../tool.js';

async function freshGate() {
  const grants = await import('../../safety/chatScopedGrants.js');
  grants.clearChat();
  const gate = await import('../../safety/fileSafetyGate.js');
  gate._clearPendingForTests();
  return gate;
}

async function withTempEnv(fn) {
  // realpath: file_delete walks the parent chain without following links, and macOS's temp directory sits behind /var → /private/var.
  const home = await realpath(await mkdtemp(join(tmpdir(), 'restore-home-')));
  const ws = await realpath(await mkdtemp(join(tmpdir(), 'restore-ws-')));
  const otherWs = await realpath(await mkdtemp(join(tmpdir(), 'restore-ws2-')));
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'restore-out-')));
  const prev = process.env.MELO_HOME;
  process.env.MELO_HOME = home;
  try {
    await mkdir(home, { recursive: true });
    await fn({ ws, otherWs, outside, home });
  } finally {
    if (prev === undefined) delete process.env.MELO_HOME; else process.env.MELO_HOME = prev;
    for (const dir of [home, ws, otherWs, outside]) await rm(dir, { recursive: true, force: true });
  }
}

const exists = async path => { try { await stat(path); return true; } catch { return false; } };

// An approver that answers every prompt and records it. `answer(payload)`
// returns the scope ('once' | 'deny') or { scope, confirmInput }.
function approver(gate, answer = () => 'once') {
  const prompts = [];
  const emit = (event, payload) => {
    prompts.push({ event, ...payload });
    const decision = answer(payload);
    const scope = typeof decision === 'string' ? decision : decision.scope;
    queueMicrotask(() => gate.resolveFileSafety(payload.requestId, scope, { confirmInput: decision?.confirmInput }));
  };
  return { emit, prompts };
}

// Deletes `paths` with the real tool; the second stage wants the file name
// (one path) or the word DELETE (several).
async function trash(gate, paths, context) {
  const names = paths.map(path => path.split('/').pop());
  const ui = approver(gate, payload => payload.stage === 'confirm' ? { scope: 'once', confirmInput: names.length === 1 ? names[0] : 'DELETE' } : 'once');
  const result = await fileDeleteTool.run({ paths, reason: 'test clean-up' }, { ...context, sseEmitter: ui.emit });
  assert.equal(result.ok, true, result.output);
  for (const path of paths) assert.equal(await exists(path), false, `${path} was moved to the trash`);
  return result.meta.operationId;
}

const trashFolders = async () => (await (await import('../../safety/trash.js')).listTrash()).map(entry => entry.operationId);

test('the tool is a valid, self-described tool: listing reads, restoring writes', () => {
  assert.deepEqual(validateTool(fileRestoreTool), { valid: true });
  assert.equal(toolEffect('file_restore', { action: 'list' }, fileRestoreTool), 'read');
  assert.equal(toolEffect('file_restore', { action: 'restore', operationId: 'x' }, fileRestoreTool), 'write');
  assert.equal(toolEffect('file_restore', {}, fileRestoreTool), 'write', 'unknown action counts as a write');
  assert.equal(toolConcurrencySafe(fileRestoreTool, { action: 'list' }), true);
  assert.equal(toolConcurrencySafe(fileRestoreTool, { action: 'restore' }), false);
  assert.equal(fileRestoreTool.capability, 'writeFiles');
  assert.equal(fileRestoreTool.permissionGate, 'file-safety');
});

test('delete, list, restore: the file is back with its content, the operation leaves the trash, the delete tool names the way back', async () => {
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    const context = { workspacePath: ws, chatId: 'chat-A' };
    const target = join(ws, 'notes', 'plan.md');
    await mkdir(join(ws, 'notes'));
    await writeFile(target, '# plan\nkeep me\n', 'utf8');

    const ui = approver(gate, payload => payload.stage === 'confirm' ? { scope: 'once', confirmInput: 'plan.md' } : 'once');
    const deleted = await fileDeleteTool.run({ paths: [target], reason: 'no longer needed' }, { ...context, sseEmitter: ui.emit });
    assert.equal(deleted.ok, true);
    assert.match(deleted.output, /file_restore with action "restore" and this operationId/);
    const operationId = deleted.meta.operationId;

    const listing = await fileRestoreTool.run({ action: 'list' }, { ...context, sseEmitter: () => assert.fail('listing asks for nothing') });
    assert.equal(listing.ok, true);
    assert.equal(listing.meta.count, 1);
    assert.match(listing.output, new RegExp(`operationId=${operationId}`));
    assert.match(listing.output, /1 file\(s\): notes\/plan\.md/, 'paths inside the workspace are shown relative to it');
    assert.match(listing.output, /reason: no longer needed/);

    const restoreUi = approver(gate);
    const restored = await fileRestoreTool.run({ action: 'restore', operationId }, { ...context, sseEmitter: restoreUi.emit });
    assert.equal(restored.ok, true, restored.output);
    assert.match(restored.output, /^Restored 1 file\(s\): notes\/plan\.md\.$/);
    assert.equal(await readFile(target, 'utf8'), '# plan\nkeep me\n');
    assert.equal(restored.meta.fullyRestored, true);
    assert.deepEqual(await trashFolders(), [], 'a fully restored operation leaves the trash');

    const again = await fileRestoreTool.run({ action: 'list' }, { ...context, sseEmitter: () => {} });
    assert.equal(again.meta.count, 0);
    assert.match(again.output, /^Nothing to restore/);
  });
});

test('a file that is back at its path is left alone; overwrite: true replaces it', async () => {
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    const context = { workspacePath: ws, chatId: 'chat-A' };
    const kept = join(ws, 'a.txt');
    const recreated = join(ws, 'b.txt');
    await writeFile(kept, 'old a', 'utf8');
    await writeFile(recreated, 'old b', 'utf8');
    const operationId = await trash(gate, [kept, recreated], context);
    await writeFile(recreated, 'new b written after the delete', 'utf8');

    const first = await fileRestoreTool.run({ action: 'restore', operationId }, { ...context, sseEmitter: approver(gate).emit });
    assert.equal(first.ok, true, 'something was restored');
    assert.match(first.output, /Restored 1 file\(s\): a\.txt\./);
    assert.match(first.output, /Left untouched 1 file\(s\) that exist at their path again: b\.txt\./);
    assert.match(first.output, /Nothing was overwritten/);
    assert.equal(await readFile(kept, 'utf8'), 'old a');
    assert.equal(await readFile(recreated, 'utf8'), 'new b written after the delete', 'the newer file is untouched');
    assert.deepEqual(await trashFolders(), [operationId], 'the operation stays in the trash for a retry');

    // Now both exist: without overwrite nothing is restored and the call says so.
    const second = await fileRestoreTool.run({ action: 'restore', operationId }, { ...context, sseEmitter: approver(gate).emit });
    assert.equal(second.ok, false);
    assert.equal(second.error, 'ALREADY_EXISTS');
    assert.equal(await readFile(recreated, 'utf8'), 'new b written after the delete');

    const forced = await fileRestoreTool.run({ action: 'restore', operationId, overwrite: true }, { ...context, sseEmitter: approver(gate).emit });
    assert.equal(forced.ok, true, forced.output);
    assert.equal(await readFile(recreated, 'utf8'), 'old b', 'overwrite: true puts the deleted content back');
    assert.equal(await readFile(kept, 'utf8'), 'old a');
    assert.deepEqual(await trashFolders(), []);
  });
});

test('a conversation sees and restores only what was deleted in it or under its workspace', async () => {
  await withTempEnv(async ({ ws, otherWs }) => {
    const gate = await freshGate();
    const mine = join(ws, 'mine.txt');
    const theirs = join(otherWs, 'secret-plan.txt');
    await writeFile(mine, 'mine', 'utf8');
    await writeFile(theirs, 'theirs', 'utf8');
    const myOperation = await trash(gate, [mine], { workspacePath: ws, chatId: 'chat-A' });
    const theirOperation = await trash(gate, [theirs], { workspacePath: otherWs, chatId: 'chat-B' });

    const listing = await fileRestoreTool.run({ action: 'list' }, { workspacePath: ws, chatId: 'chat-A', sseEmitter: () => {} });
    assert.equal(listing.meta.count, 1);
    assert.match(listing.output, new RegExp(myOperation));
    assert.doesNotMatch(listing.output, /secret-plan/, 'another project\'s file names are not shown');
    assert.doesNotMatch(listing.output, new RegExp(theirOperation));

    let asked = 0;
    const refused = await fileRestoreTool.run({ action: 'restore', operationId: theirOperation }, { workspacePath: ws, chatId: 'chat-A', sseEmitter: () => { asked += 1; } });
    assert.equal(refused.ok, false);
    assert.equal(refused.error, 'NOT_FOUND');
    assert.equal(asked, 0, 'the user is not even asked');
    assert.equal(await exists(theirs), false, 'nothing was written');
    const unknown = await fileRestoreTool.run({ action: 'restore', operationId: '00000000-0000-4000-8000-000000000000' }, { workspacePath: ws, chatId: 'chat-A', sseEmitter: () => {} });
    assert.equal(unknown.output.replace(/[0-9a-f-]{36}/, 'ID'), refused.output.replace(/[0-9a-f-]{36}/, 'ID'), 'an id from elsewhere gets the same answer as one that does not exist');

    // Another conversation of the same project (same workspace) may restore it.
    const sibling = await fileRestoreTool.run({ action: 'restore', operationId: myOperation }, { workspacePath: ws, chatId: 'chat-C', sseEmitter: approver(gate).emit });
    assert.equal(sibling.ok, true, sibling.output);
    assert.equal(await readFile(mine, 'utf8'), 'mine');

    // And the pure rule itself.
    const entry = { operationId: 'x', chatId: 'chat-A', workspacePath: ws, restorable: true };
    assert.equal(trashEntryInScope(entry, { chatId: 'chat-A', workspacePath: '/elsewhere' }), true);
    assert.equal(trashEntryInScope(entry, { chatId: 'chat-Z', workspacePath: ws }), true);
    assert.equal(trashEntryInScope(entry, { chatId: 'chat-Z', workspacePath: '/elsewhere' }), false);
    assert.equal(trashEntryInScope({ ...entry, chatId: null, workspacePath: null }, { chatId: null, workspacePath: null }), false, 'two missing ids are not a match');
    assert.equal(trashEntryInScope({ ...entry, restorable: false }, { chatId: 'chat-A', workspacePath: ws }), false);
  });
});

test('restoring outside the workspace asks the user; a refusal writes nothing and keeps the operation', async () => {
  await withTempEnv(async ({ ws, outside }) => {
    const gate = await freshGate();
    const context = { workspacePath: ws, chatId: 'chat-A' };
    const target = join(outside, 'report.txt');
    await writeFile(target, 'outside the workspace', 'utf8');
    const operationId = await trash(gate, [target], context);
    (await import('../../safety/chatScopedGrants.js')).clearChat(); // no approval left over from the delete

    const denying = approver(gate, () => 'deny');
    const refused = await fileRestoreTool.run({ action: 'restore', operationId }, { ...context, sseEmitter: denying.emit });
    assert.equal(denying.prompts.length, 1, 'the gate asked once, for this file');
    assert.equal(refused.ok, false);
    assert.equal(refused.error, 'DENIED');
    assert.equal(refused.meta.denied, true);
    assert.equal(await exists(target), false, 'nothing was written');
    assert.deepEqual(await trashFolders(), [operationId], 'the operation is still there');

    const allowing = approver(gate);
    const restored = await fileRestoreTool.run({ action: 'restore', operationId }, { ...context, sseEmitter: allowing.emit });
    assert.equal(allowing.prompts.length, 1);
    assert.equal(restored.ok, true, restored.output);
    assert.equal(await readFile(target, 'utf8'), 'outside the workspace');
    assert.match(restored.output, new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'a path outside the workspace is shown in full');
  });
});

test('a restore decided by the model never takes the path without a gate', async () => {
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    const target = join(ws, 'c.txt');
    await writeFile(target, 'c', 'utf8');
    const operationId = await trash(gate, [target], { workspacePath: ws, chatId: 'chat-A' });
    for (const context of [{ workspacePath: ws, chatId: 'chat-A' }, { workspacePath: ws, chatId: 'chat-A', sseEmitter: null }]) {
      const result = await fileRestoreTool.run({ action: 'restore', operationId }, context);
      assert.equal(result.ok, false);
      assert.equal(result.error, 'PERMISSION_NO_SURFACE');
      assert.equal(await exists(target), false);
    }
    assert.deepEqual(await trashFolders(), [operationId]);
  });
});

test('bad input is answered before anything is read or written', async () => {
  await withTempEnv(async ({ ws }) => {
    const context = { workspacePath: ws, chatId: 'chat-A', sseEmitter: () => assert.fail('no prompt') };
    assert.equal((await fileRestoreTool.run({ action: 'purge' }, context)).error, 'INVALID_ACTION');
    assert.equal((await fileRestoreTool.run({}, context)).error, 'INVALID_ACTION');
    assert.equal((await fileRestoreTool.run({ action: 'restore' }, context)).error, 'INVALID_OPERATION_ID');
    assert.equal((await fileRestoreTool.run({ action: 'restore', operationId: '   ' }, context)).error, 'INVALID_OPERATION_ID');
    assert.equal((await fileRestoreTool.run({ action: 'restore', operationId: '../../etc' }, context)).error, 'NOT_FOUND');
    assert.equal((await fileRestoreTool.run({ action: 'list' }, { chatId: 'chat-A' })).error, 'WORKSPACE_REQUIRED');
  });
});

// ─── Through the executor, as a turn calls it ───────────────────────────────

test('through the executor: a real turn deletes, lists and restores in its own workspace; an Agent without the write capability is refused first', async () => {
  const { executeTool } = await import('../executor.js');
  const { createRequestContext } = await import('../../runtime/requestContext.js');
  const { runWithRequestContext } = await import('../../runtime/requestScope.js');
  const { emptyCapabilities } = await import('../../domain/agent/capabilities.js');
  const { updateStateAtomically } = await import('../../state/stateStore.js');
  const { beginChatRun } = await import('../../services/chat/turnLedger.js');
  await withTempEnv(async ({ home }) => {
    const gate = await freshGate();
    await updateStateAtomically(state => {
      state.chats.push({ id: 'chat-A', agentId: 'main', projectId: null, messages: [] }, { id: 'chat-B', agentId: 'research', projectId: null, messages: [] });
      state.agentProfiles.research.capabilities = emptyCapabilities();
    }, { home });
    const turn = async chatId => {
      const initial = createRequestContext({ home, chatId, requestId: `request-${chatId}` });
      const { turnBinding } = await beginChatRun({ chatId, content: 'test' }, initial);
      return { ...initial, turnBinding };
    };
    // Runs one tool call of the turn; answers file-gate prompts and records every event type.
    const call = (requestContext, tool, args, confirmInput) => {
      const events = [];
      const sseEmitter = (type, payload) => {
        events.push(type);
        if (type === 'tool_permission' && payload?.requestId) queueMicrotask(() => gate.resolveFileSafety(payload.requestId, 'once', { confirmInput: payload.stage === 'confirm' ? confirmInput : undefined }));
      };
      return runWithRequestContext(requestContext, () => executeTool(tool, args, { chatId: requestContext.chatId, sseEmitter })).then(result => ({ result, events }));
    };

    const main = await turn('chat-A');
    const empty = await call(main, fileRestoreTool, { action: 'list' });
    assert.equal(empty.result.ok, true, empty.result.output);
    assert.match(empty.result.output, /^Nothing to restore/);
    assert.equal(empty.events.includes('tool_permission'), false, 'listing asks for nothing');

    // The turn's own workspace is assigned by the executor; write, delete and restore a file in it.
    const { fileWriteTool } = await import('./fileWriteTool.js');
    const written = await call(main, fileWriteTool, { path: 'draft.md', content: 'first draft' });
    assert.equal(written.result.ok, true, written.result.output);
    const target = written.result.meta.path || written.result.meta.resolvedPath;
    assert.ok(target && await exists(target), 'the file exists in the chat workspace');
    const deleted = await call(main, fileDeleteTool, { paths: ['draft.md'] }, 'draft.md');
    assert.equal(deleted.result.ok, true, deleted.result.output);
    assert.equal(await exists(target), false);

    const listed = await call(main, fileRestoreTool, { action: 'list' });
    assert.match(listed.result.output, /1 file\(s\): draft\.md/);
    const restored = await call(main, fileRestoreTool, { action: 'restore', operationId: deleted.result.meta.operationId });
    assert.equal(restored.result.ok, true, restored.result.output);
    assert.equal(await readFile(target, 'utf8'), 'first draft');
    // Whether this write needed the user's approval is the file gate's decision, the same one it made for file_write above.
    assert.equal(restored.events.includes('tool_permission'), written.events.includes('tool_permission'), 'a restore is asked about exactly like a write to the same place');

    const noWrite = await call(await turn('chat-B'), fileRestoreTool, { action: 'list' });
    assert.equal(noWrite.result.ok, false);
    assert.equal(noWrite.result.error, 'CAPABILITY_DENIED');
    assert.equal(noWrite.result.meta.executionStarted, false);
  });
});
