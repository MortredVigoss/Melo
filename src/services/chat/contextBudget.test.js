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
  // Near-window cap (design 1D-1): raw history stops at 64k; the ledger,
  // topic excerpts and read_history cover the rest.
  assert.equal(cloud.windowTokens, 64000);
  assert.equal(cloud.compactTriggerTokens, cloud.windowTokens);
  assert.equal(resolveContextBudget({ MELO_HISTORY_WINDOW_TOKENS: '100000' }, { config: { authMode: 'codex' } }).windowTokens, 100000, 'cap override');
  assert.equal(resolveContextBudget({ MELO_HISTORY_WINDOW_TOKENS: '999999' }, { config: { authMode: 'codex' } }).windowTokens, Math.floor(152000 * 0.75), 'share still bounds the window');
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

// ─── 2026-10-18 bug audit (section 2) ────────────────────────────────────────

test('L3: a full ledger plus session memory and excerpts no longer truncate memory or drop dynamic context when the request is far below the limit', async () => {
  const { buildReActPromptSections } = await import('./systemPrompt.js');
  const { renderCompactLedger, LEDGER_MAX_TOKENS } = await import('../../memory/compactLedger.js');
  const { formatCompactContextBlock } = await import('../../memory/contextCompact.js');
  const cards = Array.from({ length: 8 }, (_, i) => ({ id: `c${i}`, title: `话题${i}`, summary: `决定 ${i} 端口 ${5000 + i} 路径 /srv/${i} `.repeat(150), fromMessageId: `f${i}`, toMessageId: `t${i}`, source: 'cloud' }));
  const ledger = renderCompactLedger(cards);
  assert.ok(estimateTextTokens(ledger) > LEDGER_MAX_TOKENS / 2 && estimateTextTokens(ledger) <= LEDGER_MAX_TOKENS, `ledger is large (${estimateTextTokens(ledger)})`);
  const sections = buildReActPromptSections({
    config: {}, profile: { name: 'main', identity: '', soulMd: '', tools: [], capabilities: {}, collaboration: {} }, modePrompt: '',
    projectContext: '', projectMemoryBook: '', personalProfile: '', selectedMaterials: '', channelPrompt: '',
    memoryContext: '记忆行 '.repeat(700), toolRoutingPrompt: '', connectorPrompts: '', skillsPrompts: '',
    dynamicContext: '动态上下文 '.repeat(500),
    compactContext: formatCompactContextBlock(ledger, 120),
    topicExcerpts: '原文摘录 '.repeat(500), toolsPrompt: 'tools', sessionMemoryBlock: '会话记忆 '.repeat(300),
    languageConstraint: '', dateContext: '', vizInstructions: '', citationInstructions: '', kind: 'chat', isRemoteChannel: false, intent: 'factual',
  });
  const budget = resolveContextBudget({}, { config: { authMode: 'codex' } });
  const fit = fitRequestContext({ sections, messages: [{ role: 'user', content: '继续' }], ...budget, turnContextPlacement: 'message' });
  assert.equal(budget.inputLimit, 152000);
  assert.ok(fit.diagnostics.inputTokens < 25000, `request is small (${fit.diagnostics.inputTokens})`);
  assert.deepEqual(fit.diagnostics.truncatedSections, []);
  assert.deepEqual(fit.diagnostics.droppedSections, []);
  for (const id of ['compact', 'session-memory', 'topic-excerpts', 'memory', 'dynamic']) assert.ok(fit.sections.some(section => section.id === id), `${id} present`);
  assert.match(fit.systemPrompt, /=== End of Summary/, 'ledger footer survives in the stable prefix');
  // A tight budget still keeps a floor for the lower-priority blocks instead of dropping them.
  const tight = fitRequestContext({ sections, messages: [{ role: 'user', content: '继续' }], totalTokens: 24000, outputReserve: 2000, turnContextPlacement: 'message' });
  assert.ok(!tight.diagnostics.droppedSections.includes('dynamic'), 'dynamic keeps its floor');
  assert.ok(!tight.diagnostics.droppedSections.includes('memory'));
});

