import { publicLookupRequest } from './retrieval/publicLookupIntent.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { planRequest, actionEvidence } from './search.js';

const capabilities = { executors: ['web_search', 'fetch_url', 'phone_use'], grants: ['web_search', 'fetch_url', 'phone_use'], hostedSearch: 'unknown' };
const config = { search: { backend: 'http', endpoint: 'https://search.fixture.invalid' } };
const plan = (text, extra = {}) => planRequest({ text, capabilities, config, ...extra });

test('checking supplied text is not a web lookup, while real lookup verbs remain research', () => {
  for (const text of ['连通性检查，请回复 OK', '请检查一下这句话的语法', '审查这个计算：2 + 2 = 4']) {
    assert.equal(plan(text).route, 'none', text);
  }
  for (const text of ['查一下悉尼 brunch', '帮我查悉尼 brunch', '搜索 OpenAI 文档', '查询最新新闻']) {
    assert.equal(plan(text).route, 'http-search', text);
  }
  for (const text of ['不要调用工具，今天的天气', '不用任何工具，打开 https://example.com', 'No tools. Current weather.']) {
    assert.equal(plan(text).route, 'none', text);
    assert.deepEqual(plan(text).requiredTools, [], text);
  }
});

test('brunch recommendation plus navigation exposes research then an explicitly authorized phone action', () => {
  const result = plan('推荐一下有什么好的 Surry Hill 的 brunch，然后给我导航到那里。你先不用管有没有开门，我主要是测试一下你的能力。');
  assert.equal(result.route, 'http-search');
  assert.deepEqual(result.tools, ['web_search', 'fetch_url', 'phone_use']);
  assert.deepEqual(result.requiredTools, ['phone_use']);
  assert.equal(result.research.depth, 'standard');
  assert.match(result.instructions, /before.*phone_use/is);
});

test('recommendations read sources without claiming that every recommendation needs deep research', () => {
  for (const text of ['Surry Hills 有什么好的 brunch', '推荐一家咖啡馆', 'Recommend a cafe in Surry Hills']) {
    const result = plan(text);
    assert.equal(result.route, 'http-search', text);
    assert.deepEqual(result.tools, ['web_search', 'fetch_url']);
    assert.deepEqual(result.requiredTools, []);
  }
  assert.equal(plan('深入调研比较 Surry Hills 的 brunch，多来源核对菜单').research.depth, 'deep');
});

test('asking why an earlier action did not run never executes that action again', () => {
  for (const text of ['分析一下为什么得出了这么几个？你调用了什么工具？做了什么 Research？为什么没有直接打开我的 Google Map 帮我导航？', 'Why did you not open Google Maps? Which tools did you use?', '上一次检索了哪些来源，为什么没导航？']) {
    const result = plan(text);
    assert.equal(result.route, 'none', text);
    assert.equal(result.reason, 'execution-explanation');
    assert.deepEqual(result.tools, []);
  }
  assert.equal(plan('为什么没打开？现在帮我打开 Google Maps').route, 'phone');
});

test('quoted examples and questions about implementation do not operate a screen', () => {
  for (const text of ['解释“推荐 brunch 然后导航”这个流程如何实现', '如何实现自动打开 Google Maps 的功能？', 'What does brunch mean?']) assert.deepEqual(plan(text).tools, [], text);
});

test('missing search capability is explicit, and is not permission to browse the phone for recommendations', () => {
  const result = plan('推荐 Surry Hills brunch 然后导航', { config: {} });
  assert.equal(result.route, 'unavailable');
  assert.equal(result.reason, 'SEARCH_UNAVAILABLE');
  assert.deepEqual(result.tools, []);
});

test('navigation follow-up uses the selected place without repeating research', () => {
  const messages = [{ role: 'user', content: '推荐 Surry Hills brunch' }, { role: 'assistant', content: 'First: Fixture A. Second: Fixture B.' }];
  const result = plan('导航到第二家', { messages });
  assert.equal(result.route, 'phone');
  assert.deepEqual(result.requiredTools, ['phone_use']);
});

test('compound navigation requires an actual returned source, not just a successful empty search', () => {
  const request = { research: { navigate: true } };
  assert.equal(actionEvidence(request, []).code, 'DESTINATION_UNVERIFIED');
  assert.equal(actionEvidence(request, ['https://user:secret@fixture.invalid']).ok, false);
  assert.equal(actionEvidence(request, ['https://fixture.invalid/menu']).ok, true);
  assert.equal(actionEvidence({ route: 'phone' }, []).ok, true);
});

test('explicit app research, denied phone use and context-only answers retain their boundaries', () => {
  assert.deepEqual(plan('用小红书找 Surry Hills brunch').tools, ['phone_use']);
  assert.deepEqual(plan('推荐 Surry Hills brunch，不要操作手机').tools, ['web_search', 'fetch_url']);
  assert.deepEqual(plan('只根据已有对话推荐 brunch，不联网').tools, []);
  assert.equal(plan('打开设置', { capabilities: { executors: [], grants: [] } }).reason, 'PHONE_UNAVAILABLE');
});

test('tool availability survives an unknown-language lookup hint and obeys current user restrictions', () => {
 const p=plan('Quel temps fera-t-il au concert ?');
 assert.ok(p.availableTools.includes('web_search'));
 assert.ok(p.availableTools.includes('fetch_url'));
 for(const text of ['不要使用任何工具','no tools please']){
  const blocked=plan(text); assert.deepEqual(blocked.availableTools,[]); assert.equal(blocked.nativeSearchAvailable,false);
 }
 assert.equal(plan('不要搜索，但读取 https://example.test/a').availableTools.includes('web_search'),false);
 assert.ok(plan('不要搜索，但读取 https://example.test/a').availableTools.includes('fetch_url'));
});

test('date-only follow-up retains a public lookup goal and explicit cancellation stops it', () => {
  const history = [{role:'user',content:'查一下墨尔本到悉尼的机票'}, {role:'assistant',content:'哪一天？'}];
  for (const content of ['10月31号','2026-10-31','下周三']) {
    assert.equal(publicLookupRequest(content, history), true);
  }
  assert.equal(publicLookupRequest('不用查了，帮我写首诗', history), false);
});
