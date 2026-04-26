// Unit tests for the artifact mutations added in the manageable-shelf
// upgrade — covers the contracts the original commit's gate B-finding
// asked for: identity-field preservation, empty-content rejection,
// not-found error path, and the project `updatedAt` bump.
//
// Same MELO_HOME-isolated pattern as src/state/desktopBootstrap.test.js
// and src/services/chat/chatExecutionRunner.test.js — mkdtemp before
// importing the runner, restore env in `after()`, refuse to ever touch
// the developer's real `~/.melo`.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, statSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

const REAL_HOME_STATE_PATH = join(homedir(), '.melo', 'desktop', 'state.json');
const REAL_HOME_GUARD_ENABLED = process.env.MELO_TEST_GUARD_REAL_HOME === '1';
const REAL_STATE_MTIME_BEFORE =
  REAL_HOME_GUARD_ENABLED && existsSync(REAL_HOME_STATE_PATH)
    ? statSync(REAL_HOME_STATE_PATH).mtimeMs
    : null;

const ORIGINAL_MELO_HOME = process.env.MELO_HOME;

function freshHome() {
  const dir = mkdtempSync(join(tmpdir(), 'melo-artifact-mutations-test-'));
  mkdirSync(join(dir, 'desktop'), { recursive: true });
  mkdirSync(join(dir, 'desktop', 'agents'), { recursive: true });
  mkdirSync(join(dir, 'desktop', 'threads'), { recursive: true });
  return dir;
}

function seed(home, state) {
  writeFileSync(join(home, 'desktop', 'state.json'), JSON.stringify(state));
}

function readPersistedState(home) {
  return JSON.parse(readFileSync(join(home, 'desktop', 'state.json'), 'utf8'));
}

const TEST_HOME = freshHome();
process.env.MELO_HOME = TEST_HOME;

const { updateArtifact, deleteArtifact } = await import('./workspaceMutations.js');

after(() => {
  try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
  if (ORIGINAL_MELO_HOME === undefined) {
    delete process.env.MELO_HOME;
  } else {
    process.env.MELO_HOME = ORIGINAL_MELO_HOME;
  }
  if (REAL_HOME_GUARD_ENABLED && REAL_STATE_MTIME_BEFORE !== null && existsSync(REAL_HOME_STATE_PATH)) {
    const after = statSync(REAL_HOME_STATE_PATH).mtimeMs;
    if (after > REAL_STATE_MTIME_BEFORE) {
      throw new Error(
        `MELO_HOME isolation regressed — ${REAL_HOME_STATE_PATH} was modified during this test suite.`,
      );
    }
  }
});

// ─── Fixtures ───────────────────────────────────────────────────────────────

function fixtureState({ artifacts = [], projects = [] } = {}) {
  return {
    projects,
    chats: [],
    tasks: [],
    approvals: [],
    artifacts,
    commandRuns: [],
    externalConnectors: [],
    externalToolRuns: [],
    agentProfiles: {
      main: {
        id: 'main', name: 'main', model: 'gpt-4', identity: '', soulMd: '',
        tools: [], skills: [], channels: {},
      },
    },
    projectAgentOverrides: {},
    settings: {
      selectedProjectId: null, selectedChatId: null, selectedAgentId: 'main',
      selectedConnectorId: null, selectedFilePath: null, activeMode: 'chat',
      promptHistory: [], enabledConnectorIds: [], enabledSkillIds: [], customSkills: [],
    },
  };
}

const baseArtifact = {
  id: 'art-1',
  chatId: 'chat-x',
  projectId: 'proj-x',
  title: 'Original title',
  kind: 'note',
  language: 'markdown',
  content: 'original content body',
  createdAt: '2025-01-01T00:00:00.000Z',
};

// ─── updateArtifact ─────────────────────────────────────────────────────────

