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

// ─── G-1d slice 2: toolResults round-trip on assistant messages ───────────

test('normalizeChat: preserves toolResults with evidenceTrail on assistant message (G-1d slice 2)', () => {
  const c = normalizeChat({
    id: 'chat-1',
    messages: [
      {
        id: 'msg-1',
        role: 'assistant',
        content: 'I checked AUFB but the page returned no useful content.',
        toolResults: [
          {
            toolCallId: 'call_abc',
            toolName: 'fetch_url',
            ok: false,
            evidenceTrail: [
              { tier: 'jina', outcome: 'fail', latencyMs: 3500, reason: 'parse-empty' },
              { tier: 'direct', outcome: 'fail', latencyMs: 120, reason: 'parse-empty' },
              { tier: 'playwright', outcome: 'fail', latencyMs: 2200, reason: 'parse-empty' },
            ],
          },
        ],
      },
    ],
  });
  const m = c.messages[0];
  assert.ok(Array.isArray(m.toolResults), 'toolResults must be preserved as array');
  assert.equal(m.toolResults.length, 1);
  assert.equal(m.toolResults[0].toolCallId, 'call_abc');
  assert.equal(m.toolResults[0].toolName, 'fetch_url');
  assert.equal(m.toolResults[0].ok, false);
  assert.equal(m.toolResults[0].evidenceTrail.length, 3);
  assert.equal(m.toolResults[0].evidenceTrail[0].tier, 'jina');
});

test('normalizeChat: messages without toolResults have NO toolResults key (no spurious empty array)', () => {
  // Pure-text assistant messages (no tools fired) must not get a stray
  // `toolResults: []` — that would inflate JSON + UI would render an
  // empty trail block.  Conditional-spread protects this.
  const c = normalizeChat({
    id: 'chat-1',
    messages: [
      { id: 'm1', role: 'user', content: 'hi' },
      { id: 'm2', role: 'assistant', content: 'hello back' },
    ],
  });
  assert.ok(!('toolResults' in c.messages[0]), 'user msg: no toolResults key');
  assert.ok(!('toolResults' in c.messages[1]), 'pure-text assistant: no toolResults key');
});

test('normalizeChat: malformed toolResults entries are filtered defensively', () => {
  const c = normalizeChat({
    id: 'chat-1',
    messages: [
      {
        id: 'msg-1',
        role: 'assistant',
        content: 'x',
        toolResults: [
          null,                                                  // dropped
          undefined,                                             // dropped
          'string',                                              // dropped (non-object)
          { toolCallId: 'a', toolName: 'fetch_url', ok: true },  // kept (no trail = OK)
          { toolCallId: 'b', toolName: 'web_search', ok: false, evidenceTrail: 'not-an-array' }, // kept, trail dropped
          { toolCallId: 'c', toolName: 'social_link', ok: false, evidenceTrail: [null, { tier: 'jina', outcome: 'fail' }] }, // kept, malformed trail items dropped
        ],
      },
    ],
  });
  const trs = c.messages[0].toolResults;
  assert.equal(trs.length, 3, 'three valid entries survive (a/b/c), three malformed dropped');
  assert.equal(trs[0].toolCallId, 'a');
  assert.ok(!('evidenceTrail' in trs[0]), 'entry without trail keeps no trail key');
  assert.ok(!('evidenceTrail' in trs[1]), 'entry with non-array trail loses the field entirely');
  assert.equal(trs[2].evidenceTrail.length, 1, 'malformed trail items inside array are filtered');
  assert.equal(trs[2].evidenceTrail[0].tier, 'jina');
});

// ─── 架构 audit #2 round-2 (Codex C 闭环): errorCode round-trips ──────────
//
// toolResultProjection attaches a unified `errorCode` to failed search-tool
// results.  Pre-fix the hydration whitelist dropped it, so the persisted
// record / devtools overlay silently lost the code after reload.  These
// pin the round-trip: valid non-empty string survives, malformed dropped.

