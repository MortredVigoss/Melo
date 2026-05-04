// fileSafetyResponse.test.js — pure unit coverage for the Phase 3
// confirm-delete retry contract that Codex review marked as a
// follow-up (only static-source + backend retry case were pinning
// it before this).
//
// Behaviours tested:
//   - non-confirm-stage entries get optimistically removed before the
//     server round-trip, like the legacy tool-runner dialog
//   - confirm-stage entries do NOT remove pre-await — the dialog must
//     stay until the server reply lands so a typo is recoverable
//   - confirm-stage + ok:false + reason:'CONFIRMATION_MISMATCH' → keep
//     the entry, attach a "Typed value did not match …" banner
//   - confirm-stage + thrown error → keep the entry, attach the
//     thrown message so the user knows to retry
//   - confirm-stage + clean response → drop the entry
//   - non-confirm-stage error path is a noop (entry already gone, no
//     retry surface)

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isFileSafetyConfirmStage,
  decideFileSafetyPreflight,
  decideFileSafetyResponseAction,
} from './fileSafetyResponse.js';

// ── isFileSafetyConfirmStage ──────────────────────────────────────────

test('isFileSafetyConfirmStage: only true when kind+op+stage all match', () => {
  assert.equal(
    isFileSafetyConfirmStage({ kind: 'file_safety', operation: 'delete', payload: { stage: 'confirm' } }),
    true,
  );
  // delete stage 1 (intent) is NOT recoverable — explicit cancel via Deny
  assert.equal(
    isFileSafetyConfirmStage({ kind: 'file_safety', operation: 'delete', payload: { stage: 'intent' } }),
    false,
  );
  assert.equal(
    isFileSafetyConfirmStage({ kind: 'file_safety', operation: 'write_overwrite', payload: { stage: 'confirm' } }),
    false,
  );
  assert.equal(isFileSafetyConfirmStage({ kind: 'tool', toolId: 'bash' }), false);
  assert.equal(isFileSafetyConfirmStage(null), false);
  assert.equal(isFileSafetyConfirmStage(undefined), false);
});

// ── decideFileSafetyPreflight ─────────────────────────────────────────

test('decideFileSafetyPreflight: non-confirm stages remove optimistically', () => {
  const writeEntry = {
    kind: 'file_safety',
    operation: 'write_overwrite',
    payload: { path: '/tmp/x' },
  };
  assert.deepEqual(decideFileSafetyPreflight(writeEntry), { action: 'remove_optimistic' });

  const deleteIntent = {
    kind: 'file_safety',
    operation: 'delete',
    payload: { stage: 'intent' },
  };
  assert.deepEqual(decideFileSafetyPreflight(deleteIntent), { action: 'remove_optimistic' });

  // Tool-runner entry shape — also optimistic, same legacy behaviour.
  assert.deepEqual(
    decideFileSafetyPreflight({ kind: 'tool', toolId: 'bash' }),
    { action: 'remove_optimistic' },
  );
});

test('decideFileSafetyPreflight: confirm stage does NOT remove pre-await', () => {
  const entry = {
    kind: 'file_safety',
    operation: 'delete',
    payload: { stage: 'confirm', expectedConfirmation: 'foo.txt' },
  };
  assert.deepEqual(decideFileSafetyPreflight(entry), { action: 'noop' });
});

// ── decideFileSafetyResponseAction ────────────────────────────────────

test('post-await: confirm stage clean response → remove', () => {
  const entry = { kind: 'file_safety', operation: 'delete', payload: { stage: 'confirm' } };
  const decision = decideFileSafetyResponseAction({ entry, response: { ok: true } });
  assert.deepEqual(decision, { action: 'remove' });
});

test('post-await: confirm stage CONFIRMATION_MISMATCH → mark_error with expected name', () => {
  const entry = { kind: 'file_safety', operation: 'delete', payload: { stage: 'confirm' } };
  const decision = decideFileSafetyResponseAction({
    entry,
    response: { ok: false, reason: 'CONFIRMATION_MISMATCH', expected: 'note.md' },
  });
  assert.equal(decision.action, 'mark_error');
  assert.match(decision.message, /Typed value did not match/);
  assert.match(decision.message, /note\.md/);
});

test('post-await: confirm stage CONFIRMATION_MISMATCH with no expected → empty quotes still surface', () => {
  const entry = { kind: 'file_safety', operation: 'delete', payload: { stage: 'confirm' } };
  const decision = decideFileSafetyResponseAction({
    entry,
    response: { ok: false, reason: 'CONFIRMATION_MISMATCH' },
  });
  assert.equal(decision.action, 'mark_error');
  // The message degrades gracefully when expected is missing — better
  // than swallowing the mismatch and dropping the dialog silently.
  assert.match(decision.message, /Typed value did not match/);
});

test('post-await: confirm stage with thrown network error → mark_error with err.message', () => {
  const entry = { kind: 'file_safety', operation: 'delete', payload: { stage: 'confirm' } };
  const error = new Error('connection refused');
  const decision = decideFileSafetyResponseAction({ entry, error });
  assert.equal(decision.action, 'mark_error');
  assert.equal(decision.message, 'connection refused');
});

test('post-await: confirm stage with thrown error missing message → fallback string', () => {
  const entry = { kind: 'file_safety', operation: 'delete', payload: { stage: 'confirm' } };
  const decision = decideFileSafetyResponseAction({ entry, error: { /* no message */ } });
  assert.equal(decision.action, 'mark_error');
  assert.match(decision.message, /try again/i);
});

test('post-await: non-confirm stage thrown error → noop (entry already removed pre-await)', () => {
  const entry = { kind: 'file_safety', operation: 'write_overwrite', payload: { path: '/tmp/x' } };
  const decision = decideFileSafetyResponseAction({
    entry,
    error: new Error('whatever'),
  });
  assert.deepEqual(decision, { action: 'noop' });
});

test('post-await: non-confirm stage clean response → noop (legacy optimistic-remove already happened)', () => {
  const entry = { kind: 'file_safety', operation: 'edit', payload: { path: '/tmp/x' } };
  const decision = decideFileSafetyResponseAction({ entry, response: { ok: true } });
  assert.deepEqual(decision, { action: 'noop' });
});

// ── End-to-end retry sequence (multiple decisions over time) ──────────

test('retry sequence: mismatch keeps entry → user retries with right value → entry removed', () => {
  const entry = {
    kind: 'file_safety',
    operation: 'delete',
    payload: { stage: 'confirm', expectedConfirmation: 'doc.md' },
  };
  // First attempt: typo
  const first = decideFileSafetyResponseAction({
    entry,
    response: { ok: false, reason: 'CONFIRMATION_MISMATCH', expected: 'doc.md' },
  });
  assert.equal(first.action, 'mark_error', 'mismatch must keep entry');

  // Second attempt: correct (server resolved cleanly, returns ok:true)
  const second = decideFileSafetyResponseAction({
    entry,
    response: { ok: true },
  });
  assert.equal(second.action, 'remove', 'correct retry must drop the entry');
});
