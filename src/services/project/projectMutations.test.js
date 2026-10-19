// Architecture plan P1 (2026-10-19): project commands return a commit receipt
// built from the committed transaction. This test deliberately imports neither
// services/desktop/bootstrap.js nor desktop UI code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequestContext } from '../../runtime/requestContext.js';
import { runWithRequestContext } from '../../runtime/requestScope.js';
import { loadState } from '../../state/stateStore.js';
import { createProject, updateProject } from './projectMutations.js';

async function inHome(t, work) {
  const home = await mkdtemp(join(tmpdir(), 'melo-project-receipt-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return runWithRequestContext(createRequestContext({ home, env: { MELO_TEST_MODE: '1' } }), () => work(home));
}
const manifestRevision = async home => JSON.parse(await readFile(join(home, 'desktop', 'state.json'), 'utf8'))._revision;

test('create and update return the committed project, changed ids and a monotonic manifest revision', t => inHome(t, async home => {
  const created = await createProject({ name: ' Receipt ', summary: 'Plan', workspacePath: home });
  assert.deepEqual(Object.keys(created).sort(), ['changedIds', 'project', 'removedIds', 'revision']);
  assert.equal(created.project.name, 'Receipt');
  assert.deepEqual(created.changedIds, [created.project.id]);
  assert.deepEqual(created.removedIds, []);
  assert.equal(created.revision, await manifestRevision(home), 'revision is the persisted manifest revision');
  assert.deepEqual(created.project, (await loadState({ home })).projects.find(p => p.id === created.project.id));

  const other = await createProject({ name: 'Other', workspacePath: home });
  assert.ok(other.revision > created.revision);
  assert.deepEqual(other.changedIds, [other.project.id], 'existing projects are not reported as changed');

  const updated = await updateProject(created.project.id, { summary: 'Edited plan', workspaceConfirmation: 'ignored' });
  assert.ok(updated.revision > other.revision);
  assert.equal(updated.revision, await manifestRevision(home));
  assert.deepEqual(updated.changedIds, [created.project.id]);
  assert.deepEqual(updated.removedIds, []);
  assert.equal(updated.project.summary, 'Edited plan');
  assert.equal(updated.project.createdAt, created.project.createdAt);
  assert.deepEqual(updated.project, (await loadState({ home })).projects.find(p => p.id === created.project.id));

  // Archiving is the closest thing to a project deletion: the record stays.
  const archived = await updateProject(other.project.id, { archived: true });
  assert.ok(archived.revision > updated.revision);
  assert.equal(archived.project.archived, true);
  assert.deepEqual(archived.changedIds, [other.project.id]);
  assert.deepEqual(archived.removedIds, []);
}));

test('a project without a folder gets one under the bound home; selection side effects are unchanged', t => inHome(t, async home => {
  const created = await createProject({ name: 'Folder' });
  assert.ok(created.project.workspacePath.startsWith(join(home, 'workspaces')));
  assert.ok((await stat(created.project.workspacePath)).isDirectory());
  const state = await loadState({ home });
  assert.equal(state.settings.selectedProjectId, created.project.id);
  assert.equal(state.settings.activeView, 'projects');
}));

test('rejected updates commit nothing and return no receipt', t => inHome(t, async home => {
  const { project, revision } = await createProject({ name: 'Guarded', workspacePath: home });
  await assert.rejects(updateProject('missing', { name: 'x' }), /Project not found/);
  await assert.rejects(updateProject(project.id, { defaultAgentId: 'nobody' }), /默认 Agent 不存在/);
  await assert.rejects(updateProject(project.id, { knowledgeIds: ['missing-artifact'] }));
  assert.equal(await manifestRevision(home), revision);
  assert.deepEqual((await loadState({ home })).projects.find(p => p.id === project.id), project);
}));
