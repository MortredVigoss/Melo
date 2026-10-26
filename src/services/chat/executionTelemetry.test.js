// This fixture asserts Chinese copy explicitly; production defaults follow the device.
import { setLanguage as setFixtureLanguage } from '../../../desktop-ui/i18n.js';
setFixtureLanguage('zh-CN');
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCodexSseResponse, readChatCompletionsSseResponse } from '../../providers/streams.js';
import { requestAnthropicReply } from '../../providers/anthropic.js';
import { observeModelReplies } from './executionPipeline.js';
import { createExecutionRecorder, readExecutionScene } from './executionScenes.js';
import { executionMetadata } from '../../shared/executionMetadata.js';
import { renderExecutionDetail, renderExecutionSignal, renderReasoningRecords } from '../../../desktop-ui/executionDetails.js';

const response = events => {
  const bytes = new TextEncoder().encode(events.map(e => `data: ${JSON.stringify(e)}\r\n\r\n`).join(''));
  return new Response(new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7)); c.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
};
const summary = (id, parts) => ({ id, type: 'reasoning', encrypted_content: 'ENCRYPTED', summary: parts.map(text => ({ type: 'summary_text', text })) });
const usage = { input_tokens: 1234, output_tokens: 250, total_tokens: 1484, input_tokens_details: { cached_tokens: 1000 }, output_tokens_details: { reasoning_tokens: 120 } };
const events = () => [
  { type: 'response.created', response: { id: 'resp-1', model: 'returned-model', status: 'in_progress' } },
  { type: 'response.reasoning_text.delta', delta: 'PRIVATE' },
  { type: 'response.reasoning_summary_text.delta', item_id: 'rs-1', output_index: 0, summary_index: 0, sequence_number: 1, delta: '核对' },
  { type: 'response.reasoning_summary_text.delta', item_id: 'rs-1', output_index: 0, summary_index: 0, sequence_number: 1, delta: '核对' },
  { type: 'response.reasoning_summary_text.done', item_id: 'rs-1', output_index: 0, summary_index: 0, text: '核对条件' },
  { type: 'response.reasoning_summary_part.done', item_id: 'rs-1', output_index: 0, summary_index: 1, part: { type: 'summary_text', text: '比较证据' } },
  { type: 'response.output_text.delta', delta: 'ANSWER' },
  { type: 'response.completed', response: { id: 'resp-1', model: 'returned-model', status: 'completed', usage,
    output: [summary('rs-1', ['核对条件', '比较证据']), summary('rs-2', ['形成结论 api_key=SECRET']), { type: 'message', content: [{ type: 'output_text', text: 'ANSWER' }] }] } },
];

