import test from 'node:test';
import assert from 'node:assert/strict';
import { planRequest } from './search.js';
import { startGoal, goalCandidate, goalReviewRequest, reviewGoal, goalSnapshot } from './goal.js';
import { completionResult, completionObservation } from './completion.js';
import { evaluate } from './index.js';
import { executionScene, executionContext } from './execution.js';
import { getRequestNetworkPolicy, requestUrls } from './retrieval/requestPolicy.js';

test('routing suggestions never require executing a device action for feedback', () => {
  const plan = planRequest({ text: '明明已经开始了导航，你这里还在一直找', capabilities: { grants: ['phone_use'], executors: ['phone_use'] } });
  assert.deepEqual(plan.requiredTools, []);
  assert.deepEqual(plan.toolDependencies, {});
});

test('review can deliver feedback using conversation evidence without inventing an action', () => {
  const state = goalCandidate(startGoal('为什么已经导航了还一直找'), {
    reply: '应在验证导航开始后停止设备操作。', roundsLeft: 8, tools: ['phone_use'],
    observations: [{ id: 'read', type: 'tool', name: 'read_history', ok: true, executed: true, output: 'Navigation had started.' }],
    context: { messages: [{ role: 'user', content: '导航已经开始' }], capabilities: [{ name: 'phone_use' }], skills: [{ id: 'maps' }] },
  });
  const request = JSON.parse(goalReviewRequest(state).messages[0].content);
  assert.equal(request.context.messages[0].content, '导航已经开始');
  assert.equal(request.context.skills[0].id, 'maps');
  const checked = reviewGoal(state, JSON.stringify({ decision: 'complete', turnKind: 'feedback', reasonType: 'fulfilled', requirements: [{ text: '说明停止条件', kind: 'response', status: 'met', evidenceIds: [] }] }));
  assert.equal(checked.decision, 'complete');
  const result = completionResult({ goal: state.original, reply: state.candidate, task: goalSnapshot(checked) });
  assert.equal(result.outcome, 'completed'); assert.equal(result.kind, 'answer');
});

test('response evidence cannot certify external effects or fresh facts', () => {
  for (const kind of ['external_effect', 'external_fact']) {
    const checked = reviewGoal(startGoal('导航到目的地'), JSON.stringify({ decision: 'complete', turnKind: 'feedback', requirements: [{ text: '已经开始导航', kind, status: 'met', evidenceIds: [] }] }));
    assert.equal(checked.decision, 'partial');
  }
  const checked = reviewGoal(startGoal('导航到目的地'), JSON.stringify({ decision: 'complete', turnKind: 'task', requirements: [{ text: '已经开始导航', kind: 'response', status: 'met', evidenceIds: [] }] }));
  assert.equal(checked.decision, 'partial');
});

test('atomic phone capability advertises the actual tool and has portable effect semantics', () => {
  const plan = planRequest({ text: '打开音乐', capabilities: { grants: ['phone_action'], executors: ['phone_action'] } });
  assert.ok(plan.availableTools.includes('phone_action'));
  assert.ok(!plan.availableTools.includes('phone_use'));
  assert.ok(!plan.instructions.includes('phone_use'));
  for (const [action, effect] of [['observe', 'read'], ['tap', 'write'], ['finish', 'read']]) {
    assert.equal(evaluate({ version: 1, op: 'toolEffect', name: 'phone_action', arguments: { action } }).value, effect);
  }
  assert.equal(evaluate({ version: 1, op: 'validateTool', name: 'phone_action', arguments: { action: 'observe', include_screenshot: 'yes' } }).ok, false);
  assert.equal(evaluate({ version: 1, op: 'validateTool', name: 'phone_action', arguments: { action: 'type_text', screen_id: 'current', node_id: 'editor', text: '' } }).ok, true);
});

test('large UI trees cannot truncate the native proof out of the completion check', () => {
  const data = { nodes: 'large untrusted tree'.repeat(500), status: 'achieved', verification: 'visible_facts', package_name: 'fixture.app' };
  const rows = completionObservation({ id: 'finish', name: 'phone_action', arguments: { action: 'finish', visible_text: 'Navigation active', expected_package: 'fixture.app' }, ok: true, executed: true, data, output: JSON.stringify(data) });
  const request = goalReviewRequest(startGoal('Navigate Home'), rows);
  const body = JSON.parse(request.messages[0].content).observations[0].text;
  assert.match(body, /visible_facts/);
  assert.match(body, /Navigation active/);
});

