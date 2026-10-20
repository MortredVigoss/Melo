import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, realpath, mkdir, rm, writeFile, readFile, symlink, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { createMediaRoutes } from './mediaRoutes.js';
import { updateStateAtomically } from '../state/stateStore.js';
import { createExecutionRecorder, pruneExecutionScenes } from '../services/chat/executionScenes.js';
import { readImageRecords, imageHomeScope, archiveSceneImages } from '../media/imageRecords.js';
import { signWorkspaceFileUrl, verifySignedFileUrl } from '../web/urlSigning.js';

async function fixture(t, { legacyWorkspace = false } = {}) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'saved-image-')));
  const ws = legacyWorkspace ? join(home, 'old-project') : join(home, 'workspaces', 'chats', 'chat');
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

async function legacyFixture(t) {
  const f = await fixture(t, { legacyWorkspace: true });
  f.recordsPath = join(f.home, 'desktop', 'image-records', 'run.json');
  f.scenePath = join(f.home, 'desktop', 'execution-scenes', 'run.json');
  const record = JSON.parse(await readFile(f.recordsPath, 'utf8'));
  // Reproduce the already-written bad registration in the installed app.
  record.workspacePath = join(f.home, 'workspaces', 'chats', 'chat');
  record.canonicalRoot = null;
  for (const artifact of record.artifacts) {
    delete artifact.workspacePath;
    delete artifact.canonicalRoot;
  }
  await writeFile(f.recordsPath, JSON.stringify(record));
  return f;
}

test('legacy workspace repairs an existing wrong registration without changing originals or messages', async t => {
  const f = await legacyFixture(t);
  const stateBefore = await readFile(join(f.home, 'desktop', 'state.json'));
  const result = await f.resolveImage(); assert.equal(result.status, 200);
  const image = await result.json();
  assert.deepEqual(Buffer.from(await (await fetch(f.base + image.url)).arrayBuffer()), f.bytes);
  assert.deepEqual(await readFile(f.path), f.bytes);
  assert.deepEqual(await readFile(join(f.home, 'desktop', 'state.json')), stateBefore);
  assert.equal((await readImageRecords(f.home, 'run')).artifacts[0].workspacePath, f.ws);
  // Later telemetry archival must not undo the recovered image binding.
  const scene = JSON.parse(await readFile(f.scenePath, 'utf8'));
  await archiveSceneImages(f.home, scene, join(f.home, 'workspaces', 'chats', 'chat'));
  assert.deepEqual(Buffer.from(await (await fetch(f.base + image.url)).arrayBuffer()), f.bytes);
});

test('old scenes recover after a chat moves to another project and keep working after scene pruning', async t => {
  const f = await legacyFixture(t);
  await rm(f.recordsPath);
  await updateStateAtomically(state => {
    state.projects.push({ id: 'new-project', name: 'new', workspacePath: join(f.home, 'new-project') });
    state.chats.find(c => c.id === 'chat').projectId = 'new-project';
  }, { home: f.home });
  // Archiving a scene during pruning used to leave no trustworthy workspace.
  await pruneExecutionScenes(f.home, { now: Date.now() + 30 * 86400000 });
  await assert.rejects(readFile(f.scenePath), { code: 'ENOENT' });
  const response = await f.resolveImage(); assert.equal(response.status, 200);
  const image = await response.json();
  assert.deepEqual(Buffer.from(await (await fetch(f.base + image.url)).arrayBuffer()), f.bytes);
});

test('cold legacy scene backfill matches the saved URL identity despite re-signing', async t => {
  const f = await legacyFixture(t);
  await rm(f.recordsPath);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 2000 });
  const result = await f.resolveImage(); assert.equal(result.status, 200);
  const image = await result.json();
  assert.deepEqual(Buffer.from(await (await fetch(f.base + image.url)).arrayBuffer()), f.bytes);
});

test('scene-projected attachment ids and refreshed URLs resolve only their saved message image', async t => {
  const f = await legacyFixture(t);
  await rm(f.recordsPath);
  const projected = { ...f.reference, attachmentId: 'artifact', url: signWorkspaceFileUrl(f.path, { ttlMs: 60000 }) };
  assert.notEqual(projected.url, f.signedUrl);
  const response = await f.resolveImage(projected); assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await (await fetch(f.base + (await response.json()).url)).arrayBuffer()), f.bytes);
  assert.equal((await f.resolveImage({ ...projected, attachmentId: 'unknown' })).status, 404);
  assert.equal((await f.resolveImage({ ...projected, url: signWorkspaceFileUrl('/private/generated/picture.png') })).status, 404);
  await updateStateAtomically(state => { state.chats.find(c => c.id === 'chat').messages[0].attachments = []; }, { home: f.home });
  assert.equal((await f.resolveImage(projected)).status, 404, 'a scene id without the persisted message attachment is insufficient');
});

