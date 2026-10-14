import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { runChatAgentExecutionGraph } from './chatExecutionRunner.js';
import { createRequestContext } from '../../runtime/requestContext.js';
import { runWithRequestContext } from '../../runtime/requestScope.js';
import { registerTool, unregisterTool } from '../../tools/registryCore.js';
import { resolvePermission } from '../../tools/permissions.js';

const fn = (id, query, name = 'fixture_lookup') => ({ type: 'function_call', id: `item-${id}`,
  call_id: id, name, arguments: JSON.stringify({ query }), status: 'completed' });
const reasoning = id => ({ type: 'reasoning', id, summary: [], encrypted_content: 'opaque-fixture' });
const done = output => `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'fixture-response', model: 'fixture-model', status: 'completed', output } })}\n\n`;
const message = { type: 'message', role: 'assistant', id: 'answer', status: 'completed', content: [{ type: 'output_text', text: '核对完成。', annotations: [] }] };

async function harness(t, respond) {
  const home = await mkdtemp(join(tmpdir(), 'melo-main-functions-'));
  const requests = [], events = [], executions = [], permissions = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push({ path: req.url, body });
    res.setHeader('content-type', 'text/event-stream');
    res.end(respond(requests.length));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  registerTool({ id: 'fixture_lookup', name: 'Fixture lookup', description: 'Read the requested fixture entry.',
    parametersSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    requiresPermission: true, isConcurrencySafe: true,
    run: async args => { executions.push(args.query); return { ok: true, output: `found ${args.query}` }; } });
  t.after(async () => { unregisterTool('fixture_lookup'); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(home, { recursive: true, force: true }); });
  const config = { authMode: 'api-key', apiProtocol: 'responses', apiKey: 'fixture-key', model: 'fixture-model',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, activeLlmProfileId: 'fixture', conversationModelSelected: true };
  const text = '请调用工具读取本地代码并核对其中的内容';
  const chat = { id: 'fixture-chat', title: 'Fixture', mode: 'chat', agentId: 'main', projectId: null,
    messages: [{ id: 'user-1', role: 'user', content: text, createdAt: new Date().toISOString() }], sessionMemory: [] };
  const state = { projects: [], chats: [chat], tasks: [], approvals: [], artifacts: [], commandRuns: [], externalConnectors: [],
    agentProfiles: { main: { id: 'main', name: 'Fixture', model: 'fixture-model', tools: [], skills: [], channels: {}, identity: '', soulMd: '' } },
    projectAgentOverrides: {}, settings: { selectedChatId: chat.id, selectedAgentId: 'main', activeMode: 'chat', promptHistory: [] } };
  const context = Object.freeze({ ...createRequestContext({ home, chatId: chat.id, config,
    env: { MELO_MOCK_RESPONSE: '', MELO_DIAGNOSTICS_RECORD: '0', MELO_FUNCTION_CALLING: '', MELO_PROMPT_DEBUG: '0' } }),
    turnBinding: { role: 'main', project: null, taskId: null } });
  const run = signal => runWithRequestContext(context, () => runChatAgentExecutionGraph({ context, config, state, chat, signal,
    workspace: { rootPath: home, exists: false, entries: [], filePaths: [], fileCount: 0, commandTemplates: [], commandRuns: [] },
    connectors: [], skills: [], latestUserMessage: text, agentId: 'main', _dependencies: { getEmbedding: async () => null },
    sseEmitter(type, event) {
      events.push({ type, event });
      if (type === 'tool_permission') {
        permissions.push(event);
        void resolvePermission(event.requestId, event.args?.query !== 'B');
      }
    },
  }));
  return { requests, events, executions, permissions, run };
}

test('main chat sends native definitions, authorizes valid calls and returns all outputs across three real HTTP turns', async t => {
  const h = await harness(t, round => done(round === 1
    ? [reasoning('rs-1'), fn('a', 'A'), fn('b', 'B'), fn('bad', 9), fn('hidden', 'secret', 'not_in_role')]
    : round === 2 ? [reasoning('rs-2'), fn('c', 'C')] : [message]));
  const result = await h.run();
  assert.equal(result.normalizedReply.content, '核对完成。');
  assert.deepEqual(h.executions, ['A', 'C']);
  assert.equal(h.permissions.length, 3, 'invalid/unknown calls never reach the authorization gate');
  assert.equal(new Set(h.permissions.map(p => p.requestId)).size, 3);
  assert.equal(h.requests.length, 3);
  assert.ok(h.requests.every(r => r.path === '/v1/responses' && r.body.tools.some(t => t.name === 'fixture_lookup' && t.strict)));
  const input = h.requests[2].body.input;
  const outputs = input.filter(i => i.type === 'function_call_output');
  assert.deepEqual(outputs.map(i => i.call_id), ['a', 'b', 'bad', 'hidden', 'c']);
  assert.equal(JSON.parse(outputs[1].output).ok, false);
  assert.equal(JSON.parse(outputs[2].output).error, 'INVALID_TOOL_ARGUMENTS');
  assert.equal(JSON.parse(outputs[3].output).error, 'UNKNOWN_TOOL');
  assert.deepEqual(input.filter(i => i.type === 'reasoning').map(i => i.id), ['rs-1', 'rs-2']);
  assert.equal(JSON.stringify(h.requests).includes('<tool_result'), false);
  assert.ok(h.events.some(e => e.type === 'execution_event' && e.event.status === 'completed' && e.event.name === 'fixture_lookup'));
  assert.equal(result.normalizedReply.content.includes('opaque-fixture'), false);
});

test('main chat never executes calls from a truncated stream or a cancelled turn', async t => {
  const h = await harness(t, () => `data: ${JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: fn('a', 'A') })}\n\n`);
  await assert.rejects(h.run(), /completion|complete/i);
  assert.equal(h.executions.length, 0); assert.equal(h.permissions.length, 0);
  const requests = h.requests.length;
  await assert.rejects(h.run(AbortSignal.abort()), /abort/i);
  assert.equal(h.requests.length, requests, 'cancelled turn performs no model request');
  assert.equal(h.executions.length, 0); assert.equal(h.permissions.length, 0);
});