test('prohibiting a specific UI action does not revoke unrelated capabilities', () => {
  const capabilities = { grants: ['phone_action', 'web_search', 'fetch_url'], executors: ['phone_action', 'web_search', 'fetch_url'] };
  const config = { search: { backend: 'http', endpoint: 'https://search.fixture.invalid' } };
  for (const text of [
    '在当前测试页面导航到 Home，确认开始后停止；不要打开路线详情，也不要关闭导航。',
    'Open the music app and find the song. Do not open an advertisement or play the song.',
    '搜索 brunch 的资料，不要打开 Google Maps。',
  ]) {
    const plan = planRequest({ text, capabilities, config });
    for (const name of ['phone_action', 'web_search', 'fetch_url']) assert.ok(plan.availableTools.includes(name), `${text}: ${name}`);
  }
  const denied = planRequest({ text: '搜索 brunch，不要操作手机', capabilities, config });
  assert.ok(!denied.availableTools.includes('phone_action'));
  assert.ok(denied.availableTools.includes('web_search'));
});

test('explicit URL access prohibitions remain enforced independently of app-action restrictions', () => {
  for (const text of [
    '不要打开 https://example.com ，只解释结构',
    'Do not open https://example.com; explain the URL.',
    '不要访问这个网址 https://example.com',
  ]) {
    assert.equal(getRequestNetworkPolicy(text).fetchForbidden, true, text);
    assert.deepEqual(requestUrls(text), [], text);
  }
  for (const text of ['搜索 brunch，不要打开 Google Maps。', 'Do not open an advertisement. Search for brunch online.']) {
    assert.equal(getRequestNetworkPolicy(text).fetchForbidden, false, text);
  }
});

test('failed attempts explain unavailability but never certify a met requirement', () => {
  const rows = completionObservation({ id: 'blocked-read', name: 'phone_action', ok: false, executed: true, data: { code: 'permission_denied' } });
  for (const status of ['unavailable', 'missing', 'met']) {
    const report = { decision: 'partial', requirements: [{ text: 'Read current page', status, evidenceIds: ['blocked-read'] }] };
    const checked = reviewGoal(startGoal('Read current page'), JSON.stringify(report), rows);
    assert.equal(checked.reason, status === 'met' ? 'GOAL_EVIDENCE_INVALID' : 'GOAL_UNAVAILABLE');
  }
});

test('UI fact projection preserves page query after verbose Chrome node metadata', () => {
  const data = { nodes: [{ text: 'Address', geometry: 'x'.repeat(8000) }, { text: 'Result detail' }, { text: 'new query' }], verification: 'visible_facts' };
  const rows = completionObservation({ id: 'read', name: 'phone_action', ok: true, executed: true, data, output: JSON.stringify(data).slice(0, 4000) });
  assert.match(JSON.parse(goalReviewRequest(startGoal('Read query'), rows).messages[0].content).observations[0].text, /new query/);
});

test('portable scenes and historical context never contain native screen payloads', () => {
  const input = JSON.stringify({ action: 'type_text', text: 'private-input-marker', screen_id: 'private-screen-id' });
  const result = { ok: true, package_name: 'fixture.app', nodes: [{ text: 'private-screen-marker' }], applied_effects: [{ input: 'private-input-marker' }] };
  let scene = executionScene({ action: 'create', runId: 'one', chatId: 'chat', at: 'now' });
  scene = executionScene({ action: 'event', scene, event: { id: 'call', name: 'phone_action', kind: 'operation', input, output: JSON.stringify(result), result, status: 'completed' } });
  assert.doesNotMatch(JSON.stringify(scene), /private-(?:input|screen)-marker|private-screen-id/);
  assert.match(JSON.stringify(scene), /fixture.app/);
  const old = { ...scene, operations: [{ id: 'old', name: 'phone_action', status: 'completed', input, output: JSON.stringify(result) }] };
  assert.doesNotMatch(executionContext([old]), /private-(?:input|screen)-marker|private-screen-id/);
});

test('respected constraints need no new action but cannot substitute for a requested effect', () => {
  const rows = completionObservation({ id: 'navigation', name: 'phone_action', ok: true, executed: true, data: { status: 'achieved', verification: 'visible_facts' } });
  const constraint = { text: 'Do not look up a real address', kind: 'constraint', status: 'met', evidenceIds: [] };
  const check = requirements => reviewGoal(startGoal('Navigate saved Home without address lookup'), JSON.stringify({ decision: 'complete', turnKind: 'task', requirements }), rows);
  assert.equal(check([constraint]).reason, 'GOAL_COVERAGE_MISSING');
  const response = { text: 'Report the result to the user', kind: 'response', status: 'met', evidenceIds: [] };
  assert.equal(check([constraint, response]).reason, 'GOAL_COVERAGE_MISSING');
  const checked = check([{ text: 'Start navigation', kind: 'external_effect', status: 'met', evidenceIds: ['navigation'] }, constraint, response]);
  assert.equal(checked.decision, 'complete');
  assert.equal(completionResult({ goal: 'Navigate Home', reply: 'Navigation started', observations: rows, task: goalSnapshot(checked) }).outcome, 'completed');
});
