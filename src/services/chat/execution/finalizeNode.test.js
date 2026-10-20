// Unit tests for the finalize graph node in isolation (architecture B2-5).
// Before B2 this node was a closure inside runChatAgentExecutionGraph and
// could only be reached by running the whole turn; as a factory over the
// turn object it takes a fake turn and a graphState directly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { GRAPH_END } from '../../../agentGraph.js';
import { createFinalizeNode } from './finalizeNode.js';

function harness(overrides = {}) {
  const events = [];
  const turn = {
    background: false,
    config: {},
    createReply: async () => { throw new Error('finalize must not call the model without an uncertainty marker'); },
    env: {},
    isRemoteChannel: false,
    latestUserMessage: 'hi',
    modelOverrides: {},
    modelResponses: [],
    signal: undefined,
    sseEmitter: (type, value) => events.push({ type, value }),
    ...overrides,
  };
  return { finalize: createFinalizeNode(turn), events, turn };
}
const base = extra => ({ reply: 'Hello there.', intent: 'chat', activeAgentProfile: { model: '' }, ...extra });

test('finalize: a plain reply becomes the normalized reply, emits format start/end and the final reply_text', async () => {
  const { finalize, events } = harness();
  const out = await finalize(base({ memoryUsage: [{ id: 'm1' }] }));
  assert.equal(out.next, GRAPH_END);
  assert.equal(out.verificationRecord, null);
  assert.equal(out.normalizedReply.content, 'Hello there.');
  assert.equal(out.normalizedReply.viz, null);
  assert.deepEqual(out.normalizedReply.citations, []);
  assert.deepEqual(out.normalizedReply.memoryUsage, [{ id: 'm1' }]);
  assert.equal('modelResponses' in out.normalizedReply, false, 'no receipts → no modelResponses / usage keys');
  assert.deepEqual(events.map(e => [e.type, e.value.id ?? null, e.value.status ?? null]), [
    ['execution_event', 'reply:format', 'running'],
    ['execution_event', 'reply:format', 'completed'],
    ['reply_text', null, null],
  ]);
  assert.deepEqual(events.at(-1).value, { text: 'Hello there.', final: true });
});

test('finalize: a blank model reply is replaced by the channel-appropriate fallback', async () => {
  const desktop = await harness().finalize(base({ reply: '   ' }));
  assert.match(desktop.normalizedReply.content, /wasn't able to generate a response/);
  const remote = await harness({ isRemoteChannel: true, background: true }).finalize(base({ reply: '' }));
  assert.match(remote.normalizedReply.content, /could not generate a response/);
  assert.deepEqual(remote.normalizedReply.citations, [], 'remote channels never carry citation pins');
});

test('finalize: an aborted request throws its reason and never emits the final reply_text', async () => {
  const controller = new AbortController();
  const reason = new Error('user stopped');
  controller.abort(reason);
  const { finalize, events } = harness({ signal: controller.signal });
  await assert.rejects(() => finalize(base()), error => error === reason);
  assert.equal(events.some(e => e.type === 'reply_text'), false);
});

test('finalize: provider receipts are attached with priced usage; empty tool results are not', async () => {
  const receipts = [{ model: 'gpt-4', usage: { input_tokens: 10, output_tokens: 5 } }];
  const { finalize } = harness({ modelResponses: receipts });
  const out = await finalize(base({ toolResults: [], team: { id: 't' }, toolChain: { turns: 1 }, promptDiagnostics: { historyWindow: 4 } }));
  assert.equal(out.normalizedReply.modelResponses, receipts, 'the same receipts array the turn collected');
  assert.ok(out.normalizedReply.usage, 'usage is summarized from the receipts');
  assert.equal('toolResults' in out.normalizedReply, false, 'an empty toolResults array is not attached');
  assert.deepEqual(out.normalizedReply.team, { id: 't' });
  assert.deepEqual(out.normalizedReply.toolChain, { turns: 1 });
  assert.deepEqual(out.normalizedReply.promptDiagnostics, { historyWindow: 4 });
  const withTools = await harness().finalize(base({ toolResults: [{ id: 'r1' }] }));
  assert.deepEqual(withTools.normalizedReply.toolResults, [{ id: 'r1' }]);
});

test('finalize: completionForReply receives the reply text before normalization', async () => {
  let seen;
  const out = await harness().finalize(base({ reply: 'Done.', completionForReply: text => { seen = text; return { status: 'complete' }; } }));
  assert.equal(seen, 'Done.');
  assert.deepEqual(out.normalizedReply.completion, { status: 'complete' });
});
