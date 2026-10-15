import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {executeToolCalls} from '../testSupport/directAgentFixture.js';
import { compileFunctionTool } from './functionSchema.js';
import { bootstrapBuiltinTools, getAllTools } from './registry.js';

test('built-in function schemas compile without changing tool definitions', () => {
  bootstrapBuiltinTools();
  for (const tool of getAllTools()) {
    const schema = JSON.stringify(tool.parametersSchema);
    const compiled = compileFunctionTool(tool);
    assert.notEqual(compiled.parse('{}').error, 'INVALID_TOOL_SCHEMA', tool.id);
    assert.equal(JSON.stringify(tool.parametersSchema), schema);
  }
});

test('safe tool concurrency is bounded, output order stable and writes form a barrier', async t => {
  const home = await mkdtemp(join(tmpdir(), 'melo-function-workers-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  let active = 0, peak = 0, finished = 0;
  const starts = [];
  const read = { id: 'fixture_read', requiresPermission: false, isConcurrencySafe: true, run: async args => {
    starts.push(args.i); active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--; finished++;
    return { ok: true, output: String(args.i) };
  } };
  const write = { id: 'fixture_write', requiresPermission: false, isConcurrencySafe: false, run: async () => {
    assert.equal(active, 0); assert.equal(finished, 9); return { ok: true, output: 'write' };
  } };
  const calls = Array.from({ length: 9 }, (_, i) => ({ id: `r-${i}`, tool: read, args: { i } }));
  calls.push({ id: 'write', tool: write, args: {} }, { id: 'after', tool: read, args: { i: 10 } });
  const results = await executeToolCalls(calls, { meloHome: home });
  assert.equal(peak, 4); assert.equal(finished, 10);
  assert.deepEqual(results.map(r => r.id), calls.map(c => c.id));
  assert.ok(results.every(r => r.result.ok));
  const count = starts.length;
  for (const invalid of [[calls[0], calls[0]], Array.from({ length: 33 }, (_, i) => ({ ...calls[0], id: String(i) }))]) {
    assert.ok((await executeToolCalls(invalid, { meloHome: home })).every(r => r.result.error === 'INVALID_TOOL_BATCH'));
  }
  await executeToolCalls(calls, { meloHome: home, signal: AbortSignal.abort() });
  assert.equal(starts.length, count, 'invalid and cancelled batches invoke no tool');
});
