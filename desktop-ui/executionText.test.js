// This fixture asserts Chinese copy explicitly; production defaults follow the device.
import { setLanguage } from './i18n.js';
setLanguage('zh-CN');
import test from 'node:test';
import assert from 'node:assert/strict';
import { translations } from './translations.js';
import { LANGUAGES } from './i18n.js';
import { TOOL_NAMES, RUN_REASONS, CALL_OUTCOMES, MEMBER_HANDOFFS, toolName, isToolId, stageName, stageOutput, reasonText, callOutcome, callStatus, memberState } from './executionText.js';
import { createExecutionScene, applyExecutionEvent } from '../src/shared/executionScene.js';
import { bootstrapBuiltinTools, getAllTools } from '../src/tools/registry.js';

// Agent audit 2026-11-10. The scene keeps ids and codes; the screens printed
// them: `[agent:d1] web_search`, "Checking task delivery" in a Chinese
// interface, `REPEATED_TOOL_FAILURE`, and "failed" for a call that was never
// allowed to run. These tests go through the real scene reducer.

const stage = event => { const scene = createExecutionScene({ runId: 'r', requestId: 'q', chatId: 'c' }); applyExecutionEvent(scene, { kind: 'pipeline', ...event }); return scene.pipeline[0]; };
const call = event => { const scene = createExecutionScene({ runId: 'r', requestId: 'q', chatId: 'c' }); applyExecutionEvent(scene, { kind: 'operation', ...event }); return scene.operations[0]; };

test('every label is in the catalog in all five languages', () => {
  // These tables are looked up at run time, so the literal scanner (i18nCoverage) cannot see them.
  for (const [table, name] of [[TOOL_NAMES, 'tool'], [RUN_REASONS, 'reason'], [CALL_OUTCOMES, 'outcome'], [MEMBER_HANDOFFS, 'handoff']]) {
    for (const [key, source] of Object.entries(table)) for (const { id } of LANGUAGES) assert.ok(translations[source]?.[id]?.trim(), `${name} ${key} (${source}) in ${id}`);
  }
});

test('a tool is named in the interface language wherever it is shown', () => {
  assert.equal(toolName('fetch_url'), '读取网页');
  assert.equal(toolName('load_tools'), '加载工具说明');
  assert.equal(toolName('route_task'), '分派给成员');
  // A member's and a skill's call arrive with a scope prefix in the live events.
  assert.equal(toolName('[agent:d1] web_search'), '成员 · 联网搜索');
  assert.equal(toolName('[skill:report] file_read'), '技能 · 读取文件');
  // An MCP tool reads as its own name and the server it belongs to, in both encodings.
  assert.equal(toolName('mcp:melo-xiaohongshu:search_feeds'), 'search_feeds · melo-xiaohongshu');
  assert.equal(toolName('mcp__melo-xiaohongshu__search_feeds'), 'search_feeds · melo-xiaohongshu');
  assert.equal(toolName('skill:weekly-report'), '技能 · weekly-report');
  // An id without a label is shown as recorded, never dropped; nothing recorded reads "工具".
  assert.equal(toolName('some_new_tool'), 'some_new_tool');
  assert.equal(toolName(''), '工具');
  try { setLanguage('en'); assert.equal(toolName('[agent:d1] web_search'), 'Member · Web search'); assert.equal(toolName('web_screenshot'), 'Web page screenshot'); }
  finally { setLanguage('zh-CN'); }
  assert.equal(isToolId('fetch_url'), true); assert.equal(isToolId('模型请求'), false); assert.equal(isToolId('Checking task delivery'), false);
});

test('every built-in tool the model can call has a label', () => {
  // Registering a tool does not put its name on screen: this is where that is noticed.
  // `agent` is the legacy alias of delegate (never offered); a development job is named by its own stage.
  bootstrapBuiltinTools();
  assert.equal(getAllTools().length > 20, true, 'the registry is loaded');
  const unlabelled = getAllTools().map(tool => tool.id).filter(id => !Object.hasOwn(TOOL_NAMES, id) && !['agent', 'development_job'].includes(id));
  assert.deepEqual(unlabelled, [], 'add a label to TOOL_NAMES in desktop-ui/executionText.js');
});

