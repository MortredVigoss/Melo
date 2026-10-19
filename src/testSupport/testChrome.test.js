// Regression for the 2026-10-19 daily-gate hang: helpers that Chrome leaves
// behind (chrome_crashpad_handler, GoogleUpdater) inherited the browser's
// stdout/stderr, so Playwright's browser.close() — which waits for the child's
// 'close' event — hung until they exited and the liveRun test orphaned its
// server. launchTestChrome runs the browser through a trampoline that keeps
// those pipes out of the helpers' reach.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_TEST_CHROME, launchTestChrome, testChromeExecutable } from './testChrome.js';

const unix = process.platform !== 'win32';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// A stand-in browser: echoes its arguments, answers on fd 4 like the
// remote-debugging pipe, and leaves a helper behind that keeps stdout/stderr
// (but, like Chrome's CLOEXEC launches, not fds 3/4) open after it exits.
async function fakeBrowser(t, dir) {
  const pidFile = join(dir, 'helper.pid');
  const path = join(dir, "fake browser's binary.sh");
  await writeFile(path, `#!/bin/sh\nprintf 'args:%s|' "$@"\nprintf 'cdp-ok' >&4\nsleep 30 3>&- 4>&- &\necho $! > '${pidFile}'\n`);
  await chmod(path, 0o755);
  const helpers = [];
  t.after(() => { for (const pid of helpers) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } } });
  return { path, trackHelper: async () => helpers.push(Number(await readFile(pidFile, 'utf8'))) };
}

// Same stdio layout as Playwright's pipe launch; resolves how the run ended.
async function run(executable, args) {
  const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'] });
  let stdout = '', cdp = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stdio[4].on('data', chunk => { cdp += chunk; });
  const closed = once(child, 'close').then(() => 'closed');
  await once(child, 'exit');
  const ending = await Promise.race([closed, sleep(1000).then(() => 'still open')]);
  for (const stream of child.stdio) stream?.destroy();
  return { ending, stdout, cdp: () => cdp };
}

test('a helper that outlives the browser keeps a plain launch open, but not one through the trampoline', { skip: !unix }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'melo-test-chrome-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fake = await fakeBrowser(t, dir);

  const plain = await run(fake.path, ['--headless']);
  await fake.trackHelper();
  assert.equal(plain.ending, 'still open', 'the hazard: the leftover helper holds the inherited stdout/stderr');

  const trampoline = testChromeExecutable(fake.path);
  assert.equal(testChromeExecutable(fake.path), trampoline, 'one trampoline per binary');
  const started = Date.now();
  const wrapped = await run(trampoline, ['--headless', 'two words', "it's"]);
  await fake.trackHelper();
  assert.equal(wrapped.ending, 'closed', 'stdout/stderr no longer depend on the helper');
  assert.ok(Date.now() - started < 1000);
  assert.equal(wrapped.stdout, '', "the browser's own output goes to the log file");
  assert.equal(wrapped.cdp(), 'cdp-ok', 'fd 4 (the remote-debugging pipe) still reaches the parent');
  const log = await readFile(trampoline.replace(/\.sh$/, '.log'), 'utf8');
  assert.equal(log, "args:--headless|args:two words|args:it's|");
});

const chrome = process.env.MELO_TEST_CHROME || DEFAULT_TEST_CHROME;
test('browser.close() returns promptly although a helper outlives Chrome', { skip: !unix || !existsSync(chrome), timeout: 60000 }, async t => {
  const { chromium } = await import('playwright-core');
  const dir = await mkdtemp(join(tmpdir(), 'melo-test-chrome-real-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pidFile = join(dir, 'helper.pid');
  const wrapper = join(dir, 'chrome-with-helper.sh');
  // The leftover helper stands in for chrome_crashpad_handler / GoogleUpdater.
  await writeFile(wrapper, `#!/bin/sh\nsleep 30 3>&- 4>&- &\necho $! > '${pidFile}'\nexec '${chrome.replace(/'/g, `'\\''`)}' "$@"\n`);
  await chmod(wrapper, 0o755);
  t.after(async () => { try { process.kill(Number(await readFile(pidFile, 'utf8')), 'SIGKILL'); } catch { /* already gone */ } });
  const browser = await launchTestChrome(chromium, { executablePath: wrapper });
  const page = await browser.newPage();
  await page.goto('data:text/html,<p>ok</p>');
  assert.equal(await page.textContent('p'), 'ok');
  const started = Date.now();
  await browser.close();
  assert.ok(Date.now() - started < 10000, `browser.close() took ${Date.now() - started} ms`);
});
