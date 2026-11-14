/**
 * ttsRoutes.stopSpeech.test.js
 *
 * On exit the server clears the queue of sentences being read aloud by the
 * macOS `say` engine. It used to do so through `_nativeSayQueue`, a name that
 * exists only inside createTtsRoutes: in server.js the line threw a
 * ReferenceError that the surrounding try/catch swallowed, so the process that
 * was speaking was never stopped.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { readFile } from 'node:fs/promises';

import { createTtsRoutes } from './ttsRoutes.js';

function fakeSay() {
  const started = [];
  const spawnProcess = (command, args) => {
    const child = new EventEmitter();
    child.command = command;
    child.args = args;
    child.killed = 0;
    child.kill = () => { child.killed += 1; queueMicrotask(() => child.emit('exit', null, 'SIGTERM')); };
    started.push(child);
    return child;
  };
  return { started, spawnProcess };
}

async function post(routes, path, body) {
  const request = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: 'POST', headers: {} });
  const response = { status: 0, body: '', writeHead(status) { this.status = status; }, end(text) { this.body = String(text || ''); } };
  const handled = await routes.handle(request, response, new URL(`http://localhost${path}`), () => true);
  assert.equal(handled, true, `${path} is a declared route`);
  return response;
}

test('stopSpeech kills the sentence being spoken and drops the ones waiting', async () => {
  const { started, spawnProcess } = fakeSay();
  const routes = createTtsRoutes({ startVoicePackServers: () => { throw new Error('must not start'); }, spawnProcess });

  assert.doesNotThrow(() => routes.stopSpeech(), 'nothing has been spoken yet');

  for (const text of ['first sentence', 'second sentence', 'third sentence']) {
    assert.equal((await post(routes, '/api/tts/native-queue-add', { text })).status, 200);
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(started.length, 1, 'one sentence at a time');
  assert.equal(started[0].command, '/usr/bin/say');
  assert.deepEqual(started[0].args, ['--', 'first sentence']);

  routes.stopSpeech();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(started[0].killed, 1, 'the running say process is killed');
  assert.equal(started.length, 1, 'the two waiting sentences are never started');

  // The queue still works afterwards.
  await post(routes, '/api/tts/native-queue-add', { text: 'after the stop' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(started.length, 2);
  assert.deepEqual(started[1].args, ['--', 'after the stop']);
  routes.stopSpeech();
});

test('the server shutdown goes through stopSpeech, not through a name that only exists inside the routes module', async () => {
  const server = await readFile(new URL('../server.js', import.meta.url), 'utf8');
  const shutdown = server.slice(server.indexOf('function shutdown()'));
  assert.match(shutdown, /try \{ ttsRoutes\.stopSpeech\(\); \} catch \{\}/);
  assert.doesNotMatch(server, /_nativeSayQueue/, 'server.js has no such binding');
});
