// GET /api/media/attachments/:name serves externalized chat attachments
// (src/media/attachments.js) with the right type, long-lived caching and a
// strict name check — through the media route registry and through the real
// server dispatch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { connect } from 'node:net';
import { createMediaRoutes } from './mediaRoutes.js';
import { externalizeAttachments, attachmentsDir } from '../media/attachments.js';

async function home(t) { const dir = await mkdtemp(join(tmpdir(), 'melo-attachment-route-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }

test('externalized attachments are served with their mime type and immutable caching; unknown names 404', async t => {
  const h = await home(t);
  const bytes = Buffer.alloc(6000, 9);
  const [stored] = await externalizeAttachments([{ id: '11111111-2222-4333-8444-555555555555', kind: 'image', url: `data:image/png;base64,${bytes.toString('base64')}` }], { home: h });
  const [pdf] = await externalizeAttachments([{ id: '11111111-2222-4333-8444-555555555556', kind: 'link', url: `data:application/pdf;base64,${bytes.toString('base64')}`, mimeType: 'application/pdf' }], { home: h });
  const routes = createMediaRoutes({ home: h });
  const server = createServer(async (req, res) => { if (!(await routes.handle(req, res, new URL(req.url, 'http://local'), () => true))) { res.statusCode = 404; res.end(); } });
  server.listen(0); await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;

  const image = await fetch(base + stored.url);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.equal(image.headers.get('content-length'), String(bytes.length));
  assert.equal(image.headers.get('cache-control'), 'private, max-age=31536000, immutable');
  assert.ok(Buffer.from(await image.arrayBuffer()).equals(bytes));

  const document = await fetch(base + pdf.url);
  assert.equal(document.status, 200);
  assert.equal(document.headers.get('content-type'), 'application/pdf');

  // A real file under a name this module would never mint is still unreachable.
  await mkdir(attachmentsDir(h), { recursive: true });
  await writeFile(join(attachmentsDir(h), 'secret.txt'), 'nope');
  for (const bad of ['/api/media/attachments/secret.txt', '/api/media/attachments/../../state.json', '/api/media/attachments/..%2F..%2Fstate.json',
    '/api/media/attachments/11111111-2222-4333-8444-555555555557.png', '/api/media/attachments/']) {
    // (fetch collapses `..` segments client-side; the raw-socket path below
    // covers the server-side check.)
    const response = await fetch(base + bad);
    assert.equal(response.status, 404, bad);
  }
  const missing = await fetch(base + '/api/media/attachments/11111111-2222-4333-8444-555555555557.png');
  assert.equal((await missing.json()).error, '附件不存在。');
  const raw = await new Promise((resolve, reject) => {
    const socket = connect(server.address().port, '127.0.0.1', () => {
      socket.write('GET /api/media/attachments/../../state.json HTTP/1.1\r\nHost: local\r\nConnection: close\r\n\r\n');
    });
    let data = ''; socket.on('data', chunk => { data += chunk; }); socket.on('end', () => resolve(data)); socket.on('error', reject);
  });
  assert.match(raw, /^HTTP\/1\.1 404/);
});

test('GET /api/media/attachments/:name reaches its handler through the real server dispatch', { timeout: 45000 }, async t => {
  const h = await home(t);
  const bytes = Buffer.alloc(5000, 3);
  const [stored] = await externalizeAttachments([{ id: '11111111-2222-4333-8444-555555555558', kind: 'audio', url: `data:audio/wav;base64,${bytes.toString('base64')}` }], { home: h });
  const child = spawn(process.execPath, ['src/server.js', '--host', '127.0.0.1', '--port', '0'], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    env: { ...process.env, MELO_HOME: h, MELO_TEST_MODE: '1', MELO_MEMORY_RUNTIME: '0', MELO_DREAMING_ENABLED: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = once(child, 'exit');
  t.after(async () => {
    const kill = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.kill('SIGTERM');
    await closed;
    clearTimeout(kill);
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
  const response = await fetch(base + stored.url, { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'audio/wav');
  assert.ok(Buffer.from(await response.arrayBuffer()).equals(bytes));
  const missing = await fetch(base + '/api/media/attachments/11111111-2222-4333-8444-555555555559.wav', { signal: AbortSignal.timeout(5000) });
  assert.equal(missing.status, 404);
});

// ─── 2026-10-18 bug audit (section 2) ────────────────────────────────────────

test('L11/L20: attachments answer Range with 206 + Accept-Ranges, carry nosniff, and non-raster types download instead of rendering', async t => {
  const h = await home(t);
  const bytes = Buffer.from(Array.from({ length: 6000 }, (_, i) => i % 251));
  const attach = (id, mime) => externalizeAttachments([{ id, kind: 'file', url: `data:${mime};base64,${bytes.toString('base64')}`, mimeType: mime }], { home: h }).then(([a]) => a);
  const audio = await attach('11111111-2222-4333-8444-66666666660a', 'audio/mpeg');
  const svg = await attach('11111111-2222-4333-8444-66666666660b', 'image/svg+xml');
  const pdf = await attach('11111111-2222-4333-8444-66666666660c', 'application/pdf');
  const png = await attach('11111111-2222-4333-8444-66666666660d', 'image/png');
  const video = await attach('11111111-2222-4333-8444-66666666660e', 'video/mp4');
  const routes = createMediaRoutes({ home: h });
  const server = createServer(async (req, res) => { if (!(await routes.handle(req, res, new URL(req.url, 'http://local'), () => true))) { res.statusCode = 404; res.end(); } });
  server.listen(0); await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;

  const whole = await fetch(base + audio.url);
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get('accept-ranges'), 'bytes');
  assert.equal(whole.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(whole.headers.get('content-disposition'), null, 'audio plays inline');
  assert.equal(whole.headers.get('content-type'), 'audio/mpeg');

  const ranged = await fetch(base + audio.url, { headers: { Range: 'bytes=100-199' } });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get('content-range'), `bytes 100-199/${bytes.length}`);
  assert.equal(ranged.headers.get('content-length'), '100');
  assert.equal(ranged.headers.get('accept-ranges'), 'bytes');
  assert.equal(ranged.headers.get('cache-control'), 'private, max-age=31536000, immutable');
  assert.ok(Buffer.from(await ranged.arrayBuffer()).equals(bytes.subarray(100, 200)));
  const tail = await fetch(base + audio.url, { headers: { Range: 'bytes=5900-' } });
  assert.equal(tail.status, 206);
  assert.ok(Buffer.from(await tail.arrayBuffer()).equals(bytes.subarray(5900)));
  const suffix = await fetch(base + audio.url, { headers: { Range: 'bytes=-50' } });
  assert.equal(suffix.status, 206);
  assert.ok(Buffer.from(await suffix.arrayBuffer()).equals(bytes.subarray(bytes.length - 50)));
  const bad = await fetch(base + audio.url, { headers: { Range: 'bytes=9999-' } });
  assert.equal(bad.status, 416);
  assert.equal(bad.headers.get('content-range'), `bytes */${bytes.length}`);
  const videoRanged = await fetch(base + video.url, { headers: { Range: 'bytes=0-9' } });
  assert.equal(videoRanged.status, 206);
  assert.equal(videoRanged.headers.get('content-disposition'), null, 'video plays inline');

  for (const [attachment, type] of [[svg, 'image/svg+xml'], [pdf, 'application/pdf']]) {
    const response = await fetch(base + attachment.url);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), type);
    assert.match(response.headers.get('content-disposition'), /^attachment; filename="[0-9a-f-]+\.(svg|pdf)"$/);
    assert.equal(response.headers.get('content-security-policy'), 'sandbox');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  }
  const image = await fetch(base + png.url);
  assert.equal(image.headers.get('content-disposition'), null, 'raster images render inline');
  assert.equal(image.headers.get('x-content-type-options'), 'nosniff');
});
