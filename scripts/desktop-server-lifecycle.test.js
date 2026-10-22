import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { acquireServerHomeLock } from '../src/runtime/serverLock.js';
import { DESKTOP_OWNER_PIPE_ENV } from '../src/runtime/desktopOwner.js';
import {
  writeFixtureProject, fixtureEnv, serverArgs, startOrphanServer, waitFor, isAlive, parentPid,
  processesMatching, killMatching, portAccepts, freePortPair,
} from './desktop-lifecycle-fixture.js';

// Compiles the shell's own ProcessShutdown.swift and StaleServer.swift, so the
// signal path and the stale-server check run against real processes, ports
// and the real home lock. scripts/smoke-desktop-lifecycle.js repeats both
// against a built Melo.app.
const FIXTURE_MAIN = String.raw`
import Foundation
import Darwin
let arguments = CommandLine.arguments
switch arguments[1] {
case "signal":
  // signal <node> <child.cjs> <port> <install handlers: 1|0>
  let child = Process()
  child.executableURL = URL(fileURLWithPath: arguments[2])
  child.arguments = [arguments[3], arguments[4]]
  let output = Pipe()
  child.standardOutput = output
  try! child.run()
  _ = output.fileHandleForReading.availableData
  var sources: [DispatchSourceSignal] = []
  if arguments[5] == "1" {
    sources = ProcessShutdown.onTerminationSignals { signal in
      ProcessShutdown.stop(child) { ProcessShutdown.exit(after: signal) }
    }
  }
  print("fixture ready \(child.processIdentifier)")
  fflush(stdout)
  let keepAlive = Timer.scheduledTimer(withTimeInterval: 3600, repeats: true) { _ in }
  withExtendedLifetime((sources, keepAlive)) { RunLoop.main.run() }
case "reclaim":
  // reclaim <home> <server script> <stop timeout> <owner grace>
  let started = Date()
  let outcome = StaleServer.reclaim(home: arguments[2], serverScript: arguments[3], stopTimeout: Double(arguments[4])!, ownerGrace: Double(arguments[5])!)
  let elapsed = Date().timeIntervalSince(started)
  switch outcome {
  case .clear: print("{\"outcome\":\"clear\",\"elapsed\":\(elapsed)}")
  case .stopped(let pid): print("{\"outcome\":\"stopped\",\"pid\":\(pid),\"elapsed\":\(elapsed)}")
  case .busy(let pid): print("{\"outcome\":\"busy\",\"pid\":\(pid),\"elapsed\":\(elapsed)}")
  }
default:
  fatalError("unknown mode")
}
`;

// Exits only after a short delay, so a shell that did not wait would exit first.
const CHILD_SOURCE = `require('node:net').createServer().listen(Number(process.argv[2]), '127.0.0.1', () => console.log('ready'));
process.on('SIGTERM', () => setTimeout(() => process.exit(0), 150));
`;

