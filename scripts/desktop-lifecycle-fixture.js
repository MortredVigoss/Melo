// Shared by the desktop shell lifecycle test and the real-bundle smoke: a
// stand-in Melo server that takes the real home lock, plus process and port
// probes. Every process it starts carries its temporary directory in argv, so
// cleanup can find exactly these processes and nothing else.
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile, copyFile } from 'node:fs/promises';
import { createServer, connect } from 'node:net';
import { join } from 'node:path';

const lockModule = new URL('../src/runtime/serverLock.js', import.meta.url);

const SERVER_SOURCE = `import { createServer } from 'node:http';
import { acquireServerHomeLock } from './runtime/serverLock.js';
const option = name => process.argv[process.argv.indexOf(name) + 1];
const home = process.env.MELO_HOME;
const lock = await acquireServerHomeLock(home);
if (!lock.acquired) { console.log('busy ' + lock.holderPid); process.exit(0); }
const server = createServer((request, response) => {
  const api = request.url.startsWith('/api/');
  response.setHeader('content-type', api ? 'application/json' : 'text/html');
  response.end(request.url === '/api/health' ? JSON.stringify({ ok: true, runtime: { home, pid: process.pid } })
    : api ? '{}' : '<!doctype html><title>Melo lifecycle fixture</title><p>fixture</p>');
});
server.listen(Number(option('--port')), option('--host'), () => console.log('ready ' + process.pid));
const stop = () => {
  if (process.env.MELO_FIXTURE_IGNORE_TERM === '1') return;
  server.close();
  lock.release().finally(() => process.exit(0));
};
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, stop);
`;

export async function writeFixtureProject(project) {
  // The real lock module, at the same path the real server imports it from.
  await mkdir(join(project, 'src/runtime'), { recursive: true });
  await copyFile(lockModule, join(project, 'src/runtime/serverLock.js'));
  await mkdir(join(project, 'desktop-ui'), { recursive: true });
  await writeFile(join(project, 'src/server.js'), SERVER_SOURCE);
  await writeFile(join(project, 'desktop-ui/index.html'), '<!doctype html><title>fixture</title>');
  return join(project, 'src/server.js');
}

export function fixtureEnv(home, extra = {}) {
  return { ...process.env, MELO_HOME: home, ...extra };
}

export function serverArgs(script, port) {
  return [script, '--host', '127.0.0.1', '--port', String(port)];
}

// `sh` exits at once, so launchd adopts the server: what a killed window leaves.
export async function startOrphanServer(script, { home, port, log, ignoreTerm = false }) {
  execFileSync('/bin/sh', ['-c', '"$0" "$@" >"$LOG" 2>&1 &', process.execPath, ...serverArgs(script, port)], {
    env: fixtureEnv(home, { LOG: log, ...(ignoreTerm ? { MELO_FIXTURE_IGNORE_TERM: '1' } : {}) }),
  });
  const pid = await waitFor(async () => Number((await readFile(log, 'utf8').catch(() => '')).match(/ready (\d+)/)?.[1]) || null, { what: `orphan server on ${port}` });
  await waitFor(() => parentPid(pid) === 1, { what: `launchd adopting ${pid}` });
  return pid;
}

export async function waitFor(check, { timeoutMs = 15000, intervalMs = 50, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

export function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

export function parentPid(pid) {
  try { return Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim()); } catch { return null; }
}

export function processesMatching(marker) {
  try {
    return execFileSync('pgrep', ['-f', marker], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number);
  } catch (error) {
    if (error.status === 1) return [];
    throw error;
  }
}

export function killMatching(marker) {
  for (const pid of processesMatching(marker)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
}

export function portAccepts(port) {
  return new Promise(resolve => {
    const socket = connect(port, '127.0.0.1');
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

function canBind(port) {
  return new Promise(resolve => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

// The shell's native service listens on port + 1, so tests reserve the pair.
export async function freePortPair() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const port = 20000 + Math.floor(Math.random() * 40000);
    if (await canBind(port) && await canBind(port + 1)) return port;
  }
  throw new Error('No free port pair');
}
