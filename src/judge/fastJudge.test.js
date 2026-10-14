import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { judgeFast, judgeCandidates, probeJudges, publicExtraFast } from './fastJudge.js';
import { classifyIntent, classifyRequest } from '../retrieval/intentRouter.js';
import { classifyGroupMessageAddressal } from '../services/remote/groupAddressalClassifier.js';
import { fastGenerationOptions } from '../shared/fastGeneration.js';
import { normalizeReasoningEffort } from '../shared/modelCatalog.js';

const profile = (model, apiKey = 'fixture-key') => ({ authMode: 'api-key', model, apiKey, baseUrl: 'https://provider.invalid/v1', revision: 1 });
const configFor = () => ({ extraFast: { enabled: true }, model: 'main-answer', activeLlmProfileId: 'large',
  llmProfiles: { large: profile('large'), small: profile('mini', 'small-secret') } });
const request = config => ({ config, task: 'intent', systemPrompt: 'test', messages: [{ role: 'user', content: 'ambiguous text' }], fallback: 'factual', home: randomUUID() });

test('disabled and hard rules issue zero judge requests; contextual risk still applies', async () => {
  let calls = 0;
  const judge = async () => { calls++; return 'casual'; };
  const config = configFor();
  for (const text of ['你好', '谢谢', '写一首诗', '这是什么？', '我需要用药建议']) await classifyIntent(text, { config, judge });
  assert.equal(calls, 0);
  await judgeFast({ ...request({ ...config, extraFast: { enabled: false } }), reply: judge });
  assert.equal(calls, 0);
  const risk = await classifyRequest('好的', { config, judge, contextMessages: [{ role: 'user', content: '投资建议' }] });
  assert.equal(risk.riskLevel, 'high'); assert.equal(calls, 0);
  assert.equal(await classifyIntent('今天的心情还算不错呢', { config, judge }), 'casual');
  assert.equal(calls, 1);
  assert.equal(await classifyGroupMessageAddressal({ text: '' }, {}, config, {}, { judge }), false);
  assert.equal(calls, 1);
  assert.equal(await classifyGroupMessageAddressal({ text: '今天怎么样' }, {}, config, {}, { judge: async options => { calls++; assert.equal(options.task, 'addressal'); return 'yes'; } }), true);
  assert.equal(calls, 2);
});

test('candidate preference keeps credentials paired and does not change the answer model', async () => {
  const config = configFor(), before = structuredClone(config), args = request(config);
  const decisions = []; let calls = 0;
  const reply = async options => {
    calls++; assert.equal(options.model, 'mini'); assert.equal(options.apiKey, 'small-secret');
    assert.equal(options.baseUrl, 'https://provider.invalid/v1'); assert.equal(options.maxTokens, 1024);
    assert.equal(options.nativeWebSearchEnabled, false); assert.equal(options.nativeImageGenerationEnabled, false);
    assert.equal(options.workspacePath, null); assert.equal(options.providerProfile, 'fast');
    options.onProviderResponse({ reportedModel: 'mini-actual', usage: { input: 20, output: 1, cached: 0, cacheWrite: 0 } }); return 'creative';
  };
  assert.equal(await judgeFast({ ...args, reply, onDecision: value => decisions.push(value) }), 'creative');
  assert.equal(await judgeFast({ ...args, reply, onDecision: value => decisions.push(value) }), 'creative');
  assert.equal(calls, 1); assert.equal(decisions[1].source, 'cache');
  assert.equal(decisions[0].usage.output, 1); assert.equal(decisions[1].usage, undefined);
  assert.deepEqual(config, before);
  const visible = publicExtraFast(config, { home: args.home });
  assert.equal(visible.assignments.intent.reportedModel, 'mini-actual');
  assert.ok(!JSON.stringify(visible).includes('small-secret'));
  await judgeFast({ ...args, home: randomUUID(), reply }); assert.equal(calls, 2);
  config.llmProfiles.small.revision++;
  await judgeFast({ ...args, reply }); assert.equal(calls, 3);
});

test('duplicate connections are deduplicated, missing keys and invalid OAuth endpoints excluded', () => {
  const config = configFor();
  config.llmProfiles.copy = { ...config.llmProfiles.small };
  config.llmProfiles.empty = profile('another', '');
  config.llmProfiles.bad = { ...profile('oauth'), authMode: 'codex' };
  assert.equal(judgeCandidates(config).length, 2);
  config.llmProfiles.small.models = ['unconfigured-mini'];
  assert.ok(!judgeCandidates(config).some(c => c.connection.model === 'unconfigured-mini'));
});

