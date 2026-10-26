import { mkdir, realpath, lstat, readFile, readdir } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { command, requireSuccess } from './process.js';

export function createGit(env) {
  // Do not inherit GIT_DIR, config injection, credential helpers or hooks.
  const environment = { PATH: env.PATH, HOME: '/nonexistent', LANG: 'C.UTF-8', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'Melo development', GIT_AUTHOR_EMAIL: 'development@localhost', GIT_COMMITTER_NAME: 'Melo development', GIT_COMMITTER_EMAIL: 'development@localhost' };
  const invoke = async (args, cwd, extra = {}, { raw = false } = {}) => {
    const result = await command('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'credential.helper=', ...args], { cwd, env: { ...environment, ...extra } });
    const trimmed = requireSuccess(result);
    return raw ? result.output : trimmed;
  };
  const privateGit = (job, args, options) => invoke(['--git-dir', job.gitDir, '--work-tree', job.workspace, ...args], job.workspace, {}, options);
  return {
    invoke, privateGit,
    async repository(path) {
      const root = await realpath(path);
      if (await invoke(['rev-parse', '--show-toplevel'], root) !== root) throw new Error('Choose the repository root');
      return { root, baseSha: await invoke(['rev-parse', '--verify', 'HEAD^{commit}'], root), branch: await invoke(['symbolic-ref', '--short', 'HEAD'], root) };
    },
    async checkout(job) {
      await mkdir(job.workspace, { recursive: true, mode: 0o700 });
      await invoke(['init', '--bare', job.gitDir], job.workspace);
      await privateGit(job, ['-c', 'protocol.file.allow=always', 'fetch', '--no-tags', '--', job.repository, job.baseSha]);
      await privateGit(job, ['read-tree', job.baseSha]);
      await privateGit(job, ['checkout-index', '--all', '--force']);
      await privateGit(job, ['update-ref', 'refs/heads/candidate', job.baseSha]);
      await privateGit(job, ['symbolic-ref', 'HEAD', 'refs/heads/candidate']);
    },
    async tree(job) {
      if (await lstat(join(job.workspace, '.git')).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) throw new Error('Worker must not create Git metadata in the candidate');
      await privateGit(job, ['add', '--all', '--', '.']);
      return privateGit(job, ['write-tree']);
    },
    async snapshot(job) {
      const treeSha = await this.tree(job);
      const headSha = await privateGit(job, ['commit-tree', treeSha, '-p', job.baseSha, '-m', `Melo candidate: ${job.goal.slice(0, 180)}`]);
      await privateGit(job, ['update-ref', 'refs/heads/candidate', headSha]);
      return { treeSha, headSha };
    },
    diff(job) { return privateGit(job, ['diff', '--no-ext-diff', '--no-textconv', job.baseSha, job.headSha || job.baseSha, '--']); },
    async changed(job) { return (await privateGit(job, ['diff', '--name-only', '-z', job.baseSha, job.headSha, '--'])).split('\0').filter(Boolean); },
  };
}

export async function containedFile(root, path, { writing = false } = {}) {
  if (typeof path !== 'string' || !path || isAbsolute(path) || path.split(/[\\/]/).some(part => part === '..' || part === '.git') || path.includes('\0')) throw new Error('Use a relative candidate file path');
  const resolvedRoot = await realpath(root);
  const parts = path.split('/').filter(Boolean);
  let cursor = resolvedRoot;
  for (const [index, part] of parts.entries()) {
    cursor = join(cursor, part);
    const info = await lstat(cursor).catch(error => { if (error.code === 'ENOENT' && writing) return null; throw error; });
    if (info?.isSymbolicLink()) throw new Error('Symbolic links are not editable or readable through the development file tool');
    if (!info && index < parts.length - 1) await mkdir(cursor, { mode: 0o700 });
  }
  if (relative(resolvedRoot, cursor).startsWith('..')) throw new Error('Path escaped candidate');
  return cursor;
}

export async function repositoryRules(root) {
  const rules = [];
  async function walk(directory, depth) {
    if (depth > 12 || rules.length >= 100) return;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (['.git', 'node_modules', '.tmp', 'dist', 'build'].includes(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path, depth + 1);
      else if (entry.isFile() && ['AGENTS.md', 'CLAUDE.md'].includes(entry.name)) {
        const content = await readFile(path, 'utf8');
        if (content.length > 100000) throw new Error('Repository guidance exceeds capacity');
        rules.push({ path: relative(root, path), content });
      }
    }
  }
  await walk(root, 0);
  if (rules.reduce((size, rule) => size + rule.content.length, 0) > 200000) throw new Error('Repository guidance exceeds capacity');
  return rules;
}
