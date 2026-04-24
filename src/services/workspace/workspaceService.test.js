// Unit tests for workspaceService. Zero dependency on desktopStore state —
// project resolution and the read/write primitives are both injected, which
// is the whole point of this extraction.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readWorkspaceFilePreview,
  saveWorkspaceFileContent,
  applyArtifactContentToWorkspace,
} from './workspaceService.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function fakeProject(overrides = {}) {
  return {
    id: 'proj-1',
    name: 'demo',
    workspacePath: '/tmp/ws',
    updatedAt: '2026-04-24T00:00:00.000Z',
    ...overrides,
  };
}

// ─── readWorkspaceFilePreview ────────────────────────────────────────────────

test('readWorkspaceFilePreview validates filePath before resolver runs', async () => {
  let resolverCalls = 0;
  await assert.rejects(
    readWorkspaceFilePreview(
      { filePath: '  ' },
      {
        resolveProject: async () => {
          resolverCalls += 1;
          return fakeProject();
        },
        readFile: async () => { throw new Error('should not reach'); },
      },
    ),
    /File path is required/,
  );
  assert.equal(resolverCalls, 0);
});

test('readWorkspaceFilePreview rejects when resolver returns no project', async () => {
  await assert.rejects(
    readWorkspaceFilePreview(
      { filePath: 'notes.md' },
      { resolveProject: async () => null },
    ),
    /Project not found/,
  );
});

test('readWorkspaceFilePreview rejects when project has no workspace', async () => {
  await assert.rejects(
    readWorkspaceFilePreview(
      { filePath: 'notes.md' },
      { resolveProject: async () => fakeProject({ workspacePath: '' }) },
    ),
    /Project has no workspace/,
  );
});

test('readWorkspaceFilePreview passes trimmed relative path to readFile primitive', async () => {
  let receivedRoot = null;
  let receivedPath = null;
  const result = await readWorkspaceFilePreview(
    { filePath: '  notes.md  ' },
    {
      resolveProject: async () => fakeProject({ workspacePath: '/var/ws' }),
      readFile: async (root, path) => {
        receivedRoot = root;
        receivedPath = path;
        return { path, name: 'notes.md', content: 'hello', size: 5, truncated: false, isBinary: false, language: 'markdown' };
      },
    },
  );
  assert.equal(receivedRoot, '/var/ws');
  assert.equal(receivedPath, 'notes.md');
  assert.equal(result.content, 'hello');
});

// ─── saveWorkspaceFileContent ────────────────────────────────────────────────

test('saveWorkspaceFileContent rejects non-string content', async () => {
  await assert.rejects(
    saveWorkspaceFileContent(
      { filePath: 'x.md', content: 42 },
      { resolveProject: async () => fakeProject() },
    ),
    /File content must be text/,
  );
});

test('saveWorkspaceFileContent returns { project, relativeFilePath } on success', async () => {
  const writes = [];
  const proj = fakeProject();
  const out = await saveWorkspaceFileContent(
    { filePath: '  notes.md  ', content: 'hello', projectId: 'proj-1' },
    {
      resolveProject: async () => proj,
      writeFile: async (root, path, content) => {
        writes.push({ root, path, content });
      },
    },
  );
  assert.deepEqual(writes, [{ root: '/tmp/ws', path: 'notes.md', content: 'hello' }]);
  assert.equal(out.project, proj); // same reference — caller needs to mutate updatedAt
  assert.equal(out.relativeFilePath, 'notes.md');
});

test('saveWorkspaceFileContent rejects when project has no workspace', async () => {
  await assert.rejects(
    saveWorkspaceFileContent(
      { filePath: 'x.md', content: 'ok' },
      { resolveProject: async () => fakeProject({ workspacePath: null }) },
    ),
    /Project has no workspace/,
  );
});

// ─── applyArtifactContentToWorkspace ─────────────────────────────────────────

test('applyArtifactContentToWorkspace rejects missing target path', async () => {
  await assert.rejects(
    applyArtifactContentToWorkspace(
      { artifactContent: 'x', targetFilePath: '  ' },
      { resolveProject: async () => fakeProject() },
    ),
    /Choose a target file/,
  );
});

test('applyArtifactContentToWorkspace rejects non-string artifact content', async () => {
  await assert.rejects(
    applyArtifactContentToWorkspace(
      { artifactContent: null, targetFilePath: 'x.md' },
      { resolveProject: async () => fakeProject() },
    ),
    /Artifact content must be text/,
  );
});

test('applyArtifactContentToWorkspace writes to target and returns path info', async () => {
  const writes = [];
  const out = await applyArtifactContentToWorkspace(
    { artifactContent: 'payload', targetFilePath: 'out/draft.md' },
    {
      resolveProject: async () => fakeProject(),
      writeFile: async (root, path, content) => {
        writes.push({ root, path, content });
      },
    },
  );
  assert.deepEqual(writes, [{ root: '/tmp/ws', path: 'out/draft.md', content: 'payload' }]);
  assert.equal(out.targetPath, 'out/draft.md');
  assert.equal(out.project.id, 'proj-1');
});

// ─── Common contract: resolver is required ───────────────────────────────────

test('all three service fns throw TypeError when deps.resolveProject is missing', async () => {
  await assert.rejects(
    readWorkspaceFilePreview({ filePath: 'x' }, {}),
    err => err instanceof TypeError && /resolveProject/.test(err.message),
  );
  await assert.rejects(
    saveWorkspaceFileContent({ filePath: 'x', content: '' }, {}),
    err => err instanceof TypeError && /resolveProject/.test(err.message),
  );
  await assert.rejects(
    applyArtifactContentToWorkspace({ artifactContent: '', targetFilePath: 'x' }, {}),
    err => err instanceof TypeError && /resolveProject/.test(err.message),
  );
});

// ─── Projects with falsy ids still resolve correctly ────────────────────────

test('resolver is called with the projectId as-given (empty string stays empty)', async () => {
  let received;
  await readWorkspaceFilePreview(
    { filePath: 'x.md' },
    {
      resolveProject: async id => { received = id; return fakeProject(); },
      readFile: async () => ({ content: '' }),
    },
  );
  assert.equal(received, undefined); // projectId was not passed → resolver sees undefined
});
