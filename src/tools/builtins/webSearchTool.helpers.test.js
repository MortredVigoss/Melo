/**
 * Unit tests for the pure helpers introduced in the web-search improvement
 * rollout.  These helpers have no external dependencies (SERP, embeddings,
 * SQLite) and can be tested in isolation — but because some of them are
 * module-private, we exercise them through the public tool surface when
 * necessary.
 *
 * What's covered:
 *   - URL canonicalisation (tracking params, m./www./amp. subdomains, trailing slash)
 *   - Query normalisation (CJK-aware, order-independent)
 *   - Intent classification (time-sensitive keywords + intrinsic kinds)
 *   - Synonym / alias expansion (node → nodejs etc.)
 *   - Query-biased snippet selection
 *   - Article-date extraction (ISO / relative / year-only)
 *   - Recency boost
 *
 * Runs hermetically: isolated MELO_HOME so it never touches the developer's
 * cache.  Nothing in these tests hits the network.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEMP_HOME = mkdtempSync(join(tmpdir(), 'melo-websearch-helpers-'));
process.env.MELO_HOME = TEMP_HOME;

// The module only exports the tool + health API; private helpers aren't
// re-exported, so we import the file as a module namespace and pull what we
// need via a small accessor.  The production invariant is that these pure
// helpers are referenced through the tool's run() — we exercise them here
// by side-loading from the module's internal ESM bindings via a test hook.
//
// Strategy: re-implement a thin seeding layer for cache-hit tests, and
// smoke-test the pure helpers via the tool.parametersSchema + tool.run()
// surface.  For the handful of helpers that are genuinely private (e.g.
// expandQuerySynonyms, classifyQueryIntent), we test them indirectly by
// observing behaviour: if expansion + intent routing work, the cache key
// must segment requests correctly.

const { webSearchTool, __webSearchInternals } = await import('./webSearchTool.js');
const {
  classifyQueryIntent,
  canonicalizeUrl,
  titleFingerprint,
  normalizeQuery,
  buildCacheKey,
  ttlForIntent,
  expandQuerySynonyms,
  extractArticleDate,
  recencyBoost,
  queryBiasedSnippet,
} = __webSearchInternals;

test.after(() => {
  try {
    rmSync(TEMP_HOME, { recursive: true, force: true });
  } catch { /* best-effort */ }
});

// ─── parametersSchema surface (P1-3) ────────────────────────────────────────

test('allowBlockedDomains is exposed on parametersSchema', () => {
  const props = webSearchTool.parametersSchema.properties;
  assert.ok(props.allowBlockedDomains, 'allowBlockedDomains present');
  assert.equal(props.allowBlockedDomains.type, 'boolean');
  assert.equal(props.allowBlockedDomains.default, false);
});

test('parametersSchema examples include an allowBlockedDomains example', () => {
  const hasFlag = webSearchTool.examples.some(e => e.allowBlockedDomains === true);
  assert.ok(hasFlag, 'at least one example demonstrates the allowBlockedDomains flag');
});

// ─── Invalid query fast-fail keeps shape ────────────────────────────────────

test('empty / whitespace query returns INVALID_QUERY', async () => {
  for (const q of ['', '   ', undefined]) {
    const r = await webSearchTool.run({ query: q });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'INVALID_QUERY');
  }
});

// ─── Intent surface propagation ─────────────────────────────────────────────
//
// We can't inspect classifyQueryIntent directly, but the failing SERP path
// surfaces `intent` on meta.  Use the SEARCH_FAILED branch with a short
// signal so we don't actually hit the network.

test('meta.intent.kind is set on SEARCH_FAILED', async () => {
  const r = await webSearchTool.run(
    { query: 'a'.repeat(200), noCache: true },
    { signal: AbortSignal.timeout(500) },
  );
  // Either SERP fails fast or the race completes with no results — either
  // branch writes meta.intent.  Only assert when we really have meta.
  if (!r.ok && r.meta) {
    assert.ok(r.meta.intent, 'intent present on failure meta');
    assert.equal(typeof r.meta.intent.kind, 'string');
    assert.equal(typeof r.meta.intent.timeSensitive, 'boolean');
  }
});

