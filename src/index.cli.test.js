/**
 * CLI argument-parsing regressions for `melo search` and `melo history`.
 *
 * These tests exercise only the parse helpers — we deliberately do NOT spawn
 * the real CLI, since `runSearchCommand` would reach the network. The parsing
 * helpers are pure, so a unit test is the right level.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSearchArgs, parseHistoryArgs } from './index.js';

// ─── parseSearchArgs ────────────────────────────────────────────────────────

test('search: positional words join into a single query', () => {
  const parsed = parseSearchArgs(['latest', 'node', 'lts']);
  assert.equal(parsed.query, 'latest node lts');
  assert.equal(parsed.json, false);
  assert.equal(parsed.noCache, false);
  assert.equal(parsed.num, undefined);
});

test('search: --json toggles JSON output', () => {
  const parsed = parseSearchArgs(['--json', 'foo', 'bar']);
  assert.equal(parsed.json, true);
  assert.equal(parsed.query, 'foo bar');
});

test('search: --no-cache bypasses cache', () => {
  const parsed = parseSearchArgs(['--no-cache', 'hello']);
  assert.equal(parsed.noCache, true);
  assert.equal(parsed.query, 'hello');
});

test('search: --num N sets result count', () => {
  const parsed = parseSearchArgs(['--num', '3', 'hello']);
  assert.equal(parsed.num, 3);
  const parsed2 = parseSearchArgs(['-n', '4', 'hello']);
  assert.equal(parsed2.num, 4);
});

test('search: --num=N inline form', () => {
  const parsed = parseSearchArgs(['--num=6', 'hi']);
  assert.equal(parsed.num, 6);
});

test('search: flags may appear after positional words', () => {
  const parsed = parseSearchArgs(['hello', '--json', 'world']);
  assert.equal(parsed.json, true);
  assert.equal(parsed.query, 'hello world');
});

test('search: invalid --num throws', () => {
  assert.throws(() => parseSearchArgs(['--num', 'abc', 'x']), /Invalid --num/);
  assert.throws(() => parseSearchArgs(['--num=0', 'x']), /Invalid --num/);
});

test('search: unknown flag throws', () => {
  assert.throws(() => parseSearchArgs(['--bogus', 'x']), /Unknown flag/);
});

test('search: no positional → empty query (caller decides what to do)', () => {
  const parsed = parseSearchArgs(['--json']);
  assert.equal(parsed.query, '');
  assert.equal(parsed.json, true);
});

// ─── parseHistoryArgs ───────────────────────────────────────────────────────

test('history: basic query', () => {
  const parsed = parseHistoryArgs(['what', 'did', 'we', 'decide']);
  assert.equal(parsed.query, 'what did we decide');
  assert.equal(parsed.limit, undefined);
  assert.equal(parsed.json, false);
});

test('history: --limit and --json', () => {
  const parsed = parseHistoryArgs(['--limit', '3', '--json', 'foo']);
  assert.equal(parsed.limit, 3);
  assert.equal(parsed.json, true);
  assert.equal(parsed.query, 'foo');
});

test('history: -l short form', () => {
  const parsed = parseHistoryArgs(['-l', '5', 'bar']);
  assert.equal(parsed.limit, 5);
});

test('history: --limit=N inline form', () => {
  const parsed = parseHistoryArgs(['--limit=2', 'x']);
  assert.equal(parsed.limit, 2);
});

test('history: invalid --limit throws', () => {
  assert.throws(() => parseHistoryArgs(['--limit', 'xyz', 'x']), /Invalid --limit/);
});

test('history: unknown flag throws', () => {
  assert.throws(() => parseHistoryArgs(['--no-cache', 'x']), /Unknown flag/);
});

// ─── --cache subcommand parsing ────────────────────────────────────────────

test('search: --cache stats parses without a query', () => {
  const parsed = parseSearchArgs(['--cache', 'stats']);
  assert.equal(parsed.cache, 'stats');
  assert.equal(parsed.query, '');
});

test('search: --cache clear parses', () => {
  const parsed = parseSearchArgs(['--cache', 'clear']);
  assert.equal(parsed.cache, 'clear');
});

test('search: --cache=stats inline form', () => {
  const parsed = parseSearchArgs(['--cache=stats']);
  assert.equal(parsed.cache, 'stats');
});

test('search: --cache clear-search / clear-url / clear-stale', () => {
  for (const action of ['clear-search', 'clear-url', 'clear-stale']) {
    const parsed = parseSearchArgs(['--cache', action]);
    assert.equal(parsed.cache, action, `expected ${action}`);
  }
});

test('search: --cache with --json produces json + action together', () => {
  const parsed = parseSearchArgs(['--cache', 'stats', '--json']);
  assert.equal(parsed.cache, 'stats');
  assert.equal(parsed.json, true);
});

test('search: --cache with unknown action throws', () => {
  assert.throws(() => parseSearchArgs(['--cache', 'bogus']), /Invalid --cache action/);
  assert.throws(() => parseSearchArgs(['--cache']), /Invalid --cache action/);
});
