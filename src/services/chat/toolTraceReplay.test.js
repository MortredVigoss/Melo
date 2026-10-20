// Tool-trace replay (design audit D2): a cancelled turn leaves a plain-text
// `[工具轨迹]` assistant message in the chat, and the next turn's model
// request history carries it (so "继续" can pick up where the tools left off).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ORIGINAL_HOME = process.env.MELO_HOME, ORIGINAL_MOCK = process.env.MELO_MOCK_RESPONSE;
const TEST_HOME = mkdtempSync(join(tmpdir(), 'melo-tool-trace-'));
process.env.MELO_HOME = TEST_HOME;
process.env.MELO_TEST_MODE = '1';
mkdirSync(join(TEST_HOME, 'desktop'), { recursive: true });
mkdirSync(join(TEST_HOME, 'workspaces', 'chats', 'trace-chat', 'notes'), { recursive: true });
writeFileSync(join(TEST_HOME, 'workspaces', 'chats', 'trace-chat', 'notes', 'plan.md'), '# Plan\n1. ship D2\n');
writeFileSync(join(TEST_HOME, 'desktop', 'state.json'), JSON.stringify({
  projects: [], tasks: [], approvals: [], artifacts: [], commandRuns: [], externalConnectors: [], externalToolRuns: [],
  chats: [{ id: 'trace-chat', title: 'trace', mode: 'chat', projectId: null, agentId: 'main', messages: [], sessionMemory: [] }],
  agentProfiles: { main: { id: 'main', name: 'main', model: 'gpt-4', identity: '', soulMd: '', tools: ['local-files'], skills: [], channels: {} } },
  projectAgentOverrides: {},
  settings: { selectedProjectId: null, selectedChatId: 'trace-chat', selectedAgentId: 'main', selectedConnectorId: null, selectedFilePath: null, activeMode: 'chat', promptHistory: [], enabledConnectorIds: [], enabledSkillIds: [], customSkills: [] },
}));

const { sendChatMessage } = await import('./sendChatMessage.js');
const { runChatAgentExecutionGraph } = await import('./chatExecutionRunner.js');
const { loadState } = await import('../../state/stateStore.js');
const { buildModelMessagesFromChat } = await import('./messageBuilder.js');
const { readToolInvocationRecords } = await import('../../tools/toolInvocationRecord.js');
const { buildToolTraceText, TOOL_TRACE_PREFIX } = await import('./toolTraceReplay.js');
const { bootstrapBuiltinTools } = await import('../../tools/registry.js');
bootstrapBuiltinTools();

after(() => {
  try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
  if (ORIGINAL_HOME === undefined) delete process.env.MELO_HOME; else process.env.MELO_HOME = ORIGINAL_HOME;
  if (ORIGINAL_MOCK === undefined) delete process.env.MELO_MOCK_RESPONSE; else process.env.MELO_MOCK_RESPONSE = ORIGINAL_MOCK;
});

test('buildToolTraceText: oldest first, ≤600 chars, "…等 N 次" when cut, empty when nothing ran', () => {
  assert.equal(buildToolTraceText([]), '');
  const record = (i, status = 'ok') => ({ toolId: 'file_read', argsRedacted: { path: `dir/${'f'.repeat(30)}-${i}.md` }, resultEnvelope: { ok: status === 'ok', status, ...(status === 'error' ? { code: 'NOT_FOUND' } : {}) } });
  const short = buildToolTraceText([record(1), record(2, 'error')], { status: 'cancelled' });
  assert.ok(short.startsWith(`${TOOL_TRACE_PREFIX} 本轮已取消`));
  assert.match(short, /1\. file_read\(path=dir\/f+-1\.md\) ✓/);
  assert.match(short, /2\. file_read\(path=dir\/f+-2\.md\) ✗ NOT_FOUND/);
  const long = buildToolTraceText(Array.from({ length: 40 }, (_, i) => record(i)), { status: 'failed' });
  assert.ok(long.length <= 600, `trace must stay within 600 chars, got ${long.length}`);
  assert.match(long, /…等 \d+ 次$/);
  assert.match(long, /1\. file_read/);
  assert.doesNotMatch(long, /39\. file_read/, 'the newest calls are the ones cut');
});

