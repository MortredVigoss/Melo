import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTopicExcerpts } from './topicExcerpts.js';
import { estimateTextTokens } from '../../memory/tokenEstimate.js';

const chat = {
  messages: [
    { id: 'a0', role: 'user', content: '数据库迁移怎么做？' },
    { id: 'a1', role: 'assistant', content: 'postgres 升级到 16，配置在 /srv/db/postgresql.conf，端口 5433。' },
    { id: 'b0', role: 'user', content: '首页改版' },
    { id: 'b1', role: 'assistant', content: 'hero 区域换图。' },
    { id: 'c0', role: 'user', content: '现在的问题' },
  ],
  compactCards: [
    { id: 'c1', title: '数据库迁移', summary: 'postgres 升级到 16', fromMessageId: 'a0', toMessageId: 'a1' },
    { id: 'c2', title: '首页改版', summary: 'hero 换图', fromMessageId: 'b0', toMessageId: 'b1' },
  ],
};

test('returns the original messages of the cards the new message returns to', () => {
  const { text, cards } = buildTopicExcerpts(chat, '刚才数据库迁移时说的端口是多少？');
  assert.deepEqual(cards.map(card => card.id), ['c1']);
  assert.match(text, /## 原文摘录：数据库迁移/);
  assert.match(text, /\[#a1\] Assistant: postgres 升级到 16，配置在 \/srv\/db\/postgresql.conf，端口 5433。/);
  assert.doesNotMatch(text, /hero/);
});

test('short or unrelated messages and chats without cards produce nothing', () => {
  assert.equal(buildTopicExcerpts(chat, '好的').text, '');
  assert.equal(buildTopicExcerpts(chat, '今天天气怎么样呢').text, '');
  assert.equal(buildTopicExcerpts({ messages: chat.messages, compactSummary: 'legacy only' }, '数据库迁移的端口').text, '');
});

test('each card excerpt stays within its token budget', () => {
  const long = { messages: Array.from({ length: 30 }, (_, i) => ({ id: `l${i}`, role: i % 2 ? 'assistant' : 'user', content: `数据库迁移 细节 ${i} `.repeat(60) })),
    compactCards: [{ id: 'x', title: '数据库迁移', summary: '很多细节', fromMessageId: 'l0', toMessageId: 'l29' }] };
  const { text } = buildTopicExcerpts(long, '数据库迁移的细节', { maxTokensPerCard: 800 });
  assert.ok(estimateTextTokens(text) <= 1000, `tokens ${estimateTextTokens(text)}`);
  assert.match(text, /更多原文用 read_history 读取/);
});
