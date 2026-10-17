// Desktop half of the cross-platform behaviour contract. The same fixture runs
// in ios/Tests/SharedContractTests.swift; both must pass for the two clients
// to extract links, key sources and replay tool calls identically.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractTextUrls } from '../src/media/textUrls.js';
import { sceneSourceUrl } from '../src/shared/executionScene.js';
import { createFunctionCallingSession } from '../src/tools/functionCalling.js';
import { buildCodexResponsesInput } from '../src/openai.js';

const contract = JSON.parse(readFileSync(new URL('../shared/protocol/contracts.json', import.meta.url), 'utf8'));

test('prose URL extraction matches the shared contract', () => {
  assert.ok(contract.proseUrls.length >= 10);
  for (const { text, urls } of contract.proseUrls) assert.deepEqual(extractTextUrls(text), urls, text);
});

test('source identity keys match the shared contract', () => {
  assert.ok(contract.sourceIdentity.length >= 20);
  for (const { url, identity } of contract.sourceIdentity) assert.equal(sceneSourceUrl(url), identity, url);
});

test('tool-call replay appends output items verbatim, then one output per call in order', async () => {
  const { output, results } = contract.toolLoopReplay;
  const session = createFunctionCallingSession({ authMode: 'codex' }, [{ id: 'lookup', description: 'fixture', parametersSchema: { type: 'object', properties: {} }, run: async () => ({ ok: true, output: '' }) }]);
  assert.equal(session.native, true);
  const turn = session.parse({ protocol: 'responses', text: '', responseItems: output });
  const prior = [{ role: 'user', content: '问题' }];
  const messages = session.append(prior, turn, results.map(r => ({ call: { id: r.call_id }, result: { ok: true, output: r.output } })));
  const input = await buildCodexResponsesInput(messages);
  const tail = input.slice(input.length - output.length - results.length);
  assert.deepEqual(tail.slice(0, output.length), output);
  const outputs = tail.slice(output.length);
  assert.deepEqual(outputs.map(item => [item.type, item.call_id, typeof item.output]), results.map(r => ['function_call_output', r.call_id, 'string']));
});

test('team handoff parsing matches the shared contract', async () => {
  const { createHandoff } = await import('../src/agents/handoff.js');
  assert.ok(contract.teamHandoff.length >= 6);
  for (const { task, output, ok, expected } of contract.teamHandoff) {
    const h = createHandoff(task, { ok, output }, null);
    assert.deepEqual({ conclusion: h.conclusion, evidence: h.evidence, changedFiles: h.changedFiles, unfinished: h.unfinished, status: h.status, review: h.review }, expected, output.slice(0, 60));
  }
});

test('team plan validation matches the shared contract', async () => {
  const { validateTeamPlan } = await import('../src/agents/team.js');
  for (const row of contract.teamPlans) {
    if (row.error) { assert.throws(() => validateTeamPlan(row.plan), undefined, JSON.stringify(row.plan)); continue; }
    const plan = validateTeamPlan(row.plan);
    assert.deepEqual([plan.mode, plan.members], [row.mode, row.members]);
  }
});

test('team execution order, inputs and acceptance match the shared contract', async () => {
  const { runAgentTeam } = await import('../src/testSupport/directAgentFixture.js');
  const marker = '前序交接记录（需要独立核对）：\n';
  for (const row of contract.teamSchedule) {
    const calls = [], rounds = {};
    const team = await runAgentTeam({ plan: row.plan, task: 't', config: {}, run: async ({ roleId, instructions }) => {
      const round = rounds[roleId] = (rounds[roleId] || 0) + 1;
      calls.push({ member: roleId, round, prior: instructions.startsWith(marker) ? JSON.parse(instructions.slice(marker.length)).map(h => h.conclusion) : [] });
      const reviewer = row.plan.templateId === 'review-loop' && roleId === row.plan.members[1];
      return { ok: true, output: JSON.stringify({ conclusion: `${roleId} r${round}`, evidence: [], changedFiles: [], unfinished: [], ...(reviewer ? { review: row.approveRound && round >= row.approveRound ? 'approve' : 'revise' } : {}) }) };
    } });
    const key = call => `${call.member}${call.round}:${call.prior.join('|')}`;
    const prefix = row.parallelPrefix;
    assert.deepEqual(calls.slice(0, prefix).map(key).sort(), row.calls.slice(0, prefix).map(key).sort(), JSON.stringify(row.plan));
    assert.deepEqual(calls.slice(prefix).map(key), row.calls.slice(prefix).map(key), JSON.stringify(row.plan));
    assert.deepEqual([team.accepted, team.ok], [row.accepted, row.ok]);
  }
});

test('compact sync fixture validates on the wire and the phone-side history rule yields the turns after the boundary', async () => {
  const { portableValue, validateWorkspace } = await import('./workspaceProtocol.js');
  const { conversation, messages, expectedInputIds, summaryContains } = contract.compactSync;
  const value = portableValue('conversation', conversation);
  assert.equal(value.compact.boundaryMessageId, 'm4');
  assert.equal(value.compact.compactedCount, 4);
  assert.ok(value.compact.summary.includes(summaryContains));
  assert.equal(value.compact.cards.length, 1);
  const workspace = validateWorkspace({ version: 1, records: [{ kind: 'conversation', id: 'long-chat', versions: [{ clock: { desktop: 1 }, value: conversation }] }] });
  assert.deepEqual(workspace.records[0].versions[0].value.compact, value.compact);
  // Same rule as ConversationHistory.recentTurns(afterMessageId:) on iOS.
  const boundary = messages.findLastIndex(m => m.id === value.compact.boundaryMessageId);
  assert.deepEqual(messages.slice(boundary + 1).map(m => m.id), expectedInputIds);
  assert.equal(messages.findLastIndex(m => m.id === 'missing'), -1, 'an unknown boundary keeps the full history');
});
