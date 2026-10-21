import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequestContext } from '../../runtime/requestContext.js';
import { runWithRequestContext } from '../../runtime/requestScope.js';
import { loadConfig, saveConfig } from '../../config.js';
import { updateModelConfig } from '../settings/modelSettings.js';
import { searchCredentialId } from './sharedSearchAdapter.js';

test('Search settings preserve model settings, bind keys to the endpoint, and never return keys in bootstrap', async () => {
  const home = await mkdtemp(join(tmpdir(), 'melo-search-config-'));
  try { await runWithRequestContext(createRequestContext({ home }), async () => {
    await saveConfig({ authMode: 'api-key', apiKey: 'fixture-model-key', baseUrl: 'https://model.invalid/v1', model: 'fixture-model', systemPrompt: 'Keep my instructions' });
    const first = 'https://one.invalid/search', second = 'https://two.invalid/search';
    const settings = endpoint => ({ agentRuntime: { search: { backend: 'http', endpoint, credentialRef: 'search' } } });
    let bootstrap = await updateModelConfig({ ...settings(first), searchApiKey: 'fixture-search-key' });
    let config = await loadConfig();
    assert.equal(config.searchCredentials[searchCredentialId(first)], 'fixture-search-key');
    assert.equal(config.apiKey, 'fixture-model-key'); assert.equal(config.systemPrompt, 'Keep my instructions');
    assert.equal(JSON.stringify(bootstrap).includes('fixture-search-key'), false);
    assert.equal(JSON.stringify(bootstrap).includes('searchCredentials'), false);
    await updateModelConfig({ ...settings(first), searchApiKey: '' });
    assert.equal((await loadConfig()).searchCredentials[searchCredentialId(first)], 'fixture-search-key');
    await updateModelConfig(settings(second)); config = await loadConfig();
    assert.equal(config.searchCredentials[searchCredentialId(second)], undefined);
    assert.equal(config.searchCredentials[searchCredentialId(first)], 'fixture-search-key');
    await updateModelConfig({ ...settings(second), searchCredentials: { [searchCredentialId(second)]: 'forged-key' } });
    assert.equal((await loadConfig()).searchCredentials[searchCredentialId(second)], undefined);
    await updateModelConfig({ ...settings(first), clearSearchKey: true });
    assert.equal((await loadConfig()).searchCredentials[searchCredentialId(first)], undefined);
  }); } finally { await rm(home, { recursive: true, force: true }); }
});
