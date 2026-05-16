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
  hnMatchKind,
  fetchFromHN,
  arxivMatchKind,
  fetchFromArxiv,
  githubMatchKind,
  fetchFromGitHub,
  stackOverflowMatchKind,
  fetchFromStackOverflow,
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

// ─── Time-sensitive gate (Codex G-2b round-5 闭环) ──────────────────────────

test('wikipediaMatchKind: explicit prefix returns "explicit"', () => {
  const k = _internals.wikipediaMatchKind;
  assert.equal(k('wikipedia: Marie Curie'), 'explicit');
  assert.equal(k('wiki: Marie Curie'), 'explicit');
  assert.equal(k('维基百科：居里夫人'), 'explicit');
  assert.equal(k('维基: 居里夫人'), 'explicit');
});

test('wikipediaMatchKind: definition shape returns "implicit"', () => {
  const k = _internals.wikipediaMatchKind;
  assert.equal(k('what is photosynthesis'), 'implicit');
  assert.equal(k('who is Marie Curie'), 'implicit');
  assert.equal(k('define photosynthesis'), 'implicit');
  assert.equal(k('什么是光合作用'), 'implicit');
  assert.equal(k('谁是居里夫人'), 'implicit');
});

test('wikipediaMatchKind: non-matches return false', () => {
  const k = _internals.wikipediaMatchKind;
  assert.equal(k('best restaurants in tokyo'), false);
  assert.equal(k(''), false);
  assert.equal(k(null), false);
});

test('tryApiDirect: implicit + intent.timeSensitive → skipped (NO Wikipedia hit)', async () => {
  _setFetchForTests(async () => { throw new Error('fetch must NOT be called when time-sensitive gate fires'); });
  const result = await tryApiDirect(
    'what is the latest Node.js version',
    { kind: 'general', timeSensitive: true },
    null,
  );
  assert.ok(result, 'expected gate-skip result object, got null');
  assert.equal(result.ok, false);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'time-sensitive');
  assert.equal(result.provider, 'wikipedia');
  assert.equal(result.latencyMs, 0, 'gate-skip must not pay any latency');
});

test('tryApiDirect: implicit + intent.timeSensitive (Chinese latest/最新) → skipped', async () => {
  _setFetchForTests(async () => { throw new Error('fetch must NOT be called'); });
  const result = await tryApiDirect(
    '什么是最新的 React 框架',
    { kind: 'general', timeSensitive: true },
    null,
  );
  assert.equal(result?.skipped, true);
  assert.equal(result?.reason, 'time-sensitive');
});

