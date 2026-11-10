import test from 'node:test';
import assert from 'node:assert/strict';
import { updateTaskEvaluation, taskProgressResult } from './taskEvaluation.js';
import { startGoal, goalCandidate, goalReviewRequest, goalSnapshot, amendGoal, candidateAnchors, evidenceExcerpt, goalOperation } from './goal.js';
import { deliveryRequest, deliveryCandidate, reviewDelivery } from './limitDelivery.js';
import { DELIVERY_EVIDENCE_CHARS } from './evidence.js';
import { startTurn, advanceTurn } from './turn.js';
import { completionObservation } from './completion.js';

// 2026-11-10 agent audit, second pass: shared-core findings that were reported and are now confirmed and fixed.

const page = (id, text, url = 'https://fixture.invalid/' + id) => completionObservation({ id, name: 'fetch_url', ok: true, executed: true, output: text, data: { url, text } });
const ledger = (items, observations, goal = 'Compare the phones in the catalog', previous) => {
  const contract = previous || updateTaskEvaluation(null, { action: 'contract', data: { category: 'products' } }, { goal, revision: 1, observations });
  return updateTaskEvaluation(contract, { action: 'batch', data: { items, gaps: [] } }, { goal, revision: 1, observations });
};
const field = (value, quote, id) => ({ value, evidence: [{ id, quote }] });

test('a model and its plus variant are two ledger entities', () => {
  const text = 'Galaxy S24 costs 1199 AUD in AU, available now. Galaxy S24+ costs 1499 AUD in AU, available now.';
  const observations = page('catalog', text);
  const source = observations.find(row => row.type === 'source').id;
  const item = (model, price) => ({ fields: { name: field(model, `${model} costs ${price} AUD`, source), model: field(model, `${model} costs ${price} AUD`, source), price: field(price, `${model} costs ${price} AUD`, source), currency: field('AUD', `${model} costs ${price} AUD`, source), region: field('AU', `${price} AUD in AU`, source), availability: field('available', `${price} AUD in AU, available now`, source) }, match: 30, diversity: 5, reason: 'Listed.', conflicts: [], tags: [] });
  const state = ledger([item('Galaxy S24', 1199), item('Galaxy S24+', 1499)], observations);
  assert.equal(state.error, null);
  assert.equal(state.items.length, 2, 'the plus model is not merged into the base model');
  assert.deepEqual(state.items.map(row => row.key).sort(), ['galaxys24', 'galaxys24+']);
  assert.deepEqual(state.items.map(row => row.fields.price.value).sort(), [1199, 1499], 'each keeps its own price');
  // A sign inside a value is still punctuation: the same event listed with two spellings of its time merges.
  const events = updateTaskEvaluation(null, { action: 'contract', data: { category: 'events' } }, { goal: 'Find events', revision: 1, observations: [] });
  const listing = 'Jazz Night at Town Hall, 2026-10-31T19:30+11:00, free entry, open to all.';
  const eventRows = page('events', listing);
  const eventSource = eventRows.find(row => row.type === 'source').id;
  const event = startsAt => ({ fields: { name: field('Jazz Night', 'Jazz Night at Town Hall', eventSource), startsAt: field(startsAt, '2026-10-31T19:30+11:00', eventSource), place: field('Town Hall', 'Jazz Night at Town Hall', eventSource), participation: field('open to all', 'free entry, open to all', eventSource) }, match: 30, diversity: 5, reason: 'Listed.', conflicts: [], tags: [] });
  const merged = updateTaskEvaluation(events, { action: 'batch', data: { items: [event('2026-10-31T19:30+11:00'), event('2026-10-31T19:30 +11:00')], gaps: [] } }, { goal: 'Find events', revision: 1, observations: eventRows });
  assert.equal(merged.error, null);
  assert.equal(merged.items.length, 1);
});

