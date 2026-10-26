import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { evaluate } from './index.js';
import { startTurn, advanceTurn } from './turn.js';

const bundle = await readFile(new URL('./dist/agent-core.js', import.meta.url), 'utf8');
const manifest = JSON.parse(await readFile(new URL('./dist/manifest.json', import.meta.url)));
const root = new URL('../../', import.meta.url);
const cases = JSON.parse(await readFile(new URL('./fixtures/conformance.json', import.meta.url)));
const context = vm.createContext({}, { codeGeneration: { strings: false, wasm: false } });
vm.runInContext(bundle, context, { timeout: 1000 });
function bundled(input) {
  context.__request = JSON.stringify(input);
  return JSON.parse(vm.runInContext('MeloAgent.evaluate(__request)', context, { timeout: 250 }));
}
function subset(actual, expected) { if (expected === null || typeof expected !== 'object' || Array.isArray(expected)) { assert.deepEqual(actual, expected); return; } for (const [key, value] of Object.entries(expected)) assert.deepEqual(actual[key], value, key); }

for (const fixture of cases) test('cross-engine contract: ' + fixture.name, () => {
  const native = evaluate(fixture.input), isolated = bundled(fixture.input);
  assert.deepEqual(isolated, native);
  assert.equal(native.ok, fixture.ok);
  subset(native.ok ? native.value : native.error, fixture.expected);
});

test('bundle identity includes every source and iOS packages exactly the same bytes', async () => {
  assert.equal(createHash('sha256').update(bundle).digest('hex'), manifest.sha256);
  const ios = await readFile(new URL('ios/Melo/AgentCore/agent-core.js', root), 'utf8');
  assert.equal(ios, bundle);
  for (const [file, hash] of Object.entries(manifest.sources)) {
    const bytes = await readFile(new URL(file, root));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), hash, file);
  }
});

test('user content cannot execute JavaScript through the JSON bridge', () => {
  const result = bundled({ version: 1, op: 'plan', request: { text: "');globalThis.injected=true;// 中文 😀" } });
  assert.equal(result.ok, true);
  assert.equal(vm.runInContext('typeof injected', context), 'undefined');
  assert.equal(vm.runInContext('typeof process', context), 'undefined');
  assert.equal(vm.runInContext('typeof fetch', context), 'undefined');
});

function turn(limits = {}) { return startTurn({ runId: 'run-a', turnId: 'turn-a', now: 1000, allowedTools: ['read', 'write'], limits }); }
function event(state, type, fields = {}, now = state.lastNow) { return advanceTurn(state, { runId: state.runId, turnId: state.turnId, type, ...fields }, now); }
test('reused ID across rounds and invalid batch are rejected atomically before effects', () => {
  let state = event(turn(), 'request');
  const prior = JSON.stringify(state);
  assert.throws(() => event(state, 'calls', { calls: [{ id: 'one', name: 'write' }, { id: 'one', name: 'read' }] }), { code: 'DUPLICATE_CALL_ID' });
  assert.equal(JSON.stringify(state), prior);
  const mixed = event(state, 'calls', { calls: [{ id: 'one', name: 'read' }, { id: 'two', name: 'not-granted' }] });
  assert.deepEqual(mixed.permitted, ['one']);
  assert.deepEqual(mixed.pending, ['one', 'two']);
  state = event(state, 'calls', { calls: [{ id: 'one', name: 'read' }] });
  assert.throws(() => event(state, 'request'), { code: 'PENDING_EFFECT' });
  assert.throws(() => event(state, 'result', { callId: 'foreign', ok: true }), { code: 'UNKNOWN_RESULT' });
  state = event(state, 'result', { callId: 'one', ok: true });
  state = event(state, 'request');
  assert.throws(() => event(state, 'calls', { calls: [{ id: 'one', name: 'write' }] }), { code: 'DUPLICATE_CALL_ID' });
});
test('cancel and deadline do not allow late tool results or new model requests', () => {
  const state = event(turn(), 'request');
  const cancelled = event(state, 'cancel');
  assert.throws(() => event(cancelled, 'calls', { calls: [{ id: 'late', name: 'write' }] }), { code: 'TURN_CLOSED' });
  assert.equal(event(state, 'complete', {}, state.deadline).reason, 'DEADLINE_EXCEEDED');
  assert.throws(() => advanceTurn(state, { runId: 'foreign', turnId: state.turnId, type: 'cancel' }, state.lastNow), { code: 'TURN_MISMATCH' });
});
test('permanent failure stops after three executions and cannot burn ten model rounds', () => {
  let state = turn();
  for (let index = 0; index < 3; index++) {
    state = event(state, 'request');
    state = event(state, 'calls', { calls: [{ id: `c${index}`, name: 'read' }] });
    state = event(state, 'result', { callId: `c${index}`, ok: false });
  }
  assert.equal(state.reason, 'REPEATED_TOOL_FAILURE');
  assert.equal(state.rounds, 3);
  assert.throws(() => event(state, 'request'), { code: 'TURN_CLOSED' });
});
test('identical successful reads stop, new evidence allows progress, chats remain isolated', () => {
  let state = turn(), independent = turn();
  for (let index = 0; index < 6; index++) {
    state = event(state, 'request');
    state = event(state, 'calls', { calls: [{ id: `c${index}`, name: 'read' }] });
    state = event(state, 'result', { callId: `c${index}`, ok: true, progressKey: 'same-screen' });
  }
  assert.equal(state.reason, 'NO_PROGRESS');
  assert.equal(independent.rounds, 0);
  assert.equal(independent.status, 'running');
});
