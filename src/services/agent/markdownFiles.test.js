/**
 * src/services/agent/markdownFiles.test.js
 *
 * Coverage for `createAgentMarkdownFileHelpers` — specifically the
 * `agentsDir` parameter's dual-form support (string OR `() => string`).
 *
 * Why now: G-6 #6 (2026-05-12) refactors `desktopStore.js` to pass the
 * **function form** instead of a module-load string constant.  The factory
 * has supported the function form since Phase 7d-5α-A1 (per the docstring),
 * but no test exercised that branch — so the desktopStore caller was the
 * first real user.  This file pins both forms and the empty-arg throw so
 * a future refactor to "simplify by always treating as string" breaks
 * loudly instead of silently freezing MELO_HOME at module load.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentMarkdownFileHelpers } from './markdownFiles.js';

// ─── string-form binding (literal path, never re-evaluated) ─────────────────

test('string-form agentsDir: getAgentMarkdownPaths uses the literal value', () => {
  const { getAgentMarkdownPaths } = createAgentMarkdownFileHelpers({
    agentsDir: '/tmp/melo-test-A/desktop/agents',
  });
  const paths = getAgentMarkdownPaths('agent-001');
  assert.equal(paths.dir, '/tmp/melo-test-A/desktop/agents/global/agent-001');
  assert.match(paths.identityPath, /\/IDENTITY\.md$/);
  assert.match(paths.soulPath, /\/SOUL\.md$/);
});

test('string-form: project-scoped paths include the projectId', () => {
  const { getAgentMarkdownPaths } = createAgentMarkdownFileHelpers({
    agentsDir: '/tmp/melo-test-A/desktop/agents',
  });
  const paths = getAgentMarkdownPaths('agent-001', {
    scope: 'project',
    projectId: 'proj-42',
  });
  assert.equal(paths.dir, '/tmp/melo-test-A/desktop/agents/projects/proj-42/agent-001');
});

test('string-form: missing projectId falls back to "default-project"', () => {
  const { getAgentMarkdownPaths } = createAgentMarkdownFileHelpers({
    agentsDir: '/x/y/agents',
  });
  const paths = getAgentMarkdownPaths('agent-x', { scope: 'project' });
  assert.match(paths.dir, /\/projects\/default-project\/agent-x$/);
});

// ─── function-form binding (re-resolved on each call) ───────────────────────

test('function-form agentsDir: getter re-resolves on every getAgentMarkdownPaths call', () => {
  // This is the G-6 #6 invariant — desktopStore passes a `() => string`
  // getter so a runtime/test MELO_HOME flip propagates without rebinding.
  let current = '/tmp/melo-test-A/desktop/agents';
  const { getAgentMarkdownPaths } = createAgentMarkdownFileHelpers({
    agentsDir: () => current,
  });

  const pathsA = getAgentMarkdownPaths('agent-1');
  assert.match(pathsA.dir, /^\/tmp\/melo-test-A\//);

  // Flip the underlying source — next call must reflect it.
  current = '/tmp/melo-test-B/desktop/agents';
  const pathsB = getAgentMarkdownPaths('agent-1');
  assert.match(pathsB.dir, /^\/tmp\/melo-test-B\//,
    'function-form must re-resolve agentsDir on each call (the whole point of the form)');
  assert.notEqual(pathsA.dir, pathsB.dir);
});

test('function-form: getter is called once per getAgentMarkdownPaths invocation', () => {
  let callCount = 0;
  const { getAgentMarkdownPaths } = createAgentMarkdownFileHelpers({
    agentsDir: () => {
      callCount += 1;
      return '/tmp/observed/agents';
    },
  });
  callCount = 0;
  getAgentMarkdownPaths('a');
  assert.equal(callCount, 1, 'one path resolution = one getter call');
  getAgentMarkdownPaths('b');
  assert.equal(callCount, 2);
});

// ─── invalid input ──────────────────────────────────────────────────────────

test('missing agentsDir throws (defensive — factory contract requires it)', () => {
  assert.throws(() => createAgentMarkdownFileHelpers({}), /agentsDir is required/);
  assert.throws(() => createAgentMarkdownFileHelpers({ agentsDir: '' }), /agentsDir is required/);
  assert.throws(() => createAgentMarkdownFileHelpers({ agentsDir: null }), /agentsDir is required/);
});

// ─── source-level guard against re-introducing the freeze ───────────────────

test('source-level guard: agent mutations do NOT re-introduce `const DESKTOP_DIR = join(getMeloHome()…)`', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const here = dirname(fileURLToPath(import.meta.url));
  // src/services/agent/ → src/desktopStore.js is ../../desktopStore.js
  const source = readFileSync(join(here, 'agentMutations.js'), 'utf8');
  assert.equal(
    /const\s+DESKTOP_DIR\s*=\s*join\(\s*getMeloHome\(\)/.test(source),
    false,
    'DESKTOP_DIR must not be a module-load-time const (CLAUDE.md §6, G-6 #6)',
  );
  assert.equal(
    /const\s+AGENTS_DIR\s*=\s*join\(/.test(source),
    false,
    'AGENTS_DIR must not be a module-load-time const',
  );
  // The extracted domain module resolves the factory root at call time.
  assert.match(source, /const\s+agentsDir\s*=\s*\(\)\s*=>\s*join\(getMeloHome\(\)/);
  assert.match(source, /createAgentMarkdownFileHelpers\(\{ agentsDir \}\)/);
});
