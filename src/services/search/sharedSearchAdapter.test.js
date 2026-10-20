import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createSharedSearchTool, createCompatibleSearchTool } from './sharedSearchAdapter.js';

async function fixture(t, handler) {
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    requests.push({ method: request.method, url: request.url, headers: request.headers, body });
    handler(request, response, body);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { endpoint: `http://127.0.0.1:${server.address().port}/search`, requests };
}

test('no configured search never invokes the old browser executor', async () => {
  let browser = 0;
  const tool = createSharedSearchTool({ run() { browser++; throw new Error('Unexpected browser'); } });
  const result = await tool.run({ query: 'Surry Hills restaurants' }, { config: {} });
  assert.equal(result.error, 'SEARCH_UNAVAILABLE'); assert.equal(browser, 0);
});

test('HTTP search returns bounded sources and unknown freshness without launching a browser', async t => {
  const server = await fixture(t, (_, response) => response.end(JSON.stringify({ results: [{ title: 'Fixture A', url: 'https://fixture.invalid/menu', snippet: 'Hours unavailable' }] })));
  let browser = 0;
  const tool = createSharedSearchTool({ run() { browser++; } });
  const result = await tool.run({ query: 'Surry Hills restaurants' }, { fixture: true, searchCredential: 'fixture-search-secret', config: { agentRuntime: { search: { backend: 'http', endpoint: server.endpoint, credentialRef: 'search' } } } });
  assert.equal(result.ok, true); assert.equal(browser, 0);
  assert.deepEqual(JSON.parse(server.requests[0].body), { query: 'Surry Hills restaurants', maxResults: 6 });
  assert.equal(server.requests[0].headers.authorization, 'Bearer fixture-search-secret');
  const receipt = JSON.parse(result.output);
  assert.equal(receipt.freshness, 'unknown'); assert.equal(receipt.results[0].title, 'Fixture A');
  assert.ok(Date.parse(receipt.fetchedAt)); assert.equal(result.output.includes('fixture-search-secret'), false);
});

test('Brave uses the shared GET/header contract and normalizes web results', async t => {
  const server = await fixture(t, (_, response) => response.end(JSON.stringify({ web: { results: [{ title: 'Fixture B', url: 'https://fixture.invalid/b', description: 'Not a live opening-status guarantee' }] } })));
  const result = await createSharedSearchTool().run({ query: 'Surry Hills 咖啡', maxResults: 2 }, { fixture: true, searchCredential: 'fixture-brave-key', config: { agentRuntime: { search: { backend: 'http', provider: 'brave', endpoint: server.endpoint } } } });
  assert.equal(result.ok, true); assert.equal(server.requests[0].method, 'GET');
  const query = new URL(server.requests[0].url, server.endpoint).searchParams;
  assert.equal(query.get('q'), 'Surry Hills 咖啡'); assert.equal(query.get('count'), '2');
  assert.equal(server.requests[0].headers['x-subscription-token'], 'fixture-brave-key');
  assert.equal(server.requests[0].headers.authorization, undefined);
  assert.equal(JSON.parse(result.output).backend, 'brave');
  assert.equal(JSON.parse(result.output).results[0].snippet, 'Not a live opening-status guarantee');
});

test('redirects and backend failures never reach a second origin or a browser', async t => {
  const destination = await fixture(t, (_, response) => response.end('{}'));
  const redirect = await fixture(t, (_, response) => { response.writeHead(302, { location: destination.endpoint }); response.end(); });
  let browser = 0;
  const tool = createSharedSearchTool({ run() { browser++; } });
  const result = await tool.run({ query: 'fixture' }, { fixture: true, searchCredential: 'fixture-secret', config: { agentRuntime: { search: { backend: 'http', endpoint: redirect.endpoint } } } });
  assert.equal(result.ok, false); assert.equal(destination.requests.length, 0); assert.equal(browser, 0);
});

test('only explicit browser fallback reaches the legacy implementation', async () => {
  let browser = 0;
  const tool = createSharedSearchTool({ async run(args) { browser++; assert.equal(args.query, 'fixture'); return { ok: true, output: 'legacy fixture' }; } });
  const result = await tool.run({ query: 'fixture' }, { config: { agentRuntime: { search: { browserFallback: true } } } });
  assert.equal(result.ok, true); assert.equal(browser, 1);
});

test('Node schema compatibility delegates explicit HTTP configuration without a browser', async t => {
  const server = await fixture(t, (_, response) => response.end(JSON.stringify({ results: [{ title: 'Fixture', url: 'https://fixture.invalid/a', snippet: 'fixture only' }] })));
  const legacy = { parametersSchema: { type: 'object', properties: { query: { type: 'string' }, num_results: { type: 'number' } } },
    async run() { throw new Error('Unexpected legacy browser'); } };
  const tool = createCompatibleSearchTool(legacy);
  assert.equal(tool.parametersSchema, legacy.parametersSchema);
  const result = await tool.run({ query: 'fixture', num_results: 3 }, { fixture: true,
    config: { agentRuntime: { search: { backend: 'http', endpoint: server.endpoint } } } });
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(server.requests[0].body), { query: 'fixture', maxResults: 3 });
});
test('Node compatibility preserves legacy requests but explicit unavailable search never opens a browser', async () => {
  let calls = 0;
  const tool = createCompatibleSearchTool({ async run(args) { calls++; return { ok: true, output: args.query }; } });
  assert.equal((await tool.run({ query: 'legacy' }, { config: {} })).output, 'legacy');
  const unavailable = await tool.run({ query: 'fixture' }, { config: { agentRuntime: { search: { backend: 'none' } } } });
  assert.equal(unavailable.ok, false); assert.equal(calls, 1);
});
