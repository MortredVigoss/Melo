// Tests for stateHydration. Most coverage is integration-shaped (the
// helpers operate on whole `state` blobs and chat objects), so these
// focus on the corners byte-for-byte review caught us missing — chiefly
// the sanitizeWorkspacePath wrapper that binds APP_ROOT for relative
// project paths.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import {
  normalizeProject,
  normalizeChat,
  createDefaultState,
  hydrateState,
  hydrateChatThreads,
  BUILTIN_CONNECTORS,
} from './stateHydration.js';
import {
  saveThreadCheckpoint,
  invalidateThreadCheckpointCache,
} from '../memory/checkpointer.js';

// ─── normalizeProject — relative workspacePath regression ───────────────────
//
// Phase 7d-5α-A1 commit 7 originally extracted normalizeProject's local
// wrapper without preserving its 1-arg `sanitizeWorkspacePath` binding.
// Codex review caught the bug at C-grade: when a stored project carried
// a relative `workspacePath` (older states did), normalizeProject would
// throw `TypeError: resolve(undefined, …)` from inside the underlying
// 2-arg sanitizer. These tests pin that the wrapper resolves relative
// paths to APP_ROOT.

test('normalizeProject: relative workspacePath resolves to absolute under APP_ROOT', () => {
  const result = normalizeProject({
    id: 'proj-rel',
    name: 'Relative path test',
    workspacePath: 'relative-folder',
  });
  assert.equal(typeof result.workspacePath, 'string');
  assert.ok(
    isAbsolute(result.workspacePath),
    `expected absolute path, got "${result.workspacePath}"`,
  );
  assert.ok(
    result.workspacePath.endsWith('/relative-folder'),
    `expected suffix /relative-folder, got "${result.workspacePath}"`,
  );
});

test('normalizeProject: nested relative workspacePath also resolves under APP_ROOT', () => {
  const result = normalizeProject({
    id: 'proj-nested',
    name: 'Nested relative',
    workspacePath: 'a/b/c',
  });
  assert.ok(isAbsolute(result.workspacePath));
  assert.ok(result.workspacePath.endsWith('/a/b/c'));
});

test('normalizeProject: absolute workspacePath is preserved verbatim', () => {
  const result = normalizeProject({
    id: 'proj-abs',
    name: 'Absolute',
    workspacePath: '/tmp/melo-test/abs-ws',
  });
  assert.equal(result.workspacePath, '/tmp/melo-test/abs-ws');
});

test('normalizeProject: empty workspacePath does not crash and produces a valid project', () => {
  const result = normalizeProject({
    id: 'proj-empty',
    name: 'Empty ws',
    workspacePath: '',
  });
  // The exact behavior of sanitization on '' is the underlying primitive's
  // call — what we verify here is that the wrapper does not throw.
  assert.equal(typeof result, 'object');
  assert.equal(result.id, 'proj-empty');
});

// ─── hydrateState — integration through the same path ──────────────────────

test('hydrateState: a persisted project with relative workspacePath survives hydration', () => {
  const out = hydrateState({
    projects: [
      { id: 'proj-r1', name: 'Stored relative', workspacePath: 'workdir' },
    ],
  });
  assert.equal(out.projects.length, 1);
  const project = out.projects[0];
  assert.ok(isAbsolute(project.workspacePath));
  assert.ok(project.workspacePath.endsWith('/workdir'));
});

test('hydrateState: dropping the legacy "How to use Melo" example still works', () => {
  const out = hydrateState({
    projects: [
      // The pristine legacy example — must be filtered out.
      { id: 'example-project', name: 'How to use Melo', workspacePath: '' },
      { id: 'real-proj', name: 'My work', workspacePath: 'my-work' },
    ],
  });
  // Only the real project survives.
  assert.equal(out.projects.length, 1);
  assert.equal(out.projects[0].id, 'real-proj');
});

test('hydrateState: a renamed legacy example is preserved (user owns it now)', () => {
  const out = hydrateState({
    projects: [
      // Same id, different name → user renamed it, keep.
      { id: 'example-project', name: 'My renamed project', workspacePath: '' },
    ],
  });
  assert.equal(out.projects.length, 1);
  assert.equal(out.projects[0].name, 'My renamed project');
});

// ─── createDefaultState ─────────────────────────────────────────────────────

