import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { acquireServerHomeLock } from './serverLock.js';
import { stopWhenDesktopOwnerExits, DESKTOP_OWNER_PIPE_ENV } from './desktopOwner.js';

const ownerModule = new URL('./desktopOwner.js', import.meta.url).href;
const serverScript = fileURLToPath(new URL('../server.js', import.meta.url));

// Stands in for the desktop window: holds the target's stdin pipe and relays
// its stdout. SIGKILL on this process is the case no signal handler can see.
const OWNER = `const { spawn } = require('node:child_process');
const [command, ...args] = JSON.parse(process.env.MELO_TEST_OWNED);
const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'] });
child.stdout.on('data', chunk => process.stdout.write(chunk));
process.stdout.write('owned ' + child.pid + '\\n');
setInterval(() => {}, 1000);
`;

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

async function waitFor(check, what, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

async function startOwned(command, args, env, ready) {
  const owner = spawn(process.execPath, ['-e', OWNER], { env: { ...env, MELO_TEST_OWNED: JSON.stringify([command, ...args]) }, stdio: ['ignore', 'pipe', 'ignore'] });
  let output = '';
  owner.stdout.on('data', chunk => { output += chunk; });
  const pid = await waitFor(() => Number(output.match(/owned (\d+)/)?.[1]) || null, 'owned process');
  const match = await waitFor(() => output.match(ready), `owned process ready (${ready})`);
  return { owner, pid, match };
}

test('only the window flag makes the server watch stdin, and its own children do not inherit it', () => {
  const input = Object.assign(new EventEmitter(), { resumed: false, resume() { this.resumed = true; } });
  let calls = 0;
  assert.equal(stopWhenDesktopOwnerExits({ onOwnerGone: () => { calls += 1; }, env: {}, input }), false);
  assert.equal(input.resumed, false, 'a terminal server keeps its stdin untouched');
  const env = { [DESKTOP_OWNER_PIPE_ENV]: '1', KEEP: 'yes' };
  assert.equal(stopWhenDesktopOwnerExits({ onOwnerGone: () => { calls += 1; }, env, input }), true);
  assert.deepEqual(env, { KEEP: 'yes' });
  assert.equal(input.resumed, true);
  input.emit('end');
  input.emit('error', new Error('late'));
  assert.equal(calls, 1, 'stops once');
});

test('a SIGKILLed window takes its server with it; without the flag the server is orphaned', { timeout: 90000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'melo-desktop-owner-'));
  const started = [];
  t.after(async () => {
    for (const pid of started) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    await rm(root, { recursive: true, force: true });
  });

  await t.test('the helper stops its process, which still exits cleanly after writing to the dead owner', async () => {
    const script = join(root, 'owned.mjs');
    const exitFile = join(root, 'exit-code');
    await writeFile(script, `import { writeFileSync } from 'node:fs';
import { stopWhenDesktopOwnerExits } from ${JSON.stringify(ownerModule)};
process.on('exit', code => writeFileSync(${JSON.stringify(exitFile)}, String(code)));
stopWhenDesktopOwnerExits({ onOwnerGone: () => { console.log('owner gone'); setTimeout(() => process.exit(0), 100); } });
console.log('ready');
setInterval(() => {}, 1000);
`);
    for (const flagged of [true, false]) {
      const { owner, pid } = await startOwned(process.execPath, [script], { ...process.env, ...(flagged ? { [DESKTOP_OWNER_PIPE_ENV]: '1' } : {}) }, /ready/);
      started.push(owner.pid, pid);
      owner.kill('SIGKILL');
      if (flagged) {
        await waitFor(() => !isAlive(pid), 'flagged process to exit after its owner died', 5000);
        assert.equal(await readFile(exitFile, 'utf8'), '0', 'writing to the dead owner\'s output must not crash shutdown');
      } else {
        await new Promise(resolve => setTimeout(resolve, 1000));
        assert.equal(isAlive(pid), true, 'control: without the flag the process is orphaned');
        process.kill(pid, 'SIGKILL');
      }
    }
  });

  await t.test('the real server releases its home lock and port after its window is SIGKILLed', async () => {
    for (const flagged of [true, false]) {
      const home = join(root, flagged ? 'home-owned' : 'home-orphan');
      const env = { ...process.env, MELO_HOME: home, MELO_TEST_MODE: '1', MELO_DREAMING_ENABLED: '0', ...(flagged ? { [DESKTOP_OWNER_PIPE_ENV]: '1' } : {}) };
      const { owner, pid, match } = await startOwned(process.execPath, [serverScript, '--host', '127.0.0.1', '--port', '0'], env, /listening at (http:\/\/127\.0\.0\.1:\d+)/);
      started.push(owner.pid, pid);
      const origin = match[1];
      assert.equal((await fetch(origin + '/api/health')).status, 200);
      owner.kill('SIGKILL');
      if (!flagged) {
        await new Promise(resolve => setTimeout(resolve, 1500));
        assert.equal(isAlive(pid), true, 'control: an unflagged server outlives its owner');
        assert.equal((await fetch(origin + '/api/health')).status, 200);
        process.kill(pid, 'SIGTERM');
        await waitFor(() => !isAlive(pid), 'control server cleanup');
        continue;
      }
      await waitFor(() => !isAlive(pid), 'the server to exit after its window died', 10000);
      await assert.rejects(fetch(origin + '/api/health'), 'port still served');
      // The PID file is removed only by the graceful release, not by a crash exit.
      await assert.rejects(access(join(home, 'melo-desktop-server.lock')), 'shutdown skipped the lock release');
      const lock = await acquireServerHomeLock(home);
      assert.equal(lock.acquired, true);
      await lock.release();
    }
  });
});
