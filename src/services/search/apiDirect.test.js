/**
 * API-direct router unit tests.
 *
 * Coverage:
 *  • isWikipediaQuery — positive/negative pattern matching (CJK + ASCII)
 *  • fetchFromWikipedia — fetch DI seam, success / 0-results / HTTP error /
 *    aborted / summary-fetch-fail soft-degrade
 *  • tryApiDirect — no-match → null; match-success/fail pass-through
 *  • cleanWikipediaQuery / detectWikiLang — boundary inputs
 *
 * All HTTP is mocked via _setFetchForTests; no real network.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isWikipediaQuery,
  fetchFromWikipedia,
  tryApiDirect,
  _setFetchForTests,
  _internals,
} from './apiDirect.js';

// Reset fetch impl after every test so cross-test leakage is impossible.
test.afterEach(() => _setFetchForTests(null));

// ─── isWikipediaQuery ────────────────────────────────────────────────────────

test('isWikipediaQuery: explicit "wikipedia:" prefix matches', () => {
  assert.equal(isWikipediaQuery('wikipedia: Marie Curie'), true);
  assert.equal(isWikipediaQuery('Wikipedia: Marie Curie'), true);
  assert.equal(isWikipediaQuery('wiki: Marie Curie'), true);
});

test('isWikipediaQuery: Chinese explicit prefix matches', () => {
  assert.equal(isWikipediaQuery('维基百科：居里夫人'), true);
  assert.equal(isWikipediaQuery('维基: 居里夫人'), true);
});

test('isWikipediaQuery: definition shape matches', () => {
  assert.equal(isWikipediaQuery('what is photosynthesis'), true);
  assert.equal(isWikipediaQuery('What is photosynthesis?'), true);
  assert.equal(isWikipediaQuery('who is Marie Curie'), true);
  assert.equal(isWikipediaQuery('who was Marie Curie'), true);
  assert.equal(isWikipediaQuery('define photosynthesis'), true);
});

test('isWikipediaQuery: Chinese definition shape matches', () => {
  assert.equal(isWikipediaQuery('什么是光合作用'), true);
  assert.equal(isWikipediaQuery('谁是居里夫人'), true);
  assert.equal(isWikipediaQuery('定义 量子纠缠'), true);
});

test('isWikipediaQuery: non-matching queries return false', () => {
  assert.equal(isWikipediaQuery('best restaurants in tokyo'), false);
  assert.equal(isWikipediaQuery('how to cook pasta'), false);
  assert.equal(isWikipediaQuery('weather in beijing'), false);
  assert.equal(isWikipediaQuery('show me cute cat pictures'), false);
  assert.equal(isWikipediaQuery('北京天气'), false);
});

test('isWikipediaQuery: edge cases (empty/non-string)', () => {
  assert.equal(isWikipediaQuery(''), false);
  assert.equal(isWikipediaQuery('   '), false);
  assert.equal(isWikipediaQuery(null), false);
  assert.equal(isWikipediaQuery(undefined), false);
  assert.equal(isWikipediaQuery(42), false);
  // Prefix without content shouldn't match — needs at least one non-space char after.
  assert.equal(isWikipediaQuery('wikipedia: '), false);
  assert.equal(isWikipediaQuery('what is '), false);
});

// ─── cleanWikipediaQuery / detectWikiLang ────────────────────────────────────

test('cleanWikipediaQuery strips prefix + trailing punctuation', () => {
  const c = _internals.cleanWikipediaQuery;
  assert.equal(c('wikipedia: Marie Curie'), 'Marie Curie');
  assert.equal(c('what is photosynthesis?'), 'photosynthesis');
  assert.equal(c('什么是光合作用？'), '光合作用');
  assert.equal(c('Who is Marie Curie!'), 'Marie Curie');
  assert.equal(c('  define   photosynthesis  '), 'photosynthesis');
});

test('detectWikiLang picks zh for CJK majority, en otherwise', () => {
  const d = _internals.detectWikiLang;
  assert.equal(d('Marie Curie'), 'en');
  assert.equal(d('居里夫人'), 'zh');
  // Mixed but contains CJK → zh.  Conservative: any CJK presence wins
  // because en.wikipedia rarely has CJK page titles.
  assert.equal(d('Marie 居里'), 'zh');
  assert.equal(d(''), 'en');
});

// ─── fetchFromWikipedia happy path ───────────────────────────────────────────

function mockJsonFetch(routes) {
  // routes: Map<urlSubstring, { status?, json? } | (url) => same>
  return async (url, opts) => {
    if (opts?.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    for (const [match, handler] of routes) {
      if (!url.includes(match)) continue;
      const resp = typeof handler === 'function' ? handler(url, opts) : handler;
      const status = resp.status ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => resp.json ?? {},
      };
    }
    throw new Error(`mockJsonFetch: unmatched URL ${url}`);
  };
}

test('fetchFromWikipedia: search→summary happy path returns shaped result', async () => {
  _setFetchForTests(mockJsonFetch([
    ['list=search', {
      json: {
        query: {
          search: [{ title: 'Marie Curie', snippet: 'Polish-born <span>physicist</span>' }],
        },
      },
    }],
    ['rest_v1/page/summary', {
      json: {
        title: 'Marie Curie',
        description: 'Polish-French physicist and chemist',
        extract: 'Maria Salomea Skłodowska-Curie was a Polish-born physicist...',
        content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Marie_Curie' } },
      },
    }],
  ]));

  const result = await fetchFromWikipedia('who is Marie Curie');
  assert.equal(result.provider, 'wikipedia');
  assert.equal(result.ok, true);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].title, 'Marie Curie');
  assert.equal(result.results[0].url, 'https://en.wikipedia.org/wiki/Marie_Curie');
  assert.equal(result.results[0].snippet, 'Polish-French physicist and chemist');
  // contentMap keyed by final URL with the extract paragraph
  assert.equal(result.contentMap.size, 1);
  assert.match(
    result.contentMap.get('https://en.wikipedia.org/wiki/Marie_Curie'),
    /Maria Salomea/,
  );
  assert.equal(typeof result.latencyMs, 'number');
});

test('fetchFromWikipedia: zh path uses zh.wikipedia host', async () => {
  let observedUrl = '';
  _setFetchForTests(async (url) => {
    observedUrl = url;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        query: { search: [{ title: '光合作用', snippet: '光合' }] },
      }),
    };
  });
  // Only the search call matters here — make summary 404 to skip second call's
  // host check; since the test asserts on the first observed URL it's fine.
  await fetchFromWikipedia('什么是光合作用');
  assert.ok(observedUrl.startsWith('https://zh.wikipedia.org/'), `expected zh host, got ${observedUrl}`);
});

// ─── fetchFromWikipedia failure paths ────────────────────────────────────────

test('fetchFromWikipedia: empty cleaned query → ok=false reason=empty-query', async () => {
  // Setup a fetch that should never be called — assert via throw.
  _setFetchForTests(async () => { throw new Error('fetch should not be called for empty query'); });
  const result = await fetchFromWikipedia('what is   ');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'empty-query');
  assert.equal(result.provider, 'wikipedia');
});

test('fetchFromWikipedia: search HTTP 500 → ok=false reason=http-500', async () => {
  _setFetchForTests(async () => ({ ok: false, status: 500, json: async () => ({}) }));
  const result = await fetchFromWikipedia('who is X');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'http-500');
});

test('fetchFromWikipedia: search returns 0 results → ok=false reason=no-results', async () => {
  _setFetchForTests(mockJsonFetch([
    ['list=search', { json: { query: { search: [] } } }],
  ]));
  const result = await fetchFromWikipedia('who is Nonexistentperson');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-results');
});

test('fetchFromWikipedia: summary 404 soft-degrades to snippet-only result', async () => {
  _setFetchForTests(mockJsonFetch([
    ['list=search', {
      json: { query: { search: [{ title: 'OddPage', snippet: '<i>obscure</i> topic' }] } },
    }],
    ['rest_v1/page/summary', { status: 404, json: {} }],
  ]));
  const result = await fetchFromWikipedia('what is OddPage');
  assert.equal(result.ok, true, 'must still succeed using search snippet');
  assert.equal(result.results[0].title, 'OddPage');
  assert.equal(result.results[0].snippet, 'obscure topic'); // HTML stripped
  assert.equal(result.contentMap.size, 0, 'no extract when summary failed');
});

test('fetchFromWikipedia: pre-aborted signal → ok=false reason=aborted', async () => {
  _setFetchForTests(async (url, opts) => {
    if (opts?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    throw new Error('unexpected: signal should be aborted');
  });
  const ac = new AbortController();
  ac.abort();
  const result = await fetchFromWikipedia('what is X', ac.signal);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'aborted');
});

test('fetchFromWikipedia: thrown network error → ok=false reason=network', async () => {
  _setFetchForTests(async () => { throw new Error('ECONNREFUSED 127.0.0.1:443'); });
  const result = await fetchFromWikipedia('what is X');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'network');
});

// ─── tryApiDirect router ─────────────────────────────────────────────────────

test('tryApiDirect: no-match query returns null (caller falls through)', async () => {
  _setFetchForTests(async () => { throw new Error('fetch should not be called for no-match'); });
  const result = await tryApiDirect('how to cook pasta', null, null);
  assert.equal(result, null);
});

test('tryApiDirect: matching query delegates to provider fetch', async () => {
  _setFetchForTests(mockJsonFetch([
    ['list=search', { json: { query: { search: [{ title: 'X', snippet: 'X' }] } } }],
    ['rest_v1/page/summary', { json: { title: 'X', extract: 'X is a thing.', content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/X' } } } }],
  ]));
  const result = await tryApiDirect('what is X', null, null);
  assert.ok(result, 'expected provider result, got null');
  assert.equal(result.provider, 'wikipedia');
  assert.equal(result.ok, true);
});

test('tryApiDirect: matching query but provider fails returns ok=false (caller falls through)', async () => {
  _setFetchForTests(async () => ({ ok: false, status: 503, json: async () => ({}) }));
  const result = await tryApiDirect('what is X', null, null);
  assert.ok(result, 'provider should still return a result object, not null');
  assert.equal(result.ok, false);
  assert.equal(result.provider, 'wikipedia');
});

// ─── PROVIDERS registry sanity ───────────────────────────────────────────────

test('_internals.PROVIDERS contains wikipedia with required interface', () => {
  const provs = _internals.PROVIDERS;
  assert.ok(Array.isArray(provs));
  assert.ok(provs.length >= 1);
  const wiki = provs.find(p => p.name === 'wikipedia');
  assert.ok(wiki, 'wikipedia provider must be registered');
  assert.equal(typeof wiki.matches, 'function');
  assert.equal(typeof wiki.fetch, 'function');
});
