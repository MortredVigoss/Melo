import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { saveConfig, loadConfig, getResolvedConfig } from '../config.js';
import { createRequestContext } from '../runtime/requestContext.js';
import { runWithRequestContext } from '../runtime/requestScope.js';
import { saveLlmProfile, activateLlmProfile, forgetLlmProfile, inspectLlmProfile, testLlmProfile } from '../services/settings/llmConnections.js';
import { publicLlmConnections } from '../shared/llmProviders.js';
import { createOpenAICompatibleReply } from '../openai.js';
import { startOpenRouterOAuth, openRouterOAuthStatus } from './openRouterOAuth.js';
import { buildConnectors } from '../services/connector/connectorRollup.js';
import { updateModelConfig } from '../services/settings/modelSettings.js';

test('LLM connections isolate credentials and drive real HTTP inference without another harness', async t => {
  const home = await mkdtemp(join(tmpdir(), 'melo-llm-connections-'));
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    requests.push({ url: req.url, headers: req.headers, body });
    if (req.method === 'GET') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'vendor/model-test' }] })); return; }
    if (body.model === 'failure') { res.writeHead(401); res.end('{}'); return; }
    if (req.url.endsWith('/messages')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const event of [
        { type: 'message_start', message: { id: 'message-1', model: 'claude-reported' } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: '4' } },
        { type: 'message_delta', delta: { stop_reason: body.model === 'truncated' ? 'max_tokens' : 'end_turn' } },
        ...(body.model === 'eof' ? [] : [{ type: 'message_stop' }]),
      ]) res.write(`data: ${JSON.stringify(event)}\r\n\r\n`);
      res.end(); return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ model: 'vendor/model-reported', choices: [{ delta: { content: '4' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const context = createRequestContext({ home, env: { MELO_MOCK_RESPONSE: '', OPENAI_API_KEY: 'ambient-key-must-not-cross', MELO_MODEL: 'ambient-model', OPENAI_BASE_URL: 'https://wrong.invalid/v1' } });
  try { await runWithRequestContext(context, async () => {
    await saveConfig({ authMode: 'codex', model: 'gpt-6.1-sol', baseUrl: 'https://chatgpt.com/backend-api', minimaxApiKey: 'unchanged-voice-key', systemPrompt: 'Keep Melo instructions' });
    await t.test('platform profiles keep old settings and make independently authenticated requests', async () => {
      for (const [providerId, suffix] of [['deepseek', 'v1'], ['doubao', 'api/v3'], ['gemini', 'v1beta/openai'], ['kimi', 'v1'], ['qwen', 'compatible-mode/v1'], ['openai', 'v1']]) {
        await saveLlmProfile({ providerId, baseUrl: `${base}/${providerId}/${suffix}`, model: `${providerId}-model`, apiKey: `secret-only-for-${providerId}` });
        await activateLlmProfile(providerId);
        const config = await getResolvedConfig();
        assert.equal(config.apiKey, `secret-only-for-${providerId}`);
        assert.equal(config.model, `${providerId}-model`);
        assert.equal(config.systemPrompt, 'Keep Melo instructions');
        const result = await testLlmProfile(providerId);
        assert.equal(result.ok, true); assert.equal(result.reportedModel, 'vendor/model-reported');
        assert.equal(requests.at(-1).headers.authorization, `Bearer secret-only-for-${providerId}`);
        assert.equal(requests.at(-1).body.tools, undefined);
        assert.match(requests.at(-1).url, /chat\/completions$/);
        await saveLlmProfile({ providerId, apiKey: '' });
        await activateLlmProfile(providerId);
        assert.equal((await inspectLlmProfile(providerId)).test.reportedModel, 'vendor/model-reported');
      }
      const config = await loadConfig();
      assert.equal(config.minimaxApiKey, 'unchanged-voice-key');
      assert.equal(config.llmProfiles.existing.authMode, 'codex');
      assert.equal((await stat(join(home, 'config.json'))).mode & 0o777, 0o600);
      assert.ok(!JSON.stringify(publicLlmConnections(config)).includes('secret-only-for'));
      const connectors = buildConnectors([], config, { commandRuns: [] }, { artifacts: [], externalConnectors: [] });
      const llm = connectors.find(connector => connector.id === 'openai-compatible');
      assert.equal(llm.config.apiKey, undefined);
      assert.equal(llm.config.hasApiKey, true);
      assert.ok(!JSON.stringify(connectors).includes(config.apiKey), 'UI connector payload must not contain the active key');
    });
    await t.test('blank keeps only this connection key; changed endpoint requires explicit re-key', async () => {
      const previous = await inspectLlmProfile('deepseek');
      await saveLlmProfile({ id: 'deepseek', providerId: 'deepseek', apiKey: '', model: 'new-model', revision: previous.revision });
      assert.equal((await inspectLlmProfile('deepseek')).apiKey, previous.apiKey);
      assert.equal((await inspectLlmProfile('deepseek')).test, null, 'Changed model invalidates its previous probe');
      await assert.rejects(saveLlmProfile({ id: 'deepseek', providerId: 'deepseek', baseUrl: `${base}/other` }), /地址已改变/);
      await assert.rejects(saveLlmProfile({ id: 'deepseek', providerId: 'deepseek', revision: previous.revision }), /发生变化/);
      await assert.rejects(saveLlmProfile({ providerId: 'chatgpt', baseUrl: `${base}/codex` }), /官方/);
    });
    await t.test('Anthropic uses Messages with its own auth and rejects incomplete output', async () => {
      await saveLlmProfile({ providerId: 'anthropic', baseUrl: `${base}/anthropic/v1`, model: 'claude-test', apiKey: 'anthropic-key' });
      const result = await testLlmProfile('anthropic');
      assert.equal(result.ok, true); assert.equal(result.reportedModel, 'claude-reported');
      const request = requests.at(-1);
      assert.equal(request.headers['x-api-key'], 'anthropic-key');
      assert.equal(request.headers.authorization, undefined);
      assert.equal(request.body.tools, undefined); assert.equal(request.body.max_tokens, 8192);
      const config = await inspectLlmProfile('anthropic');
      for (const model of ['truncated', 'eof']) await assert.rejects(createOpenAICompatibleReply({ ...config, model, messages: [{ role: 'user', content: 'hi' }], onDelta() {} }), /未完成|提前结束/);
      await activateLlmProfile('anthropic');
      await updateModelConfig({ model: 'claude-new-manual' });
      const switched = await getResolvedConfig();
      assert.equal(switched.activeLlmProfileId, 'anthropic');
      assert.equal(switched.apiProtocol, 'anthropic');
      assert.equal(switched.apiKey, 'anthropic-key');
      assert.equal((await inspectLlmProfile('anthropic')).model, 'claude-new-manual');
      await activateLlmProfile('openai');
    });
    await t.test('prompt and audio edits, including unchanged legacy connection fields, retain the active profile', async () => {
      const before=await loadConfig();
      await updateModelConfig({systemPrompt:'New prompt',whisperBaseUrl:'http://localhost:9999/v1'});
      assert.equal((await loadConfig()).activeLlmProfileId,before.activeLlmProfileId);
      await updateModelConfig({authMode:before.authMode,baseUrl:before.baseUrl,apiProtocol:before.apiProtocol,apiKey:'',systemPrompt:'Another prompt'});
      const after=await loadConfig();assert.equal(after.activeLlmProfileId,before.activeLlmProfileId);assert.equal(after.apiKey,before.apiKey);assert.equal(after.model,before.model);
    });
    await t.test('model discovery never activates or rewrites a chosen model', async () => {
      const before = await loadConfig();
      const result = await testLlmProfile('gemini', { catalogOnly: true });
      assert.deepEqual(result.models, ['gemini-model', 'vendor/model-test']);
      const after = await loadConfig(); assert.equal(after.model, before.model); assert.equal(after.activeLlmProfileId, before.activeLlmProfileId);
      await saveLlmProfile({ id: 'gemini', providerId: 'gemini', model: 'failure' });
      assert.equal((await testLlmProfile('gemini')).ok, false);
    });
    await t.test('concurrent profile edit invalidates in-flight test result', async () => {
      let started, finish;
      const ready = new Promise(r => { started = r; });
      const pending = testLlmProfile('deepseek', { reply: async options => { started(); await new Promise(r => { finish = r; }); options.onProviderResponse({ reportedModel: 'old' }); return '4'; } });
      await ready; await saveLlmProfile({ id: 'deepseek', providerId: 'deepseek', model: 'newer' }); finish();
      await assert.rejects(pending, /测试期间/);
      await assert.rejects(forgetLlmProfile('openai'), /先切换/);
      await activateLlmProfile('existing'); assert.equal((await loadConfig()).authMode, 'codex');
    });
    await t.test('OpenRouter PKCE callback verifies state, saves only locally, and does not auto-activate', async () => {
      await saveLlmProfile({ providerId: 'openrouter', model: 'vendor/model' });
      let exchanges = 0;
      const flow = await startOpenRouterOAuth('openrouter', { fetchImpl: async (url, options) => {
        exchanges++; assert.equal(url, 'https://openrouter.ai/api/v1/auth/keys');
        const payload = JSON.parse(options.body); assert.equal(payload.code_challenge_method, 'S256'); assert.ok(payload.code_verifier.length >= 43);
        return Response.json({ key: 'openrouter-secret-never-return-to-ui' });
      } });
      const auth = new URL(flow.url); assert.equal(auth.hostname, 'openrouter.ai');
      const callback = new URL(auth.searchParams.get('callback_url'));
      callback.search = new URLSearchParams({ code: 'fake-code', state: 'wrong-state' });
      assert.equal((await fetch(callback)).status, 400); assert.equal(exchanges, 0);
      callback.searchParams.set('state', auth.searchParams.get('state'));
      assert.equal((await fetch(callback)).status, 200); assert.equal(exchanges, 1);
      assert.equal(openRouterOAuthStatus(flow.id).status, 'completed');
      const config = await loadConfig(); assert.equal(config.activeLlmProfileId, 'existing');
      assert.equal(config.llmProfiles.openrouter.authKind, 'oauth');
      assert.ok(!JSON.stringify(publicLlmConnections(config)).includes('openrouter-secret'));
      assert.equal((await runWithRequestContext(createRequestContext({ home: join(home, 'other') }), () => openRouterOAuthStatus(flow.id))).status, 'expired');
    });
    await t.test('provider denial without state cancels without exchanging credentials', async () => {
      let exchanges = 0;
      const flow = await startOpenRouterOAuth('openrouter', { fetchImpl: async () => { exchanges++; return Response.json({ key: 'must-not-save' }); } });
      const before = (await inspectLlmProfile('openrouter')).apiKey;
      const callback = new URL(new URL(flow.url).searchParams.get('callback_url'));
      callback.searchParams.set('error', 'access_denied');
      assert.equal((await fetch(callback)).status, 200);
      assert.equal(openRouterOAuthStatus(flow.id).status, 'cancelled');
      assert.equal(exchanges, 0); assert.equal((await inspectLlmProfile('openrouter')).apiKey, before);
    });
    await t.test('cancelled OAuth cannot exchange a code or change credentials', async () => {
      let exchanges = 0;
      const flow = await startOpenRouterOAuth('openrouter', { fetchImpl: async () => { exchanges++; return Response.json({ key: 'wrong-key' }); } });
      const before = (await inspectLlmProfile('openrouter')).apiKey;
      openRouterOAuthStatus(flow.id, { cancel: true });
      assert.equal(openRouterOAuthStatus(flow.id).status, 'expired');
      await assert.rejects(fetch(new URL(flow.url).searchParams.get('callback_url')));
      assert.equal(exchanges, 0); assert.equal((await inspectLlmProfile('openrouter')).apiKey, before);
    });
  }); } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); await rm(home, { recursive: true, force: true }); }
});

