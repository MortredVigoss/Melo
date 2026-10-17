import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReplyDelivery, receiveReplyDelivery } from '../../../desktop-ui/replyDelivery.js';

const previousHome = process.env.MELO_HOME;
const home = mkdtempSync(join(tmpdir(), 'melo-prompt-pipeline-'));
process.env.MELO_HOME = home;
const { runChatAgentExecutionGraph } = await import('./chatExecutionRunner.js');
const { clearRegistry, registerTool } = await import('../../tools/registry.js');
const { enrichMessageWithMediaContext } = await import('../../media/index.js');
const { buildSkills, BUILTIN_SKILLS } = await import('../skill/skillService.js');
clearRegistry();
registerTool({
  id: 'test_reference', name: 'Test reference', description: 'Read a deterministic release note.',
  parametersSchema: { type: 'object', properties: {} }, requiresPermission: false,
  run: async () => ({ ok: true, output: 'Release year: 2024.', meta: { url: 'https://example.test/release', coverage: 'full-text' } }),
});
after(() => {
  if (previousHome === undefined) delete process.env.MELO_HOME; else process.env.MELO_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

function fixture(question) {
  const chat = { id: 'test-chat', title: 'test', mode: 'chat', projectId: null, agentId: 'main', messages: [{ id: 'user-1', role: 'user', content: question }] };
  return {
    config: { authMode: 'unset', apiKey: '', model: 'test-model', systemPrompt: 'Answer accurately.' },
    state: { projects: [], chats: [chat], tasks: [], approvals: [], artifacts: [], commandRuns: [], externalConnectors: [], agentProfiles: { main: { id: 'main', model: 'test-model', tools: [], channels: {} } }, projectAgentOverrides: {}, settings: { promptHistory: [] } },
    chat, workspace: { rootPath: '', exists: false, entries: [], filePaths: [] }, connectors: [], skills: [], latestUserMessage: question, agentId: 'main',
  };
}

// Since 2026-10-17 the per-turn sections (tools, uncertainty, language,
// retrieved materials, recall, thread snapshot) travel inside the latest user
// message so the system prompt stays cache-stable. Assertions about those
// sections look at the whole prompt the model received.
function fullPromptText(request) {
  const latestUser = [...(request.messages || [])].reverse().find(message => message.role === 'user');
  const content = latestUser?.content;
  const userText = Array.isArray(content) ? content.map(part => part?.text || '').join('\n') : String(content ?? '');
  return [request.systemPrompt, userText].join('\n\n');
}

test('retired Demon ignores legacy flags and strips new specs while file citations still work', async () => {
  const input = fixture('请整理这段文字。');
  input.workspace.filePaths = ['notes.txt'];
  let prompt = '';
  const result = await runChatAgentExecutionGraph({
    ...input,
    demonMode: true, // Old clients and saved preferences cannot reactivate it.
    _dependencies: { getEmbedding: async () => null, createReply: async request => {
      prompt = request.systemPrompt;
      return '资料写道：<cite src="notes.txt" lines="1">已核对</cite>。\n<viz-spec>{"kind":"tree","nodes":[{"id":"root","label":"Legacy"}]}</viz-spec>';
    } },
  });
  assert.doesNotMatch(prompt, /Interactive visualization mode \(Demon\) is ENABLED/);
  assert.match(prompt, /Source citation mode is ENABLED/);
  assert.equal(result.normalizedReply.viz, null);
  assert.equal(result.normalizedReply.citations.length, 1);
  assert.doesNotMatch(result.normalizedReply.content, /viz-spec|Legacy/);

  const specOnly = await runChatAgentExecutionGraph({
    ...fixture('请整理这段文字。'), demonMode: true,
    _dependencies: { getEmbedding: async () => null, createReply: async () =>
      '<viz-spec>{"kind":"tree","nodes":[{"id":"root","label":"Legacy"}]}</viz-spec>' },
  });
  assert.equal(specOnly.normalizedReply.viz, null);
  assert.doesNotMatch(specOnly.normalizedReply.content, /viz-spec|Legacy/);
  assert.ok(specOnly.normalizedReply.content.trim());
});

test('real runner tool loop verifies fresh evidence before emitting the only final speech text', async () => {
  let calls = 0;
  let verifierCalls = 0;
  const events = [];
  const delivery = createReplyDelivery();
  const spoken = [];
  const result = await runChatAgentExecutionGraph({
    ...fixture('When did the example ship?'),
    sseEmitter: (event, payload) => {
      events.push({ event, payload });
      const next = receiveReplyDelivery(delivery, event, payload);
      if (next.speechDelta) spoken.push(next.speechDelta);
      if (next.finalSpeechText) spoken.push(next.finalSpeechText);
    },
    _dependencies: { getEmbedding: async () => null, createReply: async request => {
      if (request.systemPrompt.startsWith('Review factual claims')) {
        verifierCalls += 1;
        assert.equal(events.some(event => event.event === 'reply_text'), false);
        assert.match(request.messages.at(-1).content, /Release year: 2024/);
        assert.match(request.messages.at(-1).content, /full-text/);
        return JSON.stringify({ verdict: 'CORRECTED', evidenceId: 'tool:call1', evidenceQuote: 'Release year: 2024.', originalClaim: 'It shipped in 2025.', correction: 'It shipped in 2024.' });
      }
      calls += 1;
      assert.equal(request.cacheScope, 'main:test-chat');
      if (calls === 1) return '<tool_call>{"id":"call1","name":"test_reference","arguments":{}}</tool_call>';
      assert.match(request.messages.at(-1).content, /Release year: 2024/);
      return 'It shipped in 2025. Keep the receipt.\n[UNCERTAIN: release year]';
    } },
  });
  assert.equal(calls, 2);
  assert.equal(verifierCalls, 1);
  assert.equal(result.normalizedReply.content, 'It shipped in 2024. Keep the receipt.');
  assert.deepEqual(spoken, [result.normalizedReply.content]);
  assert.equal(events.filter(event => event.event === 'reply_text').length, 1);
  assert.equal(result.toolResults[0].ok, true);
});

test('greetings avoid tool prompts and verification; high-risk writing retains both axes', async () => {
  let calls = 0;
  const greeting = await runChatAgentExecutionGraph({
    ...fixture('hi'), _dependencies: { getEmbedding: async () => null, createReply: async () => { calls += 1; return 'Hello.'; } },
  });
  assert.equal(calls, 1);
  assert.equal(greeting.allowLiveSpeech, true);
  assert.deepEqual(greeting.visibleToolIds, []);
  const writing = await runChatAgentExecutionGraph({
    ...fixture('帮我写一份药物剂量说明'), _dependencies: { getEmbedding: async () => null, createReply: async request => {
      assert.match(fullPromptText(request), /Uncertainty signaling/);
      return '需要更多已核实的信息。';
    } },
  });
  assert.equal(writing.classification.taskType, 'creative');
  assert.equal(writing.classification.riskLevel, 'high');
  assert.equal(writing.allowLiveSpeech, false);
});

test('identical successful tools stop before exhaustion and cannot publish XML as an answer', async () => {
  let calls = 0;
  const result = await runChatAgentExecutionGraph({
    ...fixture('What happened to the release?'), _dependencies: { getEmbedding: async () => null, createReply: async () => {
      calls += 1;
      return `<tool_call>{"id":"call${calls}","name":"test_reference","arguments":{}}</tool_call>`;
    } },
  });
  assert.equal(calls, 6);
  assert.match(result.normalizedReply.content, /NO_PROGRESS/);
  assert.doesNotMatch(result.normalizedReply.content, /<tool_call>/);
});

test('a confirmation in an existing conversation keeps tools available', async () => {
  const input = fixture('好');
  input.chat.messages.unshift(
    { id: 'prior-user', role: 'user', content: '请帮我生成一个 PDF' },
    { id: 'prior-assistant', role: 'assistant', content: '现在开始生成，可以吗？' },
  );
  const result = await runChatAgentExecutionGraph({
    ...input, _dependencies: { getEmbedding: async () => null, createReply: async () => '开始处理。' },
  });
  assert.equal(result.allowLiveSpeech, false);
  assert.ok(result.visibleToolIds.includes('test_reference'));
});

test('abort during verification emits no final text', async () => {
  const controller = new AbortController();
  const events = [];
  await assert.rejects(runChatAgentExecutionGraph({
    ...fixture('What is the release date?'), signal: controller.signal,
    sseEmitter: event => events.push(event),
    _dependencies: { getEmbedding: async () => null, createReply: async request => {
      if (request.systemPrompt.startsWith('Review factual claims')) {
        controller.abort(new Error('user stopped'));
        throw controller.signal.reason;
      }
      return 'It might be 2025.\n[UNCERTAIN: release date]';
    } },
  }), /user stopped/);
  assert.equal(events.includes('reply_text'), false);
});

test('negative search reaches the model, with no approval or native search', async () => {
  const input = fixture('水在标准大气压下的沸点是多少？不要搜索。');
  let calls = 0;
  const result = await runChatAgentExecutionGraph({
    ...input, _dependencies: { getEmbedding: async () => null, createReply: async request => {
      calls += 1;
      assert.equal(request.nativeWebSearchEnabled, false);
      return '100°C。';
    } },
  });
  assert.equal(calls, 1);
  assert.equal(input.state.approvals.length, 0);
  assert.equal(result.normalizedReply.content, '100°C。');
});

test('simple arithmetic drops tools but follow-ups, files, and URLs retain them', async () => {
  async function run(question, mutate = () => {}) {
    const input = fixture(question);
    mutate(input);
    return runChatAgentExecutionGraph({ ...input, _dependencies: { getEmbedding: async () => null, createReply: async () => '323' } });
  }
  const simple = await run('17乘以19等于多少？只回答数字。');
  assert.deepEqual(simple.visibleToolIds, []);
  assert.equal(simple.toolContextPolicy.mode, 'none');
  for (const text of ['计算17乘以19并保存到文件', '请读取 https://example.com', '帮我生成一个 PDF', '现在还有哪些步骤要继续？']) {
    const result = await run(text);
    assert.ok(result.visibleToolIds.includes('test_reference'), text);
  }
  const attachment = await run('17乘以19等于多少？', input => {
    input.chat.messages[0].attachments = [{ kind: 'image', url: 'data:image/png;base64,AAAA' }];
  });
  assert.ok(attachment.visibleToolIds.includes('test_reference'));
});

test('explicit no-network context prevents automatic remote media fetching', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error('unexpected network'); };
  try {
    const message = { attachments: [{ id: 'remote-link', kind: 'link', url: 'https://example.test/private' }], extractedMedia: [] };
    await enrichMessageWithMediaContext(message, { allowRemoteExtraction: false });
    assert.equal(calls, 0);
    assert.deepEqual(message.extractedMedia, []);
  } finally { globalThis.fetch = originalFetch; }
});

