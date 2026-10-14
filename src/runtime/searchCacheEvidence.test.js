import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { webSearchTool, _resetWebSearchCacheForTests } from '../tools/builtins/webSearchTool.js';
import { describeSearchEvidence, capabilityStatus } from './capabilities.js';

test('fresh SERP plus cached URL bodies is cache reuse, not a green live fetch', async t => {
  const root = await mkdtemp(join(tmpdir(), 'melo-url-cache-evidence-'));
  const previous = process.env.MELO_HOME;
  const oldFetch = globalThis.fetch;
  process.env.MELO_HOME = root;
  globalThis.fetch = async () => { throw new Error('Unexpected network access in isolated test'); };
  t.after(async () => {
    await delay(100);
    _resetWebSearchCacheForTests();
    globalThis.fetch = oldFetch;
    if (previous === undefined) delete process.env.MELO_HOME; else process.env.MELO_HOME = previous;
    await rm(root, { recursive: true, force: true });
  });
  _resetWebSearchCacheForTests();
  const url = 'https://example.com/cache-evidence';
  let fetched = 0;
  const context = { config: {}, _tryApiDirect: async () => null,
    _searchViaPlaywright: async () => [{ title: 'Cache evidence', url, snippet: 'An article about testing.' }],
    _searchViaDdg: async () => [], _isPlaywrightCliAvailable: async () => true,
    _fetchViaJina: async () => { fetched++; return { url, content: 'Real body content. '.repeat(30), notModified: false }; },
    _fetchViaPlaywrightCli: async () => null, _fetchViaCdpChrome: async () => null };
  const first = await webSearchTool.run({ query: 'alpha cache evidence', num_results: 1 }, context);
  assert.equal(first.ok, true);
  assert.equal(first.meta.contentFreshFetched, 1);
  assert.equal(fetched, 1);
  const second = await webSearchTool.run({ query: 'beta cache evidence', num_results: 1 }, context);
  assert.equal(second.ok, true);
  assert.equal(second.meta.timings.cacheHit, false, 'This is not the query-result cache');
  assert.equal(fetched, 1, 'The second query reuses the same URL body');
  assert.equal(second.meta.contentFromCache, 1);
  assert.equal(second.meta.contentFreshFetched, 0);
  const evidence = describeSearchEvidence('web-search', second);
  assert.equal(evidence.cached, true);
  assert.equal(capabilityStatus({ ...evidence, checkedAt: new Date().toISOString() }).status, 'yellow');
});
