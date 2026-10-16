import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { atomicWriteJson } from '../storage.js';
import { decodeBootstrap } from '../../desktop-ui/bootstrapPatch.js';

test('HTTP and SSE share validation, turn identity and durable retry semantics', { timeout: 45000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'melo-chat-contract-'));
  await atomicWriteJson(join(home, 'desktop/state.json'), {
    chats: [{ id: 'contract', title: 'Contract', messages: [] }],
    approvals: [{ id: 'crashed-approval', status: 'running', kind: 'command', payload: { command: 'must not run' } }],
  });
  let child;
  let closed;
  async function stop() {
    if (!child) return;
    const kill = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.kill('SIGTERM');
    await closed;
    clearTimeout(kill);
    child = null;
  }
  t.after(async () => { await stop(); await rm(home, { recursive: true, force: true }); });
  async function start() {
    child = spawn(process.execPath, ['src/server.js', '--host', '127.0.0.1', '--port', '0'], {
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      env: { ...process.env, MELO_HOME: home, MELO_TEST_MODE: '1', MELO_MOCK_RESPONSE: 'Hello contract.', MELO_DREAMING_ENABLED: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    closed = once(child, 'exit');
    let log = '';
    child.stderr.on('data', chunk => { log += chunk; });
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(log.slice(-1000))), 15000);
      child.once('exit', () => { clearTimeout(timeout); reject(new Error(log.slice(-1000))); });
      child.stdout.on('data', chunk => {
        log += chunk;
        const match = log.match(/listening at (http:\/\/127\.0\.0\.1:\d+)/);
        if (match) { clearTimeout(timeout); resolve(match[1]); }
      });
    });
  }
  let base = await start();
  assert.equal((await fetch(base+'/api/launch/reset',{headers:{origin:'https://untrusted.example','sec-fetch-site':'cross-site'}})).status,403,'legacy GET reset is still a mutation and requires local origin');
  const sharedPreferences = await (await fetch(base+'/shared/localPreferences.js')).text();
  assert.match(sharedPreferences,/export function normalizeLocalPreferences/);
  assert.doesNotMatch(sharedPreferences,/export \* from/,'browser aliases must serve browser-safe leaf modules, not filesystem re-export shims');
  const boot = await (await fetch(base + '/api/bootstrap')).json();
  assert.equal(boot.approvals.find(a => a.id === 'crashed-approval').status, 'uncertain');
  const patchResponse = await fetch(base + '/api/settings/local', {method:'POST',headers:{'content-type':'application/json','x-melo-bootstrap-base':boot._snapshot.token},body:JSON.stringify({name:'Contract profile'})});
  assert.equal(patchResponse.status,200);
  const patch = await patchResponse.json();
  assert.equal(patch.kind,'bootstrap-patch','real mutation response must negotiate a delta');
  assert.equal(Object.hasOwn(patch.set,'activeChat'),false,'profile save must not retransmit the transcript');
  const reconstructed = decodeBootstrap(patch,boot);
  assert.equal(reconstructed.settings.localProfile.name,'Contract profile');
  assert.deepEqual(reconstructed.activeChat,boot.activeChat);
  const fallback = await (await fetch(base+'/api/bootstrap',{headers:{'x-melo-bootstrap-base':'expired'}})).json();
  assert.ok(fallback.settings && fallback.chats,'expired baselines recover without losing fields');
  const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  for (const path of ['/api/chat/send', '/api/chat/send/stream']) {
    const bad = await post(path, { chatId: 'contract', content: { invalid: true } });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).code, 'INVALID_CONTENT');
  }
  // The supplement route is reachable and refuses text when no reply is running in the chat.
  const idle = await post('/api/chat/supplement', { chatId: 'contract', content: '改成五言' });
  assert.equal(idle.status, 409);
  assert.match((await idle.json()).error, /没有进行中的回复/);
  const body = { chatId: 'contract', content: 'hello', requestId: 'stable-request' };
  const streamed = await post('/api/chat/send/stream', body);
  assert.equal(streamed.status, 200);
  const events = (await streamed.text()).split('\n\n').filter(block => block.startsWith('event:')).map(block => ({
    event: block.match(/^event: (.+)/)[1], data: JSON.parse(block.match(/\ndata: (.+)/)[1]),
  }));
  const done = events.find(item => item.event === 'done').data;
  assert.deepEqual(done.unusedSupplements, [], 'a turn with no supplements hands none back');
  assert.equal(done.requestId, body.requestId);
  for (const item of events) {
    assert.equal(item.data.runId, done.runId);
    assert.equal(item.data.chatId, body.chatId);
  }
  const stages = events.filter(item => item.event === 'execution_scene').flatMap(item => item.data.scene.pipeline || []);
  for (const id of ['model:1', 'reply:format', 'reply:save']) {
    assert.ok(stages.some(stage => stage.id === id && stage.status === 'running'), `${id} started at a real execution boundary`);
    assert.ok(stages.some(stage => stage.id === id && stage.status === 'completed'), `${id} completed`);
  }
  const finalScene = events.filter(item => item.event === 'execution_scene').at(-1).data.scene;
  assert.equal(finalScene.status, 'completed');
  assert.equal(finalScene.operations.length, 0, 'model and delivery stages must not become fictitious tools');
  assert.deepEqual(finalScene.pipeline.map(stage => stage.id), ['model:1', 'reply:format', 'reply:save']);
  assert.equal(finalScene.pipeline[0].name, '模拟响应', 'fixture replies must not claim a live model call');
  assert.ok(finalScene.pipeline.every(stage => stage.status === 'completed' && stage.finishedAt));
  assert.ok(!finalScene.pipeline.some(stage => stage.id === 'reply:render'), 'the backend cannot claim the client has rendered the answer');
  const repeated = await (await post('/api/chat/send', body)).json();
  assert.equal(repeated.replayed, true);
  assert.equal(repeated.assistantMessage.id, done.assistantMessage.id);
  const conflict = await post('/api/chat/send', { ...body, content: 'changed' });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).code, 'REQUEST_ID_CONFLICT');
  await stop();
  base = await start();
  const afterRestart = await (await post('/api/chat/send', body)).json();
  assert.equal(afterRestart.replayed, true);
  assert.equal(afterRestart.assistantMessage.id, done.assistantMessage.id);
  assert.equal(afterRestart.runId, done.runId);
  const saved = await (await fetch(`${base}/api/chat/scenes?chatId=contract`)).json();
  assert.deepEqual(saved.scenes.find(scene => scene.runId === done.runId).pipeline, finalScene.pipeline,
    'replay preserves actual delivery evidence across server restart');
});
