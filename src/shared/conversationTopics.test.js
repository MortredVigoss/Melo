import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { segmentConversationTopics, topicDividers, topicTerms } from './conversationTopics.js';

// The same cases run on the iPhone through the shared agent core (SharedAgentCoreTests).
const cases = JSON.parse(readFileSync(new URL('../../ios/Tests/Fixtures/conversation-topics.json', import.meta.url), 'utf8'));
const toMessages = rows => rows.map(([role, content], index) => ({ id: `m${index}`, role, content }));

for (const fixture of cases) {
  test(`shared topic case: ${fixture.name}`, () => {
    const messages = toMessages(fixture.messages);
    const result = segmentConversationTopics(messages);
    const order = result.topics.map(topic => topic.id);
    const actual = messages.filter(m => m.role === 'user').map(m => order.indexOf(result.byMessage[m.id]));
    assert.deepEqual(actual, fixture.messages.filter(row => row[0] === 'user').map(row => row[2]));
    messages.forEach((m, index) => { if (m.role === 'assistant') assert.equal(result.byMessage[m.id], result.byMessage[messages[index - 1].id]); });
  });
}

test('terms ignore filler words and keep Chinese bigrams and code words', () => {
  assert.deepEqual([...topicTerms('那个爬虫怎么加代理')].sort(), ['个爬', '代理', '加代', '爬虫', '虫怎'].sort());
  assert.ok(topicTerms('How do I use Postgres?').has('postgres'));
  assert.equal(topicTerms('what is this').size, 0);
});

test('dividers mark each move; a return links to where the topic began', () => {
  const dividers = topicDividers(toMessages(cases[0].messages));
  assert.deepEqual(dividers, [
    { messageId: 'm4', label: '明天北京天气怎么样', returnsTo: null },
    { messageId: 'm6', label: '推荐几本科幻小说', returnsTo: null },
    { messageId: 'm8', label: '帮我写一个 Python 爬虫，抓取…', returnsTo: 'm0' },
  ]);
  assert.deepEqual(topicDividers(toMessages(cases[2].messages)), [], 'a single-topic chat shows no dividers');
  assert.deepEqual(topicDividers([]), []);
});

test('only the opening of a long message decides its topic', async () => {
  const { TOPIC_TEXT_LIMIT } = await import('./conversationTopics.js');
  // The second message has no topic words in its first TOPIC_TEXT_LIMIT characters, so it stays on the
  // current topic; the new-topic words after the limit must not be read (they would start a new topic).
  const messages = [
    { id: 'u1', role: 'user', content: '帮我写一个 Python 爬虫，抓取豆瓣电影 Top250 的片名和评分' },
    { id: 'a1', role: 'assistant', content: '可以用 requests 抓取。' },
    { id: 'u2', role: 'user', content: '。'.repeat(TOPIC_TEXT_LIMIT) + '明天北京天气怎么样，推荐几本科幻小说' },
  ];
  const result = segmentConversationTopics(messages);
  assert.equal(result.topics.length, 1);
  assert.equal(result.byMessage.u2, 'u1');
});
