// User report 2026-10-22: desktop web search was "unavailable" for everyone
// who never saved search settings (default backend "none" since 10-18).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequestContext } from '../../runtime/requestContext.js';
import { runWithRequestContext } from '../../runtime/requestScope.js';
import { loadConfig, DEFAULT_CONFIG } from '../../config.js';
import { buildSharedSearchPlan } from '../../retrieval/sharedSearchPlan.js';
import { createCompatibleSearchTool } from './sharedSearchAdapter.js';

test('without saved search settings, a weather question is searched with the built-in search', async t => {
  const home = await mkdtemp(join(tmpdir(), 'melo-default-search-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  // A config like the user's: Codex login, no agentRuntime saved, no hosted-search proof.
  await writeFile(join(home, 'config.json'), JSON.stringify({ authMode: 'codex', model: 'gpt-6.1-sol', baseUrl: 'https://chatgpt.com/backend-api' }));
  const config = await runWithRequestContext(createRequestContext({ home, env: { MELO_TEST_MODE: '1' } }), () => loadConfig());
  assert.equal(config.agentRuntime.search.browserFallback, true);
  assert.equal(DEFAULT_CONFIG.agentRuntime.search.browserFallback, true);

  const plan = buildSharedSearchPlan({ latestUserMessage: '墨尔本明天天气怎么样', config,
    capabilities: { executors: ['web_search', 'fetch_url'], grants: ['web_search', 'fetch_url'], hostedSearch: 'unknown', browserSearch: true } });
  assert.equal(plan.route, 'melo-web', `routed to search, not "${plan.sharedPlan.reason}"`);
  assert.ok(plan.exposedNetworkTools.includes('web_search'));

  let legacyCalls = 0;
  const tool = createCompatibleSearchTool({ id: 'web_search', run: async args => { legacyCalls += 1; return { ok: true, output: `results for ${args.query}` }; } });
  const result = await tool.run({ query: 'Melbourne weather tomorrow' }, { config });
  assert.equal(legacyCalls, 1, 'the built-in search actually ran');
  assert.equal(result.ok, true);
  assert.doesNotMatch(String(result.output), /SEARCH_UNAVAILABLE/);
});

test('a saved choice still wins: turning the built-in search off keeps it off', async () => {
  const { normalizeRuntimeConfig } = await import('../../../shared/agent/tools.js');
  const config = { agentRuntime: normalizeRuntimeConfig({ search: { backend: 'none', browserFallback: false } }) };
  let legacyCalls = 0;
  const tool = createCompatibleSearchTool({ id: 'web_search', run: async () => { legacyCalls += 1; return { ok: true, output: 'x' }; } });
  const result = await tool.run({ query: 'anything' }, { config });
  assert.equal(legacyCalls, 0);
  assert.match(String(result.output), /SEARCH_UNAVAILABLE/);
});
