import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('home locks exclude concurrent owners, permit independent homes, recover after a crash', { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'melo-server-lock-test-'));
  const children = [];
  const moduleUrl = new URL('./serverLock.js', import.meta.url).href;
  async function start(home) {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { acquireServerHomeLock } from ${JSON.stringify(moduleUrl)};
      const lock = await acquireServerHomeLock(process.env.MELO_LOCK_TEST_HOME);
      process.send({ acquired: lock.acquired });
      if (!lock.acquired) process.disconnect();
      else process.on('message', async () => { await lock.release(); process.disconnect(); });
    `], { env: { ...process.env, MELO_LOCK_TEST_HOME: home }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    const exited = once(child, 'exit');
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    children.push({ child, exited });
    const message = await Promise.race([
      once(child, 'message').then(([result]) => result),
      exited.then(() => { throw new Error(`Lock worker exited without a result: ${stderr}`); }),
    ]);
    return { ...message, child, exited };
  }
  try {
    const home = join(root, 'home');
    const pair = await Promise.all([start(home), start(home)]);
    assert.equal(pair.filter(result => result.acquired).length, 1);
    const owner = pair.find(result => result.acquired);
    await symlink(home, join(root, 'alias'));
    assert.equal((await start(join(root, 'alias'))).acquired, false);
    assert.equal((await start(join(root, 'other'))).acquired, true);
    owner.child.kill('SIGKILL');
    await owner.exited;
    assert.equal((await start(home)).acquired, true);
  } finally {
    for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await Promise.all(children.map(entry => entry.exited));
    await rm(root, { recursive: true, force: true });
  }
});