test('updateArtifact: patches title only, preserves content + identity fields', async () => {
  seed(TEST_HOME, fixtureState({
    artifacts: [{ ...baseArtifact }],
    projects: [{ id: 'proj-x', name: 'demo', workspacePath: '/tmp/x', summary: '', tag: '', instructions: '', createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z' }],
  }));

  await updateArtifact('art-1', { title: 'New title' });

  const after = readPersistedState(TEST_HOME);
  const a = after.artifacts.find(x => x.id === 'art-1');
  assert.equal(a.title, 'New title');
  assert.equal(a.content, 'original content body');
  assert.equal(a.id, 'art-1');
  assert.equal(a.chatId, 'chat-x');
  assert.equal(a.projectId, 'proj-x');
  assert.equal(a.createdAt, '2025-01-01T00:00:00.000Z');

  // Project.updatedAt must have been bumped (was 2025-01-01 in seed).
  const project = after.projects.find(p => p.id === 'proj-x');
  assert.notEqual(project.updatedAt, '2025-01-01T00:00:00.000Z');
});

test('updateArtifact: empty / whitespace content rejected', async () => {
  seed(TEST_HOME, fixtureState({ artifacts: [{ ...baseArtifact, id: 'art-empty' }] }));

  await assert.rejects(
    () => updateArtifact('art-empty', { content: '   \n\t  ' }),
    /content cannot be empty/i,
  );

  // State unchanged.
  const after = readPersistedState(TEST_HOME);
  assert.equal(after.artifacts.find(x => x.id === 'art-empty').content, 'original content body');
});

test('updateArtifact: unknown id throws Artifact not found', async () => {
  seed(TEST_HOME, fixtureState());
  await assert.rejects(
    () => updateArtifact('does-not-exist', { title: 'x' }),
    /Artifact not found/,
  );
});

test('updateArtifact: missing artifactId throws', async () => {
  await assert.rejects(() => updateArtifact('', { title: 'x' }), /id is required/i);
  await assert.rejects(() => updateArtifact(null, { title: 'x' }), /id is required/i);
});

test('updateArtifact: language + kind + content all patched together, identity preserved', async () => {
  seed(TEST_HOME, fixtureState({ artifacts: [{ ...baseArtifact, id: 'art-multi' }] }));

  await updateArtifact('art-multi', {
    title: 'Renamed',
    language: 'python',
    kind: 'code',
    content: 'def hello(): pass',
  });

  const a = readPersistedState(TEST_HOME).artifacts.find(x => x.id === 'art-multi');
  assert.equal(a.title, 'Renamed');
  assert.equal(a.language, 'python');
  assert.equal(a.kind, 'code');
  assert.equal(a.content, 'def hello(): pass');
  // Identity / provenance preserved.
  assert.equal(a.id, 'art-multi');
  assert.equal(a.chatId, 'chat-x');
  assert.equal(a.projectId, 'proj-x');
  assert.equal(a.createdAt, '2025-01-01T00:00:00.000Z');
});

// ─── deleteArtifact ─────────────────────────────────────────────────────────

test('deleteArtifact: removes the matching row + bumps the owner project', async () => {
  seed(TEST_HOME, fixtureState({
    artifacts: [
      { ...baseArtifact, id: 'art-del' },
      { ...baseArtifact, id: 'art-keep', title: 'Keeper' },
    ],
    projects: [{ id: 'proj-x', name: 'demo', workspacePath: '/tmp/x', summary: '', tag: '', instructions: '', createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z' }],
  }));

  await deleteArtifact('art-del');

  const after = readPersistedState(TEST_HOME);
  assert.equal(after.artifacts.length, 1);
  assert.equal(after.artifacts[0].id, 'art-keep');

  const project = after.projects.find(p => p.id === 'proj-x');
  assert.notEqual(project.updatedAt, '2025-01-01T00:00:00.000Z');
});

test('deleteArtifact: unknown id throws Artifact not found', async () => {
  seed(TEST_HOME, fixtureState({ artifacts: [{ ...baseArtifact, id: 'art-only' }] }));

  await assert.rejects(
    () => deleteArtifact('does-not-exist'),
    /Artifact not found/,
  );

  // State unchanged — nothing removed.
  assert.equal(readPersistedState(TEST_HOME).artifacts.length, 1);
});

test('deleteArtifact: missing artifactId throws', async () => {
  await assert.rejects(() => deleteArtifact(''), /id is required/i);
  await assert.rejects(() => deleteArtifact(undefined), /id is required/i);
});
