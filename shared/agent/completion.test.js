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

// 2026-11-07 review: the kind of source and how much of its text was kept are separate facts.
test('a long provider answer stays provider-reported; only a read page becomes a partial read', async () => {
  // A source row keeps one whole page window (SOURCE_TEXT_CHARS; 16 000 before 2026-11-10).
  const { completionObservation, SOURCE_TEXT_CHARS } = await import('./completion.js');
  const long = 'Opening hours are 8am to 4pm. ' + 'x'.repeat(SOURCE_TEXT_CHARS), exact = 'y'.repeat(SOURCE_TEXT_CHARS);
  const rows = completionObservation({ id: 'hosted:0', name: 'web_search', ok: true, executed: true, output: 'Provider-reported completed Search', sources: [
    { url: 'https://cafe.example/hours', reading: 'provider', text: long },
    { url: 'https://cafe.example/menu', reading: 'snippet', text: long },
    { url: 'https://cafe.example/page', text: long },
    { url: 'https://cafe.example/exact', reading: 'provider', text: exact },
    { url: 'https://cafe.example/whole', text: exact }] });
  const by = Object.fromEntries(rows.filter(row => row.type === 'source').map(row => [row.url.split('/').pop(), row]));
  assert.deepEqual([by.hours.reading, by.hours.truncated, by.hours.text.length], ['provider', true, SOURCE_TEXT_CHARS]);
  assert.deepEqual([by.menu.reading, by.menu.truncated], ['snippet', true]);
  assert.deepEqual([by.page.reading, by.page.truncated], ['partial', true], 'a cut page is a partial read');
  assert.deepEqual([by.exact.reading, 'truncated' in by.exact], ['provider', false], 'text of exactly the limit is kept whole');
  assert.deepEqual([by.whole.reading, 'truncated' in by.whole], ['extracted', false]);
});

// 2026-11-10 agent audit. On the desktop the completion receipt planned "操作系统是什么？" as a phone
// action (操作) and "How do I open a file in Python?" as a file action, so an answer the check had
// judged self-contained was recorded and shown as blocked ("受阻 · 尚无目标完成证据").
test('an answer the check judged self-contained is delivered whatever verbs the question contains', async () => {
  const { completionResult } = await import('./completion.js');
  const { startGoal, goalCandidate, reviewGoal, goalSnapshot } = await import('./goal.js');
  const verdict = JSON.stringify({ decision: 'complete', turnKind: 'answer', reasonType: 'self_contained', reason: 'Explained.', nextStep: '', requirements: [{ text: 'explain', kind: 'response', status: 'met', evidenceIds: [] }] });
  const receiptFor = (goal, tools) => {
    const candidate = goalCandidate(startGoal(goal), { reply: 'Here is the explanation.', observations: [], tools, roundsLeft: 4 });
    assert.equal(candidate.phase, 'checking', goal);
    const reviewed = reviewGoal(candidate, verdict, []);
    return { reviewed, receipt: completionResult({ goal, reply: 'Here is the explanation.', observations: [], task: goalSnapshot(reviewed), locale: 'zh' }) };
  };
  // The desktop's tools: no phone control, so none of these questions needs evidence of an action.
  for (const goal of ['操作系统是什么？', 'How do I open a file in Python?', '写个脚本删除目录下的临时文件', '打开方式有哪几种，分别是什么意思？', 'Explain how a tree grows.']) {
    const { reviewed, receipt } = receiptFor(goal, ['web_search', 'fetch_url', 'file_read', 'file_write', 'bash']);
    assert.deepEqual([reviewed.decision, reviewed.reason], ['deliver', 'SELF_CONTAINED_ANSWER'], goal);
    assert.deepEqual([receipt.outcome, receipt.reason, receipt.summary], ['completed', 'ANSWER_DELIVERED', '回答已交付'], goal);
  }
  // With phone control offered the same questions go through the evidence path; the check's own
  // judgement that the turn is an answer still delivers them.
  for (const goal of ['操作系统是什么？', '打开方式有哪几种，分别是什么意思？']) {
    const { receipt } = receiptFor(goal, ['web_search', 'fetch_url', 'phone_use']);
    assert.deepEqual([receipt.outcome, receipt.kind], ['completed', 'answer'], goal);
  }
  // An action request that was only talked about is still not a delivered answer.
  const unchecked = completionResult({ goal: '打开设置', reply: '已经打开了。', observations: [], locale: 'zh' });
  assert.equal(unchecked.outcome, 'blocked');
  const partial = completionResult({ goal: '打开设置', reply: '已经打开了。', observations: [], locale: 'zh', task: { decision: 'partial', reason: 'GOAL_UNAVAILABLE', requirements: [{ text: 'open settings', kind: 'external_effect', status: 'missing', evidenceIds: [] }] } });
  assert.equal(partial.outcome, 'blocked');
});

