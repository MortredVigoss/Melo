// Videos are uploaded as a stream into the Melo home, served back with ranges
// for the player, and studied from disk with more frames than a quick glance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { saveUpload, uploadPath, uploadsDir } from './uploads.js';
import { createMediaRoutes } from '../http/mediaRoutes.js';
import { extractVideoContent, _setExtractAudioContentForTests } from './extractors/videoExtractor.js';

async function home(t) { const dir = await mkdtemp(join(tmpdir(), 'melo-upload-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }

test('an upload is streamed to disk; oversize uploads leave nothing behind; only known names resolve', async t => {
  const h = await home(t);
  const saved = await saveUpload(Readable.from([Buffer.alloc(1000, 1), Buffer.alloc(500, 2)]), { home: h, mimeType: 'video/mp4', fileName: 'a.mp4' });
  assert.equal(saved.size, 1500);
  assert.equal(uploadPath(saved.url, h), join(uploadsDir(h), saved.name));
  await assert.rejects(saveUpload(Readable.from([Buffer.alloc(800), Buffer.alloc(800)]), { home: h, mimeType: 'video/mp4', maxBytes: 1000 }), /超过/);
  assert.deepEqual((await readdir(uploadsDir(h))).sort(), [saved.name], 'no partial file left');
  await assert.rejects(saveUpload(Readable.from([Buffer.alloc(10)]), { home: h, mimeType: 'application/x-sh', fileName: 'x.sh' }), /只支持/);
  for (const bad of ['/api/media/uploads/../../state.json', '/api/media/uploads/x.mp4', 'https://example.com/a.mp4']) assert.equal(uploadPath(bad, h), null, bad);
});

test('uploaded videos are served with byte ranges so the player can seek', async t => {
  const h = await home(t);
  const saved = await saveUpload(Readable.from([Buffer.from('0123456789')]), { home: h, mimeType: 'video/mp4' });
  const routes = createMediaRoutes({ home: h });
  const server = createServer(async (req, res) => { if (!(await routes.handle(req, res, new URL(req.url, 'http://local'), () => true))) { res.statusCode = 404; res.end(); } });
  server.listen(0); await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const ranged = await fetch(base + saved.url, { headers: { range: 'bytes=2-5' } });
  assert.equal(ranged.status, 206); assert.equal(await ranged.text(), '2345');
  assert.equal(ranged.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal((await fetch(base + '/api/media/uploads/not-a-video.mp4')).status, 404);
});

test('an uploaded video is read from disk and studied with more, sharper frames and their times', { skip: spawnSync('ffmpeg', ['-version']).status !== 0 }, async t => {
  const h = await home(t);
  const source = join(h, 'clip.mp4');
  spawnSync('ffmpeg', ['-f', 'lavfi', '-i', 'testsrc=duration=120:size=1280x720:rate=5', '-pix_fmt', 'yuv420p', '-y', source]);
  const { readFile } = await import('node:fs/promises');
  const saved = await saveUpload(Readable.from([await readFile(source)]), { home: h, mimeType: 'video/mp4' });
  _setExtractAudioContentForTests(async () => null); t.after(() => _setExtractAudioContentForTests(null));
  const result = await extractVideoContent({ id: 'v', kind: 'video', url: saved.url, fileName: 'clip.mp4' }, { home: h });
  assert.equal(result.metadata.source, 'video-keyframes-only');
  // 120 s at one frame per 15 s → 8 frames (a quick glance takes 5), 768 px wide, with their times.
  assert.equal(result.metadata.keyframes.length, 8);
  assert.deepEqual(result.metadata.keyframeTimes, [0, 15, 30, 45, 60, 75, 90, 105]);
  const sharp = (await import('sharp')).default;
  const first = Buffer.from(result.metadata.keyframes[0].split(',')[1], 'base64');
  assert.equal((await sharp(first).metadata()).width, 768);
  assert.ok((await readdir(uploadsDir(h))).includes(saved.name), 'the uploaded video stays after extraction');
});
