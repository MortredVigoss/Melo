import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withLoopTrace, traceEvent, traceModelCall, traceProviderPayload, createLoopTrace, readLocalTrace, currentLoopTrace, traceToolCall, traceToolDispatch } from './loopTrace.js';
async function scratch(t) { const home = await mkdtemp(join(tmpdir(), 'melo-loop-trace-')); t.after(() => rm(home, { recursive: true, force: true })); return home; }
test('real JSONL keeps model inputs, schemas, provider body, receipts and child identity without secrets', async t => {
  const home = await scratch(t); let root;
  await withLoopTrace({ home, runId: 'parent', goal: 'find venue then weather' }, async () => {
    root = currentLoopTrace().root;
    await traceModelCall({ model: 'fixture', systemPrompt: 'Skill body marker', messages: [{ role: 'user', content: 'weather' }], tools: [{ name: 'web_search' }] }, async () => {
      const body = await traceProviderPayload({ model: 'fixture', tools: [{ name: 'web_search' }], input: 'Bearer private-token-string' });
      assert.ok(body.includes('private-token-string')); return { text: 'partial', usage: null };
    });
    await withLoopTrace({ kind: 'skill', runId: 'child', goal: 'search' }, async () => {
      traceEvent('cache.publish', { kind: 'action', verified: true }); return { completion: { outcome: 'blocked' } };
    });
    return { normalizedReply: { completion: { outcome: 'partial' } } };
  });
  const trace = await readLocalTrace(root.directory); assert.equal(trace.complete, true); assert.equal(trace.manifest.status, 'partial');
  assert.equal(trace.events.find(row => row.runId === 'child').parentRunId, 'parent');
  assert.equal(trace.events.filter(row => row.type === 'run.finished').length, 2);
  for (const row of trace.events) if (row.data.contentRef) assert.equal((await readFile(join(root.directory, row.data.contentRef), 'utf8')).includes('private-token-string'), false);
  assert.equal(trace.events.filter(row => row.type === 'model.request.started').length, 1);
});
test('parallel homes and scopes cannot steal each other across awaits', async t => {
  const homes = [await scratch(t), await scratch(t)], dirs = [];
  await Promise.all(homes.map((home, i) => withLoopTrace({ home, runId: 'run-' + i }, async () => { dirs[i] = currentLoopTrace().root.directory; await new Promise(r => setTimeout(r, i ? 1 : 5)); traceEvent('goal.updated', { marker: 'home-' + i }); })));
  for (let i = 0; i < 2; i++) { const raw = await readFile(join(dirs[i], 'events.jsonl'), 'utf8'); assert.ok(raw.includes('home-' + i)); assert.equal(raw.includes('home-' + (1 - i)), false); }
});
test('failed dispatch differs from a refusal and never becomes not_started', async t => {
  const home = await scratch(t); let root;
  await withLoopTrace({ home, runId: 'tools' }, async () => {
    root = currentLoopTrace().root;
    await traceToolCall({ id: 'write' }, {}, { toolCallId: 'write-1' }, async () => { await traceToolDispatch('write'); return { ok: false, code: 'TIMEOUT' }; });
    await traceToolCall({ id: 'write' }, {}, { toolCallId: 'denied-1' }, async () => ({ ok: false, code: 'CAPABILITY_DENIED' }));
  });
  const rows = (await readLocalTrace(root.directory)).events.filter(row => row.type === 'tool.result');
  assert.deepEqual(rows.map(row => row.data.effectState), ['unknown', 'not_started']);
});
test('I/O failure and bounded queue degrade capture without throwing into Agent work', async t => {
  const home = await scratch(t);
  const root = createLoopTrace({ home, runId: 'failure', traceId: 'failure', io: { appendFile: async () => { throw new Error('disk error'); } } });
  root.record({ type: 'run.started' });
  const result = await root.finish({ outcome: 'blocked' }); assert.equal(result.complete, false); assert.ok(result.problems.includes('io_error'));
  const capped = createLoopTrace({ home, runId: 'capped', traceId: 'capped', limits: { maxQueue: 1 } });
  capped.record({ type: 'run.started' }); capped.record({ type: 'model.response' }); await capped.finish({ outcome: 'unknown' });
  assert.equal(capped.manifest.complete, false);
});
