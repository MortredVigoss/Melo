// Locks the four MiniMax voice resolution cases (Codex C #14 + #15
// regressions). The browser app.js calls resolveActiveMinimaxVoiceId
// from the same module, so these tests guard the priority logic
// regardless of which runtime invokes it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveActiveMinimaxVoiceId } from './minimaxVoiceResolver.js';

test('cache valid (matches an agent voice) → use cache', () => {
  const out = resolveActiveMinimaxVoiceId({
    cachedId: 'voice-A',
    agentVoiceIds: ['voice-A', 'voice-B'],
    savedDefault: 'voice-default',
  });
  assert.equal(out.voiceId, 'voice-A');
  assert.equal(out.droppedStaleCache, false);
});

test('cache valid (matches saved default) → use cache, no drop', () => {
  const out = resolveActiveMinimaxVoiceId({
    cachedId: 'voice-default',
    agentVoiceIds: [],
    savedDefault: 'voice-default',
  });
  assert.equal(out.voiceId, 'voice-default');
  assert.equal(out.droppedStaleCache, false);
});

test('cache stale (no longer in valid set) + saved default exists → use default, drop cache', () => {
  // The Codex C #15 scenario: user removed voice-X from agent A and
  // saved voice-Y as the connector default; cache still points at X.
  const out = resolveActiveMinimaxVoiceId({
    cachedId: 'voice-X',
    agentVoiceIds: [],
    savedDefault: 'voice-Y',
  });
  assert.equal(out.voiceId, 'voice-Y', 'must use saved default, not stale cache');
  assert.equal(out.droppedStaleCache, true, 'caller must clear localStorage');
});

test('cache stale + no saved default but agents present → first agent voice', () => {
  const out = resolveActiveMinimaxVoiceId({
    cachedId: 'voice-old',
    agentVoiceIds: ['voice-A', 'voice-B'],
    savedDefault: '',
  });
  assert.equal(out.voiceId, 'voice-A');
  assert.equal(out.droppedStaleCache, true);
});

test('no cache, saved default present → use default, no drop signal', () => {
  const out = resolveActiveMinimaxVoiceId({
    cachedId: '',
    agentVoiceIds: ['voice-A'],
    savedDefault: 'voice-Y',
  });
  assert.equal(out.voiceId, 'voice-Y', 'saved default wins over agent voices when cache is empty');
  assert.equal(out.droppedStaleCache, false);
});

test('no cache, no saved default, agents available → first agent voice', () => {
  const out = resolveActiveMinimaxVoiceId({
    cachedId: '',
    agentVoiceIds: ['voice-A', 'voice-B'],
    savedDefault: '',
  });
  assert.equal(out.voiceId, 'voice-A');
  assert.equal(out.droppedStaleCache, false);
});

test('nothing configured → empty voiceId, caller refuses activation (Codex C #14 anti-wipe)', () => {
  const out = resolveActiveMinimaxVoiceId({
    cachedId: '',
    agentVoiceIds: [],
    savedDefault: '',
  });
  assert.equal(out.voiceId, '', 'must return empty so caller skips POST');
  assert.equal(out.droppedStaleCache, false);
});

test('stale cache, nothing else → empty voiceId AND drop cache', () => {
  // Edge case: only the cache exists and it points at a voice that's
  // no longer valid. Must return '' (caller refuses) AND signal cache
  // drop so a stale localStorage doesn't keep haunting the user.
  const out = resolveActiveMinimaxVoiceId({
    cachedId: 'voice-old',
    agentVoiceIds: [],
    savedDefault: '',
  });
  assert.equal(out.voiceId, '');
  assert.equal(out.droppedStaleCache, true);
});

test('whitespace and array sanitization', () => {
  const out = resolveActiveMinimaxVoiceId({
    cachedId: '  voice-A  ',
    agentVoiceIds: ['  voice-A  ', '', null, undefined, 'voice-B'],
    savedDefault: '   ',
  });
  assert.equal(out.voiceId, 'voice-A');
  assert.equal(out.droppedStaleCache, false);
});

test('input defaults safely to empty when called with no args', () => {
  const out = resolveActiveMinimaxVoiceId();
  assert.equal(out.voiceId, '');
  assert.equal(out.droppedStaleCache, false);
});
