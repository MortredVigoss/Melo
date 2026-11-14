/**
 * searchRouter.test.js — how a turn is routed to search, link reading or neither.
 *
 * Until 2026-11-14 this file called `buildSearchPlan` / `filterToolsForSearchPlan`,
 * a planner the product had stopped running (the turn plans with the shared
 * planner, retrieval/sharedSearchPlan.js). The cases are the same; they now go
 * through the planner that decides a real turn (testSupport/searchPlanFixture.js).
 *
 * One difference in what is asserted, and it is the planner's design, not a
 * loosened check: a plan no longer says hosted search is "off" for a turn that
 * merely does not need it. `nativeWebSearchEnabled` means hosted search is
 * AVAILABLE to the model in this turn; it is false only when the person ruled
 * searching out. What the route recommends is in `route` / `exposedNetworkTools`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSearchRoutingPrompt, clearSearchTriggers, registerSearchTriggers, shouldUseNativeWebSearch } from './searchRouter.js';
import { productSearchPlan } from '../testSupport/searchPlanFixture.js';
import { getRequestNetworkPolicy, requestAllowsTool } from './requestPolicy.js';

test('a current factual question goes to hosted search when the connection has it', () => {
  const plan = productSearchPlan('帮我查一下今天墨尔本天气');
  assert.equal(plan.route, 'codex-native');
  assert.equal(plan.nativeWebSearchEnabled, true);
  assert.ok(!plan.exposedNetworkTools.includes('web_search'), 'the local search tool is not the suggested one when hosted search does the lookup');
});

test('a pasted link is read with fetch_url; a social link takes the social route', () => {
  const page = productSearchPlan('总结一下这个链接 https://example.com/post');
  assert.equal(page.route, 'fetch-url');
  assert.deepEqual(page.exposedNetworkTools, ['fetch_url']);
  assert.deepEqual(page.urls, ['https://example.com/post']);
  assert.deepEqual(page.sharedPlan.suggestedRequiredTools, ['fetch_url']);

  const social = productSearchPlan('看看这个抖音 https://v.douyin.com/abc123/');
  assert.equal(social.route, 'social-link');
  assert.deepEqual(social.exposedNetworkTools, ['fetch_url']);
});

test('deep research is marked as such on either backend', () => {
  const hosted = productSearchPlan('帮我做一个多来源深度调研，比较这几个产品');
  assert.equal(hosted.route, 'codex-native');
  assert.equal(hosted.sharedPlan.research.depth, 'deep');
  assert.match(hosted.sharedPlan.instructions, /deep research/);

  const http = productSearchPlan('帮我做一个多来源深度调研，比较这几个产品', { search: 'http' });
  assert.equal(http.route, 'melo-web');
  assert.equal(http.sharedPlan.research.depth, 'deep');
  assert.deepEqual(http.exposedNetworkTools, ['web_search', 'fetch_url']);
});

test('without hosted search a web question uses the configured search backend, and says so when there is none', () => {
  const plan = productSearchPlan('帮我查一下今天新加坡天气', { search: 'http' });
  assert.equal(plan.route, 'melo-web');
  assert.equal(plan.nativeWebSearchEnabled, false);
  assert.deepEqual(plan.exposedNetworkTools, ['web_search', 'fetch_url']);

  const none = productSearchPlan('帮我查一下今天新加坡天气', { search: 'none' });
  assert.equal(none.route, 'unavailable');
  assert.equal(none.reason, 'SEARCH_UNAVAILABLE');
  assert.deepEqual(none.exposedNetworkTools, []);
  assert.match(buildSearchRoutingPrompt(none), /Search is unavailable \(search-unavailable: SEARCH_UNAVAILABLE\)/);
});

test('ordinary conversation is not routed anywhere', () => {
  for (const search of ['hosted', 'http']) {
    const plan = productSearchPlan('帮我写一段温柔一点的回复', { search });
    assert.equal(plan.route, 'none', search);
    assert.deepEqual(plan.exposedNetworkTools, [], search);
    assert.deepEqual(plan.sharedPlan.tools, [], search);
  }
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
  assert.equal(shouldUseNativeWebSearch('melo-custom-trigger', { authMode: 'codex' }), false, 'cleared');
});

test('flight lookup survives passenger, baggage and year answers', () => {
  const messages = [{ role: 'user', content: '查一下10月31日墨尔本飞悉尼，11月1日回来，早去晚回航班' }];
  for (const text of ['1个人', '没行李', '2026年 肯定默认是今年']) {
    messages.push({ role: 'assistant', content: '请补充查询条件' }, { role: 'user', content: text });
    assert.equal(productSearchPlan(text, { messages: [...messages] }).route, 'codex-native', text);
  }
  assert.equal(productSearchPlan('2026年', { messages: [...messages, { role: 'user', content: '2026年' }], search: 'http' }).route, 'melo-web');
});

test('clarifications never revive cancelled, unrelated or denied web lookups', () => {
  const base = ['帮我查机票'];
  for (const text of ['不要联网了', '只凭对话回答', '翻译 hello', '写一段祝福', '今年开始学Python，帮我写学习计划']) {
    assert.equal(productSearchPlan('2026年', { messages: [...base, text, '2026年'] }).route, 'none', text);
  }
  const denied = productSearchPlan('2026年，不要联网', { messages: base });
  assert.equal(denied.route, 'none');
  assert.equal(denied.nativeWebSearchEnabled, false);
  assert.deepEqual(denied.sharedPlan.availableTools, [], 'nothing that reaches the network is on offer');
});

test('the routing prompt is the plan’s own guidance; a plan that is not one renders nothing', () => {
  const plan = productSearchPlan('帮我查一下今天墨尔本天气');
  const prompt = buildSearchRoutingPrompt(plan);
  assert.ok(prompt.startsWith('## Search Routing\n'));
  assert.ok(prompt.includes(plan.sharedPlan.instructions));
  assert.equal(buildSearchRoutingPrompt({ route: 'fetch-url', reason: 'url-present' }), '', 'the old plan shape has no renderer any more');
  assert.equal(buildSearchRoutingPrompt(null), '');
});

test('web_screenshot is withheld only on a turn where the person turned networking off', () => {
  const shot = { id: 'web_screenshot', capability: 'network', uiModule: 'search' };
  assert.equal(requestAllowsTool(shot, getRequestNetworkPolicy('2+2 等于几')), true);
  assert.equal(requestAllowsTool(shot, getRequestNetworkPolicy('不要搜索，告诉我这个页面可能长什么样')), true, 'no search is not no network');
  assert.equal(requestAllowsTool(shot, getRequestNetworkPolicy('不要联网，2+2 等于几')), false);
  assert.equal(requestAllowsTool({ id: 'calculator' }, getRequestNetworkPolicy('不要联网，2+2 等于几')), true);
});