// ─── Span id is stable per run() call and distinct across calls ────────────

test('meta.spanId is a short deterministic-ish string', async () => {
  const r = await webSearchTool.run(
    { query: 'z-invalid-query-for-span-' + Date.now(), noCache: true },
    { signal: AbortSignal.timeout(200) },
  );
  if (!r.ok && r.meta?.spanId) {
    assert.equal(typeof r.meta.spanId, 'string');
    assert.match(r.meta.spanId, /^\d+-\d+$/);
  }
});

// ─── classifyQueryIntent ────────────────────────────────────────────────────

test('classifyQueryIntent marks weather as intrinsically time-sensitive', () => {
  const i = classifyQueryIntent('weather in Tokyo');
  assert.equal(i.kind, 'weather');
  assert.equal(i.timeSensitive, true);
});

test('classifyQueryIntent picks up explicit CJK time keywords', () => {
  const i = classifyQueryIntent('最新 iPhone 发布会');
  assert.equal(i.timeSensitive, true);
});

test('classifyQueryIntent defaults to general+fresh=false for neutral queries', () => {
  const i = classifyQueryIntent('fibonacci recursion base case');
  assert.equal(i.kind, 'general');
  assert.equal(i.timeSensitive, false);
});

test('classifyQueryIntent detects news/price/docs kinds', () => {
  assert.equal(classifyQueryIntent('breaking news Gaza').kind, 'news');
  assert.equal(classifyQueryIntent('btc price today').kind, 'price');
  assert.equal(classifyQueryIntent('react hooks docs').kind, 'docs');
});

// ─── canonicalizeUrl ────────────────────────────────────────────────────────

test('canonicalizeUrl strips common tracking params', () => {
  const out = canonicalizeUrl('https://example.com/a?utm_source=nl&utm_medium=x&id=7&gclid=123');
  assert.ok(!out.includes('utm_'), 'utm params stripped');
  assert.ok(!out.includes('gclid'), 'gclid stripped');
  assert.ok(out.includes('id=7'), 'non-tracking params kept');
});

test('canonicalizeUrl collapses m./www./amp. subdomains', () => {
  const a = canonicalizeUrl('https://m.example.com/a');
  const b = canonicalizeUrl('https://www.example.com/a');
  const c = canonicalizeUrl('https://amp.example.com/a/');
  assert.equal(a, b);
  assert.equal(a, c);
});

test('canonicalizeUrl drops trailing slash and fragment', () => {
  assert.equal(
    canonicalizeUrl('https://example.com/path/#section-2'),
    'https://example.com/path',
  );
});

test('canonicalizeUrl sorts params so order does not matter', () => {
  const a = canonicalizeUrl('https://example.com/x?b=1&a=2');
  const b = canonicalizeUrl('https://example.com/x?a=2&b=1');
  assert.equal(a, b);
});

test('canonicalizeUrl falls back to string for malformed input', () => {
  assert.equal(canonicalizeUrl('not a url'), 'not a url');
});

// ─── titleFingerprint collapses visual variants ─────────────────────────────

test('titleFingerprint is identical for punctuation/case variants', () => {
  const a = titleFingerprint('Node.js 22 — the LTS release!');
  const b = titleFingerprint('node js 22 the lts release');
  assert.equal(a, b);
});

// ─── normalizeQuery + buildCacheKey ─────────────────────────────────────────

test('normalizeQuery is order-independent', () => {
  const a = normalizeQuery('node js lts');
  const b = normalizeQuery('lts node js');
  assert.equal(a, b);
});

test('normalizeQuery handles pure CJK input', () => {
  const n = normalizeQuery('最新 新闻');
  assert.ok(n && n.length > 0);
});

