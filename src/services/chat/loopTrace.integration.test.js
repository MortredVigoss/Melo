import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { readLocalTrace } from '../../runtime/loopTrace.js';

test('production desktop Loop writes real HTTP payload, Tool dispatch and the exact next-request feedback locally', async t => {
  const home = await mkdtemp(join(tmpdir(), 'melo-trace-http-'));
  const previous = process.env.MELO_HOME; process.env.MELO_HOME = home;
  t.after(async () => { if (previous === undefined) delete process.env.MELO_HOME; else process.env.MELO_HOME = previous; await rm(home, { recursive: true, force: true }); });
  const { runChatAgentExecutionGraph } = await import('./chatExecutionRunner.js');
  const { bootstrapBuiltinTools, registerTool, unregisterTool } = await import('../../tools/registry.js');
  const { createOpenAICompatibleReply } = await import('../../openai.js');
  const { saveState } = await import('../../state/stateStore.js');
  bootstrapBuiltinTools(); let effects = 0;
  registerTool({ id: 'trace_local_probe', name: 'trace_local_probe', description: 'Local fixture read', effect: 'read', requiresPermission: false,
    parametersSchema: { type: 'object', properties: {}, additionalProperties: false }, run: async () => { effects++; return { ok: true, output: 'TRACE_FEEDBACK_MARKER' }; } });
  t.after(() => unregisterTool('trace_local_probe'));
  const bodies = [];
  const server = createServer(async (req, res) => {
    let data = ''; for await (const chunk of req) data += chunk;
    const body = JSON.parse(data); bodies.push(body);
    const tools = body.tools || []; const messages = body.messages || [];
    const checking = JSON.stringify(messages).includes("You are Melo's task completion checker");
    const hasResult = messages.some(row => row.role === 'tool');
    const content = checking ? JSON.stringify({ decision: 'complete', reasonType: 'fulfilled', reason: 'fixture receipt read', nextStep: '', requirements: [{ text: 'Read fixture', status: 'met', evidenceIds: ['fixture-read'] }] }) : '读取完成 TRACE_FEEDBACK_MARKER';
    const message = !checking && !hasResult && tools.some(tool => tool.function?.name === 'trace_local_probe')
      ? { role: 'assistant', content: null, tool_calls: [{ id: 'fixture-read', type: 'function', function: { name: 'trace_local_probe', arguments: '{}' } }] }
      : { role: 'assistant', content };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'local-response', model: 'fixture-model', choices: [{ finish_reason: message.tool_calls ? 'tool_calls' : 'stop', message }], usage: { prompt_tokens: 100, completion_tokens: 10 } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const chat = { id: 'trace-chat', title: 'Trace fixture', mode: 'chat', projectId: null, agentId: 'main', messages: [{ id: 'user', role: 'user', content: '读取本地测试资料' }], sessionMemory: [] };
  const state = { projects: [], chats: [chat], tasks: [], approvals: [], artifacts: [], commandRuns: [], externalConnectors: [], projectAgentOverrides: {},
    agentProfiles: { main: { id: 'main', name: 'main', model: 'fixture-model', identity: '', soulMd: '', tools: ['local-command','external-connectors'], skills: [], channels: {} } }, settings: { selectedProjectId: null, selectedChatId: chat.id, selectedAgentId: 'main', activeMode: 'chat', promptHistory: [] } };
  await saveState(state);
  const result = await runChatAgentExecutionGraph({ home, config: { authMode: 'unset', apiKey: '', baseUrl: '', apiProtocol: 'chat-completions', toolCalling: 'native', model: 'fixture-model' }, state, chat,
    workspace: { rootPath: join(home, 'workspace'), exists: false, entries: [], filePaths: [], fileCount: 0, selectedFile: null, commandTemplates: [], commandRuns: [] }, connectors: [], skills: [], latestUserMessage: '读取本地测试资料', agentId: 'main',
    _dependencies: { getEmbedding: async () => null, createReply: options => createOpenAICompatibleReply({ ...options, stream: false, authMode: 'api-key', apiKey: 'sk-local-fixture-secret-only', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiProtocol: 'chat-completions' }) } });
  assert.equal(effects, 1); assert.ok(result.normalizedReply);
  const ids = await readdir(join(home, 'traces')); assert.equal(ids.length, 1);
  const directory = join(home, 'traces', ids[0]); const trace = await readLocalTrace(directory); assert.equal(trace.complete, true, JSON.stringify(trace.errors));
  const eventTypes = trace.events.map(row => row.type);
  for (const type of ['loop.transition','tool.requested','tool.admitted','tool.dispatch.started','tool.result','tool.feedback.appended','model.provider.payload','run.finished']) assert.ok(eventTypes.includes(type), type);
  const wire = [];
  for (const row of trace.events) if (row.type === 'model.provider.payload') wire.push(JSON.parse(await readFile(join(directory, row.data.contentRef), 'utf8')));
  assert.equal(wire.length, bodies.length);
  const feedback = wire.find(body => body.messages?.some(message => message.role === 'tool'));
  assert.ok(feedback.messages.some(message => message.role === 'tool' && message.content.includes('TRACE_FEEDBACK_MARKER')));
  assert.ok(wire[0].tools.some(tool => tool.function?.name === 'trace_local_probe'));
  for (const file of await readdir(join(directory, 'artifacts'))) assert.equal((await readFile(join(directory,'artifacts',file),'utf8')).includes('sk-local-fixture-secret-only'), false);
});
