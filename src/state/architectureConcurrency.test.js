import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadState, saveState, updateStateAtomically } from './stateStore.js';
import { createProject, updateProject } from '../services/project/projectMutations.js';
import { createTask } from '../services/task/taskMutations.js';
import { createExternalConnector } from '../services/connector/externalConnectorMutations.js';
import { getDesktopBootstrap } from './desktopBootstrap.js';

const home = await mkdtemp(join(tmpdir(), 'melo-domain-concurrency-'));
process.env.MELO_HOME = home;
process.env.MELO_TEST_MODE = '1';
test.after(() => rm(home, { recursive: true, force: true }));

test('concurrent domain commands retain every project, task, connector and setting', async () => {
  await Promise.all(Array.from({ length: 4 }, (_, i) => Promise.all([
    createProject({ name: `Concurrent ${i}`, workspacePath: home }),
    createTask({ title: `Concurrent ${i}` }),
    createExternalConnector({ name: `Concurrent ${i}`, endpoint: `http://127.0.0.1:${20000 + i}` }),
    updateStateAtomically(s => { s.settings[`concurrent-${i}`] = i; }),
  ])));
  const state = await loadState();
  for (let i = 0; i < 4; i++) {
    assert.ok(state.projects.some(p => p.name === `Concurrent ${i}`));
    assert.ok(state.tasks.some(p => p.title === `Concurrent ${i}`));
    assert.ok(state.externalConnectors.some(p => p.name === `Concurrent ${i}`));
    assert.equal(state.settings[`concurrent-${i}`], i);
  }
  const project = state.projects.find(p => p.name === 'Concurrent 0');
  await Promise.all([
    updateProject(project.id, { summary: 'kept summary' }),
    updateProject(project.id, { instructions: 'kept instructions' }),
  ]);
  const updated = (await loadState()).projects.find(p => p.id === project.id);
  assert.equal(updated.summary, 'kept summary');
  assert.equal(updated.instructions, 'kept instructions');
});

test('a stale legacy snapshot fails explicitly without discarding a concurrent edit', async () => {
  const snapshot = await loadState();
  await updateStateAtomically(s => { s.settings.freshValue = 'survives'; });
  snapshot.settings.staleValue = 'must not overwrite';
  await assert.rejects(saveState(snapshot), { code: 'STATE_CONFLICT' });
  assert.equal((await loadState()).settings.freshValue, 'survives');
});

test('bootstrap sanitizes invalid selection without writing state or checkpoints', async () => {
  await updateStateAtomically(s => { s.settings.selectedFilePath = 'missing-file.txt'; });
  const path = join(home, 'desktop/state.json');
  const before = await readFile(path, 'utf8');
  const mtime = (await stat(path)).mtimeMs;
  await getDesktopBootstrap();
  await getDesktopBootstrap();
  assert.equal(await readFile(path, 'utf8'), before);
  assert.equal((await stat(path)).mtimeMs, mtime);
});