test('default enabled built-in skills do not disable the lean route, but custom skills do', async () => {
  const input = fixture('17乘以19等于多少？只回答数字。');
  input.skills = buildSkills(BUILTIN_SKILLS.map(skill => skill.id), []);
  const deps = { getEmbedding: async () => null, createReply: async () => '323' };
  const result = await runChatAgentExecutionGraph({ ...input, _dependencies: deps });
  assert.deepEqual(result.visibleToolIds, []);
  const custom = { id: 'custom-calculation', name: 'custom-calculation', type: 'executable', source: 'custom', enabled: true, systemPrompt: 'Use the custom workflow for calculations.' };
  input.skills = [custom];
  const protectedResult = await runChatAgentExecutionGraph({ ...input, _dependencies: deps });
  assert.ok(protectedResult.visibleToolIds.length > 0);
});

test('greetings skip embeddings and memory, while task confirmations still retrieve',async()=>{
 let embeddings=0;
 const deps={getEmbedding:async()=>{embeddings++;return null;},createReply:async()=> '你好。'};
 const greeting=await runChatAgentExecutionGraph({...fixture('你好'),_dependencies:deps});
 assert.equal(embeddings,0);assert.equal(greeting.memoryContext,'');assert.deepEqual(greeting.normalizedReply.memoryUsage,[]);
 const followup=fixture('好');
 followup.chat.messages.unshift({id:'prior',role:'assistant',content:'现在保存文件，可以吗？'});
 await runChatAgentExecutionGraph({...followup,_dependencies:deps});
 assert.equal(embeddings,1,'ongoing-task confirmation is not discarded as a greeting');
});

