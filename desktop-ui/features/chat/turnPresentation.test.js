import test from 'node:test';
import assert from 'node:assert/strict';
import { createTurnPresentation, receiveTurnPresentation, turnLabel } from './turnPresentation.js';
import { streamApi } from './api.js';

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
  // 2026-11-10: a prompt the server closed (its own request id, like the prompt) ends the waiting
  // phase; one closed for another turn, or closed when the turn is not waiting, changes nothing.
  for (const [opened, closed] of [['tool_permission', 'tool_permission_closed'], ['capability_request', 'capability_request_closed']]) {
    receiveTurnPresentation(turn, opened, { requestId: 'approval-10', turnRequestId: 'turn-1' });
    receiveTurnPresentation(turn, closed, { requestId: 'approval-10', reason: 'timeout', turnRequestId: 'turn-2' });
    assert.equal(turnLabel(turn), '等待你的确认');
    receiveTurnPresentation(turn, closed, { requestId: 'approval-10', reason: 'timeout' });
    assert.equal(turnLabel(turn), '正在思考', closed);
    assert.equal(turn.requestId, 'turn-1');
  }
  receiveTurnPresentation(turn, 'delta', { turnRequestId: 'turn-1' });
  receiveTurnPresentation(turn, 'tool_permission_closed', { requestId: 'approval-10' });
  assert.equal(turnLabel(turn), '正在回复');
});

// The chat SSE client (features/chat/api.js, moved out of app.js in P2c) with
// a stubbed fetch.
async function stream(body) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  try {
    return await streamApi('/test');
  } finally {
    globalThis.fetch = realFetch;
  }
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

// 2026-11-10 agent audit: the delivery check has its own phase while it runs.
test('a running delivery check is shown as checking and ends with its verdict', async () => {
  const { createTurnPresentation, receiveTurnPresentation, turnLabel } = await import('./turnPresentation.js');
  const turn = createTurnPresentation('request-1');
  receiveTurnPresentation(turn, 'started', {});
  receiveTurnPresentation(turn, 'delta', {});
  assert.equal(turnLabel(turn), '正在回复');
  receiveTurnPresentation(turn, 'execution_event', { kind: 'pipeline', id: 'goal-check:1', status: 'running' });
  assert.equal(turn.phase, 'checking'); assert.equal(turnLabel(turn), '正在核对回答');
  // Other stages and operations do not change the phase.
  receiveTurnPresentation(turn, 'execution_event', { kind: 'pipeline', id: 'model:2', status: 'running' });
  receiveTurnPresentation(turn, 'execution_event', { kind: 'operation', id: 'goal-check:1', status: 'completed' });
  assert.equal(turn.phase, 'checking');
  receiveTurnPresentation(turn, 'execution_event', { kind: 'pipeline', id: 'goal-check:1', status: 'completed' });
  assert.equal(turn.phase, 'thinking');
  // A verdict that arrives when the turn is in another phase leaves that phase alone.
  receiveTurnPresentation(turn, 'tool_calls_start', {});
  receiveTurnPresentation(turn, 'execution_event', { kind: 'pipeline', id: 'goal-check:2', status: 'failed' });
  assert.equal(turn.phase, 'tools');
  // A waiting approval and running tools still take precedence in the label.
  receiveTurnPresentation(turn, 'execution_event', { kind: 'pipeline', id: 'goal-check:3', status: 'running' });
  assert.equal(turnLabel(turn, { permission: true }), '等待你的确认');
  // An event of another turn is ignored.
  receiveTurnPresentation(turn, 'execution_event', { kind: 'pipeline', id: 'goal-check:3', status: 'completed', turnRequestId: 'request-2' });
  assert.equal(turn.phase, 'checking');
});
