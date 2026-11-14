import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSearchRoutingPrompt } from './searchRouter.js';
import { productSearchPlan } from '../testSupport/searchPlanFixture.js';

// Through the planner a real turn uses (see searchRouter.test.js for why these
// no longer call the old desktop planner). `http` is an API-key connection with
// a search backend configured; `hosted` is a connection with verified hosted search.
const plan = (text, messages = [], search = 'http') => productSearchPlan(text, { messages, search });

for (const text of ['Surry Hills 有什么好吃的饭店', '推荐几家悉尼适合周末吃 brunch 的餐厅', 'Any good brunch near Surry Hills?', '墨尔本住哪家酒店合适', 'Which laptop would you recommend for travel?']) {
  test(`natural recommendation has a public search route: ${text}`, () => {
    const actual = plan(text);
    assert.equal(actual.route, 'melo-web');
    assert.deepEqual(actual.exposedNetworkTools, ['web_search', 'fetch_url']);
    assert.equal(plan(text, [], 'hosted').route, 'codex-native');
    assert.match(buildSearchRoutingPrompt(actual), /Retrieve public evidence when needed/);
  });
}
for (const text of ['今天我吃了 brunch 很开心', 'I went to a restaurant yesterday.', '请翻译“Any good brunch near Surry Hills?”', '推荐餐厅的算法如何实现', '不要联网，推荐悉尼餐厅', '不要搜索，推荐悉尼餐厅']) {
  test(`recommendation routing preserves the task boundary: ${text}`, () => assert.equal(plan(text).route, 'none'));
}
test('related follow-ups keep a public task, but do not cross denial, cancellation or topic changes', () => {
  const first = 'Surry Hills 有什么好吃的饭店';
  assert.equal(plan('那家周日有停车位吗', [first]).route, 'melo-web');
  assert.equal(plan('那营业到几点', [first, '那家周日有停车位吗']).route, 'melo-web');
  for (const boundary of ['不要再搜索', '取消', '帮我写一首诗']) {
    assert.equal(plan('那家呢', [first, boundary]).route, 'none', boundary);
  }
  // A search inside an app is a different task: the follow-up belongs to it and
  // never falls back to a public web search (on a host without phone control the
  // planner reports that capability as missing).
  const inApp = plan('那家呢', [first, '在小红书搜索餐厅']);
  assert.ok(!['melo-web', 'codex-native'].includes(inApp.route), inApp.route);
  assert.deepEqual(inApp.exposedNetworkTools, []);
});
test('the route reflects current tool grants and reports missing search without device fallback', () => {
  const text = 'Surry Hills 有什么好吃的饭店';
  const denied = productSearchPlan(text, { search: 'http', tools: ['browser_open'] });
  assert.equal(denied.route, 'unavailable');
  assert.equal(denied.reason, 'SEARCH_NOT_GRANTED');
  assert.match(buildSearchRoutingPrompt(denied), /Search is unavailable \(search-unavailable: SEARCH_NOT_GRANTED\)/);
  assert.match(buildSearchRoutingPrompt(denied), /do not invent retrieved evidence or use a screen as a fallback/);
  // Granted but nothing to search with: said in the planner's own words too.
  const noBackend = productSearchPlan(text, { search: 'none' });
  assert.equal(noBackend.reason, 'SEARCH_UNAVAILABLE');
  assert.match(buildSearchRoutingPrompt(noBackend), /Do not invent current facts or open phone apps as a fallback/);
  assert.equal(productSearchPlan(text, { search: 'http', tools: ['web_search'] }).route, 'melo-web');
  assert.equal(productSearchPlan('Any good brunch?', { search: 'hosted', tools: ['web_search'] }).route, 'codex-native');
});
