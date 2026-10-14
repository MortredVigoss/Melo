import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPromptCacheKey } from './retrieval/promptCacheKey.js';
import { createCodexResponsesReply } from './openai.js';

const scope = { home: '/isolated/a', accountId: 'a', endpoint: 'https://example.test/codex/responses', model: 'gpt-5.5', scope: 'main:chat-a' };
test('cache scopes are stable, opaque and partitioned by home, account, model and chat', () => {
  const key = buildPromptCacheKey(scope);
  assert.equal(key, buildPromptCacheKey({ ...scope }));
  for (const field of ['home', 'accountId', 'model', 'scope', 'version', 'profile']) {
    assert.notEqual(key, buildPromptCacheKey({ ...scope, [field]: 'different' }));
  }
  assert.doesNotMatch(key, /isolated|chat-a|gpt-5/);
  assert.equal(buildPromptCacheKey({ ...scope, scope: '' }), null);
});

test('OAuth wire uses stable cache grouping but unique request sessions and low fast reasoning', async () => {
  const calls = [];
  const oldFast = process.env.MELO_CODEX_FAST_REASONING_EFFORT;
  const oldNormal = process.env.MELO_CODEX_REASONING_EFFORT;
  delete process.env.MELO_CODEX_FAST_REASONING_EFFORT;
  process.env.MELO_CODEX_REASONING_EFFORT = 'high';
  try {
    for (let index = 0; index < 2; index += 1) {
      await createCodexResponsesReply({
        model: 'gpt-5.5', systemPrompt: 'A stable prompt', messages: [{ role: 'user', content: 'hello' }],
        providerProfile: 'fast', cacheScope: 'main:chat-a', nativeWebSearchEnabled: false,
        _credentialProvider: async () => ({ loggedIn: true, accountId: 'account-a', accessToken: 'test-only-token' }),
        _fetchImpl: async (_url, options) => {
          calls.push({ body: JSON.parse(options.body), headers: options.headers });
          return new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hello.' }] }] } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
        },
      });
    }
    assert.equal(calls[0].body.prompt_cache_key, calls[1].body.prompt_cache_key);
    assert.notEqual(calls[0].headers.session_id, calls[1].headers.session_id);
    assert.equal(calls[0].body.reasoning.effort, 'low');
    assert.equal(calls[0].body.store, false);
    assert.equal(calls[0].body.input[0].content[0].type, 'input_text');
    assert.equal('previous_response_id' in calls[0].body, false);
  } finally {
    if (oldFast === undefined) delete process.env.MELO_CODEX_FAST_REASONING_EFFORT; else process.env.MELO_CODEX_FAST_REASONING_EFFORT = oldFast;
    if (oldNormal === undefined) delete process.env.MELO_CODEX_REASONING_EFFORT; else process.env.MELO_CODEX_REASONING_EFFORT = oldNormal;
  }
});