test('fragmented SSE, multi-part summaries and API receipts survive sidecar reload without replaying requests', async () => {
  const home = await mkdtemp(join(tmpdir(), 'melo-telemetry-'));
  try {
    const recorder = createExecutionRecorder({ home, chatId: 'c', runId: 'telemetry' }, '测试');
    let calls = 0;
    const call = observeModelReplies(async options => { calls++; return readCodexSseResponse(response(events()), options); }, (_, event) => recorder.event(event));
    assert.equal(await call({ model: 'requested-model', onDelta() {} }), 'ANSWER');
    await recorder.finish('completed', { id: 'answer', content: 'ANSWER' });
    const saved = await readExecutionScene(home, 'telemetry');
    assert.equal(calls, 1);
    const model = saved.pipeline[0], reasoning = saved.pipeline[1];
    assert.equal(model.api.responseId, 'resp-1'); assert.equal(model.api.reportedModel, 'returned-model');
    assert.deepEqual(model.api.usage, { input: 1234, output: 250, total: 1484, cached: 1000, reasoning: 120 });
    assert.ok(model.api.firstEventMs <= model.api.durationMs); assert.ok(model.api.firstTextMs <= model.api.durationMs);
    assert.equal(reasoning.output, '核对条件\n\n比较证据\n\n形成结论 api_key=[redacted]');
    assert.equal(reasoning.api.summaryParts, 3);
    assert.equal(saved.operations.length, 0);
    assert.doesNotMatch(JSON.stringify(saved), /PRIVATE|ENCRYPTED|SECRET|ANSWER/);
    const html = renderExecutionDetail(model, '已完成');
    assert.match(html, /缓存命中 token/); assert.match(html, /推理 token/); assert.match(html, /1,234/);
    assert.match(renderExecutionSignal(saved), /历史回看/);
    assert.match(renderReasoningRecords(saved, {}), /比较证据/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('missing usage is unknown, raw payload fields are excluded and invalid counts are discarded', () => {
  assert.deepEqual(executionMetadata({ usage: { output_tokens: 0, input_tokens: -1 }, headers: { authorization: 'SECRET' }, output: 'PRIVATE', responseId: '<script>' }), { usage: { output: 0 } });
  assert.deepEqual(executionMetadata({ usage: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 20, cache_creation_input_tokens: 5 } }).usage, { input: 35, output: 3, cached: 20, cacheWrite: 5 });
  const html = renderExecutionDetail({ name: '<script>', api: { durationMs: 0 } }, '已完成');
  assert.match(html, /用量未返回/); assert.match(html, /0.00 s/); assert.doesNotMatch(html, /<script>|输入 token/);
});

test('provider failure preserves metadata and public summary; late callbacks cannot reopen a completed stage', async () => {
  const history = []; let callback;
  const call = observeModelReplies(async options => {
    callback = options.onModelMetadata;
    return readCodexSseResponse(response([...events().slice(0, 6), { type: 'response.failed', response: { id: 'resp-1', status: 'failed', error: { code: 'server_error', message: 'failed fixture' }, usage } }]), options);
  }, (_, event) => history.push(structuredClone(event)));
  await assert.rejects(call({ model: 'm' }), /failed fixture/);
  assert.equal(history.at(-1).status, 'failed'); assert.equal(history.at(-1).api.finishReason, 'server_error');
  assert.equal(history.at(-2).status, 'failed'); assert.equal(history.at(-2).output, '核对条件\n\n比较证据');
  const n = history.length; callback({ reportedModel: 'late' }); assert.equal(history.length, n);
});

test('summary retention is bounded and done-only summaries are shown', async () => {
  const chunks = [];
  await readCodexSseResponse(response([{ type: 'response.completed', response: { output: [summary('rs', ['a'.repeat(30000)]), { type: 'message', content: [{ type: 'output_text', text: 'done' }] }] } }]), { onReasoningDelta: c => chunks.push(c) });
  assert.equal(chunks.length, 1); assert.equal(chunks[0].text.length, 24000); assert.equal(chunks[0].truncated, true);
});

test('chat completions and Anthropic preserve real counters and stop reasons, including incomplete output', async () => {
  const chatMetadata = [];
  assert.equal(await readChatCompletionsSseResponse(response([
    { id: 'chat-1', model: 'model', choices: [{ delta: { content: 'hi' }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, completion_tokens_details: { reasoning_tokens: 0 } } },
  ]), { onModelMetadata: m => chatMetadata.push(m) }), 'hi');
  assert.equal(chatMetadata.at(-1).finishReason, 'stop'); assert.equal(executionMetadata(chatMetadata.at(-1)).usage.reasoning, 0);
  const meta = [];
  await assert.rejects(requestAnthropicReply({ baseUrl: 'https://fixture.test', model: 'm', messages: [], onDelta() {}, onModelMetadata: m => meta.push(m), fetchImpl: async () => response([
    { type: 'message_start', message: { id: 'msg-1', model: 'claude-fixture', usage: { input_tokens: 10, cache_read_input_tokens: 4 } } },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } },
    { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 8 } },
    { type: 'message_stop' },
  ]) }), /max_tokens/);
  assert.equal(meta.at(-1).finishReason, 'max_tokens'); assert.equal(meta.at(-1).usage.output_tokens, 8);
});


test('overview never pairs an earlier round summary with a later round receipt', () => {
  const scene = { status: 'running', pipeline: [
    { id: 'model:1', api: { reportedModel: 'old' } },
    { id: 'model:1:summary', channel: 'reasoning-summary', output: 'old summary', api: {} },
    { id: 'model:2', output: '等待第二轮', api: { reportedModel: 'current' } },
  ] };
  const html = renderExecutionSignal(scene);
  assert.match(html, /等待第二轮/); assert.match(html, /current/); assert.doesNotMatch(html, /old summary/);
});