test('task-specific real measurements beat model name preferences; changed credentials invalidate them', () => {
  const config = configFor(), candidates = judgeCandidates(config), now = Date.now();
  config.extraFast.measurements = Object.fromEntries(candidates.map(c => [c.key, {
    intent: { ok: true, at: now, latencyMs: c.id === 'large' ? 10 : 100 },
    addressal: { ok: true, at: now, latencyMs: c.id === 'large' ? 100 : 10 },
  }]));
  let visible = publicExtraFast(config, { home: randomUUID() });
  assert.equal(visible.assignments.intent.model, 'large'); assert.equal(visible.assignments.addressal.model, 'mini');
  config.llmProfiles.large.apiKey = 'rotated';
  visible = publicExtraFast(config, { home: randomUUID() });
  assert.equal(visible.assignments.intent.model, 'mini');
  delete config.llmProfiles.small;
  assert.equal(publicExtraFast(config).assignments.intent.basis, 'preference');
});

test('timeout is bounded even if a transport ignores abort; no same-turn retry or invalid-label cache', async () => {
  const args = request(configFor()); let calls = 0, transportSignal;
  const result = await judgeFast({ ...args, timeoutMs: 10, reply: async options => {
    calls++; transportSignal = options.signal; return await new Promise(() => {});
  } });
  assert.equal(result, 'factual'); assert.equal(calls, 1); assert.equal(transportSignal.aborted, true);
  assert.equal(publicExtraFast(args.config, { home: args.home }).assignments.intent.model, 'large');
  assert.equal(await judgeFast({ ...args, reply: async () => { calls++; return 'yes maybe'; } }), 'factual');
  assert.equal(calls, 2);
  assert.equal(await judgeFast({ ...args, reply: async () => { calls++; return 'casual'; } }), 'factual');
  assert.equal(calls, 2); // Both candidates cooling down: zero requests.
});

test('caller cancellation propagates and is not counted as a model failure', async () => {
  const args = request(configFor()), controller = new AbortController(); let calls = 0;
  const pending = judgeFast({ ...args, signal: controller.signal, reply: async () => {
    calls++; controller.abort(new Error('user stopped')); return new Promise(() => {});
  } });
  await assert.rejects(pending, /user stopped/); assert.equal(calls, 1);
  assert.equal(publicExtraFast(args.config, { home: args.home }).assignments.intent.model, 'mini');
});

test('probes use only bounded synthetic requests and reject wrong labels and simulated responses', async () => {
  const config = configFor();
  for (let i = 0; i < 5; i++) config.llmProfiles[`p${i}`] = profile(`model${i}`);
  let calls = 0;
  const result = await probeJudges(config, { home: randomUUID(), reply: async options => {
    calls++; assert.equal(options.messages.length, 1);
    assert.ok(!options.messages[0].content.includes('private user'));
    options.onProviderResponse({ reportedModel: options.model });
    return options.cacheScope.endsWith('intent') ? 'high-stakes' : 'no';
  } });
  assert.equal(calls, 6); assert.equal(Object.keys(result).length, 3);
  assert.ok(Object.values(result).every(v => v.intent.ok && v.addressal.ok));
  const simulated = await probeJudges(configFor(), { home: randomUUID(), reply: async options => {
    options.onProviderResponse({ simulated: true }); return 'high-stakes';
  } });
  assert.ok(Object.values(simulated).every(v => !v.intent.ok && !v.addressal.ok));
  await probeJudges({ extraFast: { enabled: false } }, { reply: async () => { calls++; } }); assert.equal(calls, 6);
});

test('provider options honor exact capabilities and never enable a paid priority tier', () => {
  const options = model => fastGenerationOptions({ model, baseUrl: 'https://api.openai.com/v1', providerProfile: 'fast', maxTokens: 1024 });
  assert.deepEqual(options('gpt-6.1-sol'), { max_completion_tokens: 1024, reasoning_effort: 'low' });
  assert.deepEqual(options('gpt-6-luna'), { max_completion_tokens: 1024, reasoning_effort: 'none' });
  assert.deepEqual(fastGenerationOptions({ model: 'gpt-6-luna', baseUrl: 'https://custom.invalid/v1', providerProfile: 'fast' }), { max_tokens: 1024 });
  assert.deepEqual(fastGenerationOptions({ model: 'model', baseUrl: 'https://custom.invalid/v1' }), {});
  assert.equal(normalizeReasoningEffort('gpt-6-luna', 'none'), 'none');
  assert.equal(normalizeReasoningEffort('gpt-6.1-sol', 'none'), 'low');
});
