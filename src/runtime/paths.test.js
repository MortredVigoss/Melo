import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRuntimePaths } from './paths.js';
import { getMeloHome as getMemoryHome } from '../memory/status.js';
import { getMeloHome as getConfigHome } from '../config.js';

test('memory status and config resolve the same default and explicit data homes', () => {
  const previous = process.env.MELO_HOME;
  try {
    delete process.env.MELO_HOME;
    assert.equal(getMemoryHome(), getConfigHome());
    assert.match(getMemoryHome(), /\.tmp\/melo-home-user$/);
    process.env.MELO_HOME = '/isolated/memory-status';
    assert.equal(getMemoryHome(), getConfigHome());
    assert.equal(getMemoryHome(), '/isolated/memory-status');
  } finally {
    if (previous === undefined) delete process.env.MELO_HOME;
    else process.env.MELO_HOME = previous;
  }
});

test('desktop, CLI and diagnostics use the same project data home by default', () => {
  const paths = resolveRuntimePaths({ env: {}, projectDir: '/melo/project', userHome: '/users/me' });
  assert.equal(paths.home, '/melo/project/.tmp/melo-home-user');
  assert.equal(paths.configPath, '/melo/project/.tmp/melo-home-user/config.json');
  assert.equal(paths.legacyHome, '/users/me/.melo');
  assert.equal(paths.source, 'desktop-default');
});

test('explicit homes remain isolated and paths are captured before async work', async () => {
  const env = { MELO_HOME: '/isolated/A' };
  const paths = resolveRuntimePaths({ env, projectDir: '/melo/project' });
  env.MELO_HOME = '/isolated/B';
  await Promise.resolve();
  assert.equal(paths.home, '/isolated/A');
  assert.equal(paths.source, 'MELO_HOME');
  assert.notEqual(paths.home, resolveRuntimePaths({ env }).home);
});
