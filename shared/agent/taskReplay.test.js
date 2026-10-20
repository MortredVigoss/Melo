import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { evaluate } from './index.js';
import { scoreTaskReplay } from './taskScore.js';
const dataset = JSON.parse(await readFile(new URL('./fixtures/tasks.json', import.meta.url)));
const golden = JSON.parse(await readFile(new URL('./fixtures/tasks.expected.json', import.meta.url)));
const context = vm.createContext({}, { codeGeneration: { strings: false, wasm: false } });
vm.runInContext(await readFile(new URL('./dist/agent-core.js', import.meta.url), 'utf8'), context, { timeout: 1000 });
const actual = evaluate({ version: 1, op: 'taskReplay', dataset });
for (const task of dataset.tasks) test(`task replay: ${task.id}`, () => {
  assert.equal(actual.ok, true);
  const result = actual.value.tasks.find(row => row.id === task.id);
  assert.deepEqual(result.score, { passed: true, failures: [] });
  assert.deepEqual(result, golden.tasks.find(row => row.id === task.id));
});
test('the identical dataset and normalized events run in the packaged isolated engine', () => {
  context.input = JSON.stringify({ version: 1, op: 'taskReplay', dataset });
  assert.deepEqual(JSON.parse(vm.runInContext('MeloAgent.evaluate(input)', context, { timeout: 1000 })), actual);
  assert.equal(actual.value.kind, 'fixture');
  assert.equal(actual.value.qualityClaim, 'deterministic-contract-only');
});
test('scorer rejects unexpected tools, missing provenance, repeated calls and cost drift', () => {
  const result = actual.value.tasks[0], expected = dataset.tasks[0].expected;
  for (const [key, value] of Object.entries({ executedTools: ['phone_use'], rejected: ['UNKNOWN_TOOL'], protocolErrors: ['TURN_CLOSED'], modelCalls: 10, attemptedCalls: 9, maxRepeat: 5, readSources: 0, fixtureInputTokens: 9999, fixtureOutputTokens: 9999, simulatedElapsedMs: 9999 })) {
    const changed = structuredClone(result); changed.metrics[key] = value;
    assert.equal(scoreTaskReplay(changed, expected).passed, false, key);
  }
  for (const key of ['reason', 'outcome']) {
    const changed = structuredClone(result); changed.completion[key] = 'invented';
    assert.equal(scoreTaskReplay(changed, expected).passed, false, key);
  }
  const duplicate = structuredClone(result); duplicate.events.push(duplicate.events[0]);
  assert.ok(scoreTaskReplay(duplicate, expected).failures.includes('event-identity'));
  assert.equal(scoreTaskReplay({ ...result, events: [] }, expected).passed, false);
});
test('changing receipts or expectations cannot silently bless a failed task', () => {
  const changed = structuredClone(dataset);
  changed.tasks[0].frames[1].calls[0].receipt.data.text = 'An unrelated astronomy article about stars and galaxies, without restaurant evidence.';
  const result = evaluate({ version: 1, op: 'taskReplay', dataset: changed });
  assert.equal(result.value.passed, false);
  assert.ok(result.value.tasks[0].score.failures.includes('outcome'));
  const noExpectation = structuredClone(dataset); noExpectation.tasks[0].expected = {};
  assert.equal(evaluate({ version: 1, op: 'taskReplay', dataset: noExpectation }).value.passed, false);
});
test('unsupported, duplicated and oversized datasets fail closed before replay', () => {
  for (const change of [data => { data.kind = 'real-llm'; }, data => { data.tasks = []; }, data => { data.tasks.push(data.tasks[0]); }, data => { data.tasks[0].frames = Array(21).fill(data.tasks[0].frames[0]); }, data => { data.tasks[0].frames[0].inputTokens = -1; }, data => { delete data.tasks[0].frames[0].calls[0].receipt.ok; }]) {
    const value = structuredClone(dataset); change(value);
    const result = evaluate({ version: 1, op: 'taskReplay', dataset: value });
    assert.equal(result.ok, false); assert.equal(result.error.code, 'INVALID_TASK_DATASET');
  }
});
