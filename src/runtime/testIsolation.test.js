import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { resolveRuntimePaths, isTestProcess, PROJECT_DIR } from './paths.js';

// The user's data directory is the fallback when MELO_HOME is unset. On
// 2026-11-07 and again on 2026-11-10 a test file that restored MELO_HOME too
// early let `saveState` replace the real state of the installed app and delete
// its conversation checkpoints. These tests pin the two defences: a test
// process cannot resolve to the user home at all, and the lifecycle that
// restored MELO_HOME early is rejected in every test file.

const userData = join(PROJECT_DIR, '.tmp', 'melo-home-user');

test('a test process without MELO_HOME gets a throwaway home, never the user data directory', () => {
  assert.equal(isTestProcess(), true, 'this file runs under the test runner');
  const paths = resolveRuntimePaths({ env: {} });
  assert.equal(paths.source, 'test-isolated');
  assert.notEqual(paths.home, userData);
  assert.equal(paths.home.startsWith(resolve(tmpdir())) || paths.home.includes('melo-test-home-'), true, paths.home);
  assert.equal(resolveRuntimePaths({ env: {} }).home, paths.home, 'one throwaway home per process');
  // An explicit MELO_HOME that points at the user data is closed the same way.
  assert.equal(resolveRuntimePaths({ env: { MELO_HOME: userData } }).source, 'test-isolated');
  assert.equal(resolveRuntimePaths({ env: { MELO_HOME: userData + '/' } }).home, paths.home);
  // Any other explicit home is honoured, and the opt-out is explicit.
  assert.equal(resolveRuntimePaths({ env: { MELO_HOME: '/isolated/A' } }).home, '/isolated/A');
  assert.equal(resolveRuntimePaths({ env: { MELO_ALLOW_USER_HOME_IN_TESTS: '1' } }).home, userData);
  // Outside a test process nothing changes.
  const app = resolveRuntimePaths({ env: {}, testProcess: false });
  assert.equal(app.home, userData); assert.equal(app.source, 'desktop-default');
  assert.equal(isTestProcess({}, ['node', '/x/src/server.js']), false);
  assert.equal(isTestProcess({}, ['node', '/x/src/a.test.js']), true);
  assert.equal(isTestProcess({ NODE_TEST_CONTEXT: 'child-v8' }, ['node', '/x/run.js']), true);
});

test('a test that drops MELO_HOME and saves state cannot reach the user data directory', () => {
  // The exact failure: MELO_HOME is deleted in the middle of a test file and
  // saveState runs afterwards. The child reports where the state was written.
  const dir = mkdtempSync(join(tmpdir(), 'melo-isolation-probe-'));
  try {
    const probe = join(dir, 'probe.test.js');
    writeFileSync(probe, `
      import test from 'node:test';
      import { existsSync } from 'node:fs';
      import { join } from 'node:path';
      delete process.env.MELO_HOME;
      const { saveState } = await import(${JSON.stringify(join(PROJECT_DIR, 'src/state/stateStore.js'))});
      const { resolveRuntimePaths } = await import(${JSON.stringify(join(PROJECT_DIR, 'src/runtime/paths.js'))});
      test('probe', async () => {
        await saveState({ projects: [], chats: [{ id: 'isolation-probe', title: 'probe', mode: 'chat', messages: [] }], tasks: [], approvals: [], artifacts: [], commandRuns: [], externalConnectors: [], agentProfiles: {}, projectAgentOverrides: {}, settings: {} });
        const paths = resolveRuntimePaths();
        console.log('PROBE ' + JSON.stringify({ home: paths.home, source: paths.source, wrote: existsSync(join(paths.home, 'desktop', 'state.json')) }));
      });
    `);
    const before = existsSync(join(userData, 'desktop', 'state.json')) ? statSync(join(userData, 'desktop', 'state.json')).mtimeMs : null;
    // Once as a test file started directly (recognised by its name), once as any
    // script under the test runner's environment (recognised by NODE_TEST_CONTEXT).
    // A nested `node --test` is skipped by Node itself, so the files are run directly.
    const plain = join(dir, 'probe-script.mjs');
    writeFileSync(plain, readFileSync(probe, 'utf8'));
    for (const [script, context] of [[probe, null], [plain, 'child-v8']]) {
      const env = { ...process.env }; delete env.MELO_HOME; delete env.MELO_ALLOW_USER_HOME_IN_TESTS; delete env.NODE_TEST_CONTEXT;
      if (context) env.NODE_TEST_CONTEXT = context;
      const child = spawnSync(process.execPath, [script], { env, encoding: 'utf8', timeout: 60000 });
      const line = (child.stdout + child.stderr).split('\n').find(row => row.includes('PROBE '));
      assert.ok(line, child.stdout + child.stderr);
      const report = JSON.parse(line.slice(line.indexOf('PROBE ') + 6));
      assert.equal(report.source, 'test-isolated', script);
      assert.equal(report.wrote, true, 'the state went to the throwaway home');
      assert.notEqual(report.home, userData);
    }
    const after = existsSync(join(userData, 'desktop', 'state.json')) ? statSync(join(userData, 'desktop', 'state.json')).mtimeMs : null;
    assert.equal(after, before, 'the user state file was not touched');
    assert.equal(existsSync(join(userData, 'desktop', 'threads', 'isolation-probe.json')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('no test file restores MELO_HOME from a root-level after() next to top-level await test()', () => {
  // A root-level after() runs when the first top-level test ends, not when the
  // file ends; with later tests in the same file the restored environment is
  // what they run under. Use one parent test with t.after, or clean up at the
  // end of the file.
  const offenders = [];
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { walk(path); continue; }
      if (!/\.test\.[cm]?js$/u.test(entry.name)) continue;
      const source = readFileSync(path, 'utf8');
      if (!/process\.env\.MELO_HOME\s*=/u.test(source)) continue;
      const rootAfter = /^after\(/mu.test(source);
      const topLevelAwait = /^(?:await test\(|for\s*\([^\n]*\)\s*await test\()/mu.test(source);
      if (rootAfter && topLevelAwait) offenders.push(relative(PROJECT_DIR, path));
    }
  };
  for (const root of ['src', 'shared', 'scripts', 'mobile-sync', 'desktop-ui']) if (existsSync(join(PROJECT_DIR, root))) walk(join(PROJECT_DIR, root));
  assert.deepEqual(offenders, []);
});
