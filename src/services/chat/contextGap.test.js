import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveContextBudget } from './contextBudget.js';
import { buildRecentWindow } from '../../memory/contextWindow.js';
import { planIncrementalCompact } from '../../memory/contextCompact.js';
import { estimateMessagesTokens } from '../../memory/tokenEstimate.js';

// 2026-10-17 audit P0-2: with a 60k window and an 80k trigger, history between
// the two was dropped by the window and never summarised. The invariant below
// is what closes the gap: whenever the sliding window would drop pending
// history, a compaction plan must exist for the same chat.
function chatWith(turns, chars) {
  const messages = [];
  for (let index = 0; index < turns; index += 1) {
    messages.push({ id: `u${index}`, role: 'user', content: `问题 ${index} ` + '测试'.repeat(chars / 2) });
    messages.push({ id: `a${index}`, role: 'assistant', content: `回答 ${index} ` + '内容'.repeat(chars / 2) });
  }
  return { id: 'gap', messages, compactFailures: 0 };
}

test('pending history that the window would drop is always compactable', () => {
  for (const total of ['16000', '60000', '160000']) {
    const budget = resolveContextBudget({ MELO_CONTEXT_BUDGET_TOKENS: total });
    for (const turns of [4, 12, 40, 120]) {
      const chat = chatWith(turns, 400);
      const window = buildRecentWindow(chat.messages, budget.windowTokens);
      const dropped = chat.messages.length - window.length;
      const plan = planIncrementalCompact(chat, { triggerTokens: budget.compactTriggerTokens });
      if (dropped > 0) {
        assert.ok(plan, `budget ${total}, ${turns} turns: ${dropped} messages dropped by the window but no compaction planned`);
        assert.ok(plan.compactedCount > 0);
      }
      if (plan) {
        assert.ok(estimateMessagesTokens(chat.messages) >= budget.compactTriggerTokens);
      }
    }
  }
});

test('a chat that fits the window is not compacted', () => {
  const budget = resolveContextBudget({ MELO_CONTEXT_BUDGET_TOKENS: '160000' });
  const chat = chatWith(6, 200);
  assert.equal(buildRecentWindow(chat.messages, budget.windowTokens).length, chat.messages.length);
  assert.equal(planIncrementalCompact(chat, { triggerTokens: budget.compactTriggerTokens }), null);
});

test('Chinese text is no longer estimated at two tokens per character', async () => {
  const { estimateTextTokens } = await import('../../memory/tokenEstimate.js');
  const text = '这是一段用来校准估算器的中文文本。'.repeat(50);
  const perChar = (estimateTextTokens(text) * 4 / 3) / text.length;
  assert.ok(perChar <= 1.4, `effective tokens/char ${perChar.toFixed(2)} should sit between the o200k and Claude rates`);
  assert.ok(perChar >= 1.2);
});

test('token estimates are allocation-free and memoised per message without changing results', async () => {
  const { estimateTextTokens, estimateMessageTokens, truncateToTokens } = await import('../../memory/tokenEstimate.js');
  const reference = text => { const s = String(text); const n = (s.match(/[^\u0000-ɏ]/gu) || []).length; return Math.ceil((s.length - n) / 4 + n); };
  for (const sample of ['plain ascii', '中文内容'.repeat(50), 'mixed 中英 😀 emoji'.repeat(20), '']) {
    assert.equal(estimateTextTokens(sample), reference(sample));
  }
  const message = { role: 'user', content: '这是一条会被重复估算的消息'.repeat(30) };
  const first = estimateMessageTokens(message);
  assert.equal(estimateMessageTokens(message), first, 'memoised on the object');
  message.content = 'changed after first estimate';
  assert.notEqual(estimateMessageTokens(message), first, 'an in-place content change invalidates the memo');
  const protocol = { role: 'assistant', content: '', responseItems: [{ type: 'function_call', call_id: 'a', name: 't', arguments: '{}' }] };
  const before = estimateMessageTokens(protocol);
  protocol.responseItems.unshift({ type: 'reasoning', encrypted_content: 'x'.repeat(4000) });
  assert.ok(estimateMessageTokens(protocol) > before, 'growing the item array invalidates the memo');
  const long = '汉'.repeat(5000);
  const cut = truncateToTokens(long, 100);
  assert.ok(cut.endsWith('[Context excerpt truncated to fit request budget.]'));
  assert.ok(estimateTextTokens(cut) <= 100);
  assert.ok(estimateTextTokens(cut.slice(0, cut.indexOf('\n')) + '汉' + '\n[Context excerpt truncated to fit request budget.]') > 100, 'cut is maximal');
});
