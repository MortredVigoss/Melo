import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRunBudget, remainingMs, requestTimeoutMs, recordUsage, budgetExhausted, narrowBudget, armBudget,
  budgetExhaustedReply, describeBudgetReason, receiptInputTokens,
  DEFAULT_RUN_DEADLINE_MS, DEFAULT_RUN_MAX_INPUT_TOKENS, DEFAULT_RUN_MAX_TOOL_CALLS,
} from './runBudget.js';

function virtualClock(start = 1_000_000) {
  let t = start;
  const now = () => t;
  now.advance = ms => { t += ms; return t; };
  return now;
}

test('defaults: 20 min / 400k input tokens / 120 tool calls, env and overrides win in that order', () => {
  const now = virtualClock();
  const plain = createRunBudget({ now });
  assert.equal(plain.deadlineAt - plain.startedAt, DEFAULT_RUN_DEADLINE_MS);
  assert.equal(plain.maxInputTokens, DEFAULT_RUN_MAX_INPUT_TOKENS);
  assert.equal(plain.maxToolCalls, DEFAULT_RUN_MAX_TOOL_CALLS);
  assert.deepEqual(plain.used, { inputTokens: 0, toolCalls: 0, providerCalls: 0 });

  const env = { MELO_RUN_DEADLINE_MS: '90000', MELO_RUN_MAX_INPUT_TOKENS: '5000', MELO_RUN_MAX_TOOL_CALLS: '7' };
  const fromEnv = createRunBudget({ env, now });
  assert.equal(fromEnv.deadlineAt - fromEnv.startedAt, 90_000);
  assert.equal(fromEnv.maxInputTokens, 5000);
  assert.equal(fromEnv.maxToolCalls, 7);

  const overridden = createRunBudget({ env, now, overrides: { deadlineMs: 60_000, maxToolCalls: 3 } });
  assert.equal(overridden.deadlineAt - overridden.startedAt, 60_000);
  assert.equal(overridden.maxInputTokens, 5000, 'untouched limit still comes from env');
  assert.equal(overridden.maxToolCalls, 3);

  const garbage = createRunBudget({ env: { MELO_RUN_DEADLINE_MS: 'soon', MELO_RUN_MAX_TOOL_CALLS: '-4' }, now });
  assert.equal(garbage.deadlineAt - garbage.startedAt, DEFAULT_RUN_DEADLINE_MS);
  assert.equal(garbage.maxToolCalls, DEFAULT_RUN_MAX_TOOL_CALLS);
});

test('virtual clock: deadline 60 s — remaining shrinks, request timeout is min(cap, remaining), exhausted at 61 s', () => {
  const now = virtualClock();
  const budget = createRunBudget({ now, overrides: { deadlineMs: 60_000 } });
  assert.equal(remainingMs(budget), 60_000);
  assert.equal(requestTimeoutMs(budget), 60_000, 'remaining < 600 s cap');
  assert.equal(requestTimeoutMs(budget, { cap: 10_000 }), 10_000);
  assert.equal(budgetExhausted(budget), null);

  now.advance(45_000);
  assert.equal(remainingMs(budget), 15_000);
  assert.equal(requestTimeoutMs(budget), 15_000);
  assert.equal(budgetExhausted(budget), null);

  now.advance(16_000); // t = 61 s
  assert.equal(remainingMs(budget), 0);
  assert.equal(requestTimeoutMs(budget), 0);
  const exhausted = budgetExhausted(budget);
  assert.equal(exhausted.code, 'BUDGET_EXHAUSTED');
  assert.equal(exhausted.reason, 'deadline');
  assert.equal(exhausted.limit, 60_000);
  assert.equal(exhausted.used, 61_000);
  assert.match(budgetExhaustedReply(exhausted), /^这轮对话已达到运行预算（运行时间 1 分钟），已停止。你可以发送“继续”接着做。$/);
});

test('no budget: helpers degrade to "unbounded"', () => {
  assert.equal(remainingMs(null), Infinity);
  assert.equal(requestTimeoutMs(null), 600_000);
  assert.equal(budgetExhausted(null), null);
  assert.equal(narrowBudget(null, { deadlineMs: 1000 }), null);
  assert.equal(recordUsage(null, { toolCalls: 1 }), null);
});

test('usage limits: input tokens and tool calls each exhaust the budget with their own reason', () => {
  const now = virtualClock();
  const tokens = createRunBudget({ now, overrides: { maxInputTokens: 1000, maxToolCalls: 5 } });
  recordUsage(tokens, { providerCalls: 1, inputTokens: 400 });
  recordUsage(tokens, { providerCalls: 1, inputTokens: 599 });
  assert.equal(budgetExhausted(tokens), null);
  assert.deepEqual(tokens.used, { inputTokens: 999, toolCalls: 0, providerCalls: 2 });
  recordUsage(tokens, { inputTokens: 1 });
  assert.equal(budgetExhausted(tokens).reason, 'input-tokens');
  assert.equal(describeBudgetReason(budgetExhausted(tokens)), '输入 token 1000');

  const calls = createRunBudget({ now, overrides: { maxToolCalls: 2 } });
  recordUsage(calls, { toolCalls: 1 });
  assert.equal(budgetExhausted(calls), null);
  recordUsage(calls, { toolCalls: 1 });
  assert.equal(budgetExhausted(calls).reason, 'tool-calls');
  assert.equal(describeBudgetReason(budgetExhausted(calls)), '工具调用次数 2 次');

  // Negative / junk usage never un-spends.
  recordUsage(calls, { toolCalls: -5, inputTokens: 'x' });
  assert.deepEqual(calls.used, { inputTokens: 0, toolCalls: 2, providerCalls: 0 });
});

