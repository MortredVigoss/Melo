import test from 'node:test';
import assert from 'node:assert/strict';
import { completionReceipt as receipt, completionSummary, completionResult } from './completion.js';
const goal = 'Research Sydney brunch';
const source = { id: 'read-1', type: 'source', executed: true, ok: true, url: 'https://fixture.invalid/menu', reading: 'extracted', text: 'Sydney brunch menu with breakfast dishes and observed opening hours for this fixture.' };
const input = { goal, kind: 'research', reply: 'Sydney brunch: https://fixture.invalid/menu', observations: [source] };
test('ordinary answers complete without tools; a missing answer never does', () => {
  assert.equal(receipt({ reply: 'Hello' }).outcome, 'completed');
  assert.equal(receipt({ reply: 'Hello' }).goalState, 'not_applicable');
  assert.equal(receipt({ reply: '' }).outcome, 'blocked');
});
test('tool success, irrelevant queries, snippets and invented citations do not certify research', () => {
  for (const changed of [{ type: 'effect' }, { reading: 'snippet' }, { reading: 'unknown' }, { executed: false }, { ok: false },
    { text: '' }]) {
    assert.notEqual(receipt({ ...input, observations: [{ ...source, ...changed }] }).outcome, 'completed', JSON.stringify(changed));
  }
  assert.equal(receipt({ ...input, reply: 'See https://invented.invalid/menu', observations: [{ ...source, text: 'Unrelated astronomy observations about distant stars and galaxies.', query: goal, title: goal }] }).reason, 'RELEVANT_READ_SOURCE_MISSING');
  assert.equal(receipt({ ...input, observations: [] }).outcome, 'blocked');
});
test('actual relevant read and citation support delivery without claiming factual verification', () => {
  const result = receipt(input);
  assert.equal(result.outcome, 'completed'); assert.equal(result.goalState, 'supported');
  assert.deepEqual(result.evidenceIds, ['read-1']);
  assert.equal(JSON.stringify(result).includes(source.text), false, 'page bodies are not persisted in the receipt');
  assert.match(completionSummary(result), /not independently verified/);
});
test('explicit page requests require that page, not another successful fetch', () => {
  assert.equal(receipt({ ...input, goal: 'Read https://fixture.invalid/menu' }).outcome, 'completed');
  assert.notEqual(receipt({ ...input, goal: 'Read https://other.invalid/menu' }).outcome, 'completed');
});
test('successful writes and model-authored achieved claims remain unverified', () => {
  const result = receipt({ kind: 'action', goal: 'Create the requested file', reply: 'Done, achieved.', observations: [{ id: 'write-1', type: 'effect', ok: true, executed: true, achieved: true }] });
  assert.equal(result.outcome, 'partial'); assert.equal(result.goalState, 'unverified');
});
test('only a host-verified matching goal closes an action task', () => {
  const action = { type: 'device-visible-facts', checked: true, goal: 'Open Settings', evidenceId: 'screen-check-1' };
  const params = { kind: 'action', goal: action.goal, reply: 'Settings visible', verifiedActions: [action] };
  assert.equal(receipt(params).goalState, 'verified');
  assert.equal(receipt({ ...params, goal: 'Open Calendar' }).outcome, 'blocked');
  assert.equal(receipt({ ...params, verifiedActions: [{ ...action, checked: false }] }).outcome, 'blocked');
});
test('cancellation and budget exhaustion are distinct from successful delivery', () => {
  assert.equal(receipt({ ...input, terminalReason: 'CANCELLED' }).outcome, 'cancelled');
  for (const terminalReason of ['BUDGET_EXHAUSTED', 'DEADLINE_EXCEEDED', 'ROUND_LIMIT']) assert.equal(receipt({ ...input, terminalReason }).outcome, 'budget_exhausted');
  assert.equal(receipt({ ...input, terminalReason: 'NO_PROGRESS' }).outcome, 'partial');
  assert.equal(receipt({ ...input, observations: [], terminalReason: 'NO_PROGRESS' }).outcome, 'blocked');
});

