import test from 'node:test';
import assert from 'node:assert/strict';
import { startTurn, advanceTurn } from './turn.js';
import { evaluateJSON } from './index.js';
import { completionReceipt, completionSummary } from './completion.js';
import { createCoreTurn } from '../../src/runtime/sharedAgentCore.js';

// 2026-11-10 agent audit, second pass.

// After a completion check sends an answer back, or once work was assigned, the reducer refuses a call
// that already succeeded in the turn. That is right for a write. It also refused "run the tests again"
// after the code was fixed, because a shell command has an unknown effect and was treated like a write.
function turn(tools = ['run_command', 'file_write', 'mcp:mail:send', 'file_read']) {
  let state = startTurn({ runId: 'r', turnId: 't', allowedTools: tools, now: 0, hostToolSchemas: true }), tick = 0;
  const step = (type, fields = {}) => { state = advanceTurn(state, { type, runId: 'r', turnId: 't', ...fields }, ++tick); return state; };
  const run = (calls, ok = true) => { step('request'); step('calls', { calls }); const permitted = [...state.permitted], rejections = { ...state.rejections }; for (const call of calls) step('result', { callId: call.id, ok }); return { permitted, rejections }; };
  const correct = () => { step('request'); step('feedback', { repair: true }); };
  return { step, run, correct, get state() { return state; } };
}
const command = (id, text = 'npm test') => ({ id, name: 'run_command', arguments: { command: text }, effect: 'unknown' });
const write = (id, content = 'one') => ({ id, name: 'file_write', arguments: { path: 'a.txt', content }, effect: 'write' });

test('after a correction a command may run again once something else has changed', () => {
  const t = turn();
  t.run([command('first')]);
  t.correct();
  assert.equal(t.run([command('again-at-once')]).rejections['again-at-once'], 'ALREADY_EXECUTED', 'nothing changed in between: the earlier result still stands');
  assert.deepEqual(t.run([write('fix')]).permitted, ['fix']);
  assert.deepEqual(t.run([command('after-fix')]).permitted, ['after-fix'], 'fix the code, run the tests again');
  assert.equal(t.run([command('thrice')]).rejections.thrice, 'ALREADY_EXECUTED', 'and again only after the next change');
});

test('a completed write, an extension tool and a member\'s command are never repeated', () => {
  const t = turn();
  const mail = id => ({ id, name: 'mcp:mail:send', arguments: { to: 'a@fixture.invalid' }, effect: 'unknown' });
  t.run([write('w1')]); t.run([mail('m1')]); t.run([command('c1')]);
  t.correct();
  t.run([write('other', 'two')]);
  const replay = t.run([write('w2'), mail('m2')]);
  assert.equal(replay.rejections.w2, 'ALREADY_EXECUTED');
  assert.equal(replay.rejections.m2, 'ALREADY_EXECUTED', 'an extension tool\'s effect cannot be told');
  // A command a member ran is not the lead's own to repeat, whatever happened since.
  const lead = turn();
  lead.step('request'); lead.step('feedback', { internalRouting: true, successfulEffects: ['member-ran-tests'] });
  lead.run([write('lead-write')]);
  assert.equal(lead.run([{ ...command('lead-run'), fingerprint: 'member-ran-tests' }]).rejections['lead-run'], 'ALREADY_EXECUTED');
  // The lead's own command becomes a member's once a member reports the same fingerprint.
  const both = turn();
  both.run([{ ...command('own'), fingerprint: 'shared-run' }]);
  both.step('request'); both.step('feedback', { internalRouting: true, successfulEffects: ['shared-run'] });
  both.run([write('change')]);
  assert.equal(both.run([{ ...command('own-again'), fingerprint: 'shared-run' }]).rejections['own-again'], 'ALREADY_EXECUTED');
});

test('a read is never recorded as an effect, and the desktop bridge asks the tool what a call does', () => {
  const listing = { id: 'run_command', effectFor: args => /^(ls|git status)\b/u.test(args?.command || '') ? 'read' : 'unknown' };
  const core = createCoreTurn({ goal: 'fix the build', tools: [listing, { id: 'file_write' }], allowedTools: ['run_command', 'file_write'] });
  const run = calls => { core.update('request'); core.update('calls', { calls }); const permitted = calls.filter(call => core.permits(call.id)).map(call => call.id); core.results(calls.map(call => ({ call, result: { ok: true, output: 'ok' } }))); return permitted; };
  const call = (id, text) => ({ id, name: 'run_command', arguments: { command: text } });
  run([call('ls-1', 'ls src'), call('test-1', 'npm test')]);
  core.update('request'); core.update('feedback', { repair: true });
  assert.deepEqual(run([call('ls-2', 'ls src'), call('test-2', 'npm test')]), ['ls-2'], 'a listing repeats freely; the test run does not until something changed');
  const refusal = core.rejectionResult('test-2');
  assert.equal(refusal.error, 'ALREADY_EXECUTED');
  assert.match(refusal.output, /^Tool request rejected by the shared loop policy: ALREADY_EXECUTED\. This exact operation already succeeded/u, 'the model is told what happened and what to do');
  assert.deepEqual(run([{ id: 'edit', name: 'file_write', arguments: { path: 'a.js', content: 'fixed' } }]), ['edit']);
  assert.deepEqual(run([call('test-3', 'npm test')]), ['test-3']);
});

