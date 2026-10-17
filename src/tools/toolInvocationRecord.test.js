import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  redactToolArgs, hashToolArgs, toolArgsDigest, buildToolInvocationRecord, modelFacingOutputsFor,
  appendToolInvocationRecord, readToolInvocationRecords, toolRecordsPath, MAX_MODEL_FACING_OUTPUT_CHARS,
} from './toolInvocationRecord.js';
import { finalizeToolResult } from './toolResult.js';
import { formatToolResult } from './parser.js';
import { failureSnapshot, _resetFailureCountersForTests } from '../runtime/failureCounters.js';

test('redactToolArgs: secret keys, long strings, data URLs, binaries and cycles', () => {
  const long = 'x'.repeat(1000);
  const args = { path: '/tmp/a.md', apiKey: 'sk-live-123', nested: { Authorization: 'Bearer abc', cookie: 'c=1', note: long, list: ['ok', { token: 't' }] },
    image: `data:image/png;base64,${'A'.repeat(400)}`, raw: 'data:text/plain,hello', buf: new Uint8Array(16) };
  args.self = args;
  const out = redactToolArgs(args);
  assert.equal(out.path, '/tmp/a.md');
  assert.equal(out.apiKey, '[redacted]');
  assert.equal(out.nested.Authorization, '[redacted]');
  assert.equal(out.nested.cookie, '[redacted]');
  assert.equal(out.nested.note.length, 401, 'cut to 400 chars plus the ellipsis');
  assert.equal(out.nested.list[1].token, '[redacted]');
  assert.equal(out.image, 'data:image/png (300 bytes)');
  assert.equal(out.raw, 'data:text/plain (5 bytes)');
  assert.equal(out.buf, '[binary 16 bytes]');
  assert.equal(out.self, '[circular]');
  assert.equal(args.apiKey, 'sk-live-123', 'input is not mutated');
  assert.deepEqual(redactToolArgs(null), {});
  assert.deepEqual(redactToolArgs('text'), {});
});

test('hashToolArgs: stable across key order, sensitive to values, 16 hex chars', () => {
  const a = hashToolArgs({ path: 'a', start_line: 1, nested: { x: [1, 2], y: 'z' } });
  const b = hashToolArgs({ nested: { y: 'z', x: [1, 2] }, start_line: 1, path: 'a' });
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.notEqual(a, hashToolArgs({ path: 'a', start_line: 2, nested: { x: [1, 2], y: 'z' } }));
  assert.equal(hashToolArgs(undefined), hashToolArgs({}));
});

test('toolArgsDigest: scalars only, bounded', () => {
  assert.equal(toolArgsDigest({ path: 'notes/plan.md', start_line: 3, nested: { a: 1 }, flag: true }, { maxEntries: 3 }), 'path=notes/plan.md, start_line=3, flag=true');
  assert.equal(toolArgsDigest({ command: 'c'.repeat(100) }, { maxValue: 10 }), `command=${'c'.repeat(10)}…`);
  assert.equal(toolArgsDigest(null), '');
});

test('buildToolInvocationRecord: envelope projection, size caps, timing', () => {
  const result = finalizeToolResult({ ok: true, output: 'y'.repeat(20_000), meta: { path: '/tmp/a.md', apiKey: 'secret', blob: 'b'.repeat(5000) } });
  const record = buildToolInvocationRecord({ runId: 'run-1', iteration: 2, call: { id: 'c1', name: 'file_read', arguments: { path: '/tmp/a.md', token: 'abc' } },
    result, modelFacingOutput: 'm'.repeat(MAX_MODEL_FACING_OUTPUT_CHARS + 10), startedAt: 1_000, finishedAt: 1_250, parallelGroup: 0 });
  assert.equal(record.runId, 'run-1');
  assert.equal(record.iteration, 2);
  assert.equal(record.callId, 'c1');
  assert.equal(record.toolId, 'file_read');
  assert.deepEqual(record.argsRedacted, { path: '/tmp/a.md', token: '[redacted]' });
  assert.equal(record.argsHash, hashToolArgs({ path: '/tmp/a.md', token: 'abc' }), 'hash is over the raw args');
  assert.deepEqual({ ok: record.resultEnvelope.ok, status: record.resultEnvelope.status }, { ok: true, status: 'ok' });
  assert.equal(record.resultEnvelope.outputPreview.length, 500);
  assert.ok(JSON.stringify(record.resultEnvelope.meta).length <= 2000 || record.resultEnvelope.meta.truncated === true, 'meta stays small');
  assert.ok(!JSON.stringify(record.resultEnvelope).includes('secret'));
  assert.equal(record.modelFacingOutput.length, MAX_MODEL_FACING_OUTPUT_CHARS);
  assert.equal(record.modelFacingOutputTruncated, true);
  assert.equal(record.startedAt, new Date(1_000).toISOString());
  assert.equal(record.durationMs, 250);
  assert.equal(record.parallelGroup, 0);

  const failed = buildToolInvocationRecord({ runId: 'run-1', iteration: 0, call: { id: 'c2', name: 'bash' },
    result: finalizeToolResult({ ok: false, output: 'Tool error: ENOENT no such file', error: 'ENOENT no such file' }) });
  assert.equal(failed.resultEnvelope.status, 'error');
  assert.equal(failed.resultEnvelope.code, 'NOT_FOUND');
  assert.ok(failed.resultEnvelope.hint);
  assert.equal(failed.parallelGroup, null);
  assert.equal(failed.modelFacingOutput, '');
});