test('createDefaultState: returns the fresh-boot shape', () => {
  const s = createDefaultState();
  assert.equal(s.settings.activeView, 'chat');
  assert.equal(s.settings.selectedAgentId, 'main');
  assert.equal(s.settings.selectedConnectorId, BUILTIN_CONNECTORS[0].id);
  assert.deepEqual(s.chats, []);
  assert.deepEqual(s.projects, []);
  assert.deepEqual(s.tasks, []);
  assert.deepEqual(s.approvals, []);
});

// ─── normalizeChat (small smoke) ────────────────────────────────────────────

test('normalizeChat: minimal input produces a complete chat record', () => {
  const c = normalizeChat({});
  assert.equal(typeof c.id, 'string');
  assert.ok(c.id.length > 0);
  assert.equal(c.title, 'New chat');
  assert.equal(c.mode, 'chat');
  assert.equal(c.agentId, 'main');
  assert.equal(c.source, 'desktop');
  assert.equal(c.chatType, 'private');
  assert.equal(c.locked, false);
  assert.deepEqual(c.messages, []);
  assert.deepEqual(c.sessionMemory, []);
});

test('normalizeChat: preserves existing message metadata + viz/citations', () => {
  const c = normalizeChat({
    id: 'chat-1',
    messages: [
      {
        id: 'msg-1',
        role: 'assistant',
        content: 'hi',
        viz: { type: 'mermaid', source: 'graph TD' },
        citations: [{ filePath: 'a.md', startLine: 1, endLine: 2 }],
        metadata: { verificationRecord: { verdict: 'CORRECTED' } },
      },
    ],
  });
  const m = c.messages[0];
  assert.deepEqual(m.viz, { type: 'mermaid', source: 'graph TD' });
  assert.deepEqual(m.citations, [{ filePath: 'a.md', startLine: 1, endLine: 2 }]);
  assert.deepEqual(m.metadata, { verificationRecord: { verdict: 'CORRECTED' } });
});

test('hydrateChatThreads: restores runtime session memory and compact state from checkpoint', async () => {
  const threadsDir = await mkdtemp(join(tmpdir(), 'melo-thread-runtime-'));
  try {
    await saveThreadCheckpoint('runtime-chat', {
      version: 1,
      threadId: 'runtime-chat',
      createdAt: '2026-05-01T00:00:00.000Z',
      updatedAt: '2026-05-01T00:01:00.000Z',
      messages: [
        {
          id: 'msg-runtime-1',
          role: 'user',
          content: 'remember I prefer concise notes',
          createdAt: '2026-05-01T00:01:00.000Z',
        },
      ],
      derived: {
        chatRuntime: {
          sessionMemory: [
            {
              fact: 'User prefers concise notes',
              category: 'preference',
              extractedAt: '2026-05-01T00:01:05.000Z',
            },
          ],
          memoryLastExtractedAt: 1,
          memoryLastExtractedAtCount: 1,
          compactSummary: 'Earlier context was compacted.',
          compactBoundaryMessageId: 'msg-runtime-1',
          compactedMessageCount: 12,
          compactedAt: '2026-05-01T00:02:00.000Z',
          compactFailures: 0,
        },
      },
    }, { threadsDir });

    const state = {
      chats: [
        {
          id: 'runtime-chat',
          title: 'Runtime chat',
          createdAt: '2026-05-01T00:00:00.000Z',
          updatedAt: '2026-05-01T00:01:00.000Z',
        },
      ],
    };

    await hydrateChatThreads(state, { threadsDir });
    const chat = state.chats[0];
    assert.deepEqual(chat.sessionMemory, [
      {
        fact: 'User prefers concise notes',
        category: 'preference',
        extractedAt: '2026-05-01T00:01:05.000Z',
      },
    ]);
    assert.equal(chat.memoryLastExtractedAt, 1);
    assert.equal(chat.memoryLastExtractedAtCount, 1);
    assert.equal(chat.compactSummary, 'Earlier context was compacted.');
    assert.equal(chat.compactBoundaryMessageId, 'msg-runtime-1');
    assert.equal(chat.compactedMessageCount, 12);
    assert.equal(chat.compactedAt, '2026-05-01T00:02:00.000Z');
  } finally {
    invalidateThreadCheckpointCache(null, { threadsDir });
    await rm(threadsDir, { recursive: true, force: true });
  }
});