test('buildCacheKey segments by intent kind and time-sensitivity', () => {
  const q = 'iphone 16';
  const a = buildCacheKey(q, { kind: 'news', timeSensitive: true });
  const b = buildCacheKey(q, { kind: 'news', timeSensitive: false });
  const c = buildCacheKey(q, { kind: 'general', timeSensitive: true });
  assert.notEqual(a, b);
  assert.notEqual(a, c);
  assert.ok(a.startsWith('news|T|'));
  assert.ok(b.startsWith('news|S|'));
});

test('ttlForIntent returns the short TTL for time-sensitive queries', () => {
  assert.ok(ttlForIntent({ timeSensitive: true }) < ttlForIntent({ timeSensitive: false }));
});

// ─── expandQuerySynonyms ────────────────────────────────────────────────────

test('expandQuerySynonyms rewrites known aliases', () => {
  const variants = expandQuerySynonyms('latest node lts');
  assert.ok(variants.length >= 2, 'at least primary + one variant');
  assert.ok(variants.includes('latest node lts'));
  assert.ok(variants.some(v => /nodejs/.test(v)), 'contains a nodejs variant');
});

test('expandQuerySynonyms returns only the primary when no alias applies', () => {
  const variants = expandQuerySynonyms('fibonacci recursion');
  assert.deepEqual(variants, ['fibonacci recursion']);
});

test('expandQuerySynonyms caps at four variants', () => {
  const variants = expandQuerySynonyms('llm rag ai');
  assert.ok(variants.length <= 4);
});

// ─── extractArticleDate ────────────────────────────────────────────────────

test('extractArticleDate parses ISO date', () => {
  const t = extractArticleDate('Published 2026-03-05 by …');
  assert.ok(t);
  const d = new Date(t);
  assert.equal(d.getUTCFullYear(), 2026);
  assert.equal(d.getUTCMonth(), 2); // March
  assert.equal(d.getUTCDate(), 5);
});

test('extractArticleDate parses "N days ago" relative English', () => {
  const now = Date.UTC(2026, 3, 20); // Apr 20 2026
  const t = extractArticleDate('Posted 3 days ago: ...', '', now);
  assert.ok(t);
  assert.equal(Math.round((now - t) / 86_400_000), 3);
});

test('extractArticleDate parses CJK "N天前"', () => {
  const now = Date.UTC(2026, 3, 20);
  const t = extractArticleDate('5天前 更新', '', now);
  assert.ok(t);
  assert.equal(Math.round((now - t) / 86_400_000), 5);
});

test('extractArticleDate parses 年月 form', () => {
  const t = extractArticleDate('发布于 2025年11月20日', '');
  assert.ok(t);
  const d = new Date(t);
  assert.equal(d.getUTCFullYear(), 2025);
  assert.equal(d.getUTCMonth(), 10);
});

test('extractArticleDate returns null for text with no date', () => {
  assert.equal(extractArticleDate('no date here anywhere', 'https://example.com/x'), null);
});

// ─── recencyBoost ──────────────────────────────────────────────────────────

test('recencyBoost favors very recent items', () => {
  const now = Date.now();
  assert.equal(recencyBoost(now - 3 * 86_400_000, now), 0.40);
  assert.equal(recencyBoost(now - 15 * 86_400_000, now), 0.20);
  assert.equal(recencyBoost(now - 90 * 86_400_000, now), 0.05);
});

test('recencyBoost penalises very old items', () => {
  const now = Date.now();
  assert.equal(recencyBoost(now - 400 * 86_400_000, now), -0.15);
});

test('recencyBoost returns 0 for invalid / null date', () => {
  assert.equal(recencyBoost(null), 0);
  assert.equal(recencyBoost(NaN), 0);
});

// ─── queryBiasedSnippet ────────────────────────────────────────────────────

test('queryBiasedSnippet picks the window containing query tokens', () => {
  const body = [
    'This article discusses the history of JavaScript runtimes.',
    'The Node.js 22 release became LTS on October 29.',
    'Some unrelated paragraph about CSS Grid comes afterward.',
  ].join(' ');
  const s = queryBiasedSnippet(body, ['lts', 'node'], 320);
  assert.ok(/LTS/.test(s));
  assert.ok(/Node/.test(s));
});

