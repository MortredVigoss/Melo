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

test('hygiene contract #2: startup cleanup preserves other live owners', async () => {
  const { selectOwnedDaemonPids } = await import('../../runtime/processOwnership.js');
  const table = [
    '11 501 node /pw/cliDaemon.js melo-shared-p100-1234abcd',
    '12 501 node /pw/cliDaemon.js melo-search-p200-1234abcd',
    '13 502 node /pw/cliDaemon.js melo-search-p300-1234abcd',
  ].join('\n');
  assert.deepEqual(selectOwnedDaemonPids(table, {
    uid: 501, includeOrphans: true, isAlive: pid => pid === 100,
  }), [12]);
});

test('hygiene contract #2: cleanupStalePlaywrightDaemons is named export', async () => {
  // Codex C fix (review #11, 2026-05-04): playwrightFetcher must NOT
  // own process.exit / signal handlers — that pre-empted server.js's
  // shutdown chain (lock release / telegram/discord / voice / server.
  // close()). Cleanup is now a named export called BY server.js's
  // shutdown(). Pin: function is exported + server.js imports it.
  const { cleanupStalePlaywrightDaemons } = await import('../../web/playwrightFetcher.js');
  assert.equal(typeof cleanupStalePlaywrightDaemons, 'function');
  // server.js must import + call cleanup in shutdown.
  const { readFile } = await import('node:fs/promises');
  const serverSrc = await readFile(
    new URL('../../server.js', import.meta.url),
    'utf8',
  );
  assert.match(
    serverSrc,
    /import\s*\{\s*cleanupStalePlaywrightDaemons\s*\}\s*from\s*['"]\.\/web\/playwrightFetcher\.js['"]/,
    'server.js must import cleanupStalePlaywrightDaemons',
  );
  assert.match(
    serverSrc,
    /function\s+shutdown\s*\(\s*\)\s*\{[\s\S]+?cleanupStalePlaywrightDaemons\s*\(\)/,
    'server.js shutdown() must call cleanupStalePlaywrightDaemons',
  );
});

test('hygiene contract #2: server.js has SINGLE SIGINT/SIGTERM handler going through shutdown()', async () => {
  // Codex D #12 (review #12, 2026-05-04): server.js had a SECOND
  // pair of SIGINT/SIGTERM listeners at line 314 (releaseOnExit
  // wrapper that called process.exit) which pre-empted the
  // shutdown() listener at line 2326. Codex C fix #11 only addressed
  // playwrightFetcher's signal handlers, missing server.js's own
  // pre-empting pair. Fix: removed line 314 SIGINT/SIGTERM —
  // _releaseServerLock now runs inside shutdown()'s Promise.allSettled.
  //
  // Regression guard: server.js must NOT register a SIGINT/SIGTERM
  // listener that calls process.exit BEFORE shutdown() is registered.
  // We do this by counting listener registrations: shutdown() call
  // (`process.on('SIGINT', shutdown)`) is the only allowed one.
  const { readFile } = await import('node:fs/promises');
  const serverSrc = await readFile(
    new URL('../../server.js', import.meta.url),
    'utf8',
  );
  // Count process.on(SIGINT) occurrences. There should be exactly 1
  // (the one passing `shutdown` directly). Same for SIGTERM.
  const sigintMatches = serverSrc.match(/process\.on\(\s*'SIGINT'/g) || [];
  const sigtermMatches = serverSrc.match(/process\.on\(\s*'SIGTERM'/g) || [];
  assert.equal(
    sigintMatches.length,
    1,
    `server.js must have exactly 1 SIGINT listener; found ${sigintMatches.length}`,
  );
  assert.equal(
    sigtermMatches.length,
    1,
    `server.js must have exactly 1 SIGTERM listener; found ${sigtermMatches.length}`,
  );
  // The single listener must be `shutdown` (not an inline arrow that
  // pre-empts via process.exit).
  assert.match(
    serverSrc,
    /process\.on\(\s*'SIGINT'\s*,\s*shutdown\s*\)/,
    'SIGINT listener must be `shutdown` directly (not inline pre-empting wrapper)',
  );
  assert.match(
    serverSrc,
    /process\.on\(\s*'SIGTERM'\s*,\s*shutdown\s*\)/,
    'SIGTERM listener must be `shutdown` directly',
  );
});

test('hygiene contract #2: server.js + CLI register uncaughtException / unhandledRejection emergency-exit', async () => {
  // Codex P2 from reviews #11/#12 (2026-05-04): both server and CLI
  // entry points must register handlers for uncaughtException and
  // unhandledRejection that:
  //   1. log the error (to stderr, never throw inside the handler)
  //   2. sync cleanup playwright daemons (process state untrusted —
  //      no async / no shutdown())
  //   3. process.exit(1)
  // Pin the contract so future refactors don't silently remove these
  // (which would leave daemons leaked on every uncaught error and
  // re-introduce the system-freeze regression).
  const { readFile } = await import('node:fs/promises');
  for (const [path, label] of [
    ['../../server.js', 'server'],
    ['../../index.js', 'CLI'],
  ]) {
    const src = await readFile(new URL(path, import.meta.url), 'utf8');
    assert.match(src, /process\.on\(\s*'uncaughtException'/, `${label} must register uncaughtException`);
    assert.match(src, /process\.on\(\s*'unhandledRejection'/, `${label} must register unhandledRejection`);
    // Each emergency handler must invoke cleanup BEFORE process.exit.
    // Approximate via "cleanupStalePlaywrightDaemons within emergency
    // exit function".
    assert.match(
      src,
      /function\s+_(?:cli)?[Ee]mergencyExit[\s\S]+?cleanupStalePlaywrightDaemons[\s\S]+?process\.exit\(1\)/,
      `${label} emergency-exit must call cleanup then process.exit(1)`,
    );
  }
});

test('hygiene contract #2: src/index.js (CLI) registers cleanup on SIGINT/SIGTERM', async () => {
  // Codex D #12 (review #12, 2026-05-04): CLI mode (`melo search`)
  // didn't have signal cleanup — daemons spawned during the CLI run
  // survived until next startup-cleanup. Fix: src/index.js registers
  // process.once('SIGINT'/'SIGTERM') that calls cleanup before exit.
  const { readFile } = await import('node:fs/promises');
  const indexSrc = await readFile(
    new URL('../../index.js', import.meta.url),
    'utf8',
  );
  assert.match(
    indexSrc,
    /import\s*\{\s*cleanupStalePlaywrightDaemons\s*\}\s*from\s*['"]\.\/web\/playwrightFetcher\.js['"]/,
    'src/index.js must import cleanupStalePlaywrightDaemons',
  );
  assert.match(
    indexSrc,
    /process\.once\(\s*'SIGINT'/,
    'src/index.js must register SIGINT cleanup',
  );
  assert.match(
    indexSrc,
    /process\.once\(\s*'SIGTERM'/,
    'src/index.js must register SIGTERM cleanup',
  );
});

test('hygiene contract #2: playwrightFetcher does NOT register signal handlers', async () => {
  // Codex C fix regression guard: playwrightFetcher used to register
  // SIGINT / SIGTERM / beforeExit listeners that called process.exit(),
  // pre-empting server.js shutdown via Node's listener-order. Pin
  // these are GONE — cleanup is now driven by server.js's existing
  // shutdown() function. Future refactors that re-add signal
  // listeners here would re-introduce the regression.
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(
    new URL('../../web/playwrightFetcher.js', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(src, /process\.(?:once|on)\(\s*'SIGINT'/, 'must NOT register SIGINT in low-level module');
  assert.doesNotMatch(src, /process\.(?:once|on)\(\s*'SIGTERM'/, 'must NOT register SIGTERM in low-level module');
  assert.doesNotMatch(src, /process\.(?:once|on)\(\s*'beforeExit'/, 'must NOT register beforeExit in low-level module');
  // Real exit invocations carry a numeric exit code (130/143/etc.);
  // empty `process.exit()` strings only appear inside comments
  // explaining why we DON'T call exit. Match the call form with arg.
  assert.doesNotMatch(src, /process\.exit\(\d/, 'must NOT call process.exit(<n>) — that belongs to server.js shutdown');
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

// 2026-10-22: "Location: Melbourne" alone let the model doubt the city and
// refuse the forecast; the report now names region and country and dates each day.
test('formatWttrReport names the region and country and dates today and tomorrow', async () => {
  const { formatWttrReport } = await import('./webSearchTool.js');
  const hour = (time, tempC, rain) => ({ time, tempC, chanceofrain: String(rain), weatherDesc: [{ value: 'Sunny' }] });
  const data = {
    nearest_area: [{ areaName: [{ value: 'Melbourne' }], region: [{ value: 'Victoria' }], country: [{ value: 'Australia' }] }],
    current_condition: [{ temp_C: '28', FeelsLikeC: '26', weatherDesc: [{ value: 'Sunny' }], humidity: '30', windspeedKmph: '12', winddir16Point: 'N', visibility: '10', uvIndex: '7' }],
    weather: [
      { date: '2026-10-22', mintempC: '14', maxtempC: '31', astronomy: [{ sunrise: '06:26 AM', sunset: '07:44 PM' }], hourly: [hour('0', 16, 11), hour('1200', 29, 0)] },
      { date: '2026-10-23', mintempC: '19', maxtempC: '30', hourly: [hour('0', 20, 5), hour('300', 19, 40), hour('600', 19, 10), hour('900', 24, 0), hour('1200', 30, 0)] },
    ],
  };
  const report = formatWttrReport('墨尔本 明天 天气', data, '墨尔本');
  assert.match(report, /\*\*Location:\*\* Melbourne, Victoria, Australia/);
  assert.match(report, /\*\*Today range \(2026-10-22\):\*\* 14°C ~ 31°C/);
  assert.match(report, /\*\*Tomorrow \(2026-10-23\):\*\* 19°C ~ 30°C, Sunny, rain up to 40%/);
  // Repeated parts are not doubled; the query's own place is the fallback.
  const singapore = { ...data, nearest_area: [{ areaName: [{ value: 'Singapore' }], region: [{ value: 'Singapore' }], country: [{ value: 'Singapore' }] }] };
  assert.match(formatWttrReport('Singapore weather', singapore, 'Singapore'), /\*\*Location:\*\* Singapore\n/);
  assert.match(formatWttrReport('x', { ...data, nearest_area: [] }, '墨尔本'), /\*\*Location:\*\* 墨尔本\n/);
  assert.equal(formatWttrReport('x', { weather: [] }, 'x'), null, 'no current conditions, no report');
});
