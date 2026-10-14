import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createTurnPresentation, receiveTurnPresentation, turnLabel, chatStreamError } from './turnPresentation.js';

test('transport acceptance is waiting, not evidence that generation has started', () => {
  const turn = createTurnPresentation('turn-1');
  receiveTurnPresentation(turn, 'started', { requestId: 'turn-1', runId: 'run-1' });
  assert.equal(turnLabel(turn), '已提交 · 等待响应');
  receiveTurnPresentation(turn, 'delta', { turnRequestId: 'turn-1' });
  assert.equal(turnLabel(turn), '正在回复');
  receiveTurnPresentation(turn, 'done', { requestId: 'other' });
  assert.equal(turn.phase, 'replying');
});

test('approval identity never replaces the chat request identity', () => {
  const turn = createTurnPresentation('turn-1');
  receiveTurnPresentation(turn, 'tool_permission', { requestId: 'approval-9', turnRequestId: 'turn-1', runId: 'run-1' });
  assert.equal(turn.requestId, 'turn-1');
  assert.equal(turn.runId, 'run-1');
  assert.equal(turnLabel(turn), '等待你的确认');
  receiveTurnPresentation(turn, 'tool_calls_done', { turnRequestId: 'turn-1' });
  assert.equal(turnLabel(turn), '正在思考');
});

const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const streamSource = app.slice(app.indexOf('function parseEventStreamBlock('), app.indexOf('async function loadBootstrap('));
function stream(body) {
  const context = vm.createContext({
    TextDecoder, DOMException, chatStreamError,
    fetch: async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
  });
  vm.runInContext(streamSource, context);
  return context.streamApi('/test');
}

test('SSE disconnect without done is not treated as a successful reply', async () => {
  await assert.rejects(stream('event: delta\ndata: {"delta":"partial"}\n\n'), { code: 'STREAM_INTERRUPTED' });
});

test('SSE cancellation and interruption preserve backend execution semantics', async () => {
  await assert.rejects(stream('event: aborted\ndata: {}\n\n'), { name: 'AbortError' });
  await assert.rejects(stream('event: error\ndata: {"code":"REQUEST_INTERRUPTED","runId":"run-1"}\n\n'), error => error.code === 'REQUEST_INTERRUPTED' && error.runId === 'run-1');
  const payload = await stream('event: done\ndata: {"replayed":true,"runId":"run-1"}\n\n');
  assert.equal(payload.replayed, true);
});
