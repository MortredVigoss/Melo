import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { saveExtraFast, testExtraFast } from './extraFast.js';
import { loadConfig, saveConfig, getResolvedConfig } from '../../config.js';
import { runWithRequestContext } from '../../runtime/requestScope.js';
import { createRequestContext } from '../../runtime/requestContext.js';
import { judgeFast, publicExtraFast } from '../../judge/fastJudge.js';
import { createOpenAICompatibleReply } from '../../openai.js';

test('saved setting, probe and real HTTP judge preserve main connection and enforce wire budgets', async t => {
  const home = await mkdtemp(join(tmpdir(), 'melo-extra-fast-'));
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push({ path: req.url, body, key: req.headers.authorization || req.headers['x-api-key'] });
    const system = body.system || body.messages[0].content;
    const label = system.includes('Medical dosage') ? 'high-stakes' : system.includes('group message') ? 'no' : 'creative';
    if (body.model === 'main-answer') await new Promise(resolve => setTimeout(resolve, 80));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url.endsWith('/messages')
      ? { model: 'actual-anthropic', content: [{ type: 'text', text: label }], stop_reason: 'end_turn' }
      : { model: 'actual-mini', choices: [{ message: { content: label }, finish_reason: 'stop' }] }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(home, { recursive: true, force: true }); });
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const context = createRequestContext({ home, env: { MELO_MOCK_RESPONSE: '', MELO_API_KEY: '', OPENAI_API_KEY: '', MELO_BASE_URL: '', MELO_MODEL: '' } });
  await runWithRequestContext(context, async () => {
    await saveConfig({ authMode: 'local', model: 'main-answer', baseUrl,
      llmProfiles: { mini: { id: 'mini', name: '小模型', authMode: 'api-key', baseUrl, model: 'saved-mini', apiKey: 'paired-secret', revision: 1 } },
      systemPrompt: 'Keep role', extraFast: { enabled: false, revision: 0 } });
    assert.equal((await getResolvedConfig()).extraFast.enabled, false);
    let result = await saveExtraFast({ enabled: true, revision: 0 });
    assert.equal(result.enabled, true); assert.equal(result.revision, 1); assert.equal(requests.length, 0);
    await assert.rejects(saveExtraFast({ enabled: false, revision: 0 }), /已被更新/);
    await assert.rejects(saveExtraFast({ enabled: 'true', revision: 1 }), /无效/);
    result = await testExtraFast();
    assert.equal(result.assignments.intent.basis, 'measured'); assert.equal(requests.length, 4);
    assert.equal(result.assignments.intent.model, 'saved-mini');
    assert.ok(!JSON.stringify(result).includes('paired-secret'));
    for (const req of requests) { assert.equal(req.body.max_tokens, 1024); assert.equal(req.body.tools, undefined); assert.equal(req.key, req.body.model === 'saved-mini' ? 'Bearer paired-secret' : undefined); }
    const config = await getResolvedConfig();
    const answer = await judgeFast({ config, task: 'intent', systemPrompt: 'classify', messages: [{ role: 'user', content: 'private test' }], fallback: 'factual' });
    assert.equal(answer, 'creative'); assert.equal(requests.length, 5);
    const disk = await loadConfig(); assert.equal(disk.model, 'main-answer'); assert.equal(disk.systemPrompt, 'Keep role');
    await createOpenAICompatibleReply({ authMode: 'api-key', apiProtocol: 'anthropic', baseUrl, apiKey: 'anthropic-key', model: 'claude',
      systemPrompt: 'classify', messages: [{ role: 'user', content: 'test' }], maxTokens: 512, providerProfile: 'fast' });
    assert.equal(requests.at(-1).body.max_tokens, 512); assert.equal(requests.at(-1).key, 'anthropic-key');
    await saveExtraFast({ enabled: false, revision: 1 });
    await assert.rejects(testExtraFast(), /先开启/); assert.equal(requests.length, 6);
  });
});

test('probe started in one home cannot follow environment changes or overwrite a newer setting', async t => {
  const homes = await Promise.all([0, 1].map(() => mkdtemp(join(tmpdir(), 'melo-judge-scope-'))));
  t.after(async () => { await Promise.all(homes.map(home => rm(home, { recursive: true, force: true }))); });
  const contexts = homes.map(home => createRequestContext({ home }));
  const initial = { authMode: 'local', model: 'mini', baseUrl: 'http://127.0.0.1:1/v1', extraFast: { enabled: true, revision: 1 } };
  await Promise.all(contexts.map(context => runWithRequestContext(context, () => saveConfig(initial))));
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const hold = new Promise(resolve => { release = resolve; });
  const pending = runWithRequestContext(contexts[0], () => testExtraFast({ reply: async options => {
    entered(); await hold;
    return options.cacheScope.endsWith('intent') ? 'high-stakes' : 'no';
  } }));
  await waiting;
  await runWithRequestContext(contexts[0], async () => {
    await assert.rejects(testExtraFast(), /正在检测/);
    await saveExtraFast({ enabled: false, revision: 1 });
  });
  release(); const result = await pending; assert.equal(result.enabled, false);
  const untouched = await runWithRequestContext(contexts[1], () => loadConfig());
  assert.equal(untouched.extraFast.revision, 1); assert.equal(untouched.extraFast.measurements, undefined);
  assert.equal(publicExtraFast(untouched, { home: homes[1] }).assignments.intent.basis, 'preference');
});
