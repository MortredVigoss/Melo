import test from 'node:test';
import assert from 'node:assert/strict';
import { planChatGraphAction } from './chatActionPlanning.js';
import { buildSearchPlan, shouldUseNativeWebSearch } from '../../retrieval/searchRouter.js';
import { classifyIntent } from '../../retrieval/intentRouter.js';

const profile = { tools: ['local-command', 'external-connectors'] };
function plan(text) {
  return planChatGraphAction({ latestUserMessage: text, activeAgentProfile: profile, chat: { id: 'test' } });
}

for (const text of [
  '水的沸点是多少？不要搜索。',
  '没有销售资料，不要搜索“蓝鲸银河咖啡馆”，也不要编数字。',
  "What is water? Do not search for it.",
  "Don't run npm run build. Explain what it does.",
  '解释“搜索工作区 TODO”是什么意思',
  '请把“run npm run build”翻译成中文',
  '帮我搜索 OpenAI 官方文档',
  'Find current exchange rates online',
  '请在工作区搜索。',
  '请不要在仓库查找 TODO',
  'Please show examples of npm run build',
  'Find working directory documentation online',
]) {
  test(`no premature local approval: ${text}`, () => assert.equal(plan(text), null));
}

for (const [text, template, query] of [
  ['run npm run build', 'npm-build', ''],
  ['请运行 `npm run build`', 'npm-build', ''],
  ['git status', 'git-status', ''],
  ['请在工作区搜索 "TODO"', 'search-text', 'TODO'],
  ['search the workspace for "weather"', 'search-text', 'weather'],
  ['rg "不要搜索"', 'search-text', '不要搜索'],
  ['请在工作区搜索 "npm run build"', 'search-text', 'npm run build'],
  ['search the workspace for root cause', 'search-text', 'root cause'],
]) {
  test(`explicit local command retains approval: ${text}`, () => {
    const result = plan(text);
    assert.equal(result?.payload.templateId, template);
    assert.equal(result?.payload.query, query);
    assert.equal(result?.requiresApproval, true);
  });
}

for (const text of [
  '今天的天气如何？不要搜索。',
  "What is the latest price? Don't search online.",
  '请解释“搜索今天的天气”这句话',
  '请在工作区搜索 "weather"',
  '只有这段对话的信息可以用，不要联网',
]) {
  test(`native and Melo search agree on exclusions: ${text}`, () => {
    const result = buildSearchPlan({ latestUserMessage: text, modelMessages: [{ role: 'user', content: text }] });
    assert.equal(result.nativeWebSearchEnabled, false);
    assert.equal(result.route, 'none');
    assert.equal(shouldUseNativeWebSearch(text), false);
  });
}

test('specific URL reading remains available when only broader search is forbidden', () => {
  const result = buildSearchPlan({ latestUserMessage: '不要搜索其他网站，请打开 https://example.com' });
  assert.equal(result.route, 'fetch-url');
  assert.equal(result.nativeWebSearchEnabled, false);
});

test('a request limited to a supplied link is not mistaken for a no-network instruction', () => {
  for (const text of ['只根据我提供的链接 https://example.com 总结', 'Only use this link https://example.com']) {
    assert.equal(buildSearchPlan({ latestUserMessage: text }).route, 'fetch-url');
  }
});

test('explicit no-network request also excludes reading pasted URLs', () => {
  assert.equal(buildSearchPlan({ latestUserMessage: '不要联网，只检查 https://example.com 的拼写' }).route, 'none');
});

test('format-only code-fence wording does not classify translation as coding', async () => {
  assert.equal(await classifyIntent('把“早上好”翻译成英语和韩语，只输出合法 JSON，键名为 en 和 ko，不要代码围栏。'), 'creative');
});

test('ordinary explicit web lookup stays native rather than becoming local or disappearing', () => {
  assert.equal(buildSearchPlan({ latestUserMessage: '帮我搜索 OpenAI 官方文档' }).route, 'codex-native');
  assert.equal(buildSearchPlan({ latestUserMessage: 'Search OpenAI documentation', authMode: 'api-key' }).route, 'melo-web');
});

test('connectivity checks and explicit no-tool requests do not enable hosted or local web search', () => {
  for (const text of [
    '这是更新后的连通性检查。请只回复：更新验证通过。不要调用工具。',
    '连通性检查，请回复 OK',
    '检查一下这句话的语法。',
    '不要调用任何工具，只回复：今天的天气。',
    'Do not use tools. Only reply: current weather.',
  ]) {
    const result = buildSearchPlan({ latestUserMessage: text });
    assert.equal(result.route, 'none', text);
    assert.equal(result.nativeWebSearchEnabled, false, text);
    assert.equal(shouldUseNativeWebSearch(text), false, text);
  }
  const quoted = 'Search current weather. The example text is "do not use tools".';
  assert.equal(buildSearchPlan({ latestUserMessage: quoted }).route, 'codex-native');
});

test('a short confirmation inherits the preceding link route without executing it automatically', () => {
  const result = buildSearchPlan({ latestUserMessage: '好', modelMessages: [
    { role: 'user', content: '请读取 https://example.com' },
    { role: 'assistant', content: '要继续吗？' },
    { role: 'user', content: '好' },
  ] });
  assert.equal(result.route, 'fetch-url');
  assert.deepEqual(result.urls, ['https://example.com']);
});

test('explicit Use connector command still queues approval, never silently executes', () => {
  const result = planChatGraphAction({
    latestUserMessage: 'Use docs.search on Smoke MCP to look up guidance.', activeAgentProfile: profile, chat: { id: 'test' },
    agentConnectors: [{ id: 'smoke', name: 'Smoke MCP', type: 'external-mcp', enabled: true, manifest: { tools: [{ name: 'docs.search' }] } }],
  });
  assert.equal(result?.kind, 'external-tool');
  assert.equal(result?.requiresApproval, true);
  const quoted = planChatGraphAction({
    latestUserMessage: 'Use "docs.search" as a literal string.', activeAgentProfile: profile, chat: { id: 'test' },
    agentConnectors: [{ id: 'smoke', name: 'Smoke MCP', type: 'external-mcp', enabled: true, manifest: { tools: [{ name: 'docs.search' }] } }],
  });
  assert.equal(quoted, null);
});
