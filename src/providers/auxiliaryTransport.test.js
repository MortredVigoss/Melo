import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOpenAICompatibleReply, createCodexResponsesReply } from '../openai.js';
import { createRequestContext } from '../runtime/requestContext.js';
import { runWithRequestContext } from '../runtime/requestScope.js';

test('actual API and OAuth adapters send supported fast reasoning without service-tier changes', async t => {
  const home = await mkdtemp(join(tmpdir(), 'melo-fast-wire-'));
  const originalFetch = globalThis.fetch;
  t.after(async () => { globalThis.fetch = originalFetch; await rm(home, { recursive: true, force: true }); });
  const calls = [];
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/chat/completions');
    calls.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ model: 'actual', choices: [{ message: { content: 'factual' }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } });
  };
  const context = createRequestContext({ home, env: { MELO_MOCK_RESPONSE: '', MELO_CODEX_FAST_REASONING_EFFORT: '', MELO_CODEX_REASONING_EFFORT: 'high' } });
  await runWithRequestContext(context, async () => {
    for (const [model, effort] of [['gpt-6.1-sol', 'low'], ['gpt-6-luna', 'none']]) {
      await createOpenAICompatibleReply({ authMode: 'api-key', apiKey: 'fixture', baseUrl: 'https://api.openai.com/v1',
        model, modelCapabilities:{reasoning:true,reasoningEfforts:[effort],defaultReasoningEffort:effort}, providerProfile: 'fast', maxTokens: 1024, systemPrompt: 'classify', messages: [{ role: 'user', content: 'test' }] });
      assert.equal(calls.at(-1).max_completion_tokens, 1024);
      assert.equal(calls.at(-1).reasoning_effort, effort);
      assert.equal(calls.at(-1).service_tier, undefined);
      await createCodexResponsesReply({ model, modelCapabilities:{reasoning:true,reasoningEfforts:[effort],defaultReasoningEffort:effort}, providerProfile: 'fast', systemPrompt: 'classify', messages: [{ role: 'user', content: 'test' }],
        nativeWebSearchEnabled: false, nativeImageGenerationEnabled: false,
        _credentialProvider: async () => ({ loggedIn: true, accountId: 'fixture', accessToken: 'fixture-token' }),
        _fetchImpl: async (_url, options) => {
          const body = JSON.parse(options.body);
          assert.equal(body.reasoning.effort, effort); assert.equal(body.service_tier, undefined);
          assert.equal(body.max_output_tokens, undefined); // OAuth has no documented output-token cap.
          assert.ok(!body.tools?.length);
          return new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'factual' }] }] } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
        },
      });
    }
  });
});