test('normalizeChat: preserves toolResults[].errorCode (unified SearchTask code) across hydration', () => {
  const c = normalizeChat({
    id: 'chat-1',
    messages: [
      {
        id: 'msg-1',
        role: 'assistant',
        content: 'search came back empty',
        toolResults: [
          {
            toolCallId: 'call_abc',
            toolName: 'web_search',
            ok: false,
            errorCode: 'NO_RESULTS',
            evidenceTrail: [{ tier: 'serp', outcome: 'fail', reason: 'no-results' }],
          },
        ],
      },
    ],
  });
  const tr = c.messages[0].toolResults[0];
  assert.equal(tr.errorCode, 'NO_RESULTS',
    'errorCode must survive the hydration round-trip — pre-fix the whitelist silently dropped it');
});

test('normalizeChat: malformed / absent errorCode is omitted (shape-validated, not enum-checked)', () => {
  const c = normalizeChat({
    id: 'chat-1',
    messages: [
      {
        id: 'msg-1',
        role: 'assistant',
        content: 'x',
        toolResults: [
          { toolCallId: 'a', toolName: 'web_search', ok: false, errorCode: 'NETWORK' },   // kept
          { toolCallId: 'b', toolName: 'web_search', ok: false, errorCode: '' },           // dropped (empty)
          { toolCallId: 'c', toolName: 'web_search', ok: false, errorCode: 42 },           // dropped (non-string)
          { toolCallId: 'd', toolName: 'fetch_url', ok: true },                            // no errorCode at all
        ],
      },
    ],
  });
  const trs = c.messages[0].toolResults;
  assert.equal(trs[0].errorCode, 'NETWORK', 'valid non-empty string survives');
  assert.ok(!('errorCode' in trs[1]), 'empty string dropped');
  assert.ok(!('errorCode' in trs[2]), 'non-string dropped');
  assert.ok(!('errorCode' in trs[3]), 'absent stays absent (no spurious key)');
});

test('normalizeChat: empty toolResults array → field stripped (no empty key)', () => {
  const c = normalizeChat({
    id: 'chat-1',
    messages: [{ id: 'm1', role: 'assistant', content: 'x', toolResults: [] }],
  });
  assert.ok(!('toolResults' in c.messages[0]),
    'empty array must produce no key — same conditional-spread rule as viz/citations');
});

test('normalizeChat: ok defaults to true when omitted on toolResult entry', () => {
  // Defensive: older state files might lack `ok` field; renderer would
  // misclassify success as failure without a default.  Normalize to true
  // (the more conservative "didn't say failed" interpretation).
  const c = normalizeChat({
    id: 'chat-1',
    messages: [{
      id: 'm1', role: 'assistant', content: 'x',
      toolResults: [{ toolCallId: 'a', toolName: 'fetch_url' /* no ok */ }],
    }],
  });
  assert.equal(c.messages[0].toolResults[0].ok, true);
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

// ─── Design audit D1/D2 (2026-10-17): record projection fields + tool-trace kind ─

test('normalizeChat keeps toolResults.argsHash/durationMs and the tool-trace message kind', () => {
  const c = normalizeChat({
    id: 'd1',
    messages: [
      { id: 'a', role: 'assistant', content: 'done', toolResults: [
        { toolCallId: 'c1', toolName: 'file_read', ok: true, argsHash: '0123456789abcdef', durationMs: 42.4 },
        { toolCallId: 'c2', toolName: 'bash', ok: false, argsHash: 'XYZ', durationMs: 'slow' },
      ] },
      { id: 't', role: 'assistant', kind: 'tool-trace', content: '[工具轨迹] …', metadata: { runId: 'r', toolTrace: { status: 'cancelled' } } },
      { id: 'u', role: 'user', kind: 'something-else', content: 'hi' },
    ],
  });
  assert.deepEqual(c.messages[0].toolResults[0], { toolCallId: 'c1', toolName: 'file_read', ok: true, argsHash: '0123456789abcdef', durationMs: 42 });
  assert.equal('argsHash' in c.messages[0].toolResults[1], false);
  assert.equal('durationMs' in c.messages[0].toolResults[1], false);
  assert.equal(c.messages[1].kind, 'tool-trace');
  assert.equal(c.messages[1].metadata.toolTrace.status, 'cancelled');
  assert.equal('kind' in c.messages[2], false, 'unknown kinds are still dropped');
});
