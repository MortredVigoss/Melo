import { mkdtempSync, rmSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Live voice call (2026-11-16): a spoken turn carries the shared voice-turn
// instruction through the real execution graph — in this turn's user message
// (turn context), in the Agent's speaking style — and an ordinary turn carries
// none. The request contract accepts only a boolean and keeps every earlier
// request fingerprint. One parent test owns the fixture home
// (src/runtime/testIsolation.test.js).
await test('voice turns through the request contract and the execution graph', async t => {
  const root = process.cwd();
  const home = mkdtempSync(join(tmpdir(), 'melo-voice-turn-'));
  const oldHome = process.env.MELO_HOME;
  process.env.MELO_HOME = home;
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    if (oldHome === undefined) delete process.env.MELO_HOME; else process.env.MELO_HOME = oldHome;
  });
  const get = path => import(pathToFileURL(join(root, path)));
  const { runChatAgentExecutionGraph } = await get('src/services/chat/chatExecutionRunner.js');
  const { saveState } = await get('src/state/stateStore.js');
  const { validateChatRequest, chatRequestFingerprint } = await get('src/services/chat/requestContract.js');
  const { voiceTurnInstruction, VOICE_TURN } = await get('shared/agent/voiceTurn.js');

  await t.test('the request contract: boolean only, and earlier fingerprints do not change', () => {
    const base = { chatId: 'c1', content: '明天天气怎么样', requestId: 'r-1' };
    assert.doesNotThrow(() => validateChatRequest({ ...base, voiceTurn: true }));
    assert.doesNotThrow(() => validateChatRequest({ ...base, voiceTurn: false }));
    for (const voiceTurn of ['true', 1, {}, []]) {
      assert.throws(() => validateChatRequest({ ...base, voiceTurn }), error => error.code === 'INVALID_VOICE_TURN', String(voiceTurn));
    }
    const plain = chatRequestFingerprint(base);
    assert.equal(chatRequestFingerprint({ ...base, voiceTurn: false }), plain, 'a typed turn keeps its fingerprint');
    assert.notEqual(chatRequestFingerprint({ ...base, voiceTurn: true }), plain, 'a spoken turn is a different request');
  });

  async function turn({ voiceTurn, text = '明天天气怎么样' }) {
    assert.equal(process.env.MELO_HOME, home, 'still inside the fixture home');
    const chat = { id: `voice-${voiceTurn}`, title: 'fixture', mode: 'chat', projectId: null, agentId: 'main', messages: [{ id: `u-${voiceTurn}`, role: 'user', content: text }], sessionMemory: [] };
    const state = {
      projects: [], chats: [chat], tasks: [], approvals: [], artifacts: [], commandRuns: [], externalConnectors: [],
      agentProfiles: { main: { id: 'main', name: 'Fixture', model: 'opaque', voicePersonality: '温柔，带一点幽默', tools: [], skills: [], channels: {}, collaboration: { canDelegate: false } } },
      projectAgentOverrides: {},
      settings: { selectedProjectId: null, selectedChatId: chat.id, selectedAgentId: 'main', activeMode: 'chat', promptHistory: [] },
    };
    await saveState(state);
    const requests = [];
    await runChatAgentExecutionGraph({
      config: { replyLanguage: 'zh', authMode: 'unset', apiKey: '', baseUrl: '', model: 'opaque' },
      state, chat, workspace: { rootPath: home, exists: true, entries: [], filePaths: [], fileCount: 0, commandTemplates: [], commandRuns: [] },
      connectors: [], skills: [], latestUserMessage: text, agentId: 'main', voiceTurn,
      _dependencies: {
        turnTimeoutMs: 20 * 60_000, // above the delivery reserve, or the answer itself is refused
        getEmbedding: async () => null,
        createReply: async options => {
          const system = String(options.systemPrompt || '');
          if (options.purpose === 'routing-judge') return JSON.stringify({ complexity: 1, risk: 'low', needs: { tools: false } });
          if (system.startsWith("You are Melo's task completion checker")) return JSON.stringify({ decision: 'complete', evaluationValid: true, needsEvaluation: false, reasonType: 'none', reason: 'fixture', requirements: [] });
          requests.push({ system, messages: options.messages || [] });
          // Text protocol (no native tool calling in this config): the reply is the text itself.
          return '明天晴，最高十八度。';
        },
      },
    });
    const answer = requests.find(request => JSON.stringify(request.messages).includes(text));
    assert.ok(answer, 'the answering request was made');
    const lastUser = [...answer.messages].reverse().find(message => message.role === 'user');
    const content = typeof lastUser.content === 'string' ? lastUser.content : JSON.stringify(lastUser.content);
    return { answer, content };
  }

  await t.test('a spoken turn carries the instruction beside the user words, in the Agent style', async () => {
    const { answer, content } = await turn({ voiceTurn: true });
    const instruction = voiceTurnInstruction('明天天气怎么样', { style: '温柔，带一点幽默' });
    assert.ok(content.includes(instruction), 'the whole instruction, style line included, rides in this turn');
    assert.ok(content.includes('明天天气怎么样'));
    assert.equal(answer.system.includes('【语音通话】'), false, 'the system prompt stays cache-stable');
  });

  await t.test('an ordinary turn carries no voice instruction anywhere', async () => {
    const { answer, content } = await turn({ voiceTurn: false });
    const marker = VOICE_TURN.instruction.zh.slice(0, 6);
    assert.equal(content.includes(marker), false);
    assert.equal(answer.system.includes(marker), false);
    assert.equal(JSON.stringify(answer.messages).includes(marker), false);
  });
});