test('saving an inactive connection preserves env-based legacy access until explicit activation', async () => {
  const home = await mkdtemp(join(tmpdir(), 'melo-llm-env-'));
  const context = createRequestContext({ home, env: { MELO_AUTH_MODE: 'api-key', MELO_MODEL: 'env-vendor/model', MELO_API_KEY: 'env-only-key', MELO_BASE_URL: 'https://legacy.example/v1' } });
  try { await runWithRequestContext(context, async () => {
    await saveConfig({ authMode: 'codex', model: 'gpt-6.1-sol' });
    await saveLlmProfile({ providerId: 'gemini', model: 'gemini-manual', apiKey: 'gemini-only-key' });
    const before = await getResolvedConfig({ skipModelNormalize: true });
    assert.equal(before.apiKey, 'env-only-key'); assert.equal(before.baseUrl, 'https://legacy.example/v1');
    assert.equal(before.activeLlmProfileId, undefined);
    assert.equal((await inspectLlmProfile('existing')).apiKey, 'env-only-key');
    await activateLlmProfile('gemini');
    assert.equal((await getResolvedConfig()).apiKey, 'gemini-only-key');
    await activateLlmProfile('existing');
    const restored = await getResolvedConfig();
    assert.equal(restored.model, 'env-vendor/model'); assert.equal(restored.apiKey, 'env-only-key');
  }); } finally { await rm(home, { recursive: true, force: true }); }
});

