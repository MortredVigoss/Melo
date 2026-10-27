import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunBudget, reserveDelivery, budgetExhausted, recordUsage, admitModel, settleModel, narrowBudget, requestTimeoutMs } from './runBudget.js';

test('time, calls and input caps preserve a single delivery request and a tool-free check', () => {
  for (const cause of ['time', 'calls', 'tokens']) {
    let now = 0;
    const budget = reserveDelivery(createRunBudget({ now: () => now }));
    if (cause === 'time') now = budget.deadlineAt - 60000;
    if (cause === 'calls') recordUsage(budget, { toolCalls: budget.maxToolCalls });
    if (cause === 'tokens') recordUsage(budget, { inputTokens: budget.maxInputTokens - budget.delivery.inputTokens });
    assert.ok(budgetExhausted(budget), cause);
    assert.equal(admitModel(budget, { inputTokens: 1000 }).allowed, false);
    const delivery = admitModel(budget, { phase: 'delivery', inputTokens: 1000 });
    assert.equal(delivery.allowed, true, cause);
    assert.equal(budget.delivery.outputTokens, 8192);
    assert.equal(admitModel(budget, { phase: 'delivery', inputTokens: 1 }).allowed, false);
    settleModel(budget, delivery.claim, { inputTokens: 900 });
    const check = admitModel(budget, { phase: 'delivery-check', inputTokens: 1000 });
    assert.equal(check.allowed, true);
    settleModel(budget, check.claim, { inputTokens: 900 });
    assert.equal(budget.used.providerCalls, 2);
    assert.equal(budget.pendingInput, 0);
  }
});
test('parallel child model claims and timeouts cannot consume the root delivery reservation', () => {
  let now = 0;
  const parent = reserveDelivery(createRunBudget({ now: () => now }));
  const a = reserveDelivery(narrowBudget(parent)), b = reserveDelivery(narrowBudget(parent));
  const space = parent.maxInputTokens - parent.delivery.inputTokens;
  const claim = admitModel(a, { inputTokens: space - a.delivery.inputTokens - 10 });
  assert.equal(claim.allowed, true);
  assert.equal(admitModel(b, { inputTokens: a.delivery.inputTokens + 20 }).allowed, false);
  settleModel(a, claim.claim, { inputTokens: 500 });
  assert.equal(parent.pendingInput, 0);
  now = parent.deadlineAt - 60000;
  assert.equal(requestTimeoutMs(a, { phase: 'delivery' }), 0);
  assert.equal(admitModel(a, { phase: 'delivery', inputTokens: 1 }).allowed, false);
  assert.equal(admitModel(parent, { phase: 'delivery', inputTokens: 1000 }).allowed, true);
});
test('a real hard deadline cannot be bypassed by delivery phase', () => {
  let now = 0;
  const budget = reserveDelivery(createRunBudget({ now: () => now }));
  now = budget.deadlineAt;
  for (const phase of ['work', 'delivery', 'delivery-check']) assert.equal(admitModel(budget, { phase, inputTokens: 1 }).allowed, false);
  assert.equal(budget.used.providerCalls, 0);
});

test('member total tokens reserve output, account actual output and protect siblings and ancestors', () => {
  const root = reserveDelivery(createRunBudget({ now: 1 }));
  const parent = reserveDelivery(narrowBudget(root, { maxInputTokens: 64000, maxTotalTokens: 64000 }));
  const a = reserveDelivery(narrowBudget(parent, { maxInputTokens: 32000, maxTotalTokens: 32000 }));
  const b = reserveDelivery(narrowBudget(parent, { maxInputTokens: 32000, maxTotalTokens: 32000 }));
  const first = admitModel(a, { inputTokens: 1000, outputTokens: 10000 });
  assert.equal(first.allowed, true);
  assert.equal(parent.pendingOutput, 10000);
  assert.equal(admitModel(b, { inputTokens: 1000, outputTokens: 30000 }).allowed, false);
  settleModel(a, first.claim, { inputTokens: 1000, outputTokens: 1000 });
  assert.equal(parent.used.outputTokens, 1000);
  assert.equal(root.used.outputTokens, undefined, 'root input-token budget retains its semantics');
  assert.equal(parent.pendingOutput, 0);
  recordUsage(a, { inputTokens: a.maxTotalTokens - a.delivery.inputTokens - a.delivery.outputTokens - 2048 - a.used.inputTokens - a.used.outputTokens });
  assert.equal(admitModel(a, { inputTokens: 1 }).allowed, false);
  const delivery = admitModel(a, { phase: 'delivery', inputTokens: 1000, outputTokens: 8192 });
  assert.equal(delivery.allowed, true);
  settleModel(a, delivery.claim, { inputTokens: 1000, outputTokens: 2000 });
  assert.equal(admitModel(a, { phase: 'delivery-check', inputTokens: 1000, outputTokens: 2048 }).allowed, true);
});
