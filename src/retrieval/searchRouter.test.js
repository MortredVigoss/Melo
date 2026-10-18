import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSearchPlan,
  buildSearchRoutingPrompt,
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

test('flight lookup survives passenger, baggage and year answers', () => {
  const messages = [{ role: 'user', content: '查一下10月31日墨尔本飞悉尼，11月1日回来，早去晚回航班' }];
  for (const text of ['1个人', '没行李', '2026年 肯定默认是今年']) {
    messages.push({ role: 'assistant', content: '请补充查询条件' }, { role: 'user', content: text });
    assert.equal(buildSearchPlan({ latestUserMessage: text, modelMessages: messages }).route, 'codex-native');
  }
  assert.equal(buildSearchPlan({ latestUserMessage: '2026年', modelMessages: messages, authMode: 'api-key' }).route, 'melo-web');
});

test('clarifications never revive cancelled, unrelated or denied web lookups', () => {
  const base = [{ role: 'user', content: '帮我查机票' }];
  for (const text of ['不要联网了', '只凭对话回答', '翻译 hello', '写一段祝福', '今年开始学Python，帮我写学习计划']) {
    const modelMessages = [...base, { role: 'user', content: text }, { role: 'user', content: '2026年' }];
    assert.equal(buildSearchPlan({ latestUserMessage: '2026年', modelMessages }).route, 'none', text);
  }
  assert.equal(buildSearchPlan({ latestUserMessage: '2026年，不要联网', modelMessages: base }).route, 'none');
});

test('disabled browser automation is not advertised as an available tool', () => {
  const original = process.env.MELO_CDP_ENABLED;
  try {
    delete process.env.MELO_CDP_ENABLED;
    assert.deepEqual(filterToolsForSearchPlan([{ id: 'browser_open' }, { id: 'calculator' }], {}).map(t => t.id), ['calculator']);
    process.env.MELO_CDP_ENABLED = '1';
    assert.equal(filterToolsForSearchPlan([{ id: 'browser_open' }], {}).length, 1);
    assert.equal(filterToolsForSearchPlan([{ id: 'browser_open' }], { reason: 'user-disabled-network' }).length, 0);
  } finally {
    if (original === undefined) delete process.env.MELO_CDP_ENABLED;
    else process.env.MELO_CDP_ENABLED = original;
  }
});

test('routing prompt: web_screenshot is offered for "show me the page" on link routes and forbidden when the user turned networking off', () => {
  for (const route of ['fetch-url', 'social-link', 'melo-web']) {
    assert.match(buildSearchRoutingPrompt({ route, reason: 'url-present' }), /use `web_screenshot`; to read it, use `fetch_url`/);
  }
  assert.match(buildSearchRoutingPrompt({ route: 'none', reason: 'user-disabled-network' }), /Do not call `web_screenshot`/);
  assert.doesNotMatch(buildSearchRoutingPrompt({ route: 'codex-native', reason: 'codex-native-primary' }), /web_screenshot/);
  assert.equal(buildSearchRoutingPrompt({ route: 'none', reason: 'no-web-intent' }), '');
  // The definition set itself is not routed (A2): only the network-off turn withholds it.
  const tools = [{ id: 'web_screenshot', capability: 'network', uiModule: 'search' }, { id: 'fetch_url' }, { id: 'calculator' }];
  assert.deepEqual(filterToolsForSearchPlan(tools, buildSearchPlan({ latestUserMessage: '2+2 等于几', authMode: 'api-key' })).map(t => t.id), ['web_screenshot', 'calculator']);
  assert.deepEqual(filterToolsForSearchPlan(tools, { route: 'none', reason: 'user-disabled-network', exposedNetworkTools: [] }).map(t => t.id), ['calculator']);
});
