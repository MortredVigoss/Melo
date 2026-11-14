// Background helper requests must never carry the provider's hosted web
// search tool.
//
// In Codex mode a request that does not say whether hosted search is allowed
// is decided by keywords in its last user message (weather, prices,
// flights …). That fallback is meant for a question typed at the CLI. Three
// helpers left the flag out, and their "last user message" is a transcript or
// a finished reply: memory extraction after a turn, the read-aloud rewrite,
// and skill drafting. Whenever such a text mentioned the weather, the request
// went out with the search tool, for an Agent whose network permission is
// off as well, and a search result would have put `[source: …]` lines into
// the text to be spoken or broken the JSON the extraction parses.
//
// Each test takes the options the real helper passes to the model call and
// sends them through the real Codex request builder, down to the body that
// would go on the wire.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createCodexResponsesReply } from '../openai.js';
import { maybeExtractSessionMemory } from '../memory/sessionMemory.js';
import { rewriteForVoice } from '../services/media/voiceRewrite.js';
import { draftSkillFromConversation } from '../agents/skillDrafting.js';

const completed = text => new Response(
  `data: ${JSON.stringify({ type: 'response.completed', response: { output: [{ type: 'message', content: [{ type: 'output_text', text }] }] } })}\n\n`,
  { headers: { 'content-type': 'text/event-stream' } },
);

// The tool types in the request body the Codex path builds from `options`.
async function toolTypesOnTheWire(options) {
  let body = null;
  await createCodexResponsesReply({
    systemPrompt: options.systemPrompt,
    messages: options.messages,
    providerProfile: options.providerProfile,
    ...('nativeWebSearchEnabled' in options ? { nativeWebSearchEnabled: options.nativeWebSearchEnabled } : {}),
    model: 'fixture-model',
    nativeImageGenerationEnabled: false,
    _credentialProvider: async () => ({ loggedIn: true, accountId: 'fixture', accessToken: 'fixture-token' }),
    _fetchImpl: async (_url, init) => { body = JSON.parse(init.body); return completed('ok'); },
  });
  assert.ok(body, 'a request was built');
  return (body.tools || []).map(tool => tool.type);
}

// Every fixture below is about the weather on purpose. This helper proves the
// fixture has teeth: the same messages WITHOUT the flag do get the tool.
async function assertHelperRequest(options, label) {
  assert.equal(options.nativeWebSearchEnabled, false, `${label}: the helper states that hosted search is off`);
  const withoutFlag = { ...options };
  delete withoutFlag.nativeWebSearchEnabled;
  assert.ok((await toolTypesOnTheWire(withoutFlag)).includes('web_search'), `${label}: this text does trip the keyword fallback when the flag is left out`);
  assert.deepEqual(await toolTypesOnTheWire(options), [], `${label}: the request on the wire carries no tool`);
}

const codexConfig = { authMode: 'codex', apiProtocol: 'responses', apiKey: '', baseUrl: '', model: 'fixture-model' };

test('memory extraction: a transcript about the weather goes out without the hosted search tool', async () => {
  const messages = [];
  for (let turn = 1; turn <= 4; turn += 1) {
    messages.push({ id: `u${turn}`, role: 'user', senderId: 'local', content: turn === 4 ? '今天首尔的天气怎么样？现在气温多少度？明天会下雨吗？' : `第 ${turn} 个问题：帮我看看这段代码` });
    messages.push({ id: `a${turn}`, role: 'assistant', content: turn === 4 ? '首尔今天晴，气温 23 度，明天有小雨。' : `第 ${turn} 个回答` });
  }
  const chat = { id: 'chat-1', messages };
  let captured = null;
  const ran = await maybeExtractSessionMemory(chat, { config: codexConfig, replyFn: async options => { captured = options; return '[]'; } });
  assert.equal(ran, true);
  assert.ok(captured, 'the extraction asked the model');
  assert.match(captured.messages[0].content, /天气/);
  await assertHelperRequest(captured, 'memory extraction');
});

test('read-aloud rewrite: a reply about the weather goes out without the hosted search tool', async () => {
  const reply = '今天首尔的天气是晴天，现在气温二十三度，明天有小雨，气温会降到十五度左右，出门记得带伞。';
  let captured = null;
  const spoken = await rewriteForVoice(reply, codexConfig, '你是一位温柔的中文播音员，只说中文。', '', {
    replyFn: async options => { captured = options; return '今天首尔晴，二十三度，明天有小雨，记得带伞。'; },
  });
  assert.equal(spoken, '今天首尔晴，二十三度，明天有小雨，记得带伞。');
  assert.ok(captured, 'the rewrite asked the model');
  await assertHelperRequest(captured, 'read-aloud rewrite');
});

test('skill drafting: a conversation about the weather goes out without the hosted search tool', async () => {
  let captured = null;
  await draftSkillFromConversation({
    messages: [
      { role: 'user', content: '今天首尔的天气怎么样？现在气温多少度？' },
      { role: 'assistant', content: '首尔今天晴，气温 23 度。' },
      { role: 'user', content: '以后每天早上都这样查一下天气和气温，明天会下雨吗？' },
    ],
    config: codexConfig,
    replyFn: async options => { captured = options; return '{}'; },
  });
  assert.ok(captured, 'the drafting asked the model');
  await assertHelperRequest(captured, 'skill drafting');
});
