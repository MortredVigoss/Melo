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
  assert.deepEqual(splitCardSummary('标题：部署\nbody'), { title: '部署', body: 'body', explicitTitle: true });
});

// ─── 2026-10-18 bug audit (section 2) ────────────────────────────────────────

test('L6/L7/L13: an upgrade replaces the degraded card by id, keeps its range and title unless the model gave one, and the chat source follows the newest card', async () => {
  const { replaceCardSummary, degradedCardForUpgrade, noteCardUpgradeAttempt } = await import('./compactLedger.js');
  const chat = {};
  appendCompactCard(chat, { messages: msgs(6, 'a'), boundaryId: 'a5', compactedCount: 6 }, { summary: 'extractive one', source: 'rule' });
  appendCompactCard(chat, { messages: msgs(4, 'b'), boundaryId: 'b3', compactedCount: 10 }, { summary: '# 第二段\ncloud two', source: 'cloud' });
  assert.equal(chat.compactSummarySource, 'cloud', 'the newest card decides the chat-level source');
  const degraded = degradedCardForUpgrade(chat);
  assert.equal(degraded.id, chat.compactCards[0].id, 'the older rule card is the upgrade target, not the newest card');
  assert.equal(degraded.fromMessageId, 'a0'); assert.equal(degraded.toMessageId, 'a5');
  // Attempts are counted per card and survive normalisation; 3 attempts retire the card.
  noteCardUpgradeAttempt(chat, degraded.id); noteCardUpgradeAttempt(chat, degraded.id);
  assert.equal(ledgerCards(chat)[0].upgradeAttempts, 2);
  assert.equal(chat.compactUpgradeAttempts, 2);
  assert.ok(degradedCardForUpgrade(chat));
  noteCardUpgradeAttempt(chat, degraded.id);
  assert.equal(degradedCardForUpgrade(chat), null, 'retired after 3 attempts');
  // Replacement without a `# ` line keeps the card's own title (L13) and range (L6).
  const before = { ...ledgerCards(chat)[0] };
  const replaced = replaceCardSummary(chat, degraded.id, { summary: 'better body without a heading', source: 'cloud' });
  assert.equal(replaced.title, before.title);
  assert.equal(replaced.fromMessageId, 'a0'); assert.equal(replaced.toMessageId, 'a5'); assert.equal(replaced.messageCount, 6);
  assert.equal(replaced.source, 'cloud');
  assert.equal(replaced.upgradeAttempts, undefined, 'an upgraded card is no longer degraded');
  assert.equal(chat.compactCards[1].summary, 'cloud two', 'the newest card is untouched');
  assert.equal(chat.compactSummarySource, 'cloud');
  assert.doesNotMatch(chat.compactSummary, /抽取式摘要/);
  assert.equal(replaceCardSummary(chat, 'card-nope', { summary: 'x' }), null);
  // With a `# ` line the title is overridden.
  assert.equal(replaceCardSummary(chat, degraded.id, { summary: '# 新标题\nbody', source: 'cloud' }).title, '新标题');
  // A rule card that is the newest still marks the chat degraded; an older one does not.
  appendCompactCard(chat, { messages: msgs(2, 'c'), boundaryId: 'c1', compactedCount: 12 }, { summary: 'rule three', source: 'rule' });
  assert.equal(chat.compactSummarySource, 'rule');
  replaceCardSummary(chat, chat.compactCards[2].id, { summary: '# 恢复\nfixed', source: 'cloud' });
  assert.equal(chat.compactSummarySource, 'cloud');
});

test('L8: acknowledgements and function words select no card; a topic phrase still does; ledger-wide terms weigh nothing', () => {
  const cards = [
    { id: 'a', title: '数据库迁移', summary: '好的，我们把 postgres 升级到 16，端口 5433，路径 /srv/db。这个没问题，继续。' },
    { id: 'b', title: '首页改版', summary: '好的，我们把 hero 区域换图，这个可以继续。' },
    { id: 'c', title: '发布计划', summary: '好的，我们周五发布，这个没问题。' },
    { id: 'd', title: '会议纪要', summary: '好的，我们下周继续讨论，这个可以。' },
  ];
  assert.deepEqual(rankCardsForMessage(cards, '好的，那我们继续吧'), []);
  assert.deepEqual(rankCardsForMessage(cards, '可以，这个没问题'), []);
  assert.deepEqual(rankCardsForMessage(cards, 'ok thanks, that is fine'), []);
  assert.deepEqual(rankCardsForMessage(cards, '数据库迁移的端口').map(c => c.id), ['a']);
  assert.deepEqual(rankCardsForMessage(cards, 'what was the postgres port?').map(c => c.id), ['a']);
  // A term present in at least half of the cards carries no weight even if it is not a stop word.
  const shared = cards.map(card => ({ ...card, summary: `${card.summary} 发布周五` }));
  assert.deepEqual(rankCardsForMessage(shared, '周五发布的事'), []);
});

test('L21/L18: the migrated legacy card is pinned (never collapsed) and the read_history hint is optional', () => {
  const legacy = { id: 'legacy', title: '早期对话摘要', summary: '很多早期内容 '.repeat(120), fromMessageId: '', toMessageId: 'x9', messageCount: 300 };
  const cards = [legacy, ...Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, title: `话题${i}`, summary: `细节 ${i} `.repeat(400), fromMessageId: `f${i}`, toMessageId: `t${i}` }))];
  const text = renderCompactLedger(cards, { maxTokens: 1800 });
  assert.ok(estimateTextTokens(text) <= 1800);
  assert.match(text, /## 早期对话摘要/, 'legacy card stays in full');
  assert.doesNotMatch(text, /- 早期对话摘要（/, 'legacy card is never a collapsed title line');
  assert.match(text, /- 话题0（消息 #f0 … #t0；详情已折叠，用 read_history 读取）/);
  assert.match(text, /## 话题4/, 'newest card stays in full');
  // Only the legacy card: it is never collapsed to a line, only truncated as a last resort.
  const only = renderCompactLedger([legacy], { maxTokens: 200 });
  assert.match(only, /## 早期对话摘要/);
  assert.ok(estimateTextTokens(only) <= 200);
  const silent = renderCompactLedger(cards.slice(1, 3), { readHistory: false });
  assert.doesNotMatch(silent, /read_history/);
  assert.match(renderCompactLedger(cards.slice(1, 3)), /read_history/);
  const collapsedSilent = renderCompactLedger(cards.slice(1), { maxTokens: 1500, readHistory: false });
  assert.doesNotMatch(collapsedSilent, /read_history/);
  assert.match(collapsedSilent, /详情已折叠）/);
});

test('L14: a card for a folded oversized turn reports the covered message count', () => {
  const chat = {};
  const card = appendCompactCard(chat, { messages: [{ id: 'u0', role: 'user', content: 'excerpt' }], boundaryId: 'a1', compactedCount: 2, coveredCount: 2, truncated: true }, { summary: '# 大段\nbody' });
  assert.equal(card.messageCount, 2);
  assert.equal(card.truncated, true);
});
