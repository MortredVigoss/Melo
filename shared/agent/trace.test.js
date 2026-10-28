import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from './index.js';
const op = (action, fields = {}) => evaluate({ version: 1, op: 'trace', action, ...fields });
test('shared Core creates an explicit local trace instead of reconstructing UI records', () => {
  const result = op('create', { context: { traceId: 'trace-1', runId: 'run-1', scopeId: 'chat' }, now: 10 });
  assert.equal(result.ok, true); assert.equal(result.value.trace.sequence, 0);
});

import { traceOperation, traceSnapshot, tracedStart, tracedAdvance } from './trace.js';
import { startTurn, advanceTurn } from './turn.js';
test('traced reducer preserves the exact execution decision and pairs rejected calls', () => {
  const options = { runId: 'run', turnId: 'turn', now: 1, allowedTools: ['web_search'] };
  let plain = startTurn(options), traced = tracedStart(options);
  assert.deepEqual(traced.state, plain);
  const request = { runId: 'run', turnId: 'turn', type: 'request' };
  plain = advanceTurn(plain, request, 2); traced = tracedAdvance(traced.state, request, 2); assert.deepEqual(traced.state, plain);
  const event = { runId: 'run', turnId: 'turn', type: 'calls', calls: [{ id: 'a', name: 'web_search', arguments: { query: 'weather' } }, { id: 'b', name: 'not_allowed', arguments: {} }] };
  plain = advanceTurn(plain, event, 3); traced = tracedAdvance(traced.state, event, 3); assert.deepEqual(traced.state, plain);
  assert.equal(traced.events.filter(row => row.type === 'tool.requested').length, 2);
  assert.equal(traced.events.find(row => row.type === 'tool.rejected').data.callId, 'b');
});
test('snapshots redact structured and encoded secrets, omit media and hidden reasoning but retain actual schemas', () => {
  const input = { apiKey: 'private-key-value', arguments: JSON.stringify({ token: 'secret-token-value' }), content: [{ type: 'input_image', image_url: 'https://private/image' }, { type: 'thinking', thinking: 'private-thought' }, { type: 'reasoning', summary: [{ type: 'summary_text', text: 'public summary' }], encrypted_content: 'secret-reasoning' }], tools: [{ name: 'web_search', parameters: { type: 'object' } }], url: 'https://example.org/?%61pi_key=secret-url' };
  const snap = traceSnapshot(input);
  for (const secret of ['private-key-value', 'secret-token-value', 'private-thought', 'secret-reasoning', 'secret-url']) assert.equal(snap.json.includes(secret), false);
  assert.equal(snap.json.includes('public summary'), true); assert.equal(snap.json.includes('web_search'), true); assert.equal(snap.mediaOmitted, true);
});
test('one root sequence links child scopes; closing a child does not close its parent', () => {
  let trace = op('create', { context: { traceId: 'trace', runId: 'parent' }, now: 0 }).value.trace;
  let result = traceOperation({ action: 'append', trace, context: { traceId: 'trace', runId: 'child', parentRunId: 'parent', parentSpanId: 'tool:1' }, now: 1, event: { type: 'run.finished', data: { outcome: 'blocked' } } });
  assert.equal(result.trace.closed, false); assert.equal(result.record.parentRunId, 'parent'); assert.equal(result.record.sequence, 1);
  result = traceOperation({ action: 'append', trace: result.trace, now: 2, event: { type: 'run.finished', data: { outcome: 'partial' } } });
  assert.equal(result.trace.closed, true); assert.equal(result.record.sequence, 2);
  assert.equal(traceOperation({ action: 'append', trace: result.trace, now: 3, event: { type: 'tool.result' } }).record, null);
});
test('event quota marks truncation and preserves the root terminal without changing loop budgets', () => {
  let trace = op('create', { context: { traceId: 'trace', runId: 'run' }, maxEvents: 1, now: 0 }).value.trace;
  for (let now = 1; now <= 2; now++) { const result = traceOperation({ action: 'append', trace, now, event: { type: 'loop.transition' } }); trace = result.trace; if (now === 2) assert.equal(result.record.type, 'trace.truncated'); }
  assert.equal(traceOperation({ action: 'append', trace, now: 3, event: { type: 'run.finished' } }).record.type, 'run.finished');
  assert.throws(() => traceOperation({ action: 'append', trace, now: -1, event: { type: 'model.response' } }));
});

test('credential parameter names keep their actual JSON schema while example credentials are removed', () => {
  const schema = { tools: [{ name: 'fixture', parameters: { type: 'object', properties: { apiKey: { type: 'string', default: 'private-default-value' }, query: { type: 'string' } }, required: ['apiKey'] } }] };
  const safe = traceSnapshot(schema); const parsed = JSON.parse(safe.json);
  assert.equal(parsed.tools[0].parameters.properties.apiKey.type, 'string');
  assert.equal(parsed.tools[0].parameters.properties.apiKey.default, '[redacted]');
  assert.equal(safe.json.includes('private-default-value'), false);
});
