import test from 'node:test';
import assert from 'node:assert/strict';
import { appendCompactCard, replaceLatestCardSummary, ledgerCards, renderCompactLedger, ledgerDigest, rankCardsForMessage, splitCardSummary, normalizeCompactCards, compactCardsEqual } from './compactLedger.js';
import { estimateTextTokens } from './tokenEstimate.js';

const msgs = (n, prefix = 'm') => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, role: i % 2 ? 'assistant' : 'user', content: `${prefix} text ${i}` }));

test('each compaction appends one card and re-renders compactSummary; legacy summary becomes a card', () => {
  const chat = { compactSummary: 'old single-slot summary', compactBoundaryMessageId: 'x9', compactedMessageCount: 10, compactSummarySource: 'cloud' };
  assert.equal(ledgerCards(chat)[0].id, 'legacy');
  const plan1 = { messages: msgs(6, 'a'), boundaryId: 'a5', compactedCount: 16 };
  const card1 = appendCompactCard(chat, plan1, { summary: '# 部署流程\n1. Request: deploy\n2. Facts: port 8443 [#a2]', source: 'cloud' });
  assert.equal(chat.compactCards.length, 2);
  assert.equal(chat.compactCards[0].title, '早期对话摘要');
  assert.equal(card1.title, '部署流程');
  assert.equal(card1.fromMessageId, 'a0');
  assert.equal(card1.toMessageId, 'a5');
  assert.equal(chat.compactBoundaryMessageId, 'a5');
  assert.equal(chat.compactedMessageCount, 16);
  assert.match(chat.compactSummary, /old single-slot summary/);
  assert.match(chat.compactSummary, /## 部署流程/);
  assert.match(chat.compactSummary, /port 8443 \[#a2\]/);
  assert.match(chat.compactSummary, /消息 #a0 … #a5/);
  // A second compaction keeps card 1 byte-identical.
  const before = JSON.stringify(chat.compactCards[1]);
  appendCompactCard(chat, { messages: msgs(4, 'b'), boundaryId: 'b3', compactedCount: 20 }, { summary: 'no title line here', source: 'rule' });
  assert.equal(JSON.stringify(chat.compactCards[1]), before);
  assert.equal(chat.compactCards[2].title, 'b text 0');
  assert.equal(chat.compactSummarySource, 'rule');
  assert.match(chat.compactSummary, /抽取式摘要/);
  // Upgrading replaces only the newest (degraded) card.
  replaceLatestCardSummary(chat, { summary: '# 升级后\nbetter', source: 'cloud' });
  assert.equal(chat.compactCards.length, 3);
  assert.equal(chat.compactCards[2].title, '升级后');
  assert.equal(chat.compactSummarySource, 'cloud');
  assert.equal(JSON.stringify(chat.compactCards[1]), before);
});

test('rendering collapses the oldest cards to a title line when over budget', () => {
  const cards = Array.from({ length: 6 }, (_, i) => ({ id: `c${i}`, title: `话题${i}`, summary: `细节 ${i} `.repeat(400), fromMessageId: `f${i}`, toMessageId: `t${i}` }));
  const text = renderCompactLedger(cards, { maxTokens: 1500 });
  assert.ok(estimateTextTokens(text) <= 1500);
  assert.match(text, /### 更早的话题（已折叠）/);
  assert.match(text, /- 话题0（消息 #f0 … #t0；详情已折叠，用 read_history 读取）/);
  assert.match(text, /## 话题5/);
  assert.equal(renderCompactLedger([]), '');
  const digest = ledgerDigest(cards);
  assert.match(digest, /- 话题0：细节 0/);
  assert.ok(estimateTextTokens(digest) <= 1500);
});

test('card ranking matches CJK bigrams and latin words; weak overlap is ignored', () => {
  const cards = [
    { id: 'a', title: '数据库迁移', summary: 'postgres 升级到 16，路径 /srv/db' },
    { id: 'b', title: '首页改版', summary: 'hero 区域换图' },
  ];
  assert.deepEqual(rankCardsForMessage(cards, '刚才数据库迁移的路径是什么？').map(c => c.id), ['a']);
  assert.deepEqual(rankCardsForMessage(cards, 'postgres path?').map(c => c.id), ['a']);
  assert.deepEqual(rankCardsForMessage(cards, '你好'), []);
});

test('normalisation drops empty cards and equality ignores order-insensitive noise', () => {
  assert.deepEqual(normalizeCompactCards([null, { summary: '' }, { summary: 'x', title: '' }]).map(c => c.title), ['对话片段']);
  assert.ok(compactCardsEqual([{ id: '1', summary: 'a' }], [{ id: '1', summary: 'a', extra: 1 }]));
  assert.ok(!compactCardsEqual([{ id: '1', summary: 'a' }], [{ id: '1', summary: 'b' }]));
  assert.deepEqual(splitCardSummary('标题：部署\nbody'), { title: '部署', body: 'body' });
});
