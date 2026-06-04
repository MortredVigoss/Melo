// Unit tests for the video extraction status helper.  Pure function, no
// DOM — runs under `node --test`.

import test from 'node:test';
import assert from 'node:assert/strict';
import { describeAudioExtractionStatus, describeVideoExtractionStatus } from './videoStatus.js';

function makeAttachment(id = 'att-1') {
  return { id, kind: 'video', url: 'data:video/mp4;base64,AAAA' };
}

function makeEntry({ attachmentId = 'att-1', source = 'video-audio-transcript', keyframes = null } = {}) {
  return {
    attachmentId,
    kind: 'transcript',
    text: 'extracted text',
    metadata: {
      source,
      ...(keyframes !== null ? { keyframes } : {}),
    },
  };
}

// ─── No matching entry ───────────────────────────────────────────────────────

test('no extractedMedia at all → "extraction unavailable"', () => {
  const out = describeVideoExtractionStatus({}, makeAttachment());
  assert.equal(out, 'extraction unavailable');
});

test('extractedMedia present but no attachmentId match → "extraction unavailable"', () => {
  const message = { extractedMedia: [makeEntry({ attachmentId: 'other-id' })] };
  const out = describeVideoExtractionStatus(message, makeAttachment('att-1'));
  assert.equal(out, 'extraction unavailable');
});

test('extractedMedia is non-array (defensive) → "extraction unavailable"', () => {
  const out = describeVideoExtractionStatus({ extractedMedia: 'not-an-array' }, makeAttachment());
  assert.equal(out, 'extraction unavailable');
});

test('attachment.id missing → "extraction unavailable" even if entries exist', () => {
  const message = { extractedMedia: [makeEntry()] };
  const out = describeVideoExtractionStatus(message, { kind: 'video' });
  assert.equal(out, 'extraction unavailable');
});

// ─── video-audio-transcript (happy path) ─────────────────────────────────────

test('source=video-audio-transcript + keyframes.length=3 → "transcript ✓ · keyframes ✓ (3)"', () => {
  const message = {
    extractedMedia: [makeEntry({ source: 'video-audio-transcript', keyframes: ['a', 'b', 'c'] })],
  };
  const out = describeVideoExtractionStatus(message, makeAttachment('att-1'));
  assert.equal(out, 'transcript ✓ · keyframes ✓ (3)');
});

test('source=video-audio-transcript + no keyframes → "transcript ✓"', () => {
  const message = { extractedMedia: [makeEntry({ source: 'video-audio-transcript', keyframes: [] })] };
  const out = describeVideoExtractionStatus(message, makeAttachment('att-1'));
  assert.equal(out, 'transcript ✓');
});

test('source=video-audio-transcript + keyframes field missing → "transcript ✓"', () => {
  const message = { extractedMedia: [makeEntry({ source: 'video-audio-transcript' })] };
  const out = describeVideoExtractionStatus(message, makeAttachment('att-1'));
  assert.equal(out, 'transcript ✓');
});

// ─── video-keyframes-only (audio failed, frames survived) ────────────────────

test('source=video-keyframes-only + 5 frames → "keyframes ✓ (5) · no audio transcript"', () => {
  const message = {
    extractedMedia: [makeEntry({ source: 'video-keyframes-only', keyframes: ['a', 'b', 'c', 'd', 'e'] })],
  };
  const out = describeVideoExtractionStatus(message, makeAttachment('att-1'));
  assert.equal(out, 'keyframes ✓ (5) · no audio transcript');
});

test('source=video-keyframes-only + zero frames (defensive) → "no audio transcript"', () => {
  const message = { extractedMedia: [makeEntry({ source: 'video-keyframes-only', keyframes: [] })] };
  const out = describeVideoExtractionStatus(message, makeAttachment('att-1'));
  assert.equal(out, 'no audio transcript');
});

// ─── Other source values (e.g. user-voice transcript injected) ───────────────

test('unknown source + keyframes → "transcript ✓ · keyframes ✓ (N)"', () => {
  const message = {
    extractedMedia: [makeEntry({ source: 'user-voice', keyframes: ['a', 'b'] })],
  };
  const out = describeVideoExtractionStatus(message, makeAttachment('att-1'));
  assert.equal(out, 'transcript ✓ · keyframes ✓ (2)');
});