test('explicitly refused unknown tools do not turn completed research into an action', () => {
  const observations = [source, { id: 'refused', type: 'tool', name: 'invented_tool', ok: false, executed: false }];
  const result = completionResult({ goal, reply: input.reply, observations });
  assert.equal(result.kind, 'research');
  assert.equal(result.outcome, 'completed');
  for (const executed of [true, undefined]) {
    const possibleEffect = { ...observations[1], executed };
    const unknown = completionResult({ goal, reply: input.reply, observations: [source, possibleEffect] });
    assert.equal(unknown.kind, 'research-action');
    assert.equal(unknown.reason, 'GOAL_TERMINAL_EVIDENCE_MISSING');
  }
});

test('a connectivity reply is delivered without inventing a research requirement', () => {
  for (const goal of [
    '这是更新后的连通性检查。请只回复：更新验证通过。不要调用工具。',
    '连通性检查，请回复 OK',
    '请检查这句话的语法：“I is ready.”',
    '请核查这个计算：2 + 2 = 4',
    'Do not use tools. Only reply: current weather.',
    '不用任何工具，只根据已有知识回答：为什么会下雨？',
  ]) {
    const result = completionResult({ goal, reply: '已回答。' });
    assert.equal(result.kind, 'answer', goal);
    assert.equal(result.outcome, 'completed', goal);
    assert.equal(result.goalState, 'not_applicable', goal);
    assert.equal(result.reason, 'ANSWER_DELIVERED', goal);
  }
});

test('reply formatting and tool restrictions never fabricate external completion evidence', () => {
  for (const goal of [
    '请搜索今天的新闻，只回复一句。',
    '查一下悉尼早午餐，只回复餐厅名字。',
    '创建文件 result.txt，不要调用工具，只回复完成。',
    'Please search current weather. The example phrase is "do not use tools".',
  ]) {
    const result = completionResult({ goal, reply: '完成。' });
    assert.equal(result.outcome, 'blocked', goal);
    assert.equal(result.goalState, 'unverified', goal);
  }
  const goal = '连通性检查，请只回复 OK，不要调用工具';
  for (const terminalReason of ['CANCELLED', 'DEADLINE_EXCEEDED', 'REQUEST_FAILED']) {
    assert.notEqual(completionResult({ goal, reply: 'OK', terminalReason }).outcome, 'completed');
  }
  assert.equal(completionResult({ goal, reply: '' }).reason, 'NO_FINAL_ANSWER');
  assert.equal(completionResult({ goal, reply: 'OK', observations: [
    { id: 'write', name: 'file_write', type: 'tool', executed: true, ok: true },
  ] }).reason, 'GOAL_TERMINAL_EVIDENCE_MISSING');
});


test('relevant sources can support delivery without a pasted URL; citations can link a paraphrase', () => {
  assert.equal(receipt({ ...input, reply: 'The menu has breakfast dishes and opening hours.' }).outcome, 'completed');
  const paraphrase = { ...source, text: 'A local cafe serves a morning meal including eggs and pancakes every day.' };
  assert.equal(receipt({ ...input, observations: [paraphrase], reply: 'See the cited menu.', citations: [{url: source.url}] }).outcome, 'completed');
  assert.equal(receipt({ ...input, observations: [paraphrase], reply: 'See the cited menu.', citations: [{url: 'https://invented.invalid/menu'}] }).reason, 'RELEVANT_READ_SOURCE_MISSING');
  assert.equal(receipt({ ...input, observations: [{...paraphrase, reading: 'snippet'}], citations: [{url: source.url}] }).reason, 'RELEVANT_READ_SOURCE_MISSING');
  const half = { ...source, text: 'Sydney has a cafe serving eggs and pancakes each morning, with opening hours listed.' };
  assert.equal(receipt({ ...input, observations: [half], reply: 'A cafe serves eggs and pancakes.' }).outcome, 'completed');
  assert.notEqual(receipt({ ...input, goal: 'Read https://other.invalid/menu', citations: [{url: source.url}] }).outcome, 'completed');
});
