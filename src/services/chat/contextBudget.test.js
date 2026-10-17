import test from 'node:test';
import assert from 'node:assert/strict';
import { fitRequestContext, resolveContextBudget } from './contextBudget.js';
import { estimateMessageTokens, estimateTextTokens } from '../../memory/tokenEstimate.js';

test('whole request includes instructions, images, Chinese text and output reserve', () => {
  const current = { role: 'user', content: [{ type: 'text', text: '图片里面是什么？' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }] };
  const fit = fitRequestContext({
    sections: [{ id: 'safety', text: 'Permissions still apply.', required: true }, { id: 'memory', text: '过去的记忆'.repeat(5000), priority: 2 }],
    messages: [{ role: 'user', content: 'old '.repeat(9000) }, { role: 'assistant', content: 'previous reply' }, current],
    totalTokens: 7000, outputReserve: 1000,
  });
  assert.ok(fit.diagnostics.inputTokens + fit.diagnostics.outputReserve <= 7000);
  assert.deepEqual(fit.messages.at(-1), current);
  assert.match(fit.systemPrompt, /Permissions still apply/);
  assert.ok(fit.diagnostics.truncatedSections.includes('memory'));
  assert.ok(estimateTextTokens('中文'.repeat(100)) > estimateTextTokens('en'.repeat(100)));
  assert.ok(estimateMessageTokens(current) >= 2048);
});

test('oversized current input fails explicitly, without silently dropping attachments', () => {
  const messages = [{ role: 'user', content: 'x'.repeat(50000) }];
  assert.throws(() => fitRequestContext({ messages, totalTokens: 4096, outputReserve: 512 }), { code: 'CONTEXT_BUDGET_EXCEEDED' });
  assert.equal(messages[0].content.length, 50000);
});

test('tool results never survive without their calls; current question stays', () => {
  const messages = [
    { role: 'user', content: 'my current question' },
    { role: 'assistant', content: 'old-tool-call'.repeat(400) },
    { role: 'user', content: 'old-result'.repeat(700), isToolResult: true },
    { role: 'assistant', content: '<tool_call>new</tool_call>' },
    { role: 'user', content: 'new result', isToolResult: true },
  ];
  const result = fitRequestContext({ messages, totalTokens: 1500, outputReserve: 500 });
  assert.deepEqual(result.messages, [messages[0], messages[3], messages[4]]);
});

test('duplicate blocks count once and invalid settings fall back safely', () => {
  const result = fitRequestContext({ sections: [{ id: 'a', text: 'same' }, { id: 'b', text: 'same' }], messages: [] });
  assert.deepEqual(result.diagnostics.duplicateSections, ['b']);
  // Defaults are per provider family (2026-10-17): cloud models get the large
  // window the user asked for, local models stay small; the window and the
  // compaction trigger are derived from the same total so they cannot drift.
  const cloud = resolveContextBudget({ MELO_CONTEXT_BUDGET_TOKENS: '-1', MELO_OUTPUT_RESERVE_TOKENS: 'NaN' }, { config: { authMode: 'codex' } });
  assert.equal(cloud.totalTokens, 160000);
  assert.equal(cloud.outputReserve, 8000);
  assert.equal(cloud.inputLimit, 152000);
  assert.equal(cloud.windowTokens, Math.floor(152000 * 0.75));
  assert.equal(cloud.compactTriggerTokens, cloud.windowTokens);
  assert.ok(cloud.windowTokens < cloud.inputLimit, 'window leaves room for system prompt and tools');
  const local = resolveContextBudget({}, { config: { authMode: 'local' } });
  assert.equal(local.totalTokens, 24000);
  assert.equal(local.compactTriggerTokens, local.windowTokens);
  const override = resolveContextBudget({ MELO_CONTEXT_BUDGET_TOKENS: '300000' }, { config: { authMode: 'local' } });
  assert.equal(override.totalTokens, 300000, 'env override wins regardless of provider family');
  assert.equal(resolveContextBudget({ MELO_CONTEXT_BUDGET_TOKENS: '999999999' }).totalTokens, 400000, 'upper bound');
});