// A URL in running Chinese text was read up to the next space, so "the page the user asked for" matched
// nothing that was read and a member that had read exactly that page was reported as partial.
test('a requested URL ends where Chinese text or punctuation begins', async () => {
  const { completionReceipt, completionObservation } = await import('./completion.js');
  const read = completionObservation({ id: 'read', name: 'fetch_url', ok: true, executed: true, output: 'x', data: { url: 'https://example.com/article', text: 'The article was published on 3 March 2026 by the harbour authority.' } });
  const receipt = goal => completionReceipt({ goal, kind: 'research', reply: 'Published on 3 March 2026.', citations: ['https://example.com/article'], observations: read });
  for (const goal of ['Read https://example.com/article and tell me the date', '读取 https://example.com/article，总结发布日期', '看看https://example.com/article讲了什么', '（来源：https://example.com/article）请核对', '读取 https://example.com/article。'])
    assert.deepEqual([receipt(goal).outcome, receipt(goal).reason], ['completed', 'RELEVANT_SOURCES_READ'], goal);
  // Another requested page that was not read still leaves the receipt partial.
  assert.equal(receipt('读取 https://other.invalid/page，总结发布日期').reason, 'RELEVANT_READ_SOURCE_MISSING');
  assert.equal(receipt('读取 https://example.com/article 和 https://other.invalid/page').outcome, 'completed', 'one of the requested pages was read');
});

// 2026-11-10 pre-push review: the rule above was written as "an address ends at Chinese text, minus final
// punctuation". That lost every address with Chinese in its path and every address that really ends in
// "!". The receipt now asks whether the address of a page that was read is written in the goal.
test('a requested URL may contain Chinese text or end in punctuation, and a longer address is a different page', async () => {
  const { completionReceipt, completionObservation } = await import('./completion.js');
  const page = address => completionObservation({ id: 'read', name: 'fetch_url', ok: true, executed: true, output: 'x', data: { url: address, text: 'This is the requested report. The public source content has actually been read.' } });
  const result = (goal, address, extra = {}) => { const row = completionReceipt({ goal, kind: 'research', reply: 'Done.', observations: page(address), ...extra }); return [row.outcome, row.reason]; };
  const read = ['completed', 'RELEVANT_SOURCES_READ'], missing = ['partial', 'RELEVANT_READ_SOURCE_MISSING'];
  // The reviewer's case: the address itself ends in "!".
  assert.deepEqual(result('Read https://example.com/report!', 'https://example.com/report!'), read);
  // The same sentence when the "!" was only the end of the sentence.
  assert.deepEqual(result('Read https://example.com/report!', 'https://example.com/report'), read);
  // Chinese in the path: as typed, percent-encoded by the reader, with or without a space before the text that follows.
  const melbourne = 'https://zh.wikipedia.org/wiki/墨尔本';
  for (const goal of ['读取 ' + melbourne + ' 的简介', '读取' + melbourne + '的简介', '读取 ' + melbourne + '，总结人口'])
    for (const address of [melbourne, encodeURI(melbourne)]) assert.deepEqual(result(goal, address), read, goal + ' / ' + address);
  // Small differences that do not name another page.
  assert.deepEqual(result('Read https://Example.com/report.', 'https://example.com/report'), read, 'host case and a final full stop');
  assert.deepEqual(result('Read https://example.com', 'https://example.com/'), read, 'the slash a reader adds to a bare host');
  assert.deepEqual(result('Read https://example.com/report#summary and sum it up', 'https://example.com/report'), read, 'a fragment is the same page');
  assert.deepEqual(result('See [the report](https://example.com/report) please', 'https://example.com/report'), read);
  // A page whose address is only the beginning of the requested one was not the page asked for.
  assert.deepEqual(result('Read https://example.com/report-2 for me', 'https://example.com/report'), missing);
  assert.deepEqual(result('Read https://example.com/report?page=2 for me', 'https://example.com/report'), missing);
  assert.deepEqual(result('Read https://example.com.au/report for me', 'https://example.com'), missing);
  assert.deepEqual(result('读取 https://other.invalid/page!', 'https://example.com/report!'), missing);
  // Without an address in the goal, a page the reply cites still counts, in whichever spelling.
  assert.deepEqual(result('墨尔本有多少人口', encodeURI(melbourne), { reply: '见 ' + melbourne + '。' }), read);
  assert.deepEqual(result('墨尔本有多少人口', encodeURI(melbourne), { citations: [{ url: melbourne }] }), read);
  assert.deepEqual(result('墨尔本有多少人口', encodeURI(melbourne), { reply: '见 https://zh.wikipedia.org/wiki/悉尼。' }), missing);
});
