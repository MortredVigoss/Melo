import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, realpath, mkdir, rm, writeFile, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { createMediaRoutes } from './mediaRoutes.js';
import { updateStateAtomically } from '../state/stateStore.js';
import { createExecutionRecorder, pruneExecutionScenes } from '../services/chat/executionScenes.js';
import { readImageRecords, imageHomeScope } from '../media/imageRecords.js';
import { signWorkspaceFileUrl, verifySignedFileUrl } from '../web/urlSigning.js';

async function fixture(t) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'saved-image-')));
  const ws = join(home, 'workspaces', 'chats', 'chat');
  await mkdir(join(ws, 'generated'), { recursive: true });
  const path = join(ws, 'generated', 'picture.png');
  const bytes = await sharp({ create: { width: 32, height: 24, channels: 3, background: '#af9864' } }).png().toBuffer();
  await writeFile(path, bytes);
  const signedUrl = signWorkspaceFileUrl(path, { ttlMs: 1000 });
  const record = createExecutionRecorder({ home, runId: 'run', chatId: 'chat', workspacePath: ws }, 'image');
  record.event({ artifacts: [{ id: 'artifact', kind: 'image', path, url: signedUrl }] });
  await record.finish('completed');
  await updateStateAtomically(state => {
    state.chats.push({ id: 'chat', title: 'fixture', projectId: null, messages: [
      { id: 'reply', role: 'assistant', content: '', metadata: { runId: 'run', chatId: 'chat' },
        attachments: [{ id: 'attachment', kind: 'image', url: signedUrl }] },
    ] });
  }, { home });
  const reference = { chatId: 'chat', messageId: 'reply', attachmentId: 'attachment' };
  const routes = createMediaRoutes({ home });
  const server = createServer(async (req, res) => {
    if (!await routes.handle(req, res, new URL(req.url, 'http://local'), () => true)) { res.statusCode = 404; res.end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(done => server.close(done)); await rm(home, { recursive: true, force: true }); });
  const resolveImage = ref => fetch(`${base}/api/media/images/resolve?${new URLSearchParams(ref || reference)}`);
  return { home, ws, path, bytes, signedUrl, reference, base, resolveImage };
}

test('expired signatures and pruned execution history still resolve original image bytes', async t => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 2000 });
  const oldParams = new URL(f.signedUrl).searchParams;
  assert.equal(verifySignedFileUrl(oldParams), null);
  await pruneExecutionScenes(f.home, { now: Date.now() + 30 * 86400000 });
  await assert.rejects(readFile(join(f.home, 'desktop', 'execution-scenes', 'run.json')), { code: 'ENOENT' });
  assert.ok(await readImageRecords(f.home, 'run'), 'image identity outlives scene');
  const result = await f.resolveImage(); assert.equal(result.status, 200);
  const image = await result.json();
  assert.match(image.url, /^\/api\/media\/images\//);
  const originalHash = createHash('sha256').update(f.bytes).digest('hex');
  const response = await fetch(f.base + image.url);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  const downloaded = Buffer.from(await response.arrayBuffer());
  assert.equal(createHash('sha256').update(downloaded).digest('hex'), originalHash);
  assert.deepEqual(await readFile(f.path), f.bytes);
});

test('unregistered URL payloads, other homes, outside paths and symlink targets are refused', async t => {
  const f = await fixture(t);
  const good = await (await f.resolveImage()).json();
  assert.equal((await fetch(f.base + good.url.replace(imageHomeScope(f.home), imageHomeScope(f.home + '-other')))).status, 404);
  assert.equal((await f.resolveImage({ ...f.reference, attachmentId: 'fake', url: signWorkspaceFileUrl('/etc/passwd') })).status, 404);
  const recordsPath = join(f.home, 'desktop', 'image-records', 'run.json');
  const record = JSON.parse(await readFile(recordsPath, 'utf8'));
  const originalPath = record.artifacts[0].path;
  record.artifacts[0].path = '/etc/passwd';
  await writeFile(recordsPath, JSON.stringify(record));
  let response = await fetch(f.base + good.url); assert.equal(response.status, 403);
  assert.equal((await response.json()).code, 'IMAGE_PATH_DENIED');
  record.artifacts[0].path = originalPath; await writeFile(recordsPath, JSON.stringify(record));
  const outside = join(f.home, 'outside.png'); await writeFile(outside, f.bytes);
  await rm(f.path); await symlink(outside, f.path);
  response = await fetch(f.base + good.url); assert.equal(response.status, 403);
  assert.equal((await response.json()).code, 'IMAGE_PATH_DENIED');
  await rm(f.path); await rm(join(f.ws, 'generated'), { recursive: true });
  await mkdir(join(f.home, 'outside')); await writeFile(join(f.home, 'outside', 'picture.png'), f.bytes);
  await symlink(join(f.home, 'outside'), join(f.ws, 'generated'));
  assert.equal((await fetch(f.base + good.url)).status, 403, 'ancestor link is also refused');
});

