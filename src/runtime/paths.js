import { requestEnvironment } from './requestScope.js';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// Resolve once at the caller's entry point before scheduling asynchronous work.
export function resolveRuntimePaths({ env = requestEnvironment(), projectDir = PROJECT_DIR, userHome = homedir() } = {}) {
  const explicitHome = String(env.MELO_HOME || '').trim();
  const home = resolve(explicitHome || join(projectDir, '.tmp', 'melo-home-user'));
  return Object.freeze({
    projectDir,
    home,
    source: explicitHome ? 'MELO_HOME' : 'desktop-default',
    legacyHome: join(userHome, '.melo'),
    configPath: join(home, 'config.json'),
    desktopDir: join(home, 'desktop'),
    runtimePath: join(home, 'desktop', 'runtime.json'),
  });
}
