import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequestContext } from '../../runtime/requestContext.js';
import { runWithRequestContext } from '../../runtime/requestScope.js';
import { saveLlmProfile, testLlmProfile, activateLlmProfile } from '../settings/llmConnections.js';
import { getResolvedConfig } from '../../config.js';
import { probeHostedSearch, hostedConnectionFingerprint, resolveHostedSearchCapability } from './hostedSearchCapability.js';
import { hostedSearchProof, hostedCapability, hostedSearchReceipt } from '../../../shared/agent/hostedSearch.js';

const source = { url: 'https://developer.android.com/develop/background-work/background-tasks/jsengine', title: 'Android JavaScriptEngine' };
const items = [
  { id: 'search-1', type: 'web_search_call', status: 'completed', action: { type: 'search', sources: [source] } },
  { id: 'message-1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Official documentation.', annotations: [{ type: 'url_citation', ...source }] }] },
];

test('Responses connection settings → actual HTTP probe → matching proof; text-only response never verifies search', async t => {
  const home = await mkdtemp(join(tmpdir(), 'melo-hosted-proof-'));
  let outputs = items;
  const requests = [];
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    requests.push({ url: request.url, body: JSON.parse(raw), authorization: request.headers.authorization });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ type: 'response.completed', response: { id: 'r1', model: 'fixture-reported', status: 'completed', output: outputs } })}\n\n`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(home, { recursive: true, force: true }); });
  await runWithRequestContext(createRequestContext({ home, env: { MELO_MOCK_RESPONSE: '' } }), async () => {
    await saveLlmProfile({ id: 'probe', providerId: 'custom', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiProtocol: 'responses', model: 'fixture-model', apiKey: 'fixture-key' });
    await activateLlmProfile('probe');
    const result = await testLlmProfile('probe', { modality: 'search' });
    assert.equal(result.ok, true); assert.equal(result.reportedModel, 'fixture-reported');
    assert.equal(requests.length, 1); assert.equal(requests[0].url, '/v1/responses');
    assert.deepEqual(requests[0].body.tools, [{ type: 'web_search' }]);
    assert.ok(requests[0].body.include.includes('web_search_call.action.sources'));
    assert.equal(requests[0].authorization, 'Bearer fixture-key');
    const config = await getResolvedConfig();
    assert.equal((await resolveHostedSearchCapability(config)).status, 'verified');
    assert.equal(JSON.stringify(result.proof).includes('fixture-key'), false);
    outputs = [items[1]];
    const plain = await testLlmProfile('probe', { modality: 'search' });
    assert.equal(plain.ok, false); assert.equal(plain.error, 'HOSTED_SEARCH_NOT_OBSERVED');
    assert.equal((await resolveHostedSearchCapability(await getResolvedConfig())).status, 'unknown');
    outputs = items;
    await testLlmProfile('probe', { modality: 'search' });
    await saveLlmProfile({ id: 'probe', providerId: 'custom', model: 'changed-model' });
    assert.equal((await resolveHostedSearchCapability(await getResolvedConfig())).status, 'unknown');
  });
});

test('proof is bound to endpoint, protocol, model, credential/account identity and expiry', async () => {
  const config = { authMode: 'api-key', apiProtocol: 'responses', baseUrl: 'https://one.invalid/v1', model: 'fixture', apiKey: 'fixture-key' };
  const fingerprint = await hostedConnectionFingerprint(config);
  const proof = hostedSearchProof({ receipt: { verified: true }, fingerprint, now: 1000 });
  assert.equal(hostedCapability(proof, fingerprint, 1001).status, 'verified');
  for (const patch of [{ apiKey: 'other' }, { model: 'other' }, { baseUrl: 'https://two.invalid/v1' }, { apiProtocol: 'chat-completions' }]) {
    assert.equal(hostedCapability(proof, await hostedConnectionFingerprint({ ...config, ...patch }), 1001).status, 'unknown');
  }
  const a = await hostedConnectionFingerprint({ ...config, authMode: 'codex' }, { accountId: 'account-a' });
  const b = await hostedConnectionFingerprint({ ...config, authMode: 'codex' }, { accountId: 'account-b' });
  assert.notEqual(a, b);
  assert.equal(hostedCapability(proof, fingerprint, 999).status, 'unknown');
  assert.equal(hostedCapability(proof, fingerprint, 86_401_000).status, 'unknown');
});

test('source citations alone and mock responses cannot attest that a hosted search ran', async () => {
  assert.equal(hostedSearchReceipt({ items: [items[1]], text: 'I searched.' }).verified, false);
  assert.equal(hostedSearchReceipt({ items }).sources[0].url, source.url);
  assert.equal(hostedSearchReceipt({ items: [{ ...items[0], status: 'in_progress' }] }).verified, false);
  await assert.rejects(probeHostedSearch({ authMode: 'api-key', apiProtocol: 'responses' }, { reply: async options => {
    options.onProviderResponse({ simulated: true }); return { responseItems: items };
  } }), /模拟/);
  let calls = 0;
  await assert.rejects(probeHostedSearch({ authMode: 'api-key', apiProtocol: 'chat-completions' }, { reply: async () => { calls++; } }), /Adapter/);
  assert.equal(calls, 0);
});
