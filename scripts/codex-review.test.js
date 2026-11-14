/**
 * codex-review.test.js — `git pp` pushes the commit it evaluated.
 *
 * Runs the real script in a throwaway repository with a bare remote and a
 * stand-in for the Codex CLI. Until 2026-11-14 the push was `HEAD:<branch>`:
 * a commit made while the evaluation ran (it takes minutes) went to the remote
 * without ever being reviewed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./codex-review.sh', import.meta.url));

// Answers like the CLI: `--version`, then `exec --sandbox read-only -` with the
// prompt on stdin. On its first evaluation it can make a commit in the work
// tree, which is what "someone committed while the review was running" is.
const STUB = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "codex-stub 0.0.0"; exit 0; fi
cat >/dev/null
calls="$STUB_STATE/calls"
n=$(( $(cat "$calls" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$calls"
if [ "$n" = "1" ] && [ "$STUB_COMMIT_DURING_REVIEW" = "1" ]; then
  ( cd "$STUB_WORK" && echo late > late.txt && git add late.txt && git commit -q -m "made while the review ran" )
fi
if [ -n "$STUB_GRADE" ]; then
  printf '✅ 可以合入，无需跟进\\n质量评级：%s —— stub\\n风险等级：低 —— stub\\n\\n无具体发现\\n' "$STUB_GRADE"
else
  printf 'no grade line here\\n'
fi
`;

async function repository(t) {
  const root = await mkdtemp(join(tmpdir(), 'melo-git-pp-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const remote = join(root, 'remote.git');
  const work = join(root, 'work');
  const stub = join(root, 'codex');
  const gitConfig = join(root, 'gitconfig');
  await writeFile(stub, STUB);
  await chmod(stub, 0o755);
  await writeFile(gitConfig, '');
  // Nothing of the developer's own git setup (signing, hooks, push defaults) takes part.
  const env = {
    PATH: process.env.PATH, HOME: root, LANG: 'en_US.UTF-8',
    GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
    CODEX_BIN: stub, STUB_STATE: root, STUB_WORK: work,
  };
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
  git(root, 'init', '-q', '--bare', '-b', 'master', remote);
  git(root, 'init', '-q', '-b', 'master', work);
  await writeFile(join(work, 'a.txt'), 'a\n');
  git(work, 'add', 'a.txt');
  git(work, 'commit', '-q', '-m', 'already on the remote');
  git(work, 'remote', 'add', 'origin', remote);
  git(work, 'push', '-q', '-u', 'origin', 'master');
  const pushed = git(work, 'rev-parse', 'HEAD');
  await writeFile(join(work, 'b.txt'), 'b\n');
  git(work, 'add', 'b.txt');
  git(work, 'commit', '-q', '-m', 'the commit under review');
  const reviewed = git(work, 'rev-parse', 'HEAD');
  const run = extra => spawnSync('bash', [SCRIPT], { cwd: work, env: { ...env, ...extra }, encoding: 'utf8' });
  const remoteHead = () => git(remote, 'rev-parse', 'refs/heads/master');
  const calls = async () => Number(await readFile(join(root, 'calls'), 'utf8').catch(() => '0'));
  return { work, git, run, remoteHead, calls, pushed, reviewed };
}

test('a commit made while the evaluation runs is not pushed: the remote gets the evaluated commit', async t => {
  const repo = await repository(t);
  const result = repo.run({ STUB_GRADE: 'A', STUB_COMMIT_DURING_REVIEW: '1' });
  assert.equal(result.status, 0, result.stderr);
  const late = repo.git(repo.work, 'rev-parse', 'HEAD');
  assert.notEqual(late, repo.reviewed, 'the work tree did move during the evaluation');
  assert.equal(repo.remoteHead(), repo.reviewed, 'the remote holds exactly what was evaluated');
  assert.match(result.stdout, /1 commit\(s\) after [0-9a-f]+ were NOT pushed/);
  assert.equal(repo.git(repo.work, 'rev-parse', 'origin/master'), repo.reviewed, 'the tracking ref follows the push');
  assert.equal(await repo.calls(), 2, 'evaluation before the push, backup review after it');
});

test('without a concurrent commit the evaluated commit is pushed and nothing is reported as left behind', async t => {
  const repo = await repository(t);
  const result = repo.run({ STUB_GRADE: 'B' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(repo.remoteHead(), repo.reviewed);
  assert.doesNotMatch(result.stdout, /NOT pushed/);
});

test('grade C or D, or no readable grade, pushes nothing', async t => {
  for (const extra of [{ STUB_GRADE: 'C' }, { STUB_GRADE: 'D' }, { STUB_GRADE: '' }]) {
    const repo = await repository(t);
    const result = repo.run(extra);
    assert.equal(result.status, 1, JSON.stringify(extra));
    assert.equal(repo.remoteHead(), repo.pushed, `remote unchanged for ${JSON.stringify(extra)}`);
    assert.equal(await repo.calls(), 1, 'no backup review after a blocked push');
  }
});
