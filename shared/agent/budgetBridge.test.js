import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from './index.js';
import { createRunBudget, narrowBudget, recordUsage, budgetExhausted, remainingMs, requestTimeoutMs } from '../../src/runtime/runBudget.js';

const json = value => JSON.parse(JSON.stringify(value));
function op(action, fields = {}) {
  const reply = evaluate({ version: 1, op: 'budget', action, now: 1000, ...fields });
  assert.equal(reply.ok, true, reply.error?.message);
  return json(reply.value);
}

test('native JSON budget operations preserve Node ancestry, accounting, exhaustion and timeout', () => {
  let now = 1000;
  const parent = createRunBudget({ now: () => now, overrides: { deadlineMs: 1000, maxInputTokens: 100, maxToolCalls: 3 } });
  assert.deepEqual(op('create', { options: { deadlineMs: 1000, maxInputTokens: 100, maxToolCalls: 3 } }), json(parent));
  const child = narrowBudget(parent, { maxToolCalls: 2, deadlineMs: 900 });
  assert.deepEqual(op('narrow', { budget: json(parent), options: { maxToolCalls: 2, deadlineMs: 900 } }), json(child));
  const before = json(child), usage = { inputTokens: 30, toolCalls: 1, providerCalls: 1 };
  recordUsage(child, usage);
  assert.deepEqual(op('record', { budget: before, usage }), json(child));
  assert.deepEqual(before.used, { inputTokens: 0, toolCalls: 0, providerCalls: 0 }, 'bridge input remains unchanged');
  assert.equal(op('remaining', { budget: json(child) }), remainingMs(child));
  assert.equal(op('timeout', { budget: json(child), options: { cap: 500 } }), requestTimeoutMs(child, { cap: 500 }));
  assert.equal(op('exhausted', { budget: json(child) }), null);
  recordUsage(parent, { inputTokens: 70 });
  assert.deepEqual(op('exhausted', { budget: json(child) }), budgetExhausted(child));
  now = 2500;
  assert.deepEqual(op('exhausted', { budget: json(child), now }), budgetExhausted(child));
});

test('JSON bridge preserves zero remaining child limits and never extends a child', () => {
  const parent = op('create', { options: { maxToolCalls: 1 } });
  const used = op('record', { budget: parent, usage: { toolCalls: 1 } });
  const child = op('narrow', { budget: used, options: { maxToolCalls: 10 } });
  assert.equal(child.maxToolCalls, 0);
  assert.equal(op('exhausted', { budget: child }).reason, 'tool-calls');
  const extended = op('extend', { budget: child, options: { maxToolCalls: 100 } });
  assert.equal(extended.changes.extended, false);
  assert.equal(extended.budget.maxToolCalls, 0);
  assert.equal(evaluate({ version: 1, op: 'budget', action: 'create' }).error.code, 'INVALID_CLOCK');
});

test('effect admission returns a charged parent snapshot or a refusal without charging', () => {
  const parent = op('create', { options: { maxToolCalls: 1 } });
  const child = op('narrow', { budget: parent });
  const granted = op('admitTool', { budget: child });
  assert.equal(granted.allowed, true);
  assert.equal(granted.budget.parent.used.toolCalls, 1);
  const denied = op('admitTool', { budget: granted.budget });
  assert.equal(denied.allowed, false);
  assert.equal(denied.budget.parent.used.toolCalls, 1);
  assert.equal(denied.exhausted.reason, 'tool-calls');
  assert.equal(evaluate({ version: 1, op: 'budget', action: 'admitTool', now: 1000 }).error.code, 'BUDGET_MISSING');
});
