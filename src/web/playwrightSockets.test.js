// The browser CLI's daemon socket.
//
// Found 2026-11-14 by running the CLI: on macOS a browser session could be
// opened once per Melo process. The CLI builds its socket path as
//   <tmpdir>/pw-<8 hex>/cli/<16 hex>-<session name>.sock
// and macOS's temp directory is 49 characters, so with Melo's session names
// the path passed the 103 bytes a unix socket path may have. The kernel cut
// the name short when the daemon bound it, the daemon could not find its own
// socket to remove on close, and every later `open` of that session failed
// with EADDRINUSE. After the first idle close, page reading and search had
// lost their browser for good, without any error the user could see.
//
// The fix points the CLI at a short directory only this user can enter.
// The first group of tests is about that directory; the last one opens,
// closes and reopens a real browser session.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  cleanupStalePlaywrightDaemons,
  createPlaywrightSession,
  defaultSocketPathLength,
  ensurePrivateSocketsDir,
} from './playwrightFetcher.js';

const posix = process.platform !== 'win32';
const scratch = mkdtempSync(join(tmpdir(), 'melo-pw-sockets-test-'));
after(() => { try { rmSync(scratch, { recursive: true, force: true }); } catch {} });

test('the default socket path of a Melo session does not fit under the macOS temp directory, and fits under /tmp', () => {
  const name = 'melo-search-p99207-0a1b2c41';
  // The shape of every macOS per-user temp directory.
  const macTemp = '/var/folders/7v/7w70lvfd6dl3s4y5__3k2ngw0000gn/T';
  assert.equal(defaultSocketPathLength(name, macTemp), `${macTemp}/pw-00000000/cli/0000000000000000-${name}.sock`.length);
  assert.ok(defaultSocketPathLength(name, macTemp) > 103, 'longer than a macOS socket path may be');
  assert.ok(defaultSocketPathLength(name, '/tmp') <= 103);
  // The directory Melo uses instead keeps the path whole, also for the longest pid and uid.
  assert.ok('/tmp/melo-pw-4294967295/cli/0000000000000000-melo-search-p4194304-0a1b2c41.sock'.length <= 103);
});

test('ensurePrivateSocketsDir creates a directory closed to everyone else and accepts it again', { skip: !posix }, () => {
  const dir = join(scratch, 'fresh');
  assert.equal(ensurePrivateSocketsDir(dir), dir);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(ensurePrivateSocketsDir(dir), dir, 'an existing private directory of ours is used as is');
});

test('ensurePrivateSocketsDir refuses anything that is not a private directory of this user', { skip: !posix }, () => {
  const open = join(scratch, 'open-to-others');
  mkdirSync(open, { mode: 0o700 });
  chmodSync(open, 0o755);
  assert.equal(ensurePrivateSocketsDir(open), null, 'readable by others');

  const target = join(scratch, 'link-target');
  mkdirSync(target, { mode: 0o700 });
  const link = join(scratch, 'link');
  symlinkSync(target, link);
  assert.equal(ensurePrivateSocketsDir(link), null, 'a link someone left there, even to a private directory');

  const file = join(scratch, 'a-file');
  writeFileSync(file, '');
  assert.equal(ensurePrivateSocketsDir(file), null, 'not a directory');

  const ours = join(scratch, 'ours');
  mkdirSync(ours, { mode: 0o700 });
  assert.equal(ensurePrivateSocketsDir(ours, process.getuid() + 1), null, 'owned by somebody else');
  assert.equal(ensurePrivateSocketsDir(join(scratch, 'missing-parent', 'child')), null, 'cannot be created');
});

// ─── The real thing ──────────────────────────────────────────────────────────

async function cliUnavailableReason() {
  try {
    await promisify(execFile)('npx', ['-y', process.env.MELO_PLAYWRIGHT_CLI_PACKAGE || '@playwright/cli@0.1.11', '--version'], { timeout: 60_000 });
    return false;
  } catch (error) {
    return `the Playwright CLI cannot be started here (${String(error?.message || error).split('\n')[0].slice(0, 120)})`;
  }
}

async function daemonsOfThisProcess() {
  const { stdout } = await promisify(execFile)('ps', ['-axo', 'pid=,command='], { maxBuffer: 8 * 1024 * 1024 });
  return stdout.split('\n').filter(line => line.includes('cliDaemon.js') && line.includes(`-p${process.pid}-`));
}

test('a browser session that was closed can be opened again, and leaves neither a daemon nor a socket', { skip: !posix ? 'unix sockets only' : await cliUnavailableReason() }, async () => {
  const session = createPlaywrightSession({ sessionName: 'melo-shared', idleCloseMs: -1 });
  after(() => cleanupStalePlaywrightDaemons());

  await session.withLock(() => session.navigate('about:blank', 30_000));
  assert.equal((await daemonsOfThisProcess()).length, 1, 'the first open started one daemon');
  await session.close();
  assert.deepEqual(await daemonsOfThisProcess(), [], 'close ends it');

  // Before the fix this second open failed: "listen EADDRINUSE: address already in use …sock".
  await session.withLock(() => session.navigate('about:blank', 30_000));
  assert.equal((await daemonsOfThisProcess()).length, 1, 'the same session opens a second time');
  await session.close();
  assert.deepEqual(await daemonsOfThisProcess(), []);

  if (!process.env.PLAYWRIGHT_SOCKETS_DIR && defaultSocketPathLength(`melo-shared-p${process.pid}-00000000`) > (process.platform === 'darwin' ? 103 : 107)) {
    const left = readdirSync(`/tmp/melo-pw-${process.getuid()}/cli`).filter(name => name.includes(`-p${process.pid}-`));
    assert.deepEqual(left, [], 'the socket file is removed on close');
  }
});
