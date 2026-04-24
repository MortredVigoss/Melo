// Unit tests for searchService. These never touch desktopStore or ripgrep —
// `resolveWorkspace` and `streamFn` are both injected. That's exactly the
// boundary the service exists to enforce: search orchestration must be
// testable without booting the desktop state machine.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  streamSearchFileGroups,
  streamSearchFileHits,
  MAX_SEARCH_FILE_GROUPS,
  MAX_LINES_PER_FILE_GROUP,
} from './searchService.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function fakeGroup(file, linesCount) {
  return {
    file,
    hits: Array.from({ length: linesCount }, (_, i) => ({
      file,
      lineNumber: i + 1,
      text: `${file}:${i + 1}`,
    })),
  };
}

async function* emitGroups(groups) {
  for (const g of groups) yield g;
}

// ─── Short-circuits ──────────────────────────────────────────────────────────

test('returns zeroed summary for empty query without touching resolver', async () => {
  let resolverCalls = 0;
  const summary = await streamSearchFileGroups('  ', 'proj-1', async () => {}, {
    resolveWorkspace: async () => {
      resolverCalls += 1;
      throw new Error('resolver should not be called for empty query');
    },
  });
  assert.deepEqual(summary, {
    query: '',
    projectId: 'proj-1',
    workspaceExists: false,
    groups: 0,
    hits: 0,
  });
  assert.equal(resolverCalls, 0);
});

test('returns workspaceExists=false when resolver reports no materialized folder', async () => {
  let streamCalls = 0;
  const summary = await streamSearchFileGroups('hello', '', async () => {}, {
    resolveWorkspace: async () => ({
      project: { id: 'proj-A' },
      workspace: { exists: false },
    }),
    streamFn: async function* () {
      streamCalls += 1;
      yield fakeGroup('x', 1);
    },
  });
  assert.equal(summary.workspaceExists, false);
  assert.equal(summary.groups, 0);
  assert.equal(summary.hits, 0);
  assert.equal(summary.projectId, 'proj-A');
  assert.equal(streamCalls, 0); // stream never invoked
});

// ─── Happy path ──────────────────────────────────────────────────────────────

test('forwards each group to onGroup and counts groups + hits', async () => {
  const seen = [];
  const groups = [fakeGroup('a.md', 3), fakeGroup('b.md', 2), fakeGroup('c.md', 1)];
  const summary = await streamSearchFileGroups(
    'needle',
    '',
    async group => { seen.push(group.file); },
    {
      resolveWorkspace: async () => ({
        project: { id: 'proj-B' },
        workspace: { exists: true, rootPath: '/tmp/ws' },
      }),
      streamFn: () => emitGroups(groups),
    },
  );
  assert.deepEqual(seen, ['a.md', 'b.md', 'c.md']);
  assert.equal(summary.groups, 3);
  assert.equal(summary.hits, 6);
  assert.equal(summary.workspaceExists, true);
  assert.equal(summary.projectId, 'proj-B');
});

test('counts group as 1 hit when group.hits is missing', async () => {
  const summary = await streamSearchFileGroups(
    'needle',
    '',
    async () => {},
    {
      resolveWorkspace: async () => ({
        project: { id: 'proj' },
        workspace: { exists: true, rootPath: '/ws' },
      }),
      streamFn: () => emitGroups([{ file: 'a' }, { file: 'b' }]),
    },
  );
  assert.equal(summary.groups, 2);
  assert.equal(summary.hits, 2); // each bare group counts as 1
});

test('passes MAX_SEARCH_FILE_GROUPS and MAX_LINES_PER_FILE_GROUP through to streamFn', async () => {
  let capturedOpts = null;
  await streamSearchFileGroups('x', '', async () => {}, {
    resolveWorkspace: async () => ({
      project: { id: 'p' },
      workspace: { exists: true, rootPath: '/ws' },
    }),
    streamFn: (_root, _q, opts) => {
      capturedOpts = opts;
      return emitGroups([]);
    },
  });
  assert.equal(capturedOpts.maxFiles, MAX_SEARCH_FILE_GROUPS);
  assert.equal(capturedOpts.hitsPerFile, MAX_LINES_PER_FILE_GROUP);
});

// ─── Error paths ─────────────────────────────────────────────────────────────

test('swallows ENOENT from streamFn as an empty result', async () => {
  const enoent = Object.assign(new Error('gone'), { code: 'ENOENT' });
  const summary = await streamSearchFileGroups('x', '', async () => {}, {
    resolveWorkspace: async () => ({
      project: { id: 'p' },
      workspace: { exists: true, rootPath: '/ws' },
    }),
    streamFn: async function* () { throw enoent; },
  });
  assert.equal(summary.workspaceExists, true);
  assert.equal(summary.groups, 0);
  assert.equal(summary.hits, 0);
});

test('re-throws non-ENOENT errors from streamFn', async () => {
  await assert.rejects(
    streamSearchFileGroups('x', '', async () => {}, {
      resolveWorkspace: async () => ({
        project: { id: 'p' },
        workspace: { exists: true, rootPath: '/ws' },
      }),
      streamFn: async function* () { throw new Error('boom'); },
    }),
    /boom/,
  );
});

test('throws synchronously when resolveWorkspace is not provided', async () => {
  await assert.rejects(
    streamSearchFileGroups('query', '', async () => {}, {}),
    /resolveWorkspace is required/,
  );
});

// ─── Back-compat adapter ─────────────────────────────────────────────────────

test('streamSearchFileHits flattens groups into line-level events', async () => {
  const flatHits = [];
  const summary = await streamSearchFileHits(
    'needle',
    '',
    async hit => { flatHits.push(`${hit.file}:${hit.lineNumber}`); },
    {
      resolveWorkspace: async () => ({
        project: { id: 'p' },
        workspace: { exists: true, rootPath: '/ws' },
      }),
      streamFn: () => emitGroups([fakeGroup('a', 2), fakeGroup('b', 1)]),
    },
  );
  assert.deepEqual(flatHits, ['a:1', 'a:2', 'b:1']);
  // Summary still reflects the group-level shape, not the flattened count.
  assert.equal(summary.groups, 2);
  assert.equal(summary.hits, 3);
});