test('only an answer that still waits for its check counts as written', () => {
  const core = createCoreTurn({ goal: '读取目录并总结', tools: [{ id: 'file_read' }], allowedTools: ['file_read'] });
  assert.equal(core.pendingCandidate, '');
  core.update('request');
  assert.equal(core.candidate('目录里有三个文件。'), true);
  assert.equal(core.pendingCandidate, '目录里有三个文件。');
  core.update('feedback'); core.update('request');
  core.review(JSON.stringify({ decision: 'continue', reasonType: 'lookup_missing', reason: '没有读取目录', nextStep: '读取目录', requirements: [{ text: '目录', kind: 'external_fact', status: 'missing', evidenceIds: [] }] }));
  assert.equal(core.pendingCandidate, '', 'an answer the check sent back is no longer a pending answer');
  assert.equal(core.candidateReply, '目录里有三个文件。');
});

test('half a surrogate pair never leaves the core', () => {
  // The answer limit cuts between the two halves of the emoji; the half used to be written as an escape
  // that the iPhone's JSON parser rejects, and the whole operation's result was lost.
  const reply = 'a'.repeat(23999) + '🌧 rain';
  const state = JSON.parse(evaluateJSON(JSON.stringify({ version: 1, op: 'goal', action: 'start', goal: '明天的天气', id: 'g' }))).value;
  const out = evaluateJSON(JSON.stringify({ version: 1, op: 'goal', action: 'candidate', state, candidate: { reply, tools: ['web_search'] }, observations: [] }));
  assert.doesNotMatch(out, /\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f][0-9a-f]{2})/iu, 'no unpaired high half');
  assert.doesNotMatch(out, /(?<!\\ud[89ab][0-9a-f]{2})\\ud[c-f][0-9a-f]{2}/iu, 'no unpaired low half');
  const value = JSON.parse(out).value;
  assert.equal(value.candidate.length, 24000);
  assert.equal(value.candidate.endsWith('�'), true, 'the half is replaced, the rest is kept');
  // A whole emoji is untouched.
  const whole = JSON.parse(evaluateJSON(JSON.stringify({ version: 1, op: 'goal', action: 'candidate', state, candidate: { reply: '🌧 rain', tools: ['web_search'] }, observations: [] }))).value;
  assert.equal(whole.candidate, '🌧 rain');
});

test('a delivered answer whose check gave no verdict is unverified, not blocked', () => {
  const task = reason => ({ decision: 'partial', reason, requirements: [] });
  for (const reason of ['GOAL_CHECK_UNAVAILABLE', 'GOAL_CHECK_INVALID', 'GOAL_CHECK_TRUNCATED', 'GOAL_CHECK_CONTEXT', 'GOAL_EVIDENCE_INVALID']) {
    const receipt = completionReceipt({ goal: '整理这份笔记', kind: 'answer', reply: '整理好了。', task: task(reason) });
    assert.equal(receipt.outcome, 'unverified', reason);
    assert.equal(receipt.reason, reason);
    assert.match(completionSummary(receipt, '整理这份笔记', 'zh'), /^回答已保留/u);
  }
  // With a tool run it used to read "partial", without one "blocked".
  const ran = [{ id: 'read', type: 'tool', name: 'file_read', ok: true, executed: true, output: 'notes' }];
  assert.equal(completionReceipt({ goal: '整理这份笔记', reply: '整理好了。', observations: ran, task: task('GOAL_CHECK_UNAVAILABLE') }).outcome, 'unverified');
  // A check that did judge the answer keeps its verdict.
  assert.equal(completionReceipt({ goal: '整理这份笔记', reply: '整理好了。', observations: ran, task: task('GOAL_COVERAGE_MISSING') }).outcome, 'partial');
  assert.equal(completionReceipt({ goal: '整理这份笔记', reply: '整理好了。', task: task('GOAL_CORRECTION_LIMIT') }).outcome, 'blocked');
  // No answer at all is still not a delivery.
  assert.equal(completionReceipt({ goal: '整理这份笔记', reply: '', task: task('GOAL_CHECK_UNAVAILABLE') }).outcome, 'blocked');
});
