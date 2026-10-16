import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { segmentConversationTopics, topicDirectory, returningTopicExcerpt, topicTerms } from './conversationTopics.js';

const cases = JSON.parse(readFileSync(new URL('../../ios/Tests/Fixtures/conversation-topics.json', import.meta.url), 'utf8'));
const toMessages = rows => rows.map(([role, content], index) => ({ id: `m${index}`, role, content }));

for (const fixture of cases) {
  test(`shared topic case: ${fixture.name}`, () => {
    const messages = toMessages(fixture.messages);
    const result = segmentConversationTopics(messages);
    const order = result.topics.map(topic => topic.id);
    const actual = messages.filter(m => m.role === 'user').map(m => order.indexOf(result.byMessage[m.id]));
    const expected = fixture.messages.filter(row => row[0] === 'user').map(row => row[2]);
    assert.deepEqual(actual, expected);
    // Every answer belongs to its question's topic.
    messages.forEach((m, index) => { if (m.role === 'assistant') assert.equal(result.byMessage[m.id], result.byMessage[messages[index - 1].id]); });
  });
}

test('terms ignore filler words and keep Chinese bigrams and code words', () => {
  assert.deepEqual([...topicTerms('那个爬虫怎么加代理')].sort(), ['个爬', '代理', '加代', '爬虫', '虫怎'].sort());
  assert.ok(topicTerms('How do I use Postgres?').has('postgres'));
  assert.equal(topicTerms('what is this').size, 0);
});

test('a returning topic brings back its older turns that left the recent window, newest first within budget', () => {
  const messages = toMessages(cases[0].messages);
  const segmentation = segmentConversationTopics(messages);
  // Window holds only the last 3 messages: the crawler turns (0–3) are outside it.
  const excerpt = returningTopicExcerpt(messages.slice(0, 9), segmentation, 6, 4000);
  assert.match(excerpt, /爬虫遇到 403/);
  assert.match(excerpt, /User-Agent/);
  assert.doesNotMatch(excerpt, /北京天气|科幻小说/, 'other topics stay out');
  const tight = returningTopicExcerpt(messages.slice(0, 9), segmentation, 6, 60);
  assert.match(tight, /爬虫遇到 403/);
  assert.doesNotMatch(tight, /Top250/, 'only the newest whole turn fits a small budget');
  assert.equal(returningTopicExcerpt(messages.slice(0, 9), segmentation, 0, 4000), '', 'nothing when everything is in the window');
  assert.equal(returningTopicExcerpt(messages.slice(0, 7), segmentation, 6, 4000), '', 'a new topic has nothing older');
  const directory = topicDirectory(segmentation, segmentation.byMessage.m8);
  assert.match(directory, /（当前）帮我写一个 Python 爬虫/);
  assert.match(directory, /明天北京天气怎么样/);
  assert.equal(topicDirectory(segmentConversationTopics(toMessages(cases[2].messages)), 'm0'), '', 'one topic needs no directory');
});

test('a long single-topic chat never resends its own older turns', () => {
  const messages = [];
  for (let index = 0; index < 20; index += 1) messages.push({ id: `q${index}`, role: 'user', content: index ? `那第 ${index} 步的 React 组件怎么写` : '我们一步步写一个 React 组件' }, { id: `a${index}`, role: 'assistant', content: `第 ${index} 步的写法` });
  const segmentation = segmentConversationTopics(messages);
  assert.equal(segmentation.topics.length, 1);
  assert.equal(returningTopicExcerpt(messages, segmentation, 30, 4000), '', 'the topic is still being discussed in the window');
});

test('the fold request marks topics, keeps the newest part within budget and carries the previous summary', async () => {
  const { foldSummaryRequest, topicContextForTurn } = await import('./conversationTopics.js');
  const messages = toMessages(cases[0].messages);
  const request = foldSummaryRequest(messages, '旧摘要内容', 100000);
  assert.match(request, /\[话题：帮我写一个 Python 爬虫/);
  assert.match(request, /\[话题：明天北京天气怎么样\]/);
  assert.match(request, /group the content by topic/);
  assert.match(request, /Previous summary[\s\S]*旧摘要内容/);
  const capped = foldSummaryRequest(messages, '', 80);
  assert.match(capped, /earlier part omitted/);
  assert.doesNotMatch(capped, /Top250/, 'the oldest part is cut first');
  assert.doesNotMatch(foldSummaryRequest(toMessages(cases[2].messages), '', 10000), /话题：|group the content by topic/, 'one topic needs no grouping');
  const turn = topicContextForTurn(messages.slice(0, 9), 6, 4000);
  assert.equal(turn.returned, true);
  assert.match(turn.text, /本对话涉及的话题[\s\S]*爬虫遇到 403/);
  assert.equal(topicContextForTurn(messages.slice(0, 7), 6, 4000).returned, false);
});
