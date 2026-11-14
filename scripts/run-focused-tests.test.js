// The focused `npm run test:*` commands run through scripts/run-focused-tests.js.
//
// Three things are held here:
//   1. the runner gives the tests a Melo home of their own and removes it,
//      whatever MELO_HOME the caller has (the two incidents of November 2026
//      were bare `node --test` runs in the real data directory);
//   2. a failing test and a pattern that matches nothing both fail the command;
//   3. no npm script runs a bare `node --test` again, and every file a focused
//      command names exists.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { expandPatterns } from './run-focused-tests.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const runner = fileURLToPath(new URL('./run-focused-tests.js', import.meta.url));
// A test runner started from inside a test must not inherit NODE_TEST_CONTEXT:
// with it, the inner `node --test` reports to a parent that is not listening
// and runs nothing.
function run(args, env = {}) {
  const childEnv = { ...process.env, ...env };
  delete childEnv.NODE_TEST_CONTEXT;
  return promisify(execFile)(process.execPath, [runner, ...args], { cwd: root, env: childEnv, timeout: 120_000 })
    .then(result => ({ code: 0, ...result }), error => ({ code: error.code, stdout: error.stdout || '', stderr: error.stderr || '' }));
}

async function scratch(t) {
  const directory = await mkdtemp(join(tmpdir(), 'melo-focused-runner-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('expandPatterns: literal files, * inside a directory, ** across directories; sorted, each file once', async t => {
  const directory = await scratch(t);
  for (const file of ['a.test.js', 'b.test.js', 'notes.md', 'deep/c.test.js', 'deep/er/d.test.js', 'node_modules/pkg/e.test.js', '.tmp/f.test.js']) {
    await mkdir(join(directory, file, '..'), { recursive: true });
    await writeFile(join(directory, file), '');
  }
  assert.deepEqual(await expandPatterns(['b.test.js', 'a.test.js', 'a.test.js'], directory), ['a.test.js', 'b.test.js']);
  assert.deepEqual(await expandPatterns(['*.test.js'], directory), ['a.test.js', 'b.test.js']);
  assert.deepEqual(await expandPatterns(['deep/*.test.js'], directory), ['deep/c.test.js']);
  assert.deepEqual(await expandPatterns(['**/*.test.js'], directory), ['a.test.js', 'b.test.js', 'deep/c.test.js', 'deep/er/d.test.js'], 'node_modules and .tmp are not searched');
  assert.deepEqual(await expandPatterns(['deep/**/*.test.js', 'a.test.js'], directory), ['a.test.js', 'deep/c.test.js', 'deep/er/d.test.js']);
  assert.deepEqual(await expandPatterns([join(directory, 'deep/c.test.js')], directory), ['deep/c.test.js'], 'an absolute path inside the root is shown relative to it');
});

test('expandPatterns: a pattern that matches nothing is an error that names it', async t => {
  const directory = await scratch(t);
  await writeFile(join(directory, 'a.test.js'), '');
  await assert.rejects(expandPatterns(['a.test.js', 'gone.test.js', 'missing/*.test.js'], directory), /No test file matches: gone\.test\.js, missing\/\*\.test\.js/);
  await mkdir(join(directory, 'folder.test.js'));
  await assert.rejects(expandPatterns(['folder.test.js'], directory), /No test file matches/, 'a directory is not a test file');
});

test('the runner gives the tests their own Melo home, whatever the caller has, and removes it afterwards', async t => {
  const directory = await scratch(t);
  const marker = join(directory, 'seen.json');
  const fixture = join(directory, 'home.fixture.test.js');
  await writeFile(fixture, `
import test from 'node:test';
import { writeFileSync, statSync } from 'node:fs';
test('records where it runs', () => {
  writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ home: process.env.MELO_HOME, mode: process.env.MELO_TEST_MODE, homeIsDirectory: statSync(process.env.MELO_HOME).isDirectory() }));
});
`);
  const callerHome = join(directory, 'the-callers-real-home');
  const result = await run([fixture], { MELO_HOME: callerHome, MELO_TEST_MODE: '' });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const seen = JSON.parse(await readFile(marker, 'utf8'));
  assert.notEqual(seen.home, callerHome, 'not the home the caller had');
  assert.match(seen.home, /melo-focused-tests-/);
  assert.equal(seen.mode, '1');
  assert.equal(seen.homeIsDirectory, true, 'the home existed while the test ran');
  await assert.rejects(stat(seen.home), { code: 'ENOENT' }, 'and is gone afterwards');
  await assert.rejects(stat(callerHome), { code: 'ENOENT' }, 'nothing was created at the caller\'s home');
  assert.match(result.stdout, /# pool 1 files/, 'the gate\'s pool ran it');
});

test('a failing test fails the command and its home is removed all the same; so does a pattern that matches nothing', async t => {
  const directory = await scratch(t);
  const marker = join(directory, 'seen.txt');
  const fixture = join(directory, 'failing.fixture.test.js');
  await writeFile(fixture, `
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
test('fails on purpose', () => { writeFileSync(${JSON.stringify(marker)}, process.env.MELO_HOME); assert.equal(1, 2); });
`);
  const failed = await run([fixture]);
  assert.equal(failed.code, 1);
  await assert.rejects(stat(await readFile(marker, 'utf8')), { code: 'ENOENT' });

  const nothing = await run([join(directory, 'no-such.test.js')]);
  assert.equal(nothing.code, 2);
  assert.match(nothing.stderr, /No test file matches/);
  const usage = await run([]);
  assert.equal(usage.code, 2);
  assert.match(usage.stderr, /Usage: run-focused-tests\.js/);
});

test('package.json: no script runs a bare `node --test`, and every file a focused command names exists', async () => {
  const scripts = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')).scripts;
  const bare = Object.entries(scripts).filter(([, command]) => /(^|[;&|]\s*)node\s+(?:--[\w-]+(?:=\S+)?\s+)*--test\b/.test(command)).map(([name]) => name);
  assert.deepEqual(bare, [], 'run test files through scripts/run-focused-tests.js (isolated Melo home, the gate\'s pool)');

  const focused = Object.entries(scripts).filter(([, command]) => command.startsWith('node scripts/run-focused-tests.js '));
  assert.ok(focused.length >= 25, `the focused commands are there (${focused.length})`);
  for (const [name, command] of focused) {
    const patterns = command.slice('node scripts/run-focused-tests.js '.length).split(/\s+/).map(value => value.replace(/^'(.*)'$/, '$1'));
    const files = await expandPatterns(patterns, root).catch(error => assert.fail(`${name}: ${error.message}`));
    assert.ok(files.length >= 1, name);
    assert.ok(files.every(file => /\.test\.(?:js|mjs)$/.test(file)), `${name} names test files only`);
  }
});