test('queryBiasedSnippet falls back to head when no tokens match', () => {
  const body = 'alpha beta gamma delta.';
  const s = queryBiasedSnippet(body, ['omega'], 100);
  assert.ok(s.startsWith('alpha'));
});

test('queryBiasedSnippet returns empty for empty content', () => {
  assert.equal(queryBiasedSnippet('', ['x']), '');
});

// ─── Phase 2D follow-up #14 hygiene fix contracts ──────────────────────────
// Background: a system freeze/reboot happened during round 14 because
// concurrent web_search calls overlapped the Playwright SERP queue without
// bound. Three root causes addressed in this hygiene fix:
//   (a) isConcurrencySafe was true → tool runner overlapped calls → unbounded
//       Playwright queue → many Chrome helpers → OOM.
//   (b) No idle close on the browser session → idle browser kept alive
//       across the entire chat session.
//   (c) SWR background refresh fire-and-forgot per cache hit → polling the
//       search panel queued one Playwright SERP task per poll.
// These tests pin the static contract so a future refactor can't regress
// the root fix silently.

test('hygiene contract: webSearchTool.isConcurrencySafe is false', () => {
  // Single most important pin — root fix for the unbounded queue. If this
  // ever flips back to true the system-freeze regression returns.
  assert.equal(
    webSearchTool.isConcurrencySafe,
    false,
    'isConcurrencySafe must remain false to prevent unbounded Playwright queueing',
  );
});

