import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCapabilityRecorder, readCapabilityEvidence, capabilityStatus, describeMediaEvidence, describeSearchEvidence } from './capabilities.js';

test('installation, cached results, mocks and stale successes cannot produce a green capability', () => {
  const now = Date.now();
  const live = { ok: true, level: 'body', checkedAt: new Date(now).toISOString() };
  assert.equal(capabilityStatus().status, 'yellow');
  assert.equal(capabilityStatus(live).status, 'green');
  for (const patch of [{ cached: true }, { simulated: true }, { level: 'preview' }, { checkedAt: '2000-01-01T00:00:00Z' }]) {
    assert.equal(capabilityStatus({ ...live, ...patch }).status, 'yellow');
  }
  assert.equal(capabilityStatus({ ...live, ok: false }).status, 'red');
  assert.equal(capabilityStatus({ ...live, model: 'old' }, { model: 'new' }).reason, 'configuration-changed');
});

test('social metadata is not a transcript or video understanding', () => {
  const titleOnly = { kind: 'article', text: 'Video title', metadata: { source: 'youtube-oembed' } };
  assert.equal(describeMediaEvidence({ kind: 'video' }, titleOnly).level, 'preview');
  assert.equal(describeSearchEvidence('url-fetch', { ok: true, output: 'Title', meta: { method: 'social-link', length: 100 } }).level, 'preview');
  assert.equal(describeMediaEvidence({ kind: 'image' }, null, { modelSupportsVision: true }).level, 'image-input');
  assert.equal(describeMediaEvidence({ kind: 'audio' }, { ...titleOnly, metadata: { source: 'whisper-unavailable' } }).ok, false);
  const video = { kind: 'transcript', text: 'Actual speech', metadata: { source: 'video-audio-transcript', keyframes: [{}] } };
  assert.equal(describeMediaEvidence({ kind: 'video' }, video).level, 'transcript+keyframes');
  assert.equal(describeMediaEvidence({ kind: 'video' }, { ...titleOnly, metadata: { source: 'youtube-oembed+yt-dlp', hasTranscript: true } }).level, 'transcript');
  assert.equal(describeMediaEvidence({ kind: 'link' }, { ...video, metadata: { source: 'social-link:douyin', directMediaExtractionAttempted: true, directMediaExtractionSource: 'video-keyframes-only', keyframes: [{}] }, kind: 'article' }).level, 'keyframes');
});

test('concurrent evidence writes retain every capability, bind home and omit private fields', async t => {
  const root = await mkdtemp(join(tmpdir(), 'melo-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { MELO_HOME: root };
  const record = createCapabilityRecorder({ home: root, env, config: { model: 'test-model' } });
  env.MELO_HOME = join(root, 'other');
  await Promise.all([
    record('audio', { ok: true, level: 'transcript', text: 'private transcript', url: 'private-url', reason: 'secret=token' }),
    record('video', { ok: false, level: 'none' }),
  ]);
  const saved = await readCapabilityEvidence(root);
  assert.equal(saved.audio.ok, true);
  assert.equal(saved.video.ok, false);
  assert.deepEqual(await readCapabilityEvidence(env.MELO_HOME), {});
  assert.doesNotMatch(await readFile(join(root, 'desktop/capabilities.json'), 'utf8'), /private|secret=token/);
});