test('the compaction trigger never exceeds what the window can carry', () => {
  for (const total of ['8192', '60000', '160000', '400000']) {
    const budget = resolveContextBudget({ MELO_CONTEXT_BUDGET_TOKENS: total });
    assert.ok(budget.compactTriggerTokens <= budget.windowTokens);
    assert.ok(budget.windowTokens <= budget.inputLimit);
  }
});

test('history is a recent continuous suffix; a large recent turn cannot expose older scraps',()=>{
 const messages=[{role:'user',content:'old'},{role:'assistant',content:'old answer'},{role:'user',content:'big'.repeat(10000)},{role:'assistant',content:'recent answer'},{role:'user',content:'now'}];
 const result=fitRequestContext({messages,totalTokens:4096,outputReserve:512});assert.deepEqual(result.messages,[messages.at(-1)]);
});

test('per-turn sections ride in the latest user message and the system prompt stays identical across turns', async () => {
  const { attachTurnContextToMessages, TURN_CONTEXT_USER_MARKER } = await import('./contextBudget.js');
  const sections = [
    { id: 'base', text: 'Stable base instructions', required: true, placement: 'system' },
    { id: 'agent', text: 'Agent persona', required: true, placement: 'system' },
    { id: 'tools', text: 'Tool policy for this turn', required: true, placement: 'turn' },
    { id: 'memory', text: 'Recalled note A', required: false, priority: 80, placement: 'turn' },
  ];
  const turn1 = fitRequestContext({ sections, messages: [{ role: 'user', content: 'first' }], turnContextPlacement: 'message' });
  const turn2 = fitRequestContext({
    sections: sections.map(s => s.id === 'memory' ? { ...s, text: 'Recalled note B' } : s),
    messages: [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'reply' }, { role: 'user', content: 'second' }],
    turnContextPlacement: 'message',
  });
  assert.equal(turn1.systemPrompt, turn2.systemPrompt, 'system prompt is byte-identical across turns');
  assert.doesNotMatch(turn1.systemPrompt, /Tool policy|Recalled note/);
  assert.match(turn2.turnContext, /Tool policy for this turn/);
  assert.match(turn2.turnContext, /Recalled note B/);
  assert.match(turn2.promptText, /Stable base instructions[\s\S]*Recalled note B/);
  // Prepared messages stay clean; attachment happens at request time.
  assert.equal(turn2.messages.at(-1).content, 'second');
  const sent = attachTurnContextToMessages(turn2.messages, turn2.turnContext);
  assert.equal(sent[0].content, 'first', 'earlier history untouched');
  assert.match(sent.at(-1).content, new RegExp(`Recalled note B[\\s\\S]*${TURN_CONTEXT_USER_MARKER.replace(/[[\]]/g, '\\$&')}\\nsecond$`));
  assert.equal(attachTurnContextToMessages(sent, turn2.turnContext).at(-1).content, sent.at(-1).content, 'idempotent');
  // Multimodal user turns get a leading text part instead of string concatenation.
  const multimodal = attachTurnContextToMessages([{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] }], 'ctx');
  assert.equal(multimodal[0].content[0].type, 'text');
  assert.match(multimodal[0].content[0].text, /ctx/);
  assert.equal(multimodal[0].content.length, 3);
  // Supplements appended mid-turn do not move the block.
  const withSupplement = attachTurnContextToMessages([
    { role: 'user', content: 'original' }, { role: 'assistant', content: 'working', responseItems: [] },
    { role: 'user', content: 'also do X', isSupplement: true },
  ], 'ctx');
  assert.match(withSupplement[0].content, /ctx/);
  assert.equal(withSupplement[2].content, 'also do X');
  // Default placement keeps the pre-2026-10-17 layout for direct callers.
  const legacy = fitRequestContext({ sections, messages: [{ role: 'user', content: 'x' }] });
  assert.match(legacy.systemPrompt, /Tool policy for this turn/);
  assert.equal(legacy.turnContext, '');
});
