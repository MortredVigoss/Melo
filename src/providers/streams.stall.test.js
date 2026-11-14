// A provider that keeps the connection open and sends nothing must end the
// request as "the stream stalled". Until 2026-11-14 it did not: the watchdog
// cancelled the reader, the cancelled read was fulfilled with `done: true`,
// and the reader left through its normal exit. The caller then got a
// different error, or, for a request without tools on the Responses
// transport, the text received so far as if it were the finished reply.
//
// These tests feed the real exported readers a stream that goes silent.

import test from 'node:test';
import assert from 'node:assert/strict';

import { readCodexSseResponse, readChatCompletionsSseResponse } from './streams.js';
import { formatProviderFailureMessage } from '../services/chat/providerErrors.js';

const encoder = new TextEncoder();
const STALLED = /stopped producing output[\s\S]*stream stalled/;

// A body that sends `blocks` and then stays open without sending anything.
// `cancelled` records that the reader gave the connection back.
function silentAfter(blocks) {
  const state = { cancelled: false };
  const body = new ReadableStream({
    start(controller) {
      for (const block of blocks) controller.enqueue(encoder.encode(block));
    },
    cancel() { state.cancelled = true; },
  });
  return { response: { body }, state };
}

// A body that sends one block every `everyMs` and then closes.
function paced(blocks, everyMs) {
  let index = 0;
  const body = new ReadableStream({
    async pull(controller) {
      if (index >= blocks.length) { controller.close(); return; }
      await new Promise(resolve => setTimeout(resolve, everyMs));
      controller.enqueue(encoder.encode(blocks[index]));
      index += 1;
    },
  });
  return { body };
}

// The watchdog timer is unref'd, so a test that only waits for it would let
// the process exit with the promise pending. Hold the loop open ourselves.
async function withLoopHeldOpen(run) {
  const hold = setInterval(() => {}, 20);
  try { return await run(); } finally { clearInterval(hold); }
}

const responsesDelta = text => `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\n`;
const responsesCompleted = text => `data: ${JSON.stringify({
  type: 'response.completed',
  response: { id: 'r1', model: 'm', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] },
})}\n\n`;
const chatDelta = text => `data: ${JSON.stringify({ id: 'c1', model: 'm', choices: [{ index: 0, delta: { content: text } }] })}\n\n`;
const chatStop = () => `data: ${JSON.stringify({ id: 'c1', model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`;

test('Responses stream that goes silent after some text: the stall error, not the partial text as a reply', async () => {
  const { response, state } = silentAfter([responsesDelta('The answer is forty')]);
  const seen = [];
  await withLoopHeldOpen(() => assert.rejects(
    readCodexSseResponse(response, { idleTimeoutMs: 120, onDelta: ({ text }) => seen.push(text) }),
    STALLED,
  ));
  assert.deepEqual(seen, ['The answer is forty'], 'the text that did arrive was streamed');
  assert.equal(state.cancelled, true, 'the connection is given back');
});

test('Responses stream that is silent from the start, with tools: the stall error', async () => {
  const { response } = silentAfter([]);
  await withLoopHeldOpen(() => assert.rejects(
    readCodexSseResponse(response, { idleTimeoutMs: 120, returnToolResponse: true }),
    STALLED,
  ));
});

test('chat-completions stream that goes silent: the stall error, with and without tools', async () => {
  for (const returnToolResponse of [false, true]) {
    const { response } = silentAfter([chatDelta('half an ans')]);
    await withLoopHeldOpen(() => assert.rejects(
      readChatCompletionsSseResponse(response, { idleTimeoutMs: 120, returnToolResponse }),
      STALLED,
      `returnToolResponse=${returnToolResponse}`,
    ));
  }
});

test('the stall error is the one the chat turns into "stopped responding midway"', async () => {
  const { response } = silentAfter([chatDelta('x')]);
  let error;
  await withLoopHeldOpen(async () => {
    try { await readChatCompletionsSseResponse(response, { idleTimeoutMs: 120 }); } catch (caught) { error = caught; }
  });
  assert.ok(error);
  const shown = formatProviderFailureMessage(error);
  assert.doesNotMatch(shown, /ended before a completion event/);
  assert.match(shown, /stopped responding midway|中途停止/);
});

test('a stream that pauses for less than the limit and then completes is returned in full', async () => {
  const response = paced([responsesDelta('one '), responsesDelta('two'), responsesCompleted('one two')], 60);
  const text = await withLoopHeldOpen(() => readCodexSseResponse(response, { idleTimeoutMs: 400 }));
  assert.equal(text, 'one two');
});

test('a slow consumer is not a stalled provider: time spent in the delta callback does not count', async () => {
  // The whole reply is already in the body; only Melo's own callback is slow
  // (three times the idle limit). The clock must not run during it.
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(chatDelta('slow ')));
      controller.enqueue(encoder.encode(chatDelta('consumer')));
      controller.enqueue(encoder.encode(chatStop()));
      controller.close();
    },
  });
  let calls = 0;
  const text = await withLoopHeldOpen(() => readChatCompletionsSseResponse({ body }, {
    idleTimeoutMs: 100,
    onDelta: async () => { calls += 1; await new Promise(resolve => setTimeout(resolve, 300)); },
  }));
  assert.equal(text, 'slow consumer');
  assert.equal(calls, 2);
});
