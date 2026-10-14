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
  assert.deepEqual(resolveContextBudget({ MELO_CONTEXT_BUDGET_TOKENS: '-1', MELO_OUTPUT_RESERVE_TOKENS: 'NaN' }), { totalTokens: 60000, outputReserve: 8000 });
});

test('history is a recent continuous suffix; a large recent turn cannot expose older scraps',()=>{
 const messages=[{role:'user',content:'old'},{role:'assistant',content:'old answer'},{role:'user',content:'big'.repeat(10000)},{role:'assistant',content:'recent answer'},{role:'user',content:'now'}];
 const result=fitRequestContext({messages,totalTokens:4096,outputReserve:512});assert.deepEqual(result.messages,[messages.at(-1)]);
});
