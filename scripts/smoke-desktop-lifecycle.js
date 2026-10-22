// Real-bundle check for the desktop shell's server lifecycle: a signalled or
// SIGKILLed Melo window leaves no server behind, and a server orphaned by an
// older window is replaced on the same port instead of shifting to port + 1. It runs
// a built Melo.app against a stand-in project, home and port, so the user's
// own Melo, home and 43127 are never touched.
//   node scripts/smoke-desktop-lifecycle.js [path/to/Melo.app]
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  writeFixtureProject, fixtureEnv, serverArgs, startOrphanServer, waitFor, isAlive, parentPid,
  processesMatching, killMatching, portAccepts, freePortPair,
} from './desktop-lifecycle-fixture.js';

const appPath = resolve(process.argv[2] || '.tmp/desktop-build/Melo.app');
const binary = join(appPath, 'Contents/MacOS/MeloDesktop');

const READY = /status=(?:server-ready|page-loaded)/;
const FAILED = /status=(?:server-home-busy|server-exited|server-launch-failed|node-not-found)/;

async function launchShell({ project, home, port }, { expect = READY } = {}) {
  const debugPath = join(project, '.tmp/desktop-app-debug.txt');
  await unlink(debugPath).catch(() => {});
  const shell = spawn(binary, [], {
    env: fixtureEnv(home, { MELO_PROJECT_DIR: project, MELO_DESKTOP_PORT: String(port), MELO_NODE_PATH: process.execPath }),
    stdio: 'ignore',
  });
  const exited = new Promise(resolve => shell.once('exit', (code, signal) => resolve({ code, signal })));
  const debug = await waitFor(async () => {
    const text = await readFile(debugPath, 'utf8').catch(() => '');
    if (expect.test(text)) return text;
    if (FAILED.test(text) || READY.test(text)) throw new Error(`Melo reported an unexpected launch state:\n${text}`);
    return null;
  }, { timeoutMs: 40000, what: `launch state ${expect}` });
  if (expect !== READY) return { shell, exited, debug };
  const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
  return { shell, exited, debug, serverPid: health.runtime.pid };
}

async function signalShell({ shell, exited, serverPid }, { project, port }, signal) {
  process.kill(shell.pid, signal);
  const result = await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error(`${signal}: Melo did not exit`)), 15000))]);
  assert.equal(result.signal, signal, `${signal}: Melo ends with the signal it received`);
  // SIGKILL runs no handler: the server follows through its closed owner pipe.
  if (signal === 'SIGKILL') await waitFor(() => !isAlive(serverPid), { timeoutMs: 10000, what: `SIGKILL: server ${serverPid} to follow Melo` });
  assert.equal(isAlive(serverPid), false, `${signal}: server ${serverPid} outlived Melo`);
  assert.equal(await portAccepts(port), false, `${signal}: ${port} still served`);
  assert.equal(await portAccepts(port + 1), false, `${signal}: native service on ${port + 1} still served`);
  assert.deepEqual(processesMatching(project), [], `${signal}: processes left behind`);
}

async function main() {
  if (process.platform !== 'darwin') throw new Error('The desktop shell lifecycle smoke needs macOS.');
  if (!existsSync(binary)) throw new Error(`No built shell at ${binary}; run npm run build:desktop first.`);
  const root = await mkdtemp(join(tmpdir(), 'melo-shell-smoke-'));
  try {
    const project = join(root, 'project');
    const script = await writeFixtureProject(project);
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGKILL']) {
      const context = { project, home: join(root, `home-${signal}`), port: await freePortPair() };
      const running = await launchShell(context);
      assert.equal(parentPid(running.serverPid), running.shell.pid, 'the server is the window\'s own child');
      await signalShell(running, context, signal);
      console.log(`PASS ${signal}: Melo stopped its server ${running.serverPid}; no process or port left`);
    }

    const context = { project, home: join(root, 'home-stale'), port: await freePortPair() };
    const orphan = await startOrphanServer(script, { home: context.home, port: context.port, log: join(root, 'orphan.log') });
    const running = await launchShell(context);
    assert.equal(isAlive(orphan), false, `stale server ${orphan} still running`);
    assert.match(running.debug, new RegExp(`serverURL=http://127\\.0\\.0\\.1:${context.port}\\n`), 'Melo moved off its configured port');
    assert.equal(parentPid(running.serverPid), running.shell.pid);
    assert.deepEqual(processesMatching(script), [running.serverPid], 'exactly one server after reclaim');
    console.log(`PASS stale server ${orphan} on ${context.port} replaced by ${running.serverPid} on the same port`);
    await signalShell(running, context, 'SIGTERM');

    // A server whose owner is alive (a terminal, another window) keeps running.
    const owned = { project, home: join(root, 'home-owned'), port: await freePortPair() };
    const holder = spawn(process.execPath, serverArgs(script, owned.port), { env: fixtureEnv(owned.home), stdio: ['ignore', 'pipe', 'ignore'] });
    let holderOutput = '';
    holder.stdout.on('data', chunk => { holderOutput += chunk; });
    await waitFor(() => /ready/.test(holderOutput), { what: 'owned server' });
    const blocked = await launchShell(owned, { expect: /status=server-home-busy/ });
    assert.match(blocked.debug, new RegExp(`holderPid=${holder.pid}\\n`));
    assert.equal(isAlive(holder.pid), true, 'Melo signalled a server it does not own');
    assert.deepEqual(processesMatching(script), [holder.pid], 'Melo started a second server');
    assert.equal(await portAccepts(owned.port + 1), false, 'Melo shifted to port + 1');
    process.kill(blocked.shell.pid, 'SIGTERM');
    assert.equal((await blocked.exited).signal, 'SIGTERM');
    assert.equal(isAlive(holder.pid), true, 'quitting Melo stopped a server it does not own');
    holder.kill('SIGKILL');
    console.log(`PASS server ${holder.pid} with a live owner left running; Melo reported the home busy`);
  } finally {
    killMatching(root);
    await rm(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
