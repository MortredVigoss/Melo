import test from 'node:test';
import assert from 'node:assert/strict';
import { projectDeletionId, projectDeletionValue, projectDeletionMarkers, projectLifecycleWorkspace } from './projectLifecycle.js';
import { mergeWorkspaces, putWorkspace, validateWorkspace } from './workspaceProtocol.js';

function fixture() {
  const old = { version: 1, records: [] };
  putWorkspace(old, 'project', 'project', { name: 'P' }, 'old');
  putWorkspace(old, 'conversation', 'chat', { agentId: 'main', projectId: 'project' }, 'old');
  putWorkspace(old, 'knowledge', 'image-ref', { title: 'Original', content: 'unchanged', projectId: 'project' }, 'old');
  return old;
}
test('a deletion survives offline edits in either merge order and repeated reopen', () => {
  const old = fixture(), deleted = structuredClone(old);
  putWorkspace(deleted, 'knowledge', projectDeletionId('project'), projectDeletionValue({ projectId: 'project', operationId: 'delete1', deletedAt: '2026-10-20T00:00:00Z' }), 'desktop');
  putWorkspace(old, 'project', 'project', { name: 'Offline changed title' }, 'old');
  for (const args of [[deleted, old], [old, deleted]]) {
    const merged = mergeWorkspaces(...args);
    assert.ok(!merged.records.some(row => row.kind === 'project'));
    for (const id of ['chat', 'image-ref']) assert.equal(merged.records.find(row => row.id === id).versions[0].value.projectId, null);
    assert.equal(merged.records.find(row => row.id === 'image-ref').versions[0].value.content, 'unchanged');
    assert.deepEqual(validateWorkspace(JSON.parse(JSON.stringify(merged))), merged);
    assert.equal(projectDeletionMarkers(merged).size, 1);
  }
});
test('old marker IDs cannot be overwritten by ordinary knowledge or a different project', () => {
  const workspace = fixture();
  putWorkspace(workspace, 'knowledge', projectDeletionId('project'), { content: 'not a marker' }, 'old');
  assert.throws(() => validateWorkspace(workspace), /marker/);
  workspace.records.find(row => row.id === projectDeletionId('project')).versions[0].value = projectDeletionValue({ projectId: 'other', operationId: 'op', deletedAt: '2026-10-20T00:00:00Z' });
  assert.throws(() => projectDeletionMarkers(workspace), /identity/);
});
test('project memory remains scoped and becomes historical rather than global', () => {
  const marker = projectDeletionValue({ projectId: 'p', operationId: 'op', deletedAt: '2026-10-20T00:00:00Z' });
  const result = projectLifecycleWorkspace({ records: [
    { kind: 'knowledge', id: projectDeletionId('p'), versions: [{ value: marker }] },
    { kind: 'memory', id: 'm', versions: [{ value: { projectId: 'p', scope: 'project', status: 'active', text: 'retain' } }] },
  ] });
  assert.deepEqual(result.records[1].versions[0].value, { projectId: 'p', scope: 'project', status: 'historical', text: 'retain' });
});

// The same wire sample is consumed by Swift and Android, including frozen v1 validation.
test('shared tombstone fixture is v1-compatible and retains its exact identity', async () => {
  const { readFile } = await import('node:fs/promises');
  const fixture = JSON.parse(await readFile(new URL('../shared/protocol/project-lifecycle.fixture.json', import.meta.url), 'utf8'));
  assert.equal(projectDeletionId(fixture.projectId), fixture.markerId);
  assert.deepEqual(projectDeletionValue(fixture), fixture.markerValue);
  const wire = validateWorkspace({ version: 1, records: [{ kind: 'knowledge', id: fixture.markerId, versions: [{ clock: { desktop: 1 }, value: fixture.markerValue }] }] });
  assert.equal(projectDeletionMarkers(wire).get(fixture.projectId).operationId, 'delete-once');
  for (const projectId of ['constructor', '__proto__', 'bad\n']) assert.throws(() => projectDeletionValue({ ...fixture, projectId }));
});