test('actual prompt gets a fact once, and only complete budget-surviving facts count as used',async()=>{
 const store=await import('../../memory/store.js');
 const {factId}=await import('../../memory/factPolicy.js');
 const chatId='test-chat', text='nebula preference: answer in Chinese', id=factId(chatId,text);
 const make=(value,key=id)=>({id:key,namespace:`chat:${chatId}`,kind:'session-fact',text:value,
  metadata:{chatId,scope:'chat',audience:'local',category:'preference'},createdAt:'2026-01-01T00:00:00Z'});
 store.replaceMemories([make(text)]);
 let prompt='';
 const result=await runChatAgentExecutionGraph({...fixture('Please recall my nebula preference.'),_dependencies:{getEmbedding:async()=>null,createReply:async req=>{prompt=fullPromptText(req);return '已记住。';}}});
 assert.equal(prompt.split(text).length-1,1,'one fact must have exactly one prompt representation');
 assert.equal(result.normalizedReply.memoryUsage.filter(r=>r.id===id).length,1);
 assert.equal(store.getMemoriesByIds([id])[0].metadata.useCount,1);
 // A single long fact is clipped by the existing session-memory budget. The
 // whole fact must not be claimed as used just because its first 80 chars fit.
 const huge='nebula '+('This is a very long saved preference. '.repeat(2500));
 const hugeId=factId(chatId,huge);
 store.replaceMemories([make(huge,hugeId)]);
 const clipped=await runChatAgentExecutionGraph({...fixture('Please recall my nebula preference.'),_dependencies:{getEmbedding:async()=>null,createReply:async()=> '内容过长。'}});
 assert.equal(clipped.normalizedReply.memoryUsage.some(r=>r.id===hugeId),false);
 assert.equal(store.getMemoriesByIds([hugeId])[0].metadata.useCount,undefined);
 assert.equal(store.getHitStats({memoryIds:[hugeId]})[0]?.goodOutcomes,0);
});