test('desktop shell stops its server child on signals and only reclaims its own orphaned server', { skip: process.platform !== 'darwin', timeout: 120000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'melo-shell-lifecycle-'));
  const spawned = [];
  try {
    const binary = join(root, 'lifecycle-fixture');
    await writeFile(join(root, 'main.swift'), FIXTURE_MAIN);
    execFileSync('xcrun', ['swiftc', 'desktop-app/ProcessShutdown.swift', 'desktop-app/StaleServer.swift', join(root, 'main.swift'), '-o', binary], { timeout: 90000 });
    const childScript = join(root, 'child.cjs');
    await writeFile(childScript, CHILD_SOURCE);
    const project = join(root, 'project');
    const script = await writeFixtureProject(project);
    const reclaim = (home, { stopTimeout = 8, ownerGrace = 0.3 } = {}) =>
      JSON.parse(execFileSync(binary, ['reclaim', home, script, String(stopTimeout), String(ownerGrace)], { encoding: 'utf8', timeout: 30000 }));
    const lockIsFree = async home => {
      const lock = await acquireServerHomeLock(home);
      await lock.release?.();
      return lock.acquired;
    };

    async function runShell(signal, install) {
      const port = await freePortPair();
      const shell = spawn(binary, ['signal', process.execPath, childScript, String(port), install ? '1' : '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
      spawned.push(shell);
      const exited = new Promise(resolve => shell.once('exit', (code, signalName) => resolve({ code, signal: signalName })));
      let output = '';
      shell.stdout.on('data', chunk => { output += chunk; });
      const childPid = await waitFor(() => Number(output.match(/fixture ready (\d+)/)?.[1]) || null, { what: 'shell fixture' });
      assert.equal(await portAccepts(port), true, 'child serves before the signal');
      process.kill(shell.pid, signal);
      const result = await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error(`${signal}: shell did not exit`)), 10000))]);
      return { result, childPid, port };
    }

    await t.test('SIGTERM, SIGINT and SIGHUP stop the child before the shell exits', async () => {
      for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
        const { result, childPid, port } = await runShell(signal, true);
        assert.equal(result.signal, signal, `${signal}: the shell ends with the signal it received`);
        assert.equal(isAlive(childPid), false, `${signal}: server child outlived the shell`);
        assert.equal(await portAccepts(port), false, `${signal}: port still served after exit`);
        assert.deepEqual(processesMatching(childScript), [], `${signal}: processes left behind`);
      }
    });

    await t.test('control: without the handlers the same signal orphans the child', async () => {
      const { result, childPid, port } = await runShell('SIGTERM', false);
      try {
        assert.equal(result.signal, 'SIGTERM');
        assert.equal(isAlive(childPid), true, 'the measurement must be able to see an orphan');
        await waitFor(() => parentPid(childPid) === 1, { what: 'launchd adopting the orphan' });
        assert.equal(await portAccepts(port), true);
        assert.deepEqual(processesMatching(childScript), [childPid]);
      } finally { process.kill(childPid, 'SIGKILL'); }
      await waitFor(() => !isAlive(childPid), { what: 'control orphan cleanup' });
    });

    await t.test('an orphaned server of this project holding the home lock is stopped and its port freed', async () => {
      const home = join(root, 'home-orphan');
      const port = await freePortPair();
      const orphan = await startOrphanServer(script, { home, port, log: join(root, 'orphan.log') });
      const outcome = reclaim(home);
      assert.equal(outcome.outcome, 'stopped');
      assert.equal(outcome.pid, orphan, 'the PID came from the lock holder');
      assert.equal(isAlive(orphan), false);
      assert.equal(await portAccepts(port), false);
      assert.equal(await lockIsFree(home), true);
      assert.deepEqual(processesMatching(script), []);
      assert.equal(reclaim(home).outcome, 'clear', 'a second check finds nothing to stop');
    });

    await t.test('an orphan that ignores SIGTERM is killed after the bound', async () => {
      const home = join(root, 'home-stuck');
      const orphan = await startOrphanServer(script, { home, port: await freePortPair(), log: join(root, 'stuck.log'), ignoreTerm: true });
      const outcome = reclaim(home, { stopTimeout: 0.5 });
      assert.equal(outcome.outcome, 'stopped');
      assert.equal(outcome.pid, orphan);
      assert.ok(outcome.elapsed >= 0.5 && outcome.elapsed < 5, `bounded escalation, took ${outcome.elapsed}s`);
      assert.equal(isAlive(orphan), false);
      assert.equal(await lockIsFree(home), true);
    });

    await t.test('a server that still has a live parent is reported busy and left running', async () => {
      const home = join(root, 'home-owned');
      const owned = spawn(process.execPath, serverArgs(script, await freePortPair()), { env: fixtureEnv(home), stdio: ['ignore', 'pipe', 'ignore'] });
      spawned.push(owned);
      let output = '';
      owned.stdout.on('data', chunk => { output += chunk; });
      await waitFor(() => /ready/.test(output), { what: 'owned server' });
      const outcome = reclaim(home, { ownerGrace: 0.3 });
      assert.deepEqual([outcome.outcome, outcome.pid], ['busy', owned.pid]);
      assert.equal(isAlive(owned.pid), true, 'a server with a live owner must not be signalled');
      assert.equal(await lockIsFree(home), false);
    });

    await t.test('an orphan holding the lock with another script is not this project\'s server', async () => {
      const home = join(root, 'home-foreign');
      const foreignScript = await writeFixtureProject(join(root, 'other-project'));
      const foreign = await startOrphanServer(foreignScript, { home, port: await freePortPair(), log: join(root, 'foreign.log') });
      try {
        const outcome = reclaim(home, { ownerGrace: 0.3 });
        assert.deepEqual([outcome.outcome, outcome.pid], ['busy', foreign]);
        assert.equal(isAlive(foreign), true);
      } finally { process.kill(foreign, 'SIGKILL'); }
    });

    await t.test('a PID file alone never selects a process, even a matching orphan', async () => {
      const home = join(root, 'home-pidfile');
      await mkdir(home, { recursive: true });
      assert.equal(await lockIsFree(home), true, 'creates an unheld lock database');
      const port = await freePortPair();
      // This project's orphan, but serving another home: it holds no lock here.
      const other = await startOrphanServer(script, { home: join(root, 'home-other'), port, log: join(root, 'other.log') });
      try {
        await writeFile(join(home, 'melo-desktop-server.lock'), String(other));
        assert.equal(reclaim(home).outcome, 'clear');
        assert.equal(reclaim(join(root, 'home-missing')).outcome, 'clear', 'no lock database');
        assert.equal(isAlive(other), true);
        assert.equal(await portAccepts(port), true, 'another home\'s server keeps its port');
      } finally { process.kill(other, 'SIGKILL'); }
    });

    await t.test('the app installs the handlers before its first child and reclaims before every spawn', async () => {
      const main = await readFile('desktop-app/main.swift', 'utf8');
      const launch = main.slice(main.indexOf('func applicationDidFinishLaunching'), main.indexOf('func applicationShouldTerminateAfterLastWindowClosed'));
      const handlers = launch.indexOf('ProcessShutdown.onTerminationSignals');
      assert.ok(handlers >= 0 && handlers < launch.indexOf('startServerIfNeeded()'), 'signal handlers precede the first spawn');
      assert.match(main, /private func terminateAfterSignal[\s\S]*?ProcessShutdown\.stop\(serverProcess\)[\s\S]*?releaseNativeResources\(\)[\s\S]*?ProcessShutdown\.exit\(after: signal\)/);
      assert.match(main, /StaleServer\.reclaim\(home: home, serverScript: serverScript\)[\s\S]*?launchServer\(after: outcome\)/);
      const calls = [...main.matchAll(/\bspawnServer\(\)/g)].map(match => match.index);
      const launchServer = main.indexOf('private func launchServer(after');
      assert.equal(calls.length, 2, 'one definition and one call');
      assert.ok(calls[0] > launchServer && calls[0] < main.indexOf('private func spawnServer()'), 'only the post-reclaim path spawns');
      assert.match(await readFile('scripts/build-desktop-app.sh', 'utf8'), /desktop-app\/StaleServer\.swift/);
      // SIGKILL runs no handler: the server needs the flag and a pipe only the window holds.
      assert.ok(main.includes(`"${DESKTOP_OWNER_PIPE_ENV}": "1"`), 'the window flags its server as owned');
      assert.match(main, /fcntl\(ownerPipe\.fileHandleForWriting\.fileDescriptor, F_SETFD, FD_CLOEXEC\)[\s\S]*?process\.standardInput = ownerPipe/);
    });
  } finally {
    for (const child of spawned) { try { child.kill('SIGKILL'); } catch {} }
    killMatching(root);
    await rm(root, { recursive: true, force: true });
  }
});