test('modelFacingOutputsFor: native outputs by call_id, legacy rebuilt byte-for-byte', () => {
  const pairs = [{ call: { id: 'a', name: 't' }, result: finalizeToolResult({ ok: true, output: 'one' }) }, { call: { id: 'b', name: 't' }, result: finalizeToolResult({ ok: false, output: 'x', error: 'TIMEOUT' }) }];
  const native = modelFacingOutputsFor({ functionCallOutputs: [{ type: 'function_call_output', call_id: 'a', output: '{"ok":true}' }, { call_id: 'b', output: '{"ok":false}' }] }, pairs);
  assert.equal(native.get('a'), '{"ok":true}');
  assert.equal(native.get('b'), '{"ok":false}');
  const legacy = modelFacingOutputsFor({ role: 'user', content: 'xml', isToolResult: true }, pairs);
  assert.equal(legacy.get('a'), formatToolResult(pairs[0].call, pairs[0].result, { maxOutputChars: 8000 }));
  assert.equal(legacy.get('b'), formatToolResult(pairs[1].call, pairs[1].result, { maxOutputChars: 8000 }));
});

test('appendToolInvocationRecord / readToolInvocationRecords: jsonl under execution-scenes, 0o600, bad lines skipped', async () => {
  const home = await mkdtemp(join(tmpdir(), 'melo-tool-records-'));
  try {
    const base = { runId: 'run_A-1', call: { id: 'x', name: 'calc', arguments: { expression: '1+1' } }, result: finalizeToolResult({ ok: true, output: '2' }) };
    assert.equal(appendToolInvocationRecord(buildToolInvocationRecord({ ...base, iteration: 0 }), { home }), true);
    assert.equal(appendToolInvocationRecord(buildToolInvocationRecord({ ...base, iteration: 1, call: { id: 'y', name: 'calc', arguments: { expression: '2+2' } } }), { home }), true);
    const file = toolRecordsPath(home, 'run_A-1');
    assert.equal(file, join(home, 'desktop', 'execution-scenes', 'run_A-1.tools.jsonl'));
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await stat(join(home, 'desktop', 'execution-scenes'))).mode & 0o777, 0o700);
    await writeFile(file, `${await readFile(file, 'utf8')}not json\n${JSON.stringify({ runId: 'other', toolId: 'calc' })}\n`);
    const records = await readToolInvocationRecords('run_A-1', { home });
    assert.deepEqual(records.map(r => [r.callId, r.iteration]), [['x', 0], ['y', 1]]);
    assert.deepEqual(await readToolInvocationRecords('missing', { home }), []);
    assert.deepEqual(await readToolInvocationRecords('../escape', { home }), []);
    assert.equal(toolRecordsPath(home, '../escape'), null);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('appendToolInvocationRecord never throws: unwritable directory and invalid run id are counted', async () => {
  _resetFailureCountersForTests();
  const home = await mkdtemp(join(tmpdir(), 'melo-tool-records-ro-'));
  try {
    const record = buildToolInvocationRecord({ runId: 'run-ro', iteration: 0, call: { id: 'x', name: 'calc', arguments: {} }, result: finalizeToolResult({ ok: true, output: '' }) });
    // A regular file where the scenes directory should be makes mkdir fail on every platform.
    await writeFile(join(home, 'desktop'), 'not a directory');
    assert.equal(appendToolInvocationRecord(record, { home }), false);
    assert.equal(appendToolInvocationRecord({ ...record, runId: 'bad/id' }, { home }), false);
    assert.equal(appendToolInvocationRecord(record, {}), false);
    assert.equal(failureSnapshot()['tool:invocation-record'].count, 3);
    await chmod(join(home, 'desktop'), 0o600).catch(() => {});
  } finally { await rm(home, { recursive: true, force: true }); }
});