test('cancel after one file_read → chat holds a tool-trace line with the file name, and the next turn sends it to the model', async () => {
  process.env.MELO_MOCK_RESPONSE = '<tool_call>{"id":"read-1","name":"file_read","arguments":{"path":"notes/plan.md"}}</tool_call>';
  const abort = new AbortController();
  const events = [];
  // The scheduler rejects the caller as soon as the signal fires while the
  // turn finishes its bookkeeping in the background; the final
  // `execution_scene` (status cancelled) marks that bookkeeping done.
  let settled; const settledPromise = new Promise(resolve => { settled = resolve; });
  const turn = sendChatMessage({ chatId: 'trace-chat', content: '看一下计划', requestId: 'trace-turn-1', signal: abort.signal, skipBootstrap: true,
    sseEmitter: (event, payload) => {
      events.push({ event, payload });
      if (event === 'tool_calls_done') abort.abort();
      if (event === 'execution_scene' && payload?.scene?.status === 'cancelled') settled();
    } });
  await assert.rejects(turn, error => error?.name === 'AbortError' || error?.code === 'ABORT_ERR');
  await settledPromise;
  const done = events.find(e => e.event === 'tool_calls_done');
  assert.equal(done.payload.results[0].ok, true, 'the file was actually read before the cancel');
  const start = events.find(e => e.event === 'tool_calls_start');
  assert.equal(start.payload.calls[0].arguments.path, 'notes/plan.md');

  const state = await loadState({ home: TEST_HOME });
  const chat = state.chats.find(c => c.id === 'trace-chat');
  assert.equal(state.chatRuns.find(r => r.requestId === 'trace-turn-1').status, 'cancelled');
  const trace = chat.messages.find(m => m.kind === 'tool-trace');
  assert.ok(trace, 'a tool-trace assistant message is persisted on cancel');
  assert.equal(trace.role, 'assistant');
  assert.ok(trace.content.startsWith(TOOL_TRACE_PREFIX));
  assert.match(trace.content, /file_read\(path=notes\/plan\.md\) ✓/);
  assert.ok(trace.content.length <= 600);
  assert.equal(trace.metadata.toolTrace.status, 'cancelled');
  assert.equal(trace.metadata.runId, done.payload.runId);
  const records = await readToolInvocationRecords(trace.metadata.runId, { home: TEST_HOME });
  assert.equal(records.length, 1);
  assert.equal(records[0].toolId, 'file_read');

  // The replay survives hydration and enters the history window…
  const history = buildModelMessagesFromChat(chat, { windowTokens: 60_000 });
  assert.ok(history.some(m => m.role === 'assistant' && String(m.content).includes('notes/plan.md')), 'history window carries the trace');

  // …and the next turn's model request actually contains it.
  chat.messages.push({ id: 'trace-user-2', role: 'user', content: '继续', createdAt: new Date().toISOString() });
  let requestMessages = null;
  const result = await runChatAgentExecutionGraph({ config: { authMode: 'unset', apiKey: '', baseUrl: '', model: 'gpt-4' }, state, chat,
    workspace: { rootPath: join(TEST_HOME, 'workspaces', 'chats', 'trace-chat'), exists: true, entries: [], filePaths: [], fileCount: 0, selectedFilePath: null, selectedFile: null, commandTemplates: [], commandRuns: [] },
    connectors: [], skills: [], latestUserMessage: '继续', agentId: 'main',
    _dependencies: { getEmbedding: async () => null, createReply: async options => { requestMessages = options.messages; return '好的，接着上次读过的计划继续。'; } } });
  assert.match(result.normalizedReply.content, /接着/);
  const serialized = JSON.stringify(requestMessages);
  assert.ok(serialized.includes(TOOL_TRACE_PREFIX) && serialized.includes('notes/plan.md'), 'next turn prompt history includes the tool trace with the file name');
  assert.ok(!JSON.stringify(history).includes('read-1'), 'the legacy trace remains plain text with no call IDs');
  assert.ok(serialized.includes(`${trace.metadata.runId}/tool/0%3Aread-1/result`), 'canonical history links to the saved UI event');
  function assertNoReplay(value) {
    if (!value || typeof value !== 'object') return;
    assert.ok(!['function_call', 'function_call_output', 'tool_use', 'tool_result'].includes(value.type), 'history must not reconstruct executable protocol objects');
    assert.ok(!Object.hasOwn(value, 'call_id') && !Object.hasOwn(value, 'tool_call_id') && !Object.hasOwn(value, 'tool_calls'));
    for (const child of Object.values(value)) assertNoReplay(child);
  }
  assertNoReplay(requestMessages);
});
