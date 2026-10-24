import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

export function desktopInstallPaths({ projectDir = fileURLToPath(new URL('../', import.meta.url)), home = homedir(), env = {} } = {}) {
  const directory = value => {
    if (!value || !isAbsolute(value) || /[\r\n\0]/u.test(value)) throw new Error('Install directories must be absolute paths without control characters.');
    return resolve(value);
  };
  const project = directory(projectDir);
  const source = join(project, '.tmp', 'desktop-build', 'Melo.app');
  const primary = join(directory(env.MELO_DESKTOP_INSTALL_DIR || join(directory(home), 'Applications')), 'Melo.app');
  const shortcut = join(directory(env.MELO_DESKTOP_SHORTCUT_DIR || dirname(project)), 'Melo.app');
  if (primary === source || shortcut === source) throw new Error('Install destination must not replace the build source.');
  return { source, primary, shortcut };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const paths = desktopInstallPaths({ projectDir: process.argv[2], home: process.env.HOME || homedir(), env: { ...process.env } });
  const key = process.argv[3];
  if (key && !Object.hasOwn(paths, key)) throw new Error('Unknown install path.');
  process.stdout.write(key ? paths[key] + '\n' : JSON.stringify(paths) + '\n');
}