test('missing and damaged originals produce distinct failures, never a forged success', async t => {
  const f = await fixture(t);
  const image = await (await f.resolveImage()).json();
  await writeFile(f.path, 'not an image');
  let response = await fetch(f.base + image.url);
  assert.equal(response.status, 422); assert.equal((await response.json()).code, 'IMAGE_DAMAGED');
  await rm(f.path);
  response = await f.resolveImage();
  assert.equal(response.status, 404); assert.equal((await response.json()).code, 'IMAGE_FILE_MISSING');
});

test('legacy scenes backfill trusted image identities without rewriting messages or original files', async t => {
  const f = await fixture(t);
  await rm(join(f.home, 'desktop', 'image-records'), { recursive: true });
  const result = await f.resolveImage(); assert.equal(result.status, 200);
  assert.ok(await readImageRecords(f.home, 'run'));
  assert.deepEqual(await readFile(f.path), f.bytes);
});

test('already-pruned legacy history recovers only its registered generated file, never an arbitrary p path', async t => {
  const f = await fixture(t);
  await rm(join(f.home, 'desktop', 'image-records'), { recursive: true });
  await rm(join(f.home, 'desktop', 'execution-scenes'), { recursive: true });
  assert.equal((await f.resolveImage()).status, 200);
  assert.deepEqual(await readFile(f.path), f.bytes);
  await rm(join(f.home, 'desktop', 'image-records'), { recursive: true });
  await updateStateAtomically(state => {
    const message = state.chats.find(c => c.id === 'chat').messages[0];
    // Same basename, but a malicious encoded path outside the generated root.
    message.attachments[0].url = signWorkspaceFileUrl(join(f.home, 'private', 'picture.png'));
  }, { home: f.home });
  assert.equal((await f.resolveImage()).status, 404);
});

test('concurrent legacy image recovery keeps every attachment in the durable record', async t => {
  const f = await fixture(t);
  await rm(join(f.home, 'desktop', 'image-records'), { recursive: true });
  await rm(join(f.home, 'desktop', 'execution-scenes'), { recursive: true });
  const secondPath = join(f.ws, 'generated', 'second.png');
  await writeFile(secondPath, f.bytes);
  await updateStateAtomically(state => {
    state.chats.find(c => c.id === 'chat').messages[0].attachments.push({
      id: 'second', kind: 'image', url: signWorkspaceFileUrl(secondPath),
    });
  }, { home: f.home });
  const responses = await Promise.all([f.resolveImage(), f.resolveImage({ ...f.reference, attachmentId: 'second' })]);
  for (const response of responses) {
    assert.equal(response.status, 200);
    const image = await response.json();
    assert.deepEqual(Buffer.from(await (await fetch(f.base + image.url)).arrayBuffer()), f.bytes);
  }
  assert.equal((await readImageRecords(f.home, 'run')).artifacts.length, 2);
});

test('real server cold restarts and port changes preserve image preview and save', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  let child, exited;
  async function stop() {
    if (!child) return;
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    child.kill('SIGTERM'); await exited; clearTimeout(timer); child = null;
  }
  async function start() {
    child = spawn(process.execPath, ['src/server.js', '--host', '127.0.0.1', '--port', '0'], {
      cwd: resolve('.'), env: { ...process.env, MELO_HOME: f.home, MELO_TEST_MODE: '1', MELO_MEMORY_RUNTIME: '0', MELO_DREAMING_ENABLED: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    exited = once(child, 'exit');
    return new Promise((done, reject) => {
      let log = ''; const timer = setTimeout(() => reject(new Error(log.slice(-2000))), 20000);
      child.stderr.on('data', bytes => { log += bytes; });
      child.stdout.on('data', bytes => { log += bytes; const match = log.match(/listening at (http:\/\/127\.0\.0\.1:\d+)/); if (match) { clearTimeout(timer); done(match[1]); } });
      child.once('exit', () => { clearTimeout(timer); reject(new Error(log.slice(-2000))); });
    });
  }
  // Stop the child before fixture cleanup removes its home.
  try {
    const first = await start();
    const old = new URL(f.signedUrl);
    assert.equal((await fetch(first + old.pathname + old.search)).status, 403, 'different process rejects previous signing key');
    const resolved = await fetch(first + '/api/media/images/resolve?' + new URLSearchParams(f.reference));
    assert.equal(resolved.status, 200); const image = await resolved.json();
    assert.deepEqual(Buffer.from(await (await fetch(first + image.url)).arrayBuffer()), f.bytes);
    await stop();
    const second = await start();
    assert.notEqual(first, second);
    assert.deepEqual(Buffer.from(await (await fetch(second + image.url)).arrayBuffer()), f.bytes);
    assert.deepEqual(await readFile(f.path), f.bytes);
  } finally { await stop(); }
});
