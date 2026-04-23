/**
 * Search audit B-2 regression: coerceAfterTimestamp is strict about the
 * chat-timestamp window [2001-09-09, 2200-01-01) and rejects nonsense
 * inputs rather than coercing them into a permissive 1970-ish filter.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { coerceAfterTimestamp } from './conversationIndex.js';

test('coerceAfterTimestamp accepts an ISO date string', () => {
  assert.equal(
    coerceAfterTimestamp('2024-01-01T00:00:00Z'),
    Date.parse('2024-01-01T00:00:00Z'),
  );
});

test('coerceAfterTimestamp accepts a Date instance', () => {
  const d = new Date('2024-05-15T12:00:00Z');
  assert.equal(coerceAfterTimestamp(d), d.getTime());
});

test('coerceAfterTimestamp recognises epoch seconds', () => {
  const s = 1_700_000_000; // 2023-11-14
  assert.equal(coerceAfterTimestamp(s), s * 1000);
});

test('coerceAfterTimestamp recognises epoch milliseconds', () => {
  const ms = 1_700_000_000_000;
  assert.equal(coerceAfterTimestamp(ms), ms);
});

test('coerceAfterTimestamp scales microseconds down to milliseconds', () => {
  const us = 1_700_000_000_000_000;
  assert.equal(coerceAfterTimestamp(us), 1_700_000_000_000);
});

test('coerceAfterTimestamp scales nanoseconds down to milliseconds', () => {
  const ns = 1_700_000_000_000_000_000;
  assert.equal(coerceAfterTimestamp(ns), 1_700_000_000_000);
});

test('coerceAfterTimestamp rejects a suspiciously small number (e.g. 1000 ms)', () => {
  // Previously this would be read as "1000 seconds" and coerced to 1e6 ms
  // (1970-01-01 00:16:40 UTC), producing a permissive pre-epoch filter.
  assert.equal(coerceAfterTimestamp(1000), null);
});

test('coerceAfterTimestamp rejects negative numbers', () => {
  assert.equal(coerceAfterTimestamp(-5), null);
  assert.equal(coerceAfterTimestamp(-1_700_000_000_000), null);
});

test('coerceAfterTimestamp rejects far-future timestamps (year 2200+)', () => {
  // Any timestamp past the MAX_CHAT_MS sentinel is almost certainly a bug
  // (e.g. nanoseconds that didn't get scaled).  Rejecting lets the caller
  // skip the filter cleanly instead of emitting an impossible query.
  const year9999 = Date.parse('9999-01-01T00:00:00Z');
  assert.equal(coerceAfterTimestamp(year9999), null);
});

test('coerceAfterTimestamp rejects zero, NaN, +Infinity', () => {
  assert.equal(coerceAfterTimestamp(0), null);
  assert.equal(coerceAfterTimestamp(NaN), null);
  assert.equal(coerceAfterTimestamp(Infinity), null);
});

test('coerceAfterTimestamp rejects numeric year strings like "2024"', () => {
  // The previous implementation let Date.parse interpret "2024" as
  // 2024-01-01 which silently turned an accidental year-as-string argument
  // into a valid filter.  With numeric-string re-routing, "2024" is a
  // small number → out-of-window → null.
  assert.equal(coerceAfterTimestamp('2024'), null);
});

test('coerceAfterTimestamp accepts a numeric string in seconds', () => {
  assert.equal(coerceAfterTimestamp('1700000000'), 1_700_000_000_000);
});

test('coerceAfterTimestamp returns null for empty / missing values', () => {
  assert.equal(coerceAfterTimestamp(null), null);
  assert.equal(coerceAfterTimestamp(undefined), null);
  assert.equal(coerceAfterTimestamp(''), null);
});

test('coerceAfterTimestamp returns null for unparseable strings', () => {
  assert.equal(coerceAfterTimestamp('not-a-date'), null);
});
