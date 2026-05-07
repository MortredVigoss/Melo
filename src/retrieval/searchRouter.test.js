import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSearchPlan,
  clearSearchTriggers,
  filterToolsForSearchPlan,
  registerSearchTriggers,
  shouldUseNativeWebSearch,
} from './searchRouter.js';

const TOOL_FIXTURES = [
  { id: 'web_search' },
  { id: 'fetch_url' },
  { id: 'calculator' },
  { id: 'read_file' },
];

test('buildSearchPlan routes current factual search to Codex native search under codex auth', () => {
  const plan = buildSearchPlan({
    latestUserMessage: '帮我查一下今天墨尔本天气',
    authMode: 'codex',
  });

  assert.equal(plan.route, 'codex-native');
  assert.equal(plan.nativeWebSearchEnabled, true);
  assert.deepEqual(plan.exposedNetworkTools, []);
  assert.deepEqual(
    filterToolsForSearchPlan(TOOL_FIXTURES, plan).map(t => t.id),
    ['calculator', 'read_file'],
  );
});

test('buildSearchPlan routes pasted normal URLs to fetch_url and suppresses native search', () => {
  const plan = buildSearchPlan({
    latestUserMessage: '总结一下这个链接 https://example.com/post',
    authMode: 'codex',
  });

  assert.equal(plan.route, 'fetch-url');
  assert.equal(plan.nativeWebSearchEnabled, false);
  assert.deepEqual(plan.exposedNetworkTools, ['fetch_url']);
  assert.deepEqual(
    filterToolsForSearchPlan(TOOL_FIXTURES, plan).map(t => t.id),
    ['fetch_url', 'calculator', 'read_file'],
  );
});

test('buildSearchPlan routes social URLs through fetch_url social preview path', () => {
  const plan = buildSearchPlan({
    latestUserMessage: '看看这个抖音 https://v.douyin.com/abc123/',
    authMode: 'codex',
  });

  assert.equal(plan.route, 'social-link');
  assert.equal(plan.nativeWebSearchEnabled, false);
  assert.deepEqual(plan.exposedNetworkTools, ['fetch_url']);
});

test('buildSearchPlan routes deep research to Melo web search for structured sources', () => {
  const plan = buildSearchPlan({
    latestUserMessage: '帮我做一个多来源深度调研，比较这几个产品',
    authMode: 'codex',
  });

  assert.equal(plan.route, 'melo-web');
  assert.equal(plan.nativeWebSearchEnabled, false);
  assert.deepEqual(plan.exposedNetworkTools, ['web_search', 'fetch_url']);
});

test('buildSearchPlan uses Melo web search for non-codex auth when web intent is present', () => {
  const plan = buildSearchPlan({
    latestUserMessage: '帮我查一下今天新加坡天气',
    authMode: 'api-key',
  });

  assert.equal(plan.route, 'melo-web');
  assert.equal(plan.nativeWebSearchEnabled, false);
  assert.deepEqual(plan.exposedNetworkTools, ['web_search', 'fetch_url']);
});

test('buildSearchPlan leaves ordinary chat without web network tools', () => {
  const plan = buildSearchPlan({
    latestUserMessage: '帮我写一段温柔一点的回复',
    authMode: 'codex',
  });

  assert.equal(plan.route, 'none');
  assert.equal(plan.nativeWebSearchEnabled, false);
  assert.deepEqual(plan.exposedNetworkTools, []);
  assert.deepEqual(
    filterToolsForSearchPlan(TOOL_FIXTURES, plan).map(t => t.id),
    ['calculator', 'read_file'],
  );
});

test('custom web search triggers still feed the unified router', () => {
  try {
    registerSearchTriggers([{ pattern: 'melo-custom-trigger', weight: 3 }]);
    assert.equal(
      shouldUseNativeWebSearch('melo-custom-trigger', { authMode: 'codex' }),
      true,
    );
  } finally {
    clearSearchTriggers();
  }
});