test('the page text the ledger keeps for the model is not sent with the check nor saved with the receipt', () => {
  const text = 'Model A costs 100 AUD in AU, available now. ' + 'detail '.repeat(400);
  const observations = page('catalog', text);
  const source = observations.find(row => row.type === 'source').id;
  const quote = 'Model A costs 100 AUD in AU';
  const evaluation = ledger([{ fields: Object.fromEntries(['name', 'model', 'price', 'currency', 'region', 'availability'].map(key => [key, field(key === 'price' ? 100 : 'Model A', quote, source)])), match: 30, diversity: 5, reason: 'Listed.', conflicts: [], tags: [] }], observations);
  assert.equal(evaluation.availableEvidence.length > 0, true);
  assert.equal(taskProgressResult(evaluation).availableEvidence.length > 0, true, 'the task_progress result still tells the model what it may cite');
  const state = goalCandidate({ ...startGoal('Compare the phones in the catalog'), evaluation }, { reply: 'Model A costs 100 AUD.', observations, tools: ['fetch_url', 'task_progress'] });
  const sent = JSON.parse(goalReviewRequest(state, observations).messages[0].content);
  assert.equal(sent.evaluation.availableEvidence, undefined);
  assert.equal(sent.evaluation.items.length, 1, 'the ledger itself is still checked');
  assert.equal(goalSnapshot(state).evaluation.availableEvidence, undefined);
  assert.equal(goalSnapshot(state).evaluation.contract.category, 'products');
  assert.equal(state.evaluation.availableEvidence.length > 0, true, 'the live state keeps it');
});

test('a supplement supersedes an answer that still waits for its check', () => {
  const observations = page('p', 'The venue is Town Hall.');
  const waiting = goalCandidate(startGoal('Where is the concert?'), { reply: 'Town Hall.', observations, tools: ['fetch_url'] });
  assert.equal(waiting.phase, 'checking');
  const amended = amendGoal(waiting, 'Also tell me when the doors open.');
  assert.equal(amended.phase, 'working');
  assert.equal(amended.revision, waiting.revision + 1);
  // An amendment at any other moment leaves the phase alone.
  assert.equal(amendGoal(startGoal('Where is the concert?'), 'And when?').phase, 'working');
});

test('the check of a limit delivery reads what its writer read; a written answer is checked like any answer', () => {
  // Each fact sits past the 4 000 characters a limit delivery reads of a page.
  const long = index => `page ${index} ` + 'navigation '.repeat(500) + `FACT-${index}: the gate opens at 18:0${index}. ` + 'footer '.repeat(300);
  const observations = Array.from({ length: 3 }, (_, index) => page('p' + index, long(index))).flat();
  const base = startGoal('When does each gate open?');
  // Written at the limit from the page beginnings: writer and checker see the same text.
  const writer = JSON.parse(deliveryRequest(base, observations, 'BUDGET_EXHAUSTED').messages[0].content).observations;
  const delivered = deliveryCandidate(base, 'Confirmed: gate times.', observations, 'BUDGET_EXHAUSTED');
  const checker = JSON.parse(goalReviewRequest(delivered, observations).messages[0].content).observations;
  assert.deepEqual(checker.map(row => row.text), writer.map(row => row.text), 'the checker is shown exactly what the writer was shown');
  assert.equal(writer.map(row => row.text).join('').length <= DELIVERY_EVIDENCE_CHARS, true);
  assert.equal(delivered.writtenCandidate, undefined);
  // An answer written during the turn cites a passage deep in its pages: its check gets those passages.
  assert.doesNotMatch(checker.map(row => row.text).join('\n'), /FACT-/, 'the page beginnings do not reach the facts');
  const answer = 'Gate 1 opens at 18:01 and gate 2 opens at 18:02.';
  const waiting = goalCandidate(base, { reply: answer, observations, tools: ['fetch_url'], uncertainClaim: 'Gate 2 opens at 18:02.' });
  const handed = deliveryCandidate(waiting, answer, observations, 'BUDGET_EXHAUSTED');
  assert.equal(handed.writtenCandidate, true);
  assert.equal(handed.uncertainClaim, 'Gate 2 opens at 18:02.', 'it keeps the claim it flagged');
  const shown = JSON.parse(goalReviewRequest(handed, observations).messages[0].content).observations.map(row => row.text).join('\n');
  assert.match(shown, /FACT-1: the gate opens at 18:01/); assert.match(shown, /FACT-2: the gate opens at 18:02/);
  assert.equal(goalSnapshot(handed).writtenCandidate, undefined, 'the marker is not part of the saved record');
  // A delivery written at the limit does not inherit a claim flagged by an earlier answer.
  assert.equal(deliveryCandidate(waiting, 'Confirmed: gate times.', observations, 'BUDGET_EXHAUSTED').uncertainClaim, undefined);
  assert.equal(reviewDelivery(handed, null, observations).deliveryCheck, 'unverified');
});

