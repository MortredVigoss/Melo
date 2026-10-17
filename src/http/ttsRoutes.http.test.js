import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

// Regression for the 2026-10-17 audit P0-1. The registry-level unit test in
// routeRegistry.test.js cannot see server.js wiring; this one drives the real
// createServer dispatch so a dropped `requireLocalOrigin` argument (or any
// other dispatch slip) shows up as a hung request instead of passing silently.
test('POST /api/tts/* reaches its handler through the real server dispatch', { timeout: 45000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'melo-tts-http-'));
  const child = spawn(process.execPath, ['src/server.js', '--host', '127.0.0.1', '--port', '0'], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    env: { ...process.env, MELO_HOME: home, MELO_TEST_MODE: '1', MELO_MEMORY_RUNTIME: '0', MELO_DREAMING_ENABLED: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = once(child, 'exit');
  t.after(async () => {
    const kill = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.kill('SIGTERM');
    await closed;
    clearTimeout(kill);
    await rm(home, { recursive: true, force: true });
  });
  let log = '';
  child.stderr.on('data', chunk => { log += chunk; });
  const base = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(log.slice(-1000))), 15000);
    child.once('exit', () => { clearTimeout(timeout); reject(new Error(log.slice(-1000))); });
    child.stdout.on('data', chunk => {
      log += chunk;
      const match = log.match(/listening at (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
  });

  // speak-stop is side-effect free when nothing is playing and must answer
  // promptly; before the fix it never answered at all.
  const stop = await fetch(base + '/api/tts/speak-stop', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(stop.status, 200);
  assert.deepEqual(await stop.json(), { ok: true });

  // The origin gate still applies: a cross-site Origin is rejected with 403
  // (and still answers, rather than hanging).
  const forbidden = await fetch(base + '/api/tts/speak-stop', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://evil.example' }, body: '{}',
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(forbidden.status, 403);
  assert.equal((await forbidden.json()).error, 'FORBIDDEN_ORIGIN');

  // A local-read voice route keeps working too.
  const voices = await fetch(base + '/api/tts/say-voices', { signal: AbortSignal.timeout(10000) });
  assert.equal(voices.status, 200);
});
