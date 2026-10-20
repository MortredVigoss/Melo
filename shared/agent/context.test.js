import test from 'node:test';
import assert from 'node:assert/strict';
import { contextCost, contextPlan, contextWirePlan, historyPage } from './context.js';
import { resolveContextBudget } from '../../src/services/chat/contextBudget.js';

test('mobile capacity uses production Node budget defaults and limits', () => {
  for (const capacity of [4096, 24000, 160000, 400000, 900000]) {
    const plan = contextPlan({ capacity, messages: [{ id: 'one', role: 'user', tokens: 10 }] });
    const budget = resolveContextBudget({ MELO_CONTEXT_BUDGET_TOKENS: capacity });
    for (const key of ['totalTokens', 'outputReserve', 'inputLimit', 'windowTokens']) assert.equal(plan[key], budget[key]);
  }
});
test('long multilingual history keeps complete turns and original provenance after reopen', () => {
  const messages = Array.from({ length: 300 }, (_, i) => ({
    id: `m-${i}`, role: i % 2 ? 'assistant' : 'user', tokens: contextCost('决定不能更改 原始编号'.repeat(90)),
    excerpt: i === 0 ? 'The first decision: keep account 427.' : `Topic ${i}`,
  }));
  const first = contextPlan({ capacity: 24000, messages, fixedTokens: 600 });
  assert.ok(first.start > 0); assert.equal(first.start % 2, 0);
  assert.equal(first.ledger.cards[0].fromMessageId, 'm-0');
  assert.match(first.ledger.cards[0].summary, /account 427/);
  assert.ok(first.summary.includes('read_history'));
  const restored = contextPlan({ capacity: 24000, messages, fixedTokens: 600, ledger: JSON.parse(JSON.stringify(first.ledger)) });
  assert.deepEqual(restored, first);
  assert.equal(messages.length, 300);
  const off = contextPlan({ capacity: 24000, messages, fixedTokens: 600, ledger: first.ledger, enabled: false });
  assert.equal(off.summary, '');
});
test('current input/images and entire tool chain cannot silently disappear', () => {
  assert.throws(() => contextPlan({ capacity: 4096, messages: [{ id: 'large', role: 'user', tokens: 6144 }] }), /exceed/);
  assert.throws(() => contextWirePlan({ capacity: 4096, costs: [5, 5, 100, 2000, 2000], roles: ['user', 'assistant', 'user', 'assistant', 'user'], chainStart: 2 }), /exceed/);
  const value = contextWirePlan({ capacity: 4096, costs: [2000, 100, 100, 200, 200], roles: ['user', 'assistant', 'user', 'assistant', 'user'], chainStart: 2, fixedTokens: 100 });
  assert.equal(value.start, 2); assert.ok(value.inputTokens <= value.inputLimit);
});
test('original history pagination progresses without corrupting emoji or losing a suffix', () => {
  const content = '早期决定😀value427 '.repeat(4000) + 'DO NOT LOSE THIS';
  let offset = 0, recovered = '';
  while (offset < content.length) {
    const page = historyPage({ message: { id: 'm1', role: 'user', content }, fromChar: offset, maxTokens: 600 });
    assert.ok(page.nextOffset > offset); assert.ok(!/[\uD800-\uDBFF]$/.test(content.slice(offset, page.nextOffset)));
    recovered += content.slice(offset, page.nextOffset); offset = page.nextOffset;
  }
  assert.equal(recovered, content);
  const literal = '\n[Context excerpt truncated to fit request budget.]';
  assert.equal(historyPage({ message: { id: 'm', role: 'user', content: literal } }).complete, true);
});
test('edited or removed boundary does not retain invented references', () => {
  const plan = contextPlan({ messages: [{ id: 'new', role: 'user', tokens: 50 }], ledger: { cards: [{ fromMessageId: 'missing', toMessageId: 'missing', summary: 'old secret' }] } });
  assert.equal(plan.ledger.cards.length, 0); assert.equal(plan.summary, '');
});