test('narrowBudget: min of each limit against the parent remainder, shared deadline, child usage propagates up', () => {
  const now = virtualClock();
  const parent = createRunBudget({ now, overrides: { deadlineMs: 120_000, maxInputTokens: 10_000, maxToolCalls: 10 } });
  recordUsage(parent, { inputTokens: 4000, toolCalls: 3 });

  // Member asks for a 5 min timeout: the parent's deadline (2 min) is earlier and wins.
  const wide = narrowBudget(parent, { deadlineMs: 300_000 });
  assert.equal(wide.deadlineAt, parent.deadlineAt, 'child shares the parent deadline');
  assert.equal(wide.maxInputTokens, 6000, 'parent remaining tokens');
  assert.equal(wide.maxToolCalls, 7, 'parent remaining tool calls');
  assert.deepEqual(wide.used, { inputTokens: 0, toolCalls: 0, providerCalls: 0 });
  assert.equal(wide.parent, parent);

  // Member with a shorter timeout and its own smaller caps keeps the smaller of each.
  now.advance(10_000);
  const tight = narrowBudget(parent, { deadlineMs: 30_000, maxInputTokens: 500, maxToolCalls: 100 });
  assert.equal(tight.deadlineAt, now() + 30_000);
  assert.equal(remainingMs(tight), 30_000);
  assert.equal(tight.maxInputTokens, 500);
  assert.equal(tight.maxToolCalls, 7);

  // Spending on the child lands on the parent (and the grandparent).
  const grandchild = narrowBudget(tight, { maxToolCalls: 1 });
  recordUsage(grandchild, { providerCalls: 1, inputTokens: 300, toolCalls: 1 });
  assert.deepEqual(grandchild.used, { inputTokens: 300, toolCalls: 1, providerCalls: 1 });
  assert.deepEqual(tight.used, { inputTokens: 300, toolCalls: 1, providerCalls: 1 });
  assert.deepEqual(parent.used, { inputTokens: 4300, toolCalls: 4, providerCalls: 1 });
  assert.equal(budgetExhausted(grandchild).reason, 'tool-calls', 'grandchild hit its own 1-call cap');
  assert.equal(budgetExhausted(tight), null);

  // A sibling draining the parent exhausts the child too.
  const sibling = narrowBudget(parent);
  recordUsage(sibling, { inputTokens: 5700 });
  assert.equal(budgetExhausted(parent).reason, 'input-tokens');
  assert.equal(budgetExhausted(tight).reason, 'input-tokens', 'ancestor exhaustion is visible from the child');

  // Child timeouts never exceed the parent remainder.
  now.advance(25_000);
  assert.ok(remainingMs(tight) <= remainingMs(parent));
  now.advance(100_000);
  assert.equal(budgetExhausted(wide).reason, 'deadline');
});

test('armBudget re-bases an unused budget to now and leaves a spent one alone', () => {
  const now = virtualClock();
  const queued = createRunBudget({ now, overrides: { deadlineMs: 60_000 } });
  now.advance(50_000); // sat in the chat queue
  armBudget(queued);
  assert.equal(remainingMs(queued), 60_000);
  assert.equal(queued.startedAt, now());

  const spent = createRunBudget({ now, overrides: { deadlineMs: 60_000 } });
  recordUsage(spent, { toolCalls: 1 });
  now.advance(30_000);
  armBudget(spent);
  assert.equal(remainingMs(spent), 30_000);

  const child = narrowBudget(spent, {});
  now.advance(5_000);
  armBudget(child);
  assert.equal(remainingMs(child), 25_000, 'children are never re-based');
});

test('receiptInputTokens accepts normalized and raw provider usage shapes', () => {
  assert.equal(receiptInputTokens({ usage: { input: 42, output: 3 } }), 42);
  assert.equal(receiptInputTokens({ usage: { input_tokens: 17 } }), 17);
  assert.equal(receiptInputTokens({ usage: { prompt_tokens: 9 } }), 9);
  assert.equal(receiptInputTokens({ usage: null }), null);
  assert.equal(receiptInputTokens(null), null);
  assert.equal(receiptInputTokens({ usage: { input: -1 } }), null);
});

// ─── Bug audit 2026-10-18 T8 ─────────────────────────────────────────────────

test('extendBudget: a root budget grows to a plan (max of remaining and requested); children and spent limits never shrink', async () => {
  const { extendBudget } = await import('./runBudget.js');
  const now = virtualClock();
  const root = createRunBudget({ now, overrides: { deadlineMs: 20 * 60_000, maxInputTokens: 400_000 } });
  recordUsage(root, { inputTokens: 100_000 });
  now.advance(5 * 60_000);
  // A 60-minute / 2M-token team plan extends the deadline and the token pool…
  const grown = extendBudget(root, { deadlineMs: 60 * 60_000, maxInputTokens: 2_000_000 });
  assert.deepEqual(grown, { extended: true, deadline: true, inputTokens: true, toolCalls: false });
  assert.equal(remainingMs(root), 60 * 60_000, 'deadline = now + plan');
  assert.equal(root.maxInputTokens, 100_000 + 2_000_000, 'pool = used + plan');
  // …a smaller plan never shrinks what is left…
  assert.deepEqual(extendBudget(root, { deadlineMs: 60_000, maxInputTokens: 1_000 }), { extended: false, deadline: false, inputTokens: false, toolCalls: false });
  assert.equal(remainingMs(root), 60 * 60_000);
  // …and a child pool is never widened past its parent.
  const child = narrowBudget(root, { deadlineMs: 60_000 });
  assert.equal(extendBudget(child, { deadlineMs: 90 * 60_000, maxInputTokens: 9_000_000 }).extended, false);
  assert.equal(remainingMs(child), 60_000);
  assert.equal(extendBudget(null, { deadlineMs: 1 }).extended, false);
});