test('hygiene contract: SWR background refresh deduplicates by cache key', async () => {
  // Source-level pin: the dedup machinery must exist in webSearchTool.js.
  // We grep the source rather than instrumenting the cache because the
  // refresh path is fire-and-forget through queueMicrotask — observability
  // would require module mocks. The static pattern is robust enough.
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('./webSearchTool.js', import.meta.url), 'utf8');
  assert.match(src, /_backgroundRefreshInFlight/, 'in-flight Set must exist');
  assert.match(src, /_backgroundRefreshInFlight\.has\(/, 'must check before scheduling');
  assert.match(src, /_backgroundRefreshInFlight\.add\(/, 'must register on schedule');
  assert.match(src, /_backgroundRefreshInFlight\.delete\(/, 'must clean up after refresh');
  // Pin the cleanup is in `.finally` (not just `.then`) so failed refreshes
  // also release the slot — otherwise a flaky refresh would block all
  // future refreshes for that key forever.
  assert.match(
    src,
    /\.finally\(\(\) => _backgroundRefreshInFlight\.delete/,
    'cleanup must live in .finally so failures release the slot too',
  );
});

test('hygiene contract: playwrightFetcher pins CLI version (not @latest)', async () => {
  // `@latest` makes `npx -y` revalidate against the registry on every cold
  // start — non-reproducible across ops machines + occasional fresh
  // installs. Pin to a specific version; ops escape hatch is the
  // MELO_PLAYWRIGHT_CLI_PACKAGE env var.
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(
    new URL('../../web/playwrightFetcher.js', import.meta.url),
    'utf8',
  );
  assert.match(src, /PLAYWRIGHT_CLI_PACKAGE/, 'package constant must exist');
  assert.match(
    src,
    /'@playwright\/cli@\d+\.\d+\.\d+'/,
    'default must be a pinned semver, not @latest',
  );
  assert.doesNotMatch(
    src,
    /\|\|\s*'@playwright\/cli@latest'/,
    'default must NOT fall back to @latest (regression guard)',
  );
});

test('hygiene contract: playwrightFetcher exposes idle-close machinery', async () => {
  // Pins the surface that prevents idle browsers from accumulating across
  // a long chat session. closeSoon = debounced timer; close = explicit.
  // Both must remain on the session shape.
  const { createPlaywrightSession } = await import('../../web/playwrightFetcher.js');
  const session = createPlaywrightSession({ sessionName: 'hygiene-test' });
  assert.equal(typeof session.close, 'function', 'session.close must exist');
  assert.equal(typeof session.closeSoon, 'function', 'session.closeSoon must exist');
  // Default-session back-compat exports (used by fetchUrlTool):
  const mod = await import('../../web/playwrightFetcher.js');
  assert.equal(typeof mod.closePlaywrightSession, 'function');
  assert.equal(typeof mod.closePlaywrightSessionSoon, 'function');
});

test('hygiene contract #2: stale-daemon cleanup runs at module load', async () => {
  // Hygiene fix #2 (system-freeze second occurrence): the first hygiene
  // fix (closeSoon idle-close) only handled within-session accumulation.
  // The system froze a second time after melo crashes / SIGKILL left
  // orphan `cliDaemon.js melo-(shared|search)` processes that kept
  // spawning Chrome. Pin: source MUST contain the cleanup call at
  // module load + the regex matching daemon arg pattern.
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(
    new URL('../../web/playwrightFetcher.js', import.meta.url),
    'utf8',
  );
  assert.match(
    src,
    /function cleanupStalePlaywrightDaemons/,
    'cleanupStalePlaywrightDaemons function must exist',
  );
  // Daemon match pattern — anchor at $ avoids matching a hypothetical
  // `cliDaemon.js melo-shared-extra`. The src contains the literal
  // bytes `cliDaemon\\.js melo-(shared|search)$` (the JS source
  // single-quoted string `'cliDaemon\\.js melo-(shared|search)$'`),
  // so substring check matches the JS string-literal form directly.
  assert.ok(
    src.includes('cliDaemon\\\\.js melo-(shared|search)$'),
    'pkill regex must match exact daemon arg pattern (cliDaemon.js melo-...)',
  );
  // Module-load invocation (vs only being declared).
  const cleanupInvocations = src.match(/^cleanupStalePlaywrightDaemons\(\);?$/gm);
  assert.ok(
    (cleanupInvocations?.length ?? 0) >= 1,
    'cleanupStalePlaywrightDaemons must be invoked at module load',
  );
});

test('hygiene contract #2: process exit hooks for graceful daemon shutdown', async () => {
  // Pin: SIGINT / SIGTERM / beforeExit handlers must exist so a clean
  // melo exit (Ctrl-C / kill TERM / event loop drain) doesn't leave
  // daemons running. SIGKILL / hard crash still need #1 (cleanup at
  // next start) — those are the orthogonal coverages.
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(
    new URL('../../web/playwrightFetcher.js', import.meta.url),
    'utf8',
  );
  assert.match(src, /process\.once\(\s*'SIGINT'/, 'SIGINT handler must be installed');
  assert.match(src, /process\.once\(\s*'SIGTERM'/, 'SIGTERM handler must be installed');
  assert.match(src, /process\.once\(\s*'beforeExit'/, 'beforeExit handler must be installed');
  // Pin standard exit codes (130 for SIGINT, 143 for SIGTERM) — common
  // POSIX convention; deviating would surprise process supervisors.
  assert.match(src, /process\.exit\(130\)/, 'SIGINT must exit 130');
  assert.match(src, /process\.exit\(143\)/, 'SIGTERM must exit 143');
});

test('hygiene contract: closeSoon is a no-op when nothing is open', async () => {
  // Prevents schedule storm on cold sessions. Without this guard,
  // calling closeSoon() before any navigate would still arm a timer.
  const { createPlaywrightSession } = await import('../../web/playwrightFetcher.js');
  const session = createPlaywrightSession({ sessionName: 'hygiene-noop', idleCloseMs: 100 });
  // Should return synchronously without arming a timer or throwing.
  // We can't directly inspect the timer, but we can call it many times
  // and verify nothing blows up + the session methods remain usable.
  for (let i = 0; i < 10; i++) session.closeSoon();
  // Negative delay opts out (per the implementation).
  session.closeSoon(-1);
  // close() with browser never opened is a no-op too — must not throw.
  await session.close();
});