test('unknown source + no keyframes → "transcript ✓"', () => {
  const message = { extractedMedia: [makeEntry({ source: '' })] };
  const out = describeVideoExtractionStatus(message, makeAttachment('att-1'));
  assert.equal(out, 'transcript ✓');
});

// ─── Multiple entries, only matching one counts ──────────────────────────────

test('multiple entries — only the attachmentId-matching one drives the status', () => {
  const message = {
    extractedMedia: [
      makeEntry({ attachmentId: 'other', source: 'video-audio-transcript', keyframes: ['x', 'y'] }),
      makeEntry({ attachmentId: 'att-1', source: 'video-keyframes-only', keyframes: ['k1', 'k2', 'k3'] }),
    ],
  };
  const out = describeVideoExtractionStatus(message, makeAttachment('att-1'));
  assert.equal(out, 'keyframes ✓ (3) · no audio transcript');
});

// ─── Defensive: malformed entry shapes ───────────────────────────────────────

test('entry without metadata field → falls through to "transcript ✓" branch', () => {
  // Matches by attachmentId but entry.metadata is undefined; helper should
  // not throw and should treat as a generic-source transcript.
  const message = {
    extractedMedia: [{ attachmentId: 'att-1', kind: 'transcript', text: 'x' }],
  };
  const out = describeVideoExtractionStatus(message, makeAttachment('att-1'));
  assert.equal(out, 'transcript ✓');
});

test('entry with non-array keyframes (defensive) → frameCount = 0', () => {
  const message = {
    extractedMedia: [{
      attachmentId: 'att-1',
      metadata: { source: 'video-audio-transcript', keyframes: 'not-an-array' },
    }],
  };
  const out = describeVideoExtractionStatus(message, makeAttachment('att-1'));
  assert.equal(out, 'transcript ✓');
});

test('audio: no matching entry → "transcript unavailable"', () => {
  const out = describeAudioExtractionStatus({}, { id: 'aud-1', kind: 'audio' });
  assert.equal(out, 'transcript unavailable');
});

test('audio: whisper-cpp source shows local transcription status', () => {
  const message = {
    extractedMedia: [{
      attachmentId: 'aud-1',
      kind: 'transcript',
      text: 'hello world',
      metadata: { source: 'whisper-cpp' },
    }],
  };
  const out = describeAudioExtractionStatus(message, { id: 'aud-1', kind: 'audio' });
  assert.equal(out, 'transcript ✓ · local Whisper');
});

test('audio: whisper-unavailable source does not imply the model received audio content', () => {
  const message = {
    extractedMedia: [{
      attachmentId: 'aud-1',
      kind: 'transcript',
      text: 'Audio received. Transcription requires a Whisper-compatible endpoint.',
      metadata: { source: 'whisper-unavailable' },
    }],
  };
  const out = describeAudioExtractionStatus(message, { id: 'aud-1', kind: 'audio' });
  assert.equal(out, 'transcription unavailable');
});

test('audio: voice-message (speech-recognition, linked id) → "transcript ✓ · voice input" (2026-05-23 Codex C 闭环)', () => {
  // The shape the voice auto-submit path now produces AFTER the id-linkage
  // fix: audio attachment + prefilled transcript share an id. Pre-fix the
  // voice attachment had no id and the transcript no attachmentId → no match
  // → falsely "transcript unavailable". Pins that a correctly-linked voice
  // message renders the voice-input status.
  const message = {
    extractedMedia: [{
      attachmentId: 'voice-uuid-1',
      kind: 'transcript',
      text: 'remind me to water the plants tomorrow',
      metadata: { source: 'speech-recognition', fileName: 'voice-message.wav' },
    }],
  };
  const out = describeAudioExtractionStatus(message, { id: 'voice-uuid-1', kind: 'audio' });
  assert.equal(out, 'transcript ✓ · voice input');
});

test('audio: id MISMATCH (the pre-fix bug shape) → "transcript unavailable"', () => {
  // Guards the regression directly: a transcript whose attachmentId does NOT
  // match the attachment id renders unavailable — exactly what the un-linked
  // voice path produced before the fix.
  const message = {
    extractedMedia: [{
      attachmentId: 'some-other-id',
      kind: 'transcript',
      text: 'belongs to a different attachment',
      metadata: { source: 'speech-recognition' },
    }],
  };
  const out = describeAudioExtractionStatus(message, { id: 'voice-uuid-1', kind: 'audio' });
  assert.equal(out, 'transcript unavailable');
});
