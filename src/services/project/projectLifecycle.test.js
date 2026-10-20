import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequestContext } from '../../runtime/requestContext.js';
import { runWithRequestContext } from '../../runtime/requestScope.js';
import { updateStateAtomically, loadState } from '../../state/stateStore.js';
import { createProject } from './projectMutations.js';
import { changeProjectLifecycle } from './projectLifecycle.js';
import { applyPortableWorkspace, refreshPortableWorkspace } from '../chat/portableWorkspace.js';
import { mergeWorkspaces } from '../../../mobile-sync/workspaceProtocol.js';
import { createChatRecord } from '../../state/conversation.js';
import { executeApproval } from '../approval/approvalMutations.js';
import { prepareTaskExecution } from '../task/prepareTaskExecution.js';

async function isolated(fn) {
  const root = await mkdtemp(join(tmpdir(), 'melo-project-lifecycle-'));
  const home = join(root, 'home'), external = join(root, 'external');
  await mkdir(external); await writeFile(join(external, 'original.png'), Buffer.from([0, 255, 17, 9]));
  const ctx = createRequestContext({ home, env: { ...process.env, MELO_HOME: home, MELO_TEST_MODE: '1' } });
  try { return await runWithRequestContext(ctx, () => fn({ home, external })); }
  finally { await rm(root, { recursive: true, force: true }); }
}
test('committed deletion survives lost response and process restart; restore uses a new identity without replay', () => isolated(async ({ home, external }) => {
  const { project } = await createProject({ name: 'Retain files', workspacePath: external });
  const chat = createChatRecord({ projectId: project.id });
  const oldRun = { id: 'finished-run', chatId: chat.id, projectId: project.id, status: 'completed', workspacePath: external };
  await updateStateAtomically(state => {
    state.chats.push(chat);
    state.artifacts.push({ id: 'asset', title: 'Original', content: 'keep exact text', projectId: project.id, createdAt: new Date().toISOString() });
    state.approvals.push({ id: 'pending', chatId: chat.id, projectId: project.id, status: 'pending', kind: 'command', payload: { command: 'must never execute' } });
    state.chatRuns = [oldRun];
    refreshPortableWorkspace(state);
  });
  const offline = structuredClone((await loadState()).mobileWorkspaceSync);
  const receipt = await changeProjectLifecycle({ projectId: project.id, action: 'delete', operationId: 'delete-once' });
  assert.deepEqual(receipt.operation.report.chatIds, [chat.id]);
  assert.deepEqual(receipt.operation.report.invalidatedApprovalIds, ['pending']);
  assert.deepEqual(receipt.operation.report.artifactIds, ['asset']);
  assert.equal((await changeProjectLifecycle({ projectId: project.id, action: 'delete', operationId: 'retry-after-response-loss' })).operation.deleteOperationId, 'delete-once');
  await assert.rejects(executeApproval('pending'), { code: 'APPROVAL_NOT_PENDING' });
  const beforeRestart = await loadState();
  assert.equal(beforeRestart.chats.find(row => row.id === chat.id).projectId, null);
  assert.equal(beforeRestart.artifacts.find(row => row.id === 'asset').content, 'keep exact text');
  assert.equal(beforeRestart.chatRuns.find(row => row.id === oldRun.id).projectId, project.id);
  const probe = "const {loadState}=await import('./src/state/stateStore.js');const s=await loadState();console.log(JSON.stringify(s.projects.map(p=>({id:p.id,deletedAt:p.deletedAt,lifecycle:p.lifecycle}))));";
  const reopened = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', probe], { cwd: process.cwd(), env: { ...process.env, MELO_HOME: home, MELO_TEST_MODE: '1' }, encoding: 'utf8' }).trim().split('\n').at(-1));
  assert.equal(reopened.find(row => row.id === project.id).lifecycle.deleteOperationId, 'delete-once');
  await updateStateAtomically(state => { applyPortableWorkspace(state, mergeWorkspaces(state.mobileWorkspaceSync, offline), { home }); });
  assert.ok((await loadState()).projects.find(row => row.id === project.id).deletedAt);
  const restored = await changeProjectLifecycle({ projectId: project.id, action: 'restore', operationId: 'restore-once' });
  assert.notEqual(restored.project.id, project.id);
  assert.equal(restored.project.workspacePath, external);
  assert.equal((await changeProjectLifecycle({ projectId: project.id, action: 'restore', operationId: 'restore-retry' })).project.id, restored.project.id);
  assert.deepEqual(await readFile(join(external, 'original.png')), Buffer.from([0, 255, 17, 9]));
  assert.equal((await loadState()).chats.find(row => row.id === chat.id).projectId, null);
}));

test('running approvals and replies reject deletion before changing any membership', () => isolated(async ({ external }) => {
  const { project } = await createProject({ name: 'Busy', workspacePath: external });
  const chat = createChatRecord({ projectId: project.id });
  await updateStateAtomically(state => { state.chats.push(chat); state.chatRuns = [{ id: 'active', chatId: chat.id, status: 'running' }]; });
  await assert.rejects(changeProjectLifecycle({ projectId: project.id, action: 'delete', operationId: 'blocked' }), { code: 'PROJECT_LIFECYCLE_CONFLICT' });
  assert.equal((await loadState()).chats.find(row => row.id === chat.id).projectId, project.id);
  assert.ok(!(await loadState()).projects.find(row => row.id === project.id).deletedAt);
}));

test('a task from a deleted project cannot restart in its detached old workspace', () => isolated(async ({ external }) => {
  const { project } = await createProject({ name: 'Old task project', workspacePath: external });
  const { project: replacement } = await createProject({ name: 'New task project' });
  const chat = createChatRecord({ projectId: project.id });
  chat.messages = [{ id: 'original', role: 'assistant', content: 'Original run evidence' }];
  await updateStateAtomically(state => {
    state.chats.push(chat);
    state.tasks.push({ id: 'old-task', title: 'Task', projectId: project.id, owner: 'main', status: 'todo', execution: { chatId: chat.id, requestId: 'old-request', status: 'prepared' } });
  });
  await changeProjectLifecycle({ projectId: project.id, action: 'delete', operationId: 'delete-task' });
  await assert.rejects(prepareTaskExecution('old-task', { skipBootstrap: true }), /项目已删除/);
  await updateStateAtomically(state => { state.tasks.find(row => row.id === 'old-task').projectId = replacement.id; });
  const { execution } = await prepareTaskExecution('old-task', { skipBootstrap: true });
  assert.notEqual(execution.chatId, chat.id);
  assert.notEqual(execution.requestId, 'old-request');
  const state = await loadState();
  assert.equal(state.chats.find(row => row.id === execution.chatId).projectId, replacement.id);
  assert.equal(state.chats.find(row => row.id === chat.id).messages[0].content, 'Original run evidence');
  assert.equal(state.chats.find(row => row.id === chat.id).projectId, null);
}));
