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

async function seed(home, state) {
  // Use the state-store API so fixture replacement also invalidates resident
  // projections and checkpoints left by the preceding mutation test.
  const { runWithRequestContext } = await import('../../runtime/requestScope.js');
  const { saveState } = await import('../../state/stateStore.js');
  await runWithRequestContext({ env: { ...process.env, MELO_HOME: home } }, () => saveState(state));
}

function readPersistedState(home) {
  return JSON.parse(readFileSync(join(home, 'desktop', 'state.json'), 'utf8'));
}

const TEST_HOME = freshHome();
process.env.MELO_HOME = TEST_HOME;

const {
  updateArtifact,
  deleteArtifact,
  restoreArtifact,
  purgeStaleSoftDeletes,
  applyArtifactToWorkspaceFile,
} = await import('./workspaceMutations.js');

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
  await seed(TEST_HOME, fixtureState({
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
  await seed(TEST_HOME, fixtureState({ artifacts: [{ ...baseArtifact, id: 'art-empty' }] }));

  await assert.rejects(
    () => updateArtifact('art-empty', { content: '   \n\t  ' }),
    /content cannot be empty/i,
  );

  // State unchanged.
  const after = readPersistedState(TEST_HOME);
  assert.equal(after.artifacts.find(x => x.id === 'art-empty').content, 'original content body');
});

test('updateArtifact: unknown id throws Artifact not found', async () => {
  await seed(TEST_HOME, fixtureState());
  await assert.rejects(
    () => updateArtifact('does-not-exist', { title: 'x' }),
    /Artifact not found/,
  );
});

test('updateArtifact: rejects soft-deleted rows (id reachable but tombstoned)', async () => {
  // The bootstrap hides soft-deleted rows from the UI so this is mostly
  // a defence-in-depth test — but a stale id round-tripping through a
  // long-lived chat / external caller must not be allowed to mutate
  // a tombstone (Codex 2026-04-27 audit).
  await seed(TEST_HOME, fixtureState({
    artifacts: [{ ...baseArtifact, id: 'art-tomb', deletedAt: '2026-04-26T12:00:00.000Z' }],
  }));

  await assert.rejects(
    () => updateArtifact('art-tomb', { title: 'sneaky' }),
    /Artifact not found/,
  );

  // State unchanged — the row stays tombstoned with its original title.
  const after = readPersistedState(TEST_HOME).artifacts.find(a => a.id === 'art-tomb');
  assert.equal(after.title, baseArtifact.title);
  assert.equal(after.deletedAt, '2026-04-26T12:00:00.000Z');
});

test('updateArtifact: missing artifactId throws', async () => {
  await assert.rejects(() => updateArtifact('', { title: 'x' }), /id is required/i);
  await assert.rejects(() => updateArtifact(null, { title: 'x' }), /id is required/i);
});

test('updateArtifact: language + kind + content all patched together, identity preserved', async () => {
  await seed(TEST_HOME, fixtureState({ artifacts: [{ ...baseArtifact, id: 'art-multi' }] }));

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

// ─── deleteArtifact (now soft-delete) ───────────────────────────────────────

test('deleteArtifact: stamps deletedAt instead of dropping the row + bumps the owner project', async () => {
  await seed(TEST_HOME, fixtureState({
    artifacts: [
      { ...baseArtifact, id: 'art-del' },
      { ...baseArtifact, id: 'art-keep', title: 'Keeper' },
    ],
    projects: [{ id: 'proj-x', name: 'demo', workspacePath: '/tmp/x', summary: '', tag: '', instructions: '', createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z' }],
  }));

  await deleteArtifact('art-del');

  const after = readPersistedState(TEST_HOME);
  // Both rows still on disk — soft-delete keeps the data so undo + GC
  // can reach it without round-tripping the client.
  assert.equal(after.artifacts.length, 2);

  const deleted = after.artifacts.find(a => a.id === 'art-del');
  const kept = after.artifacts.find(a => a.id === 'art-keep');
  assert.ok(typeof deleted.deletedAt === 'string' && Date.parse(deleted.deletedAt));
  assert.ok(!kept.deletedAt);

  const project = after.projects.find(p => p.id === 'proj-x');
  assert.notEqual(project.updatedAt, '2025-01-01T00:00:00.000Z');
});

test('deleteArtifact: bootstrap response hides soft-deleted rows', async () => {
  await seed(TEST_HOME, fixtureState({
    artifacts: [
      { ...baseArtifact, id: 'art-hidden' },
      { ...baseArtifact, id: 'art-visible', title: 'Visible' },
    ],
    projects: [{ id: 'proj-x', name: 'demo', workspacePath: '/tmp/x', summary: '', tag: '', instructions: '', createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z' }],
  }));

  const bootstrap = await deleteArtifact('art-hidden');
  const ids = (bootstrap.artifacts || []).map(a => a.id);
  assert.ok(!ids.includes('art-hidden'), 'soft-deleted artifact must not appear in bootstrap.artifacts');
  assert.ok(ids.includes('art-visible'));
});

test('deleteArtifact: unknown id throws Artifact not found', async () => {
  await seed(TEST_HOME, fixtureState({ artifacts: [{ ...baseArtifact, id: 'art-only' }] }));

  await assert.rejects(
    () => deleteArtifact('does-not-exist'),
    /Artifact not found/,
  );

  // State unchanged — nothing soft-deleted.
  const after = readPersistedState(TEST_HOME);
  assert.equal(after.artifacts.length, 1);
  assert.ok(!after.artifacts[0].deletedAt);
});

test('deleteArtifact: double-delete throws Artifact not found (already soft-deleted)', async () => {
  await seed(TEST_HOME, fixtureState({
    artifacts: [{ ...baseArtifact, id: 'art-once', deletedAt: '2025-01-02T00:00:00.000Z' }],
  }));

  await assert.rejects(
    () => deleteArtifact('art-once'),
    /Artifact not found/,
  );
});

test('deleteArtifact: missing artifactId throws', async () => {
  await assert.rejects(() => deleteArtifact(''), /id is required/i);
  await assert.rejects(() => deleteArtifact(undefined), /id is required/i);
});

// ─── restoreArtifact ────────────────────────────────────────────────────────

test('restoreArtifact: clears deletedAt + bumps owner project', async () => {
  await seed(TEST_HOME, fixtureState({
    artifacts: [{ ...baseArtifact, id: 'art-r', deletedAt: '2025-01-02T00:00:00.000Z' }],
    projects: [{ id: 'proj-x', name: 'demo', workspacePath: '/tmp/x', summary: '', tag: '', instructions: '', createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z' }],
  }));

  const bootstrap = await restoreArtifact('art-r');
  const restored = readPersistedState(TEST_HOME).artifacts.find(a => a.id === 'art-r');
  assert.equal(restored.deletedAt, undefined);

  // Reappears in bootstrap.
  const ids = (bootstrap.artifacts || []).map(a => a.id);
  assert.ok(ids.includes('art-r'));

  const project = readPersistedState(TEST_HOME).projects.find(p => p.id === 'proj-x');
  assert.notEqual(project.updatedAt, '2025-01-01T00:00:00.000Z');
});

test('restoreArtifact: unknown id throws Artifact not found', async () => {
  await seed(TEST_HOME, fixtureState({ artifacts: [{ ...baseArtifact, id: 'art-only' }] }));
  await assert.rejects(() => restoreArtifact('nope'), /Artifact not found/);
});

test('restoreArtifact: row that was never soft-deleted throws', async () => {
  await seed(TEST_HOME, fixtureState({ artifacts: [{ ...baseArtifact, id: 'art-live' }] }));
  await assert.rejects(() => restoreArtifact('art-live'), /not soft-deleted/);
});

test('restoreArtifact: missing id throws', async () => {
  await assert.rejects(() => restoreArtifact(''), /id is required/i);
});

// ─── purgeStaleSoftDeletes ──────────────────────────────────────────────────

test('purgeStaleSoftDeletes: drops rows whose deletedAt is older than the cutoff', async () => {
  const oldIso = '2025-01-01T00:00:00.000Z';   // ~13 months before nowMs
  const recentIso = '2026-04-26T12:00:00.000Z'; // 1 day before nowMs
  const nowMs = Date.parse('2026-04-27T12:00:00.000Z');

  await seed(TEST_HOME, fixtureState({
    artifacts: [
      { ...baseArtifact, id: 'old',    deletedAt: oldIso },
      { ...baseArtifact, id: 'recent', deletedAt: recentIso },
      { ...baseArtifact, id: 'live' }, // no deletedAt — must survive
    ],
  }));

  const result = await purgeStaleSoftDeletes({ olderThanDays: 7, nowMs });
  assert.equal(result.purged, 1);

  const ids = readPersistedState(TEST_HOME).artifacts.map(a => a.id);
  assert.ok(!ids.includes('old'), 'old soft-deleted row should be evicted');
  assert.ok(ids.includes('recent'), 'recent soft-deleted row stays for the undo window');
  assert.ok(ids.includes('live'));
});

test('purgeStaleSoftDeletes: idempotent — second run drops nothing', async () => {
  const oldIso = '2025-01-01T00:00:00.000Z';
  const nowMs = Date.parse('2026-04-27T12:00:00.000Z');

  await seed(TEST_HOME, fixtureState({
    artifacts: [{ ...baseArtifact, id: 'old', deletedAt: oldIso }],
  }));

  const first = await purgeStaleSoftDeletes({ olderThanDays: 7, nowMs });
  assert.equal(first.purged, 1);
  const second = await purgeStaleSoftDeletes({ olderThanDays: 7, nowMs });
  assert.equal(second.purged, 0);
});

test('purgeStaleSoftDeletes: keeps rows with unparseable deletedAt (defensive)', async () => {
  await seed(TEST_HOME, fixtureState({
    artifacts: [{ ...baseArtifact, id: 'broken', deletedAt: 'not-a-date' }],
  }));

  const result = await purgeStaleSoftDeletes({ olderThanDays: 7, nowMs: Date.now() });
  assert.equal(result.purged, 0);
  const ids = readPersistedState(TEST_HOME).artifacts.map(a => a.id);
  assert.ok(ids.includes('broken'));
});

// ─── applyArtifactToWorkspaceFile soft-delete gate ──────────────────────────

test('applyArtifactToWorkspaceFile: rejects soft-deleted artifact ids', async () => {
  // A stale or buggy caller must not be able to write tombstoned
  // content back to the workspace via /api/artifacts/apply (Codex
  // 2026-04-27 🔵 finding).  The pre-flight check throws before
  // applyArtifactContentToWorkspaceService is reached, so no file IO
  // happens — we only need to assert the error path here.
  await seed(TEST_HOME, fixtureState({
    artifacts: [{ ...baseArtifact, id: 'art-deleted', deletedAt: '2026-04-26T12:00:00.000Z' }],
  }));

  await assert.rejects(
    () => applyArtifactToWorkspaceFile({ artifactId: 'art-deleted', filePath: 'x.md' }),
    /Artifact not found/,
  );
});

test('applyArtifactToWorkspaceFile: unknown id throws Artifact not found', async () => {
  await seed(TEST_HOME, fixtureState({ artifacts: [] }));
  await assert.rejects(
    () => applyArtifactToWorkspaceFile({ artifactId: 'nope' }),
    /Artifact not found/,
  );
});
