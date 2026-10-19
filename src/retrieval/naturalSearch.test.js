import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSearchPlan, constrainSearchPlan, buildSearchRoutingPrompt, filterToolsForSearchPlan } from './searchRouter.js';

const plan = (text, messages = [], authMode = 'api-key') => buildSearchPlan({ latestUserMessage: text, modelMessages: messages.map(content => ({ role: 'user', content })), authMode });
for (const text of ['Surry Hills 有什么好吃的饭店', '推荐几家悉尼适合周末吃 brunch 的餐厅', 'Any good brunch near Surry Hills?', '墨尔本住哪家酒店合适', 'Which laptop would you recommend for travel?']) {
  test(`natural recommendation has a public search route: ${text}`, () => {
    const actual = plan(text);
    assert.equal(actual.route, 'melo-web');
    assert.deepEqual(filterToolsForSearchPlan([{ id: 'web_search' }, { id: 'fetch_url' }], actual).map(t => t.id), ['web_search', 'fetch_url']);
    assert.equal(plan(text, [], 'codex').route, 'codex-native');
    assert.match(buildSearchRoutingPrompt(actual), /cite those sources/);
  });
}
for (const text of ['今天我吃了 brunch 很开心', 'I went to a restaurant yesterday.', '请翻译“Any good brunch near Surry Hills?”', '推荐餐厅的算法如何实现', '不要联网，推荐悉尼餐厅', '不要搜索，推荐悉尼餐厅', '在仓库搜索餐厅名称', '在小红书搜索 Surry Hills 好吃的饭店', 'Find good restaurants in Google Maps', '为什么刚才没有搜索餐厅？']) {
  test(`recommendation routing preserves the task boundary: ${text}`, () => assert.equal(plan(text).route, 'none'));
}
test('related follow-ups keep a public task, but do not cross denial, cancellation or topic changes', () => {
  const first = 'Surry Hills 有什么好吃的饭店';
  assert.equal(plan('那家周日有停车位吗', [first]).route, 'melo-web');
  assert.equal(plan('那营业到几点', [first, '那家周日有停车位吗']).route, 'melo-web');
  for (const boundary of ['不要再搜索', '取消', '帮我写一首诗', '在小红书搜索餐厅']) {
    assert.equal(plan('那家呢', [first, boundary]).route, 'none', boundary);
  }
});
test('the route reflects current tool grants and reports missing search without device fallback', () => {
  const intent = plan('Surry Hills 有什么好吃的饭店');
  const denied = constrainSearchPlan(intent, { toolIds: ['browser_open'] });
  assert.equal(denied.route, 'unavailable');
  assert.equal(denied.reason, 'search-unavailable');
  assert.match(buildSearchRoutingPrompt(denied), /Do not invent current facts or take over a phone/);
  assert.equal(constrainSearchPlan(intent, { toolIds: ['web_search'] }).route, 'melo-web');
  assert.equal(constrainSearchPlan(plan('Any good brunch?', [], 'codex'), { nativeSearch: true }).route, 'codex-native');
});