test('concurrent legacy recovery binds each image to its own recorded workspace', async t => {
  const f = await legacyFixture(t);
  const secondRoot = join(f.home, 'another-old-project');
  await mkdir(join(secondRoot, 'generated'), { recursive: true });
  const secondPath = join(secondRoot, 'generated', 'second.png');
  const secondBytes = await sharp(f.bytes).resize(16, 12).png().toBuffer();
  await writeFile(secondPath, secondBytes);
  const secondUrl = signWorkspaceFileUrl(secondPath);
  await archiveSceneImages(f.home, { runId: 'run', chatId: 'chat',
    artifacts: [{ id: 'second', kind: 'image', path: secondPath, url: secondUrl }] });
  await updateStateAtomically(state => {
    state.chats.find(c => c.id === 'chat').messages[0].attachments.push({ id: 'second', kind: 'image', url: secondUrl });
  }, { home: f.home });
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) =>
    f.resolveImage(i % 2 ? { ...f.reference, attachmentId: 'second' } : f.reference)));
  for (const [i, response] of results.entries()) {
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await (await fetch(f.base + (await response.json()).url)).arrayBuffer()), i % 2 ? secondBytes : f.bytes);
  }
  const record = await readImageRecords(f.home, 'run');
  assert.deepEqual(record.artifacts.map(a => a.workspacePath), [f.ws, secondRoot]);
});

test('legacy recovery refuses unrelated paths, attachment mismatches and symlinks before binding', async t => {
  const f = await legacyFixture(t);
  const initial = await readFile(f.recordsPath, 'utf8');
  const outside = join(f.home, 'private', 'generated', 'picture.png');
  await mkdir(join(f.home, 'private', 'generated'), { recursive: true });
  await writeFile(outside, f.bytes);
  const tampered = JSON.parse(initial);
  tampered.artifacts[0].path = outside;
  await writeFile(f.recordsPath, JSON.stringify(tampered));
  assert.notEqual((await f.resolveImage()).status, 200, 'a path alone is not authority');
  await writeFile(f.recordsPath, initial);
  await updateStateAtomically(state => {
    state.chats.find(c => c.id === 'chat').messages[0].attachments[0].url = signWorkspaceFileUrl(outside);
  }, { home: f.home });
  assert.notEqual((await f.resolveImage()).status, 200, 'matching an id alone cannot authorize a different URL');
  await updateStateAtomically(state => {
    state.chats.find(c => c.id === 'chat').messages[0].attachments[0].url = f.signedUrl;
  }, { home: f.home });
  await rm(f.path); await symlink(outside, f.path);
  assert.equal((await f.resolveImage()).status, 403);
  assert.equal((await readImageRecords(f.home, 'run')).artifacts[0].workspacePath, undefined);
  await rm(join(f.ws, 'generated'), { recursive: true });
  await symlink(join(f.home, 'private', 'generated'), join(f.ws, 'generated'));
  assert.equal((await f.resolveImage()).status, 403, 'ancestor links are not rebound');
});

test('a recovered workspace stays pinned when its root is replaced by a symlink', async t => {
  const f = await legacyFixture(t);
  const response = await f.resolveImage(); assert.equal(response.status, 200);
  const image = await response.json();
  await rename(f.ws, f.ws + '-moved');
  await symlink(f.ws + '-moved', f.ws);
  assert.equal((await f.resolveImage()).status, 403);
  assert.equal((await fetch(f.base + image.url)).status, 403);
});

test('an unregistered legacy root cannot be authorized through a symlink', async t => {
  const f = await legacyFixture(t);
  await rename(f.ws, f.ws + '-moved');
  await symlink(f.ws + '-moved', f.ws);
  assert.equal((await f.resolveImage()).status, 403);
  assert.equal((await readImageRecords(f.home, 'run')).artifacts[0].workspacePath, undefined);
});

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

for (const legacy of [false, true]) test(`real server cold restarts and port changes preserve ${legacy ? 'legacy' : 'current'} image preview and save`, { timeout: 60000 }, async t => {
  const f = legacy ? await legacyFixture(t) : await fixture(t);
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
