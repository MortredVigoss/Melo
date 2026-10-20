import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRuntimeConfig, normalizeFetchedPage, normalizeSearchResponse, searchRequest } from './tools.js';
import { startTurn, advanceTurn } from './turn.js';

test('all Hosts get identical safe defaults; Brave fills its one shared endpoint', () => {
  assert.equal(normalizeRuntimeConfig().search.backend, 'none');
  assert.equal(normalizeRuntimeConfig().search.browserFallback, false);
  const config = normalizeRuntimeConfig({ search: { backend: 'http', provider: 'brave' } });
  assert.equal(config.search.endpoint, 'https://api.search.brave.com/res/v1/web/search');
  assert.equal(config.search.credentialRef, 'search');
  const request = searchRequest({ query: '中文 & / 😀', maxResults: 3 }, config);
  assert.equal(new URL(request.url).searchParams.get('q'), '中文 & / 😀');
  assert.equal(request.credentialHeader, 'X-Subscription-Token');
  assert.equal('credential' in request, false);
});

test('source normalization never converts retrieval time into live status', () => {
  const receipt = normalizeSearchResponse({ results: [{ url: 'https://fixture.invalid', title: 'Fixture', snippet: 'Hours unavailable' }, { url: 'javascript:alert(1)' }] }, { fetchedAt: '2026-10-17T01:00:00Z' });
  assert.equal(receipt.results.length, 1); assert.equal(receipt.freshness, 'unknown');
  assert.equal(receipt.results[0].observedAt, undefined);
  assert.equal(normalizeSearchResponse({ results: [{ url: 'file:///private' }] }).ok, false);
});

test('static HTML parser drops scripts/styles and handles unclosed markup in linear scans', () => {
  const receipt = normalizeFetchedPage({ url: 'https://fixture.invalid', contentType: 'text/html', content: '<p>餐厅&nbsp;A</p><script>send_secret()</script><style>.x{}</style><p>Hours unknown</p>' });
  assert.equal(receipt.text, '餐厅 A Hours unknown'); assert.equal(receipt.reading, 'static_html');
  const broken = normalizeFetchedPage({ contentType: 'text/html', content: 'Visible<script>' + '<script>'.repeat(100_000) });
  assert.equal(broken.text, 'Visible');
});

test('a completed phone goal cannot be reissued under a fresh call ID', () => {
  let state = startTurn({ runId: 'r', turnId: 't', allowedTools: ['phone_use'], now: 1000 });
  const event = (type, fields = {}) => { state = advanceTurn(state, { type, runId: 'r', turnId: 't', ...fields }, 1000); };
  const argumentsValue = { goal: 'Open Maps', purpose: 'action' };
  event('request'); event('calls', { calls: [{ id: 'first', name: 'phone_use', arguments: argumentsValue }] });
  assert.deepEqual(state.permitted, ['first']);
  event('result', { callId: 'first', ok: true });
  event('request'); event('calls', { calls: [{ id: 'second', name: 'phone_use', arguments: argumentsValue }] });
  assert.deepEqual(state.permitted, []); assert.equal(state.rejections.second, 'REPEATED_TASK');
});
