import test from 'node:test';
import assert from 'node:assert/strict';
import { selectTtsBridgeCallback } from './ttsBridgeRouter.js';

function avaudioRef() {
  let called = 0;
  return {
    source: 'avaudio',
    _onAudioEnded: () => { called += 1; },
    callCount: () => called,
  };
}

function sayRef() {
  let called = 0;
  return {
    source: 'say',
    _onSayEnded: () => { called += 1; },
    callCount: () => called,
  };
}

test('avaudio ref + audioEnded → returns _onAudioEnded', () => {
  const ref = avaudioRef();
  const cb = selectTtsBridgeCallback({ action: 'audioEnded' }, ref);
  assert.equal(typeof cb, 'function');
  cb();
  assert.equal(ref.callCount(), 1);
});

test('avaudio ref + audioFailed → returns _onAudioEnded', () => {
  const ref = avaudioRef();
  const cb = selectTtsBridgeCallback({ action: 'audioFailed' }, ref);
  assert.equal(typeof cb, 'function');
});

test('say ref + sayEnded → returns _onSayEnded', () => {
  const ref = sayRef();
  const cb = selectTtsBridgeCallback({ action: 'sayEnded' }, ref);
  assert.equal(typeof cb, 'function');
  cb();
  assert.equal(ref.callCount(), 1);
});

test('cross-engine stale event (the bug Codex caught): old sayEnded after new playAudio bridgeRef installed → returns null', () => {
  // Simulates: user clicks speak msg A (say), waitUntilExit pending. User
  // clicks speak msg B (playAudio). Swift terminates msg A's say AND
  // installs new AVAudio. msg A's waitUntilExit returns → emits sayEnded.
  // _ttsAudio is now the new avaudio bridgeRef.
  const newAvaudio = avaudioRef();
  const cb = selectTtsBridgeCallback({ action: 'sayEnded' }, newAvaudio);
  assert.equal(cb, null, 'stale sayEnded must NOT clear new AVAudio ref');
  assert.equal(newAvaudio.callCount(), 0);
});

test('symmetric stale: old audioEnded after new say bridgeRef installed → returns null', () => {
  const newSay = sayRef();
  const cb = selectTtsBridgeCallback({ action: 'audioEnded' }, newSay);
  assert.equal(cb, null);
});

test('null ref → returns null', () => {
  assert.equal(selectTtsBridgeCallback({ action: 'audioEnded' }, null), null);
});

test('unknown action → returns null', () => {
  assert.equal(selectTtsBridgeCallback({ action: 'startedDancing' }, avaudioRef()), null);
});

test('avaudio ref without _onAudioEnded → returns null', () => {
  assert.equal(selectTtsBridgeCallback({ action: 'audioEnded' }, { source: 'avaudio' }), null);
});

test('ref without source field → returns null', () => {
  assert.equal(selectTtsBridgeCallback({ action: 'audioEnded' }, { _onAudioEnded() {} }), null);
});