test('tryApiDirect: implicit + intent.timeSensitive=false → fetches normally', async () => {
  _setFetchForTests(mockJsonFetch([
    ['list=search', { json: { query: { search: [{ title: 'Photosynthesis', snippet: 'Plant chemistry' }] } } }],
    ['rest_v1/page/summary', { json: { title: 'Photosynthesis', extract: 'Photosynthesis converts light...', content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Photosynthesis' } } } }],
  ]));
  const result = await tryApiDirect(
    'what is photosynthesis',
    { kind: 'general', timeSensitive: false },
    null,
  );
  assert.equal(result?.ok, true);
  assert.equal(result?.skipped, undefined, 'implicit + not time-sensitive must NOT be gated');
});

test('tryApiDirect: explicit prefix + intent.timeSensitive → fetches anyway (user-intent override)', async () => {
  // User explicitly asked for Wikipedia even though query contains "latest".
  // The gate must defer to user intent here — Wikipedia stub returned even
  // if the data is stale; user can re-query without `wiki:` to force SERP.
  let fetchCalled = false;
  _setFetchForTests(mockJsonFetch([
    ['list=search', () => { fetchCalled = true; return { json: { query: { search: [{ title: 'X', snippet: 'X' }] } } }; }],
    ['rest_v1/page/summary', { json: { title: 'X', extract: 'X is a thing.', content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/X' } } } }],
  ]));
  const result = await tryApiDirect(
    'wiki: latest Node.js version',
    { kind: 'general', timeSensitive: true },
    null,
  );
  assert.equal(fetchCalled, true, 'explicit prefix must override time-sensitive gate');
  assert.equal(result?.ok, true);
  assert.equal(result?.skipped, undefined);
});

test('tryApiDirect: no intent passed → treats as non-time-sensitive (defensive default)', async () => {
  _setFetchForTests(mockJsonFetch([
    ['list=search', { json: { query: { search: [{ title: 'X', snippet: 'X' }] } } }],
    ['rest_v1/page/summary', { json: { title: 'X', extract: 'X.', content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/X' } } } }],
  ]));
  const result = await tryApiDirect('what is X', null, null);
  assert.equal(result?.ok, true, 'missing intent must not block legitimate matches');
});

// ─── PROVIDERS registry sanity ───────────────────────────────────────────────

test('_internals.PROVIDERS contains wikipedia with required interface (matchKind + fetch)', () => {
  const provs = _internals.PROVIDERS;
  assert.ok(Array.isArray(provs));
  assert.ok(provs.length >= 1);
  const wiki = provs.find(p => p.name === 'wikipedia');
  assert.ok(wiki, 'wikipedia provider must be registered');
  assert.equal(typeof wiki.matchKind, 'function');
  assert.equal(typeof wiki.fetch, 'function');
});

test('_internals.PROVIDERS contains all expected providers with matchKind+fetch', () => {
  const provs = _internals.PROVIDERS;
  const expected = ['wikipedia', 'hackernews', 'arxiv', 'github', 'stackoverflow'];
  for (const name of expected) {
    const p = provs.find(x => x.name === name);
    assert.ok(p, `provider ${name} must be registered`);
    assert.equal(typeof p.matchKind, 'function', `${name}.matchKind must be a function`);
    assert.equal(typeof p.fetch, 'function', `${name}.fetch must be a function`);
  }
});

// ─── HN Algolia provider ─────────────────────────────────────────────────────

test('hnMatchKind: explicit prefix + phrase matches return "explicit"', () => {
  assert.equal(hnMatchKind('hn: rust async'), 'explicit');
  assert.equal(hnMatchKind('hackernews: rust async'), 'explicit');
  assert.equal(hnMatchKind('hacker news: rust async'), 'explicit');
  assert.equal(hnMatchKind('hacker news discussion on AI safety'), 'explicit');
  assert.equal(hnMatchKind('hn comments on Linux kernel'), 'explicit');
  assert.equal(hnMatchKind('what people on hacker news say about Rust'), 'explicit');
});

test('hnMatchKind: non-matching queries return false', () => {
  assert.equal(hnMatchKind('rust async tutorial'), false);
  assert.equal(hnMatchKind('hn'), false, 'bare "hn" without context should not match');
  assert.equal(hnMatchKind(''), false);
  assert.equal(hnMatchKind(null), false);
});

test('cleanHnQuery strips prefix + phrase noise', () => {
  const c = _internals.cleanHnQuery;
  assert.equal(c('hn: rust async'), 'rust async');
  assert.equal(c('hacker news discussion on AI safety'), 'AI safety');
  assert.equal(c('hn comments on Linux kernel'), 'Linux kernel');
  assert.equal(c('what hacker news thinks about Rust'), 'what thinks about Rust');
});

test('fetchFromHN: happy path returns shaped results', async () => {
  _setFetchForTests(async (url) => {
    assert.match(url, /hn\.algolia\.com\/api\/v1\/search/, 'expected HN Algolia URL');
    return {
      ok: true, status: 200,
      json: async () => ({
        hits: [
          {
            objectID: '12345',
            title: 'Show HN: Rust async runtime',
            url: 'https://example.com/rust-async',
            points: 240,
            num_comments: 89,
            created_at: '2026-05-10T08:00:00Z',
            story_text: 'A new async runtime for Rust...',
          },
        ],
      }),
    };
  });
  const result = await fetchFromHN('hn: rust async');
  assert.equal(result.provider, 'hackernews');
  assert.equal(result.ok, true);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].title, 'Show HN: Rust async runtime');
  assert.equal(result.results[0].url, 'https://news.ycombinator.com/item?id=12345');
  assert.match(result.results[0].snippet, /240 points · 89 comments/);
  assert.equal(result.contentMap.size, 1);
});

test('fetchFromHN: no hits → no-results', async () => {
  _setFetchForTests(async () => ({ ok: true, status: 200, json: async () => ({ hits: [] }) }));
  const result = await fetchFromHN('hn: obscure xyz');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-results');
});

test('fetchFromHN: HTTP error → http-NNN reason', async () => {
  _setFetchForTests(async () => ({ ok: false, status: 503, json: async () => ({}) }));
  const result = await fetchFromHN('hn: rust');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'http-503');
});

// ─── arXiv provider (via Semantic Scholar) ───────────────────────────────────

test('arxivMatchKind: explicit prefix + site mention return "explicit"', () => {
  // User named arXiv directly — bypass the time-sensitive gate.
  assert.equal(arxivMatchKind('arxiv: attention is all you need'), 'explicit');
  assert.equal(arxivMatchKind('arxiv:1706.03762'), 'explicit');
  assert.equal(arxivMatchKind('arxiv paper on transformer'), 'explicit');
  assert.equal(arxivMatchKind('search arxiv for transformer'), 'explicit');
});

test('arxivMatchKind: academic phrasing without site mention return "implicit" (gated by time-sensitive)', () => {
  // Academic intent but didn't name arXiv — flows through the
  // time-sensitive gate per Codex G-2b round-6 (2026-05-16) decision.
  assert.equal(arxivMatchKind('paper on transformer architecture'), 'implicit');
  assert.equal(arxivMatchKind('research on reinforcement learning'), 'implicit');
  assert.equal(arxivMatchKind('research about quantum computing'), 'implicit');
  assert.equal(arxivMatchKind('paper about LLM scaling'), 'implicit');
  assert.equal(arxivMatchKind('transformer 论文'), 'implicit');
  assert.equal(arxivMatchKind('关于 attention 的论文'), 'implicit');
});

test('arxivMatchKind: non-matching queries return false', () => {
  assert.equal(arxivMatchKind('transformer architecture'), false);
  assert.equal(arxivMatchKind('what is a transformer'), false, 'bare "what is" routes to Wikipedia not arXiv');
  assert.equal(arxivMatchKind(''), false);
});

test('tryApiDirect: arXiv implicit + intent.timeSensitive → skipped (NO arXiv fetch)', async () => {
  // The Codex G-2b round-6 (2026-05-16) regression: "latest research on AI
  // safety" used to short-circuit SERP into arXiv where the data is
  // necessarily behind the preprint cycle.  Now gated.
  _setFetchForTests(async () => { throw new Error('fetch must NOT be called when time-sensitive gate fires for arXiv'); });
  const result = await tryApiDirect(
    'latest research on AI safety',
    { kind: 'general', timeSensitive: true },
    null,
  );
  assert.ok(result, 'expected gate-skip result object, got null');
  assert.equal(result.ok, false);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'time-sensitive');
  assert.equal(result.provider, 'arxiv');
});

test('tryApiDirect: arXiv implicit + intent.timeSensitive (current/今天) → skipped', async () => {
  _setFetchForTests(async () => { throw new Error('fetch must NOT be called'); });
  const en = await tryApiDirect(
    'current research on quantum computing',
    { kind: 'general', timeSensitive: true },
    null,
  );
  assert.equal(en?.skipped, true);
  assert.equal(en?.provider, 'arxiv');
  const zh = await tryApiDirect(
    '最新的 transformer 论文',
    { kind: 'general', timeSensitive: true },
    null,
  );
  assert.equal(zh?.skipped, true);
  assert.equal(zh?.provider, 'arxiv');
});

test('tryApiDirect: arXiv explicit + intent.timeSensitive → fetches anyway (user override)', async () => {
  // User explicitly said `arxiv:` — that's an override of the gate.
  let fetchCalled = false;
  _setFetchForTests(mockJsonFetch([
    ['semanticscholar.org/graph/v1/paper/search', () => {
      fetchCalled = true;
      return { json: { data: [{ title: 'X', externalIds: { ArXiv: '2024.0001' } }] } };
    }],
  ]));
  const result = await tryApiDirect(
    'arxiv: latest transformer research',
    { kind: 'general', timeSensitive: true },
    null,
  );
  assert.equal(fetchCalled, true, 'explicit arXiv prefix must override time-sensitive gate');
  assert.equal(result?.ok, true);
});

test('fetchFromArxiv: filters Semantic Scholar results to arXiv-only papers', async () => {
  _setFetchForTests(async (url) => {
    assert.match(url, /api\.semanticscholar\.org\/graph\/v1\/paper\/search/);
    return {
      ok: true, status: 200,
      json: async () => ({
        data: [
          {
            title: 'Attention Is All You Need',
            authors: [{ name: 'Vaswani' }, { name: 'Shazeer' }, { name: 'Parmar' }, { name: 'Uszkoreit' }],
            abstract: 'The dominant sequence transduction models...',
            year: 2017,
            externalIds: { ArXiv: '1706.03762', DOI: '10.5555/3295222' },
          },
          {
            title: 'Not on arXiv',
            authors: [{ name: 'X' }],
            abstract: 'irrelevant',
            year: 2020,
            externalIds: { DOI: '10.1000/abcd' }, // no ArXiv — must be filtered out
          },
        ],
      }),
    };
  });
  const result = await fetchFromArxiv('paper on transformer');
  assert.equal(result.ok, true);
  assert.equal(result.results.length, 1, 'non-arXiv paper must be filtered');
  assert.equal(result.results[0].title, 'Attention Is All You Need');
  assert.equal(result.results[0].url, 'https://arxiv.org/abs/1706.03762');
  assert.match(result.results[0].snippet, /\(2017\) · Vaswani, Shazeer, Parmar et al\./);
  assert.match(result.contentMap.get('https://arxiv.org/abs/1706.03762'), /dominant sequence/);
});

test('fetchFromArxiv: all results lack ArXiv id → no-results', async () => {
  _setFetchForTests(async () => ({
    ok: true, status: 200,
    json: async () => ({ data: [{ title: 'X', externalIds: { DOI: 'x' } }] }),
  }));
  const result = await fetchFromArxiv('arxiv: nonexistent');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-results');
});

// ─── GitHub provider ─────────────────────────────────────────────────────────

test('githubMatchKind: explicit prefix + phrase matches return "explicit"', () => {
  assert.equal(githubMatchKind('github: vue.js'), 'explicit');
  assert.equal(githubMatchKind('gh: vue.js'), 'explicit');
  assert.equal(githubMatchKind('github repo for vue.js'), 'explicit');
  assert.equal(githubMatchKind('vue.js on github'), 'explicit');
  assert.equal(githubMatchKind('gh repo vue'), 'explicit');
});

test('githubMatchKind: non-matching queries return false', () => {
  assert.equal(githubMatchKind('vue.js tutorial'), false);
  assert.equal(githubMatchKind('git push fails'), false, 'bare "git" must not match GitHub provider');
  assert.equal(githubMatchKind(''), false);
});

test('fetchFromGitHub: happy path returns repo list', async () => {
  _setFetchForTests(async (url, opts) => {
    assert.match(url, /api\.github\.com\/search\/repositories/);
    assert.equal(opts?.headers?.Accept, 'application/vnd.github+json');
    return {
      ok: true, status: 200,
      json: async () => ({
        items: [
          {
            full_name: 'vuejs/vue',
            html_url: 'https://github.com/vuejs/vue',
            description: 'A progressive, incrementally-adoptable framework',
            stargazers_count: 207000,
            language: 'JavaScript',
            updated_at: '2026-05-15T00:00:00Z',
          },
        ],
      }),
    };
  });
  const result = await fetchFromGitHub('github: vue');
  assert.equal(result.ok, true);
  assert.equal(result.results[0].title, 'vuejs/vue');
  assert.equal(result.results[0].url, 'https://github.com/vuejs/vue');
  assert.match(result.results[0].snippet, /★ 207000/);
  assert.match(result.results[0].snippet, /JavaScript/);
  assert.match(result.contentMap.get('https://github.com/vuejs/vue'), /progressive/);
});

test('fetchFromGitHub: HTTP 403 (rate limited) → http-403', async () => {
  _setFetchForTests(async () => ({ ok: false, status: 403, json: async () => ({}) }));
  const result = await fetchFromGitHub('github: rate-limit-test');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'http-403');
});

// ─── Stack Overflow provider ────────────────────────────────────────────────

test('stackOverflowMatchKind: explicit prefix + phrase matches return "explicit"', () => {
  assert.equal(stackOverflowMatchKind('stackoverflow: javascript closure'), 'explicit');
  assert.equal(stackOverflowMatchKind('stack overflow: javascript closure'), 'explicit');
  assert.equal(stackOverflowMatchKind('javascript closure on stack overflow'), 'explicit');
});

test('stackOverflowMatchKind: non-matching + ambiguous "so:" return false', () => {
  assert.equal(stackOverflowMatchKind('javascript closure'), false);
  assert.equal(stackOverflowMatchKind('so: I went home'), false, '"so:" must not match — too generic');
  assert.equal(stackOverflowMatchKind(''), false);
});

test('fetchFromStackOverflow: decodes HTML entities in title', async () => {
  _setFetchForTests(async (url) => {
    assert.match(url, /api\.stackexchange\.com\/2\.3\/search\/advanced/);
    assert.match(url, /site=stackoverflow/);
    return {
      ok: true, status: 200,
      json: async () => ({
        items: [
          {
            title: 'What does &quot;use strict&quot; do in JavaScript &amp; why?',
            link: 'https://stackoverflow.com/q/1335851',
            score: 7800,
            answer_count: 30,
            is_answered: true,
            tags: ['javascript', 'syntax', 'strict-mode'],
          },
        ],
      }),
    };
  });
  const result = await fetchFromStackOverflow('stack overflow javascript strict');
  assert.equal(result.ok, true);
  assert.equal(
    result.results[0].title,
    'What does "use strict" do in JavaScript & why?',
    'HTML entities must be decoded',
  );
  assert.match(result.results[0].snippet, /↑ 7800/);
  assert.match(result.results[0].snippet, /✓ answered/);
  assert.match(result.results[0].snippet, /tags: javascript, syntax, strict-mode/);
});

// ─── Router cross-provider ──────────────────────────────────────────────────

test('tryApiDirect: HN-shaped query routes to hackernews', async () => {
  _setFetchForTests(async (url) => {
    assert.match(url, /hn\.algolia\.com/);
    return {
      ok: true, status: 200,
      json: async () => ({ hits: [{ objectID: '1', title: 'T', points: 1, num_comments: 0 }] }),
    };
  });
  const result = await tryApiDirect('hacker news rust async', null, null);
  assert.equal(result?.provider, 'hackernews');
  assert.equal(result?.ok, true);
});

test('tryApiDirect: GitHub-shaped query routes to github', async () => {
  _setFetchForTests(async (url) => {
    assert.match(url, /api\.github\.com/);
    return {
      ok: true, status: 200,
      json: async () => ({ items: [{ full_name: 'x/y', html_url: 'https://github.com/x/y' }] }),
    };
  });
  const result = await tryApiDirect('github: vue', null, null);
  assert.equal(result?.provider, 'github');
  assert.equal(result?.ok, true);
});

test('tryApiDirect: provider order — wikipedia explicit wins over a query that also could match phrases', async () => {
  // `wiki: hacker news ranking` contains both an explicit wiki prefix AND
  // the "hacker news" phrase.  Provider order puts Wikipedia first, so it
  // claims the query and HN is never consulted.  This is the right
  // behavior: explicit prefix is the strongest signal.
  _setFetchForTests(async (url) => {
    assert.match(url, /wikipedia\.org/, 'must route to Wikipedia, not HN');
    return {
      ok: true, status: 200,
      json: async () => ({ query: { search: [{ title: 'X', snippet: '' }] } }),
    };
  });
  const result = await tryApiDirect('wiki: hacker news ranking', null, null);
  assert.equal(result?.provider, 'wikipedia');
});
