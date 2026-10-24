import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, DEFAULT_MODEL_CATALOGS, migrateCodexCatalog, loadConfig, saveConfig } from './config.js';
import { normalizeReasoningEffort } from './shared/modelCatalog.js';
import { modelSupportsVision } from './media/visionCapability.js';
import { readCodexModelCatalog } from './providers/codexModels.js';
import { createRequestContext } from './runtime/requestContext.js';
import { runWithRequestContext } from './runtime/requestScope.js';
import { readCapabilityEvidence } from './runtime/capabilities.js';
import { createCodexResponsesReply, createOpenAICompatibleReply, discoverAvailableModels } from './openai.js';

test('current defaults migrate only the old default catalog and retain custom model choices', () => {
  assert.equal(DEFAULT_CONFIG.model, 'gpt-6.1-sol');
  assert.deepEqual(DEFAULT_MODEL_CATALOGS.codex, ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna']);
  assert.deepEqual(migrateCodexCatalog(['gpt-5.5', 'gpt-5.4', 'gpt-4.1']), DEFAULT_MODEL_CATALOGS.codex);
  const custom = ['my-model', 'gpt-5.5'];
  assert.deepEqual(migrateCodexCatalog(custom), custom);
  for (const model of ['gpt-6.1-sol', 'gpt-6-astra']) {
    assert.equal(modelSupportsVision(model), undefined);
    assert.equal(modelSupportsVision(model, null, {modelMetadata:{[model]:{vision:true}}}), true);
    assert.equal(normalizeReasoningEffort(model, 'minimal', 'low', {reasoningEfforts:['low','medium','high','max']}), 'low');
    assert.equal(normalizeReasoningEffort(model, 'none', 'low', {reasoningEfforts:['low','medium','high','max']}), 'low');
    assert.equal(normalizeReasoningEffort(model, 'max'), 'max');
    assert.equal(normalizeReasoningEffort(model, 'ultra'), 'medium');
  }
  assert.equal(normalizeReasoningEffort('legacy-custom', 'minimal'), 'minimal');
});

test('Codex refresh uses fresh visible account models, preserves selection and falls back when stale', async t => {
  const home = await mkdtemp(join(tmpdir(), 'melo-model-catalog-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { CODEX_HOME: home };
  const file = join(home, 'models_cache.json');
  await writeFile(file, JSON.stringify({ fetched_at: new Date().toISOString(), models: [
    { slug: 'gpt-6.1-sol', visibility: 'list' }, { slug: 'gpt-6-astra', visibility: 'list' },
    { slug: 'hidden-model', visibility: 'hide' }, { slug: 'gpt-6.1-sol', visibility: 'list' },
  ] }));
  assert.deepEqual(await readCodexModelCatalog({ env }), ['gpt-6.1-sol', 'gpt-6-astra']);
  const context = createRequestContext({ home, env });
  assert.deepEqual(await runWithRequestContext(context, () => discoverAvailableModels({ authMode: 'codex', model: 'custom-pin' })), ['custom-pin', 'gpt-6.1-sol', 'gpt-6-astra']);
  assert.deepEqual(await readCodexModelCatalog({ env, now: Date.now() + 25 * 60 * 60 * 1000 }), []);
  await writeFile(file, 'malformed');
  assert.deepEqual(await runWithRequestContext(context, () => discoverAvailableModels({ authMode: 'codex' })), DEFAULT_MODEL_CATALOGS.codex);
});

test('explicit legacy model pin survives the catalog upgrade and configuration reload', async t => {
  const home = await mkdtemp(join(tmpdir(), 'melo-model-pin-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await runWithRequestContext(createRequestContext({ home }), async () => {
    await saveConfig({ authMode: 'codex', model: 'gpt-4.1' });
    assert.equal((await loadConfig()).model, 'gpt-4.1');
    await saveConfig({ authMode: 'codex', model: 'gpt-6-astra' });
    assert.equal((await loadConfig()).model, 'gpt-6-astra');
    await saveConfig({ authMode: 'api-key' });
    assert.equal((await loadConfig()).model, 'gpt-4.1-mini');
  });
});

test('Sol and Astra payloads keep selected model, normalize effort and expose the provider model', async () => {
  for (const model of ['gpt-6.1-sol', 'gpt-6-astra']) {
    for (const [requested, expected] of [['minimal', 'low'], ['max', 'max'], ['high', 'high']]) {
      let seen;
      await runWithRequestContext(createRequestContext({ env: { MELO_CODEX_REASONING_EFFORT: requested } }), () => createCodexResponsesReply({
        model, modelCapabilities:{reasoning:true,reasoningEfforts:['low','medium','high','max'],defaultReasoningEffort:'low'}, systemPrompt: 'Reply OK.', messages: [{ role: 'user', content: 'test' }], nativeWebSearchEnabled: false,
        onModelMetadata: metadata => { seen = metadata; },
        _credentialProvider: async () => ({ loggedIn: true, accessToken: 'test', accountId: 'test' }),
        _fetchImpl: async (url, options) => {
          const payload = JSON.parse(options.body);
          assert.ok(url.endsWith('/codex/responses'));
          assert.equal(payload.model, model);
          assert.equal(payload.reasoning.effort, expected);
          return new Response(`data: ${JSON.stringify({ type: 'response.completed', response: {
            id: 'response-test', model, output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }],
          } })}\n\n`);
        },
      }));
      assert.equal(seen.reportedModel, model);
    }
  }
});

test('provider evidence distinguishes requested and returned model and never invents a missing identity', async t => {
  const home = await mkdtemp(join(tmpdir(), 'melo-model-evidence-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const context = createRequestContext({ home, env: { NODE_TEST_CONTEXT: '', MELO_DIAGNOSTICS_RECORD: '1', MELO_MOCK_RESPONSE: '', MELO_MODEL: '', MELO_AUTH_MODE: '' } });
  for (const reportedModel of ['provider-model-snapshot', '']) {
    globalThis.fetch = async () => new Response(JSON.stringify({ model: reportedModel, choices: [{ message: { content: 'OK' } }] }));
    let receipt;
    await runWithRequestContext(context, () => createOpenAICompatibleReply({
      authMode: 'local', baseUrl: 'http://fixture.invalid/v1', model: 'selected-model', systemPrompt: 'test', messages: [],
      onProviderResponse: value => { receipt = value; },
    }));
    assert.equal(receipt.requestedModel, 'selected-model');
    assert.equal(receipt.reportedModel, reportedModel);
    const evidence = (await readCapabilityEvidence(home)).model;
    assert.equal(evidence.model, 'selected-model');
    assert.equal(evidence.reportedModel, reportedModel);
    assert.equal(evidence.simulated, false);
  }
});