test('a stage is named in the interface language, not by the English fallback the scene keeps', () => {
  const check = stage({ id: 'goal-check:2', module: 'compute', messageId: 'stage.delivery', status: 'running' });
  assert.equal(check.name, 'Checking task delivery', 'the scene keeps an English fallback next to the message id');
  assert.equal(stageName(check), '核对任务交付');
  const condensed = stage({ id: 'tool-chain:condense:1', module: 'compute', messageId: 'stage.condense', status: 'completed', outputMessageId: 'output.condensed' });
  assert.match(condensed.output, /[A-Za-z]/, 'and an English fallback of the output');
  assert.doesNotMatch(stageOutput(condensed), /^[A-Za-z ,.']+$/, 'shown in Chinese');
  // A member's stage keeps its actor.
  const member = stage({ id: 'job-1:goal-check:1', module: 'compute', messageId: 'stage.delivery', actorName: '检索成员', status: 'running' });
  assert.equal(stageName(member), '检索成员 · 核对任务交付');
  // A tool call is named as a tool, a stage with its own text keeps it.
  assert.equal(stageName(call({ id: '0:a', name: 'fetch_url', module: 'search', status: 'completed' })), '读取网页');
  assert.equal(stageName(stage({ id: 'internal:1', module: 'compute', name: '检索成员', status: 'running' })), '检索成员');
});

test('a stop or delivery stage says why in words, and the wrap-up at the limit is not called a check', () => {
  const stopped = stage({ id: 'core:stop', module: 'compute', messageId: 'stage.stopped', status: 'failed', output: 'REPEATED_TOOL_FAILURE' });
  assert.equal(stageName(stopped), '执行已停止');
  assert.equal(stageOutput(stopped), '工具连续几轮失败');
  const delivered = stage({ id: 'limit:delivery', module: 'compute', messageId: 'stage.delivery', status: 'completed', output: 'LIMIT_DELIVERED' });
  assert.equal(stageName(delivered), '整理已确认的内容');
  assert.equal(stageOutput(delivered), '已按上限整理并交付');
  const failedDelivery = stage({ id: 'limit:delivery', module: 'compute', messageId: 'stage.delivery', status: 'failed', output: 'BUDGET_EXHAUSTED' });
  assert.equal(stageOutput(failedDelivery), '运行预算已用完');
  const check = stage({ id: 'goal-check:1', module: 'compute', messageId: 'stage.delivery', status: 'failed', output: 'GOAL_CHECK_UNAVAILABLE' });
  assert.equal(stageOutput(check), '核验没有返回结果');
  // A code this table does not know is shown as recorded; the checker's own explanation is never touched.
  assert.equal(stageOutput(stage({ id: 'core:stop', module: 'compute', messageId: 'stage.stopped', status: 'failed', output: 'SOME_NEW_REASON' })), 'SOME_NEW_REASON');
  assert.equal(stageOutput(stage({ id: 'goal-check:1', module: 'compute', messageId: 'stage.delivery', status: 'failed', output: '价格缺少来源。' })), '价格缺少来源。');
  // Only those stages: a tool whose output happens to be a code keeps it.
  assert.equal(stageOutput(call({ id: '0:b', name: 'bash', module: 'tools', status: 'completed', output: 'ROUND_LIMIT' })), 'ROUND_LIMIT');
  assert.equal(reasonText('NO_PROGRESS'), '连续几轮没有新进展'); assert.equal(reasonText('nope'), '');
  try { setLanguage('en'); assert.equal(stageOutput(stopped), 'Tools failed several rounds in a row'); assert.equal(stageName(delivered), 'Wrapping up what is confirmed'); }
  finally { setLanguage('zh-CN'); }
});

test('a call that was refused or never ran is not shown as a failed tool', () => {
  const denied = call({ id: '0:c', name: 'file_write', module: 'files', status: 'failed', errorCode: 'PERMISSION_DENIED', output: 'User denied.' });
  assert.equal(denied.errorCode, 'PERMISSION_DENIED', 'the scene keeps the code');
  assert.equal(callOutcome(denied), '未获许可，没有执行');
  assert.equal(callStatus(denied, '失败'), '未获许可，没有执行');
  assert.equal(callOutcome(call({ id: '0:d', name: 'web_search', module: 'search', status: 'failed', errorCode: 'BUDGET_EXHAUSTED' })), '运行预算已用完');
  assert.equal(callOutcome(call({ id: '0:e', name: 'bash', module: 'tools', status: 'failed', errorCode: 'TOOL_TIMEOUT' })), '执行超时');
  // The live pill carries the code of calls the host answered itself.
  assert.equal(callOutcome({ status: 'error', errorCode: 'ALREADY_EXECUTED' }), '已经执行过，没有重复');
  assert.equal(callOutcome({ status: 'error', errorCode: 'CAPABILITY_DENIED' }), '能力没有开启，没有执行');
  // A tool that ran and failed, a running one and a finished one keep their ordinary state.
  const broken = call({ id: '0:f', name: 'bash', module: 'tools', status: 'failed', errorCode: 'TOOL_FAILED' });
  assert.equal(callOutcome(broken), ''); assert.equal(callStatus(broken, '失败'), '失败');
  assert.equal(callOutcome({ status: 'completed', errorCode: 'PERMISSION_DENIED' }), '');
  assert.equal(callOutcome({ status: 'running' }), '');
});

test('a member row says what its hand-off recorded; without that record it keeps the stage state', () => {
  assert.equal(memberState({ running: true, handoff: 'partial' }, '已中断'), '进行中');
  assert.equal(memberState({ handoff: 'observed' }, '完成'), '已交回');
  assert.equal(memberState({ handoff: 'unverified' }, '已中断'), '已交回 · 没有核实到内容');
  assert.equal(memberState({ handoff: 'partial' }, '已中断'), '没做完 · 已交回');
  assert.equal(memberState({ status: 'interrupted' }, '已中断'), '已中断', 'a scene recorded before the field keeps what it showed');
  assert.equal(memberState({ handoff: 'constructor' }, '已中断'), '已中断');
});

test('the list of recorded events names calls and states, and says when a call did not run', async () => {
  const { sessionEventLine } = await import('./executionDetails.js');
  assert.equal(sessionEventLine({ kind: 'tool', name: 'fetch_url', status: 'failed', resultState: 'not_executed', code: 'PERMISSION_DENIED' }), '读取网页 · 未获许可，没有执行');
  assert.equal(sessionEventLine({ kind: 'tool', name: 'bash', status: 'failed', resultState: 'not_executed' }), '运行命令 · 没有执行');
  assert.equal(sessionEventLine({ kind: 'tool', name: 'bash', status: 'failed', resultState: 'unknown' }), '运行命令 · 失败 · 结果未知，请先核对再继续');
  assert.equal(sessionEventLine({ kind: 'tool', name: 'web_search', status: 'completed', resultState: 'returned' }), '联网搜索 · 已完成');
  assert.equal(sessionEventLine({ kind: 'model', name: undefined, status: 'running' }), '模型请求 · 执行中');
  assert.equal(sessionEventLine({ kind: 'turn', status: 'running' }), '本轮 · 执行中');
  assert.equal(sessionEventLine({ kind: 'terminal', status: 'interrupted' }), '结束 · 已中断');
  try { setLanguage('en'); assert.equal(sessionEventLine({ kind: 'tool', name: 'bash', status: 'failed', resultState: 'not_executed' }), 'Run commands · Did not run'); }
  finally { setLanguage('zh-CN'); }
});