test('L10: the compact section keeps its footer across ledger sizes', async () => {
  const { buildReActPromptSections } = await import('./systemPrompt.js');
  const { renderCompactLedger, LEDGER_MAX_TOKENS } = await import('../../memory/compactLedger.js');
  const { formatCompactContextBlock } = await import('../../memory/contextCompact.js');
  const budget = resolveContextBudget({}, { config: { authMode: 'codex' } });
  for (let repeat = 20; repeat <= 420; repeat += 10) {
    const cards = Array.from({ length: 6 }, (_, i) => ({ id: `c${i}`, title: `话题${i}`, summary: `细节 ${i} 数值 ${i * 7} `.repeat(repeat), fromMessageId: `f${i}`, toMessageId: `t${i}`, source: 'cloud' }));
    const ledger = renderCompactLedger(cards);
    assert.ok(estimateTextTokens(ledger) <= LEDGER_MAX_TOKENS);
    const sections = buildReActPromptSections({
      config: {}, profile: { name: 'main', identity: '', soulMd: '', tools: [], capabilities: {}, collaboration: {} }, modePrompt: '',
      projectContext: '', projectMemoryBook: '', personalProfile: '', selectedMaterials: '', channelPrompt: '', memoryContext: '', toolRoutingPrompt: '',
      connectorPrompts: '', skillsPrompts: '', dynamicContext: '', compactContext: formatCompactContextBlock(ledger, 100, { source: 'cloud' }), topicExcerpts: '',
      toolsPrompt: 'tools', sessionMemoryBlock: '', languageConstraint: '', dateContext: '', vizInstructions: '', citationInstructions: '', kind: 'chat', isRemoteChannel: false, intent: 'factual',
    });
    const fit = fitRequestContext({ sections, messages: [{ role: 'user', content: 'hi' }], ...budget, turnContextPlacement: 'message' });
    const compact = fit.sections.find(section => section.id === 'compact');
    assert.ok(compact, `compact present at repeat=${repeat}`);
    assert.ok(!fit.diagnostics.truncatedSections.includes('compact'), `not truncated at repeat=${repeat}`);
    assert.match(compact.text, /=== End of Summary — continue the conversation from here ===\n\[End reference data: compact\]$/, `footer intact at repeat=${repeat}`);
    assert.match(compact.text, /## 话题5/, 'newest card present');
  }
});

test('L4: budget exposes a chunk size for the summariser and the effective history window follows the required prompt', async () => {
  const { requiredPromptTokens, effectiveHistoryWindow } = await import('./contextBudget.js');
  const local = resolveContextBudget({}, { config: { authMode: 'local' } });
  assert.equal(local.inputLimit, 16000);
  assert.equal(local.compactChunkTokens, 8000, 'half the input limit');
  assert.equal(resolveContextBudget({ MELO_CONTEXT_BUDGET_TOKENS: '4096' }).compactChunkTokens, 4000, 'floor');
  assert.equal(resolveContextBudget({}, { config: { authMode: 'codex' } }).compactChunkTokens, 45000, 'cloud keeps the tuned 45k cap');
  const sections = [
    { id: 'base', text: 'word '.repeat(5000), required: true },
    { id: 'memory', text: 'optional '.repeat(5000), required: false },
  ];
  const definitions = Array.from({ length: 21 }, (_, i) => ({ type: 'function', name: `tool_${i}`, description: 'd '.repeat(60), parameters: { type: 'object', properties: { a: { type: 'string', description: 'x'.repeat(80) } } } }));
  const required = requiredPromptTokens({ sections, toolDefinitions: definitions });
  const requiredNoTools = requiredPromptTokens({ sections });
  assert.ok(required > requiredNoTools && requiredNoTools > 5000, `required counts instructions and tools (${required})`);
  assert.ok(required < 16000);
  const window = effectiveHistoryWindow(local, required);
  assert.ok(window < local.windowTokens, `effective window shrinks (${window} < ${local.windowTokens})`);
  assert.ok(window + required + 512 <= local.inputLimit);
  assert.equal(effectiveHistoryWindow(local, 100), local.windowTokens, 'a small prompt keeps the nominal window');
  assert.equal(effectiveHistoryWindow(local, 100000), 1024, 'never below the floor');
});
