import test from 'node:test';
import assert from 'node:assert/strict';
import {
  UNDO_TOAST_DEFAULT_MS,
  formatUndoCountdown,
  formatUndoToastLabel,
  nextCountdownTickMs,
} from './undoToast.js';

// ─── formatUndoCountdown ────────────────────────────────────────────────────

test('formatUndoCountdown rounds 5000ms up to "5s"', () => {
  assert.equal(formatUndoCountdown(5000), '5s');
});

test('formatUndoCountdown rounds 4250ms up to "5s" (still in the 5th second)', () => {
  assert.equal(formatUndoCountdown(4250), '5s');
});

test('formatUndoCountdown rounds 4001ms up to "5s"', () => {
  assert.equal(formatUndoCountdown(4001), '5s');
});

test('formatUndoCountdown rounds 4000ms exactly to "4s"', () => {
  assert.equal(formatUndoCountdown(4000), '4s');
});

test('formatUndoCountdown returns "0s" at the boundary', () => {
  assert.equal(formatUndoCountdown(0), '0s');
});

test('formatUndoCountdown clamps negatives to "0s"', () => {
  assert.equal(formatUndoCountdown(-100), '0s');
});

test('formatUndoCountdown handles non-finite input as zero', () => {
  assert.equal(formatUndoCountdown(NaN), '0s');
  assert.equal(formatUndoCountdown(Infinity), '0s');
  assert.equal(formatUndoCountdown(undefined), '0s');
});

// ─── formatUndoToastLabel ───────────────────────────────────────────────────

test('formatUndoToastLabel composes message + countdown', () => {
  assert.equal(formatUndoToastLabel('Deleted "Foo".', 4500), 'Deleted "Foo". Undo · 5s');
});

test('formatUndoToastLabel falls back to "Undo · Xs" when message is empty', () => {
  assert.equal(formatUndoToastLabel('', 3000), 'Undo · 3s');
  assert.equal(formatUndoToastLabel('   ', 3000), 'Undo · 3s');
});

test('formatUndoToastLabel handles null / undefined messages without crashing', () => {
  assert.equal(formatUndoToastLabel(null, 1000), 'Undo · 1s');
  assert.equal(formatUndoToastLabel(undefined, 1000), 'Undo · 1s');
});

// ─── nextCountdownTickMs ────────────────────────────────────────────────────

test('nextCountdownTickMs aligns to the next integer-second boundary', () => {
  // 3.4s left → wake up in 0.4s so the label flips from "4s" → "3s"
  // right when we cross the 3.0s mark.
  assert.equal(nextCountdownTickMs(3400), 400);
});

test('nextCountdownTickMs at exact boundaries waits exactly 1 second', () => {
  assert.equal(nextCountdownTickMs(3000), 1000);
  assert.equal(nextCountdownTickMs(5000), 1000);
});

test('nextCountdownTickMs floors very-near-deadline ticks at 100ms (no busy loop)', () => {
  // Less than 100ms should still give us 100ms so a runaway interval
  // can't pummel the renderer.
  assert.equal(nextCountdownTickMs(40), 100);
});

test('nextCountdownTickMs returns 0 once the deadline has passed', () => {
  assert.equal(nextCountdownTickMs(0), 0);
  assert.equal(nextCountdownTickMs(-10), 0);
});

test('nextCountdownTickMs caps interval at remaining time so we never overshoot', () => {
  // 220ms left, next "second boundary" math says wait 220ms (not 1000).
  assert.equal(nextCountdownTickMs(220), 220);
});

// ─── default constant sanity ────────────────────────────────────────────────

test('UNDO_TOAST_DEFAULT_MS is 5000 (documents the contract)', () => {
  assert.equal(UNDO_TOAST_DEFAULT_MS, 5000);
});
