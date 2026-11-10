import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchUrlTool, hedgedRead } from './fetchUrlTool.js';

// 2026-11-10 latency audit L5: one page read through Jina took 21.7 s while the
// same host answered a direct request in about a second. The auto chain now
// starts the direct read alongside a Jina request that has not answered after
// the hedge delay. Jina's rendered page stays the preferred read of an HTML
// page for a grace period; a resource that is not HTML is used at once. The
// counters below prove which requests were really sent and which was aborted.

const article = 'Forecast for tomorrow: partly cloudy, 15 to 19 degrees. '.repeat(60);
const looksEmpty = content => !content || content.replace(/\s+/g, '').length < 120;
const waitUnlessAborted = (ms, signal, value) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => resolve(value), ms);
  signal.addEventListener('abort', () => { clearTimeout(timer); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true });
});
const limits = { operationalLimits: { search: { fetchHedgeMs: 60, fetchHedgeGraceMs: 200 } } };
const run = (extra = {}) => fetchUrlTool.run({ url: 'https://fixture.invalid/forecast' }, { config: limits, ...extra });
const tiers = result => result.evidenceTrail.filter(entry => ['jina', 'direct'].includes(entry.tier)).map(entry => [entry.tier, entry.outcome, entry.reason]);

test('a fast Jina answer never starts the direct read', async () => {
  let jina = 0, direct = 0;
  const result = await run({ _fetchViaJina: async () => { jina++; return article; }, _fetchDirect: async () => { direct++; return article; } });
  assert.equal(result.ok, true);
  assert.deepEqual([jina, direct], [1, 0]);
  assert.equal(result.meta.method, 'jina');
  assert.deepEqual(tiers(result), [['jina', 'ok', undefined]]);
});

test('a Jina read that stays silent past the grace period is replaced by the direct page and aborted', async () => {
  let jina = 0, direct = 0, jinaAborted = false, jinaFinished = false;
  const started = Date.now();
  const result = await run({
    _fetchViaJina: async (url, signal) => { jina++; signal.addEventListener('abort', () => { jinaAborted = true; }, { once: true }); const value = await waitUnlessAborted(5000, signal, article); jinaFinished = true; return value; },
    _fetchDirect: async () => { direct++; return 'DIRECT ' + article; },
  });
  const elapsed = Date.now() - started;
  assert.equal(result.ok, true);
  assert.deepEqual([jina, direct], [1, 1]);
  assert.match(result.output, /^DIRECT /);
  assert.equal(result.meta.method, 'direct');
  assert.equal(jinaAborted, true, 'the losing Jina request is aborted');
  assert.equal(jinaFinished, false);
  assert.equal(elapsed >= 200 && elapsed < 2000, true, `the read waits for the grace period and no longer: ${elapsed}`);
  // The request Melo gave up on is recorded as aborted: the trail must not show a failed tier in the failure colour.
  assert.deepEqual(tiers(result), [['jina', 'aborted', 'slow'], ['direct', 'ok', undefined]]);
  assert.equal(result.evidenceTrail.find(entry => entry.tier === 'direct').extra.hedged, true);
});

test('within the grace period Jina\'s rendered page is preferred over a direct page that already arrived', async () => {
  // A direct read of a script-driven site extracts its navigation, however long; the rendered page is the better read.
  let direct = 0, directAborted = false;
  const result = await run({
    _fetchViaJina: async (url, signal) => waitUnlessAborted(140, signal, 'JINA ' + article),
    _fetchDirect: async () => { direct++; return 'Home About Products News Contact '.repeat(400); },
  });
  assert.equal(direct, 1);
  assert.match(result.output, /^JINA /);
  assert.equal(result.meta.method, 'jina');
  assert.deepEqual(tiers(result), [['direct', 'skip', 'jina-preferred'], ['jina', 'ok', undefined]]);
  // The direct request is aborted when Jina answers first.
  const early = await run({
    _fetchViaJina: async (url, signal) => waitUnlessAborted(100, signal, 'JINA ' + article),
    _fetchDirect: async (url, signal) => { signal.addEventListener('abort', () => { directAborted = true; }, { once: true }); return waitUnlessAborted(5000, signal, article); },
  });
  assert.equal(early.meta.method, 'jina');
  assert.equal(directAborted, true);
});

test('a resource that is not HTML is used as soon as the direct read returns it', async () => {
  // The fourth argument is how the real direct reader reports what it fetched.
  const json = JSON.stringify({ forecast: Array.from({ length: 40 }, (_, day) => ({ day, max: 19, min: 15 })) });
  let jinaAborted = false;
  const started = Date.now();
  const result = await run({
    _fetchViaJina: async (url, signal) => { signal.addEventListener('abort', () => { jinaAborted = true; }, { once: true }); return waitUnlessAborted(5000, signal, article); },
    _fetchDirect: async (url, signal, cookies, info) => { info.html = false; return json; },
  });
  assert.equal(result.meta.method, 'direct');
  assert.equal(result.output.startsWith(json), true);
  assert.equal(jinaAborted, true);
  assert.equal(Date.now() - started < 190, true, 'no grace period for an exact resource');
});

test('a failing Jina read falls back to the direct page at once, in or after the hedge window', async () => {
  const page = 'Short static page with the opening hours: nine to five on weekdays, closed on public holidays. '.repeat(3);
  const quick = await run({ _fetchViaJina: async () => { throw new Error('Jina returned 502'); }, _fetchDirect: async () => page });
  assert.equal(quick.meta.method, 'direct');
  assert.deepEqual(tiers(quick).map(row => row.slice(0, 2)), [['jina', 'fail'], ['direct', 'ok']]);
  const started = Date.now();
  const late = await run({ _fetchViaJina: async (url, signal) => { await waitUnlessAborted(100, signal); throw new Error('Jina returned 502'); }, _fetchDirect: async () => page });
  assert.equal(late.meta.method, 'direct');
  assert.match(late.output, /opening hours/);
  assert.equal(Date.now() - started < 190, true, 'a failed Jina ends the grace period');
});

test('hedgedRead reports both failures and returns no content', async () => {
  const read = await hedgedRead({ jina: async signal => { await waitUnlessAborted(80, signal); throw new Error('timeout'); }, direct: async () => { throw new Error('HTTP 403'); }, hedgeMs: 20, graceMs: 500, looksEmpty });
  assert.equal(read.content, '');
  assert.equal(read.method, '');
  assert.deepEqual(read.events.map(event => [event.tier, event.outcome]), [['direct', 'fail'], ['jina', 'fail']]);
  // An empty Jina page with a failed direct read keeps Jina's page, as the chain did before.
  const empty = await hedgedRead({ jina: async signal => waitUnlessAborted(60, signal, 'tiny'), direct: async () => { throw new Error('HTTP 403'); }, hedgeMs: 20, graceMs: 500, looksEmpty });
  assert.deepEqual([empty.content, empty.method], ['tiny', 'jina']);
});

test('cancelling the read aborts both requests', async () => {
  const controller = new AbortController();
  const aborted = [];
  const pending = hedgedRead({ hedgeMs: 20, graceMs: 5000, looksEmpty, signal: controller.signal,
    jina: async signal => { signal.addEventListener('abort', () => aborted.push('jina'), { once: true }); return waitUnlessAborted(5000, signal, article); },
    direct: async signal => { signal.addEventListener('abort', () => aborted.push('direct'), { once: true }); return waitUnlessAborted(5000, signal, article); } });
  setTimeout(() => controller.abort(new Error('user stop')), 80);
  const read = await pending;
  assert.deepEqual(aborted.sort(), ['direct', 'jina']);
  assert.equal(read.content, '');
});
