// Starts the system Chrome for browser tests and the browser acceptance scripts.
//
// 2026-10-19 daily-gate hang: Google Chrome passes its stdout/stderr on to
// helpers that outlive the browser — chrome_crashpad_handler and the
// GoogleUpdater processes it wakes (`--server`, `--crash-handler`), which are
// reparented to launchd in process groups of their own. Playwright pipes the
// browser's stdout/stderr and resolves browser.close() only after the
// child's 'close' event, that is once every holder of those pipes is gone.
// Whenever the updater ran, close() waited for it (minutes, observed with
// lsof): desktop-ui/liveRun.browser.test.js never reached its server SIGTERM,
// node --test killed the file at 120 s and left the Melo server orphaned.
//
// The browser therefore starts through a /bin/sh trampoline that execs Chrome
// with stdout/stderr appended to a log file in a per-process temp directory.
// exec keeps the pid, so Playwright's process-group kill still applies, and
// keeps fds 3/4, the --remote-debugging-pipe Playwright actually talks over.
// Whatever Chrome spawns inherits the log file, never Playwright's pipes.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_TEST_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const shellQuote = value => `'${String(value).replace(/'/g, `'\\''`)}'`;
const trampolines = new Map();
let directory = null;

/** Path of an executable that runs `executablePath` with stdout/stderr sent to a log file. */
export function testChromeExecutable(executablePath = process.env.MELO_TEST_CHROME || DEFAULT_TEST_CHROME) {
  const existing = trampolines.get(executablePath);
  if (existing) return existing;
  if (!directory) {
    directory = mkdtempSync(join(tmpdir(), 'melo-test-chrome-'));
    process.once('exit', () => { try { rmSync(directory, { recursive: true, force: true }); } catch { /* best effort */ } });
  }
  const name = `chrome-${trampolines.size}`;
  const script = join(directory, `${name}.sh`);
  writeFileSync(script, `#!/bin/sh\nexec ${shellQuote(executablePath)} "$@" >>${shellQuote(join(directory, `${name}.log`))} 2>&1\n`);
  chmodSync(script, 0o755);
  trampolines.set(executablePath, script);
  return script;
}

/** chromium.launch() for tests: headless by default, Chrome's stdio detached from Playwright. */
export function launchTestChrome(chromium, { executablePath, ...options } = {}) {
  return chromium.launch({ headless: true, ...options, executablePath: testChromeExecutable(executablePath || undefined) });
}
