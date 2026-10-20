import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionEvents, sessionContext } from './sessionEvents.js';

const scene = () => ({ version: 1, runId: 'r', chatId: 'c', status: 'cancelled',
  startedAt: '2026-10-20T00:00:00Z', finishedAt: '2026-10-20T00:00:03Z',
  pipeline: [{ id: 'model:0', model: 'provider-a', status: 'completed' }],
  operations: [{ id: '0:a', name: 'file_write', status: 'completed' },
    { id: '1:a', name: 'send_message', status: 'cancelled' }],
  toolCalls: [{ iteration: 0, callId: 'a', toolId: 'file_write', status: 'ok', argsHash: 'abcdef1234567890' }] });

test('stable IDs distinguish turns, model providers and repeated call IDs across iterations', () => {
  const data = scene(), events = sessionEvents(data);
  assert.equal(new Set(events.map(event => event.eventId)).size, events.length);
  assert.equal(events.find(event => event.operationId === '0:a').resultState, 'returned');
  assert.equal(events.find(event => event.operationId === '1:a').resultState, 'unknown');
  assert.ok(events.some(event => event.eventId === 'r/model/model%3A0/finished'));
  assert.deepEqual(sessionEvents(JSON.parse(JSON.stringify(data))), events);
  data.pipeline[0].model = 'provider-b';
  assert.deepEqual(sessionEvents(data).map(event => event.eventId), events.map(event => event.eventId));
  data.runId = 'another';
  assert.ok(sessionEvents(data).every(event => !events.some(old => old.eventId === event.eventId)));
});

test('unknown interrupted effects stay unknown; explicit pre-execution refusals remain distinguishable', () => {
  const data = scene();
  data.toolCalls.push({ iteration: 1, callId: 'refused', toolId: 'file_write', status: 'error', executed: false, code: 'PERMISSION_DENIED' });
  data.toolCalls.push({ iteration: 1, callId: 'failed', toolId: 'send_message', status: 'error', executed: true, code: 'TIMEOUT' });
  const events = sessionEvents(data);
  assert.equal(events.find(event => event.operationId === '1:refused').resultState, 'not_executed');
  assert.equal(events.find(event => event.operationId === '1:failed').resultState, 'error_returned');
  const context = sessionContext([data]);
  assert.match(context, /never blindly repeat/);
  for (const event of events) assert.ok(context.includes(event.eventId));
});

test('member scopes prevent provider-generated call IDs colliding in the parent run', () => {
  const data = scene();
  data.toolCalls.push(...['member-a', 'member-b'].map(scopeId => ({ scopeId, iteration: 0, callId: 'a', toolId: 'web_search', status: 'ok' })));
  const ids = sessionEvents(data).filter(event => event.kind === 'tool').map(event => event.operationId);
  assert.ok(ids.includes('member-a:0:a')); assert.ok(ids.includes('member-b:0:a'));
});

test('canonical event allowlist excludes credentials, raw content, reasoning and replay instructions', () => {
  const data = scene();
  data.query = 'SECRET_QUESTION';
  data.operations[0].input = 'Bearer SECRET_AUTH';
  data.operations[0].output = '{"password":"SECRET_PASSWORD"}';
  data.operations[0].result = { token: 'SECRET_TOKEN' };
  data.pipeline.push({ id: 'model:0:summary', channel: 'reasoning-summary', status: 'completed', output: 'SECRET_REASONING' });
  data.toolCalls[0].argsRedacted = { url: 'https://example.com?token=SECRET_URL' };
  data.toolCalls[0].modelFacingOutput = 'SECRET_MODEL';
  const context = sessionContext([data]);
  assert.doesNotMatch(context, /SECRET_/);
  assert.match(context, /abcdef1234567890/);
  assert.deepEqual(sessionEvents({ ...data, runId: '../bad path' }), []);
});

test('bounded history keeps valid JSON and explicitly reports omitted events', () => {
  const data = scene();
  data.operations = Array.from({ length: 160 }, (_, n) => ({ id: `op-${n}`, name: 'file_write', status: 'interrupted' }));
  const text = sessionContext([data, { ...data, runId: 'r2' }, { ...data, runId: 'r3' }]);
  assert.ok(text.length < 16000);
  const rows = JSON.parse(text.slice(text.indexOf('\n') + 1));
  assert.ok(rows.every(row => row.omittedEvents > 0));
  assert.ok(rows.every(row => row.events.at(-1).kind === 'terminal'));
  assert.equal(sessionContext([]), '');
});