test('per-model declarations survive activation and discovery but do not follow an endpoint change', async t => {
  const home=await mkdtemp(join(tmpdir(),'melo-model-capabilities-'));t.after(()=>rm(home,{recursive:true,force:true}));
  await runWithRequestContext(createRequestContext({home}),async()=>{
    await saveLlmProfile({id:'opaque',providerId:'custom',baseUrl:'https://one.invalid/v1',model:'vendor/opaque',apiKey:'fixture-key',modelCapabilities:{second:{vision:true}},modelCapability:{vision:false,reasoning:true}});
    await activateLlmProfile('opaque');
    await testLlmProfile('opaque',{catalogOnly:true,discover:async({onModelMetadata})=>{onModelMetadata([{id:'vendor/opaque',input_modalities:['text','image']}]);return ['vendor/opaque'];}});
    let profile=await inspectLlmProfile('opaque');
    assert.equal(profile.modelCapabilities['vendor/opaque'].vision,false);assert.equal(profile.modelMetadata['vendor/opaque'].vision,true);
    assert.equal(profile.apiKey,'fixture-key');assert.equal(profile.modelCapabilities.second.vision,true);
    await saveLlmProfile({id:'opaque',providerId:'custom',baseUrl:'https://two.invalid/v1',model:'vendor/opaque',apiKey:'new-fixture-key'});
    profile=await inspectLlmProfile('opaque');
    assert.deepEqual(profile.modelMetadata,{});assert.deepEqual(profile.modelCapabilities,{});assert.equal(profile.apiKey,'new-fixture-key');
  });
});
