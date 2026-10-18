import test from 'node:test';
import assert from 'node:assert/strict';
import { finalizeToolResult, canonicalToolCode, toolStatus, TOOL_ERROR_CODES, toolCodeHint } from './toolResult.js';
import { formatToolResult } from './parser.js';

// 2026-10-17 design audit T2 / option B1: every tool result leaves the executor
// with status ok|empty|error and a canonical code, so the model can tell
// "nothing found" from "the tool is broken" and repeatGuard fingerprints on
// codes instead of free text.
test('legacy free-text errors map to canonical codes and keep the original as detail', () => {
  const cases = [
    ['DENIED', 'PERMISSION_DENIED'],
    ['Exit code 1', 'EXIT_NONZERO'],
    ["ENOENT: no such file or directory, open '/tmp/x'", 'NOT_FOUND'],
    ['Permission denied by policy', 'PERMISSION_DENIED'],
    ['fetch failed', 'NETWORK'],
    ['Request timed out after 15s', 'TIMEOUT'],
    ['SEARCH_FAILED', 'PROVIDER_DOWN'],
    ['INVALID_TOOL_ARGUMENTS', 'INVALID_TOOL_ARGUMENTS'],
    ['TOOL_NOT_WHITELISTED', 'TOOL_NOT_WHITELISTED'],
    ['COMMIT_FAILED', 'COMMIT_FAILED'],
    ['something odd happened', 'UNKNOWN'],
  ];
  for (const [raw, expected] of cases) assert.equal(canonicalToolCode(raw), expected, raw);
  const finalized = finalizeToolResult({ ok: false, output: 'x', error: 'Exit code 2', meta: {} });
  assert.equal(finalized.status, 'error');
  assert.equal(finalized.code, 'EXIT_NONZERO');
  assert.equal(finalized.error, 'EXIT_NONZERO', 'error mirrors code for existing === checks');
  assert.equal(finalized.meta.detail, 'Exit code 2');
  assert.equal(finalized.meta.exitCode, 2);
  assert.ok(TOOL_ERROR_CODES.includes('NO_RESULTS'));
});

test('empty results are a distinct status, not a failure and not a plain success', () => {
  const empty = finalizeToolResult({ ok: true, status: 'empty', code: 'NO_RESULTS', output: 'nothing', meta: {} });
  assert.equal(empty.status, 'empty');
  assert.equal(empty.ok, true);
  assert.equal(empty.code, 'NO_RESULTS');
  const viaMeta = finalizeToolResult({ ok: true, output: 'nothing', meta: { empty: true } });
  assert.equal(viaMeta.status, 'empty');
  const ok = finalizeToolResult({ ok: true, output: 'found 3', meta: {} });
  assert.equal(ok.status, 'ok');
  assert.equal(ok.code, undefined);
  assert.equal(toolStatus({ ok: false }), 'error');
  assert.match(toolCodeHint('NO_RESULTS'), /do not retry|rather than retrying/i);
});

test('aborted and timed-out results are classified from meta, and finalisation is idempotent', () => {
  const timedOut = finalizeToolResult({ ok: false, output: 'Tool error: x', error: 'Tool "bash" timed out after 60s.', meta: { aborted: true, timedOut: true } });
  assert.equal(timedOut.code, 'TIMEOUT');
  const aborted = finalizeToolResult({ ok: false, output: '', error: 'Aborted.', meta: { aborted: true } });
  assert.equal(aborted.code, 'ABORTED');
  const again = finalizeToolResult(timedOut);
  assert.equal(again.code, 'TIMEOUT');
  assert.equal(again.meta.detail, timedOut.meta.detail);
});

test('the legacy XML result carries status, code and hint for the model', () => {
  const xml = formatToolResult({ id: 'c1', name: 'web_search' }, finalizeToolResult({ ok: true, status: 'empty', code: 'NO_RESULTS', output: 'none', meta: {} }));
  assert.match(xml, /status="empty"/);
  assert.match(xml, /code="NO_RESULTS"/);
  assert.match(xml, /<hint>/);
  const err = formatToolResult({ id: 'c2', name: 'bash' }, finalizeToolResult({ ok: false, output: 'stderr: boom', error: 'Exit code 3', meta: {} }));
  assert.match(err, /status="error" code="EXIT_NONZERO"/);
  assert.match(err, /<error>EXIT_NONZERO: Exit code 3<\/error>/);
});