test('answers in any alphabet find their passage', () => {
  const filler = 'навигация меню раздел '.repeat(120);
  const body = filler + 'Завтра в Сиднее ожидается переменная облачность, температура до девятнадцати градусов. ' + filler;
  const anchors = candidateAnchors('Завтра в Сиднее переменная облачность, до девятнадцати градусов.');
  assert.equal(anchors.has('облачность') && anchors.has('сиднее'), true);
  assert.match(evidenceExcerpt(body, 1000, anchors).text, /переменная облачность/);
  // A Spanish word is one anchor, not the part before its first accent.
  assert.equal(candidateAnchors('La información según la previsión').has('información'), true);
  // Greek, Arabic and Thai (written without spaces, so matched as pairs like Chinese).
  assert.equal(candidateAnchors('Αύριο συννεφιά στο Σίδνεϊ').has('συννεφιά'), true);
  assert.equal(candidateAnchors('الطقس غدا غائم جزئيا').has('جزئيا'), true);
  assert.equal(candidateAnchors('พรุ่งนี้มีเมฆบางส่วน').has('พร'), true);
  // What worked before still works the same.
  const before = candidateAnchors('Tomorrow 明天多云 19 degrees');
  assert.deepEqual([...before].sort(), ['19', 'degrees', 'tomorrow', '多云', '天多', '明天'].sort());
});

test('a result that arrives at the deadline is recorded before the turn stops', () => {
  let state = startTurn({ runId: 'r', turnId: 't', allowedTools: ['file_write'], now: 0, limits: { timeoutMs: 1000 }, hostToolSchemas: true });
  const step = (type, fields, now) => { state = advanceTurn(state, { type, runId: 'r', turnId: 't', ...fields }, now); };
  step('request', {}, 10);
  step('calls', { calls: [{ id: 'w', name: 'file_write', arguments: { path: 'a', content: 'x' }, effect: 'write', fingerprint: 'write-a' }] }, 20);
  step('result', { callId: 'w', ok: true }, 1000);
  assert.equal(state.status, 'blocked'); assert.equal(state.reason, 'DEADLINE_EXCEEDED');
  assert.deepEqual(state.successfulEffects, ['write-a'], 'the write that finished in the last moment is known to have happened');
  assert.deepEqual(state.successfulTools, ['file_write']);
  // Anything else at the deadline still just stops the turn, and a closed turn takes no further events.
  let late = startTurn({ runId: 'r', turnId: 't', allowedTools: ['file_write'], now: 0, limits: { timeoutMs: 1000 } });
  late = advanceTurn(late, { type: 'request', runId: 'r', turnId: 't' }, 1000);
  assert.equal(late.reason, 'DEADLINE_EXCEEDED');
  assert.throws(() => advanceTurn(state, { type: 'request', runId: 'r', turnId: 't' }, 1001), { code: 'TURN_CLOSED' });
  assert.equal(goalOperation({ action: 'snapshot', state: startGoal('x') }).version, 1);
});

test('a stop reply says why in words, in every language, and never hides a code it does not know', async () => {
  const { turnStopReply } = await import('./turn.js');
  const { RUNTIME_MESSAGES, runtimeMessage } = await import('./runtimeMessages.js');
  assert.equal(turnStopReply('REPEATED_TOOL_FAILURE', '', 'zh'), '本轮已停止（工具连续几轮失败）。已有操作和回执已保留，尚未确认任务完成；请调整目标或补充信息后继续。');
  for (const code of ['REPEATED_TOOL_FAILURE', 'REPEATED_DEVICE_FAILURE', 'NO_PROGRESS', 'DEADLINE_EXCEEDED', 'GOAL_CHECK_LIMIT', 'GOAL_CHECK_TOOLS', 'UNEXPECTED_HOSTED_CALL', 'MISSING_TOOL_EVIDENCE', 'TASK_EVALUATION_LIMIT', 'TOKEN_LIMIT', 'BUDGET_EXHAUSTED', 'CANCELLED', undefined])
    for (const locale of ['zh', 'en', 'ja', 'ko', 'es']) assert.doesNotMatch(turnStopReply(code, '', locale), /[A-Z]{3,}_[A-Z_]+|LOOP_STOPPED|undefined/, `${code} ${locale}`);
  assert.match(turnStopReply('SOME_NEW_REASON', '', 'zh'), /SOME_NEW_REASON/, 'an unknown code is shown rather than dropped');
  // The total-token budget has a label like the other three limits.
  for (const reason of ['deadline', 'input_tokens', 'tool_calls', 'total_tokens']) for (const locale of ['zh', 'en', 'ja', 'ko', 'es']) assert.notEqual(runtimeMessage('value.budget_' + reason, locale), 'value.budget_' + reason);
  // Every row of the table has all five languages.
  assert.deepEqual(Object.entries(RUNTIME_MESSAGES).filter(([, row]) => ['zh', 'en', 'ja', 'ko', 'es'].some(locale => typeof row[locale] !== 'string' || !row[locale])).map(([id]) => id), []);
});
