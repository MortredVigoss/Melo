import { requestEnvironment } from './requestScope.js';
import { homedir, tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// A test process never resolves to the user's data directory.
//
// Without MELO_HOME the home is `<project>/.tmp/melo-home-user`, which on a
// developer machine is the real data of the installed desktop app. Twice a
// test that restored MELO_HOME too early (a root-level `after()` next to
// top-level `await test()` runs when the first test ends) let later
// `saveState` calls replace the user's state and delete every conversation
// checkpoint that was not in the fixture (2026-11-07 and 2026-11-10). Fixing
// one test file does not stop the next one, so the fallback itself is closed:
// under the Node test runner, or when the entry script is a test file, a
// missing MELO_HOME (or one that points at the user home) resolves to a
// throwaway directory of this process instead. `MELO_ALLOW_USER_HOME_IN_TESTS=1`
// is the explicit opt-out; nothing in the repository sets it.
export function isTestProcess(env = process.env, argv = process.argv) {
  return Boolean(env.NODE_TEST_CONTEXT) || /\.test\.[cm]?js$/u.test(String(argv?.[1] || ''));
}
let isolatedHome = null;
function isolatedTestHome() {
  if (isolatedHome) return isolatedHome;
  isolatedHome = mkdtempSync(join(tmpdir(), 'melo-test-home-'));
  const created = isolatedHome;
  process.once('exit', () => { try { rmSync(created, { recursive: true, force: true }); } catch {} });
  return isolatedHome;
}

// Resolve once at the caller's entry point before scheduling asynchronous work.
export function resolveRuntimePaths({ env = requestEnvironment(), projectDir = PROJECT_DIR, userHome = homedir(), testProcess = isTestProcess() } = {}) {
  const explicitHome = String(env.MELO_HOME || '').trim();
  const userData = join(projectDir, '.tmp', 'melo-home-user');
  const isolated = testProcess && projectDir === PROJECT_DIR && env.MELO_ALLOW_USER_HOME_IN_TESTS !== '1' && process.env.MELO_ALLOW_USER_HOME_IN_TESTS !== '1'
    && (!explicitHome || resolve(explicitHome) === userData);
  const home = isolated ? isolatedTestHome() : resolve(explicitHome || userData);
  return Object.freeze({
    projectDir,
    home,
    source: isolated ? 'test-isolated' : explicitHome ? 'MELO_HOME' : 'desktop-default',
    legacyHome: join(userHome, '.melo'),
    configPath: join(home, 'config.json'),
    desktopDir: join(home, 'desktop'),
    runtimePath: join(home, 'desktop', 'runtime.json'),
  });
}
