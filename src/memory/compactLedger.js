// Ledger-style conversation summary (2026-10-17 design 1D-2).
//
// Before: `chat.compactSummary` was a single slot. Every compaction fed the
// previous summary back into the model together with the new chunk and
// overwrote the slot with the result, so early topics decayed one generation
// at a time and a degraded (rule) summary could silently replace a good one.
//
// Now: each compaction produces one *card* for the chunk it summarised —
// `{id, title, summary, fromMessageId, toMessageId, messageCount, at, source}`
// — and cards are appended to `chat.compactCards`, never rewritten by later
// compactions. `chat.compactSummary` becomes a rendering of the ledger, so
// everything downstream (prompt section, thread checkpoint, state hydration,
// phone sync) keeps reading the same field. When the rendering exceeds its
// token budget the oldest cards collapse to a one-line title that points to
// the original message range, which `read_history` can read back verbatim.
//
// Legacy chats that still carry a bare `compactSummary` are migrated on the
// next compaction: the old text becomes one historical card.

import { estimateTextTokens, truncateToTokens } from './tokenEstimate.js';

export const LEDGER_MAX_TOKENS = 6000;
export const CARD_SUMMARY_MAX_TOKENS = 2500;
const TITLE_MAX_CHARS = 80;

export function normalizeCompactCards(cards) {
  if (!Array.isArray(cards)) return [];
  const out = [];
  for (const card of cards) {
    if (!card || typeof card !== 'object') continue;
    const summary = typeof card.summary === 'string' ? card.summary.trim() : '';
    if (!summary) continue;
    out.push({
      id: typeof card.id === 'string' && card.id.trim() ? card.id.trim() : `card-${out.length + 1}`,
      title: typeof card.title === 'string' && card.title.trim() ? card.title.trim().slice(0, TITLE_MAX_CHARS) : '对话片段',
      summary,
      fromMessageId: typeof card.fromMessageId === 'string' ? card.fromMessageId : '',
      toMessageId: typeof card.toMessageId === 'string' ? card.toMessageId : '',
      messageCount: Number.isFinite(Number(card.messageCount)) && Number(card.messageCount) >= 0 ? Number(card.messageCount) : 0,
      at: typeof card.at === 'string' ? card.at : '',
      source: ['cloud', 'local', 'rule'].includes(card.source) ? card.source : 'cloud',
      ...(card.truncated === true ? { truncated: true } : {}),
      ...(card.userEdited === true ? { userEdited: true } : {}),
      // Degraded state is per card (audit L7): how often the model was retried
      // for this card's own range. Dropped from the phone wire format.
      ...(Number.isFinite(Number(card.upgradeAttempts)) && Number(card.upgradeAttempts) > 0 ? { upgradeAttempts: Math.floor(Number(card.upgradeAttempts)) } : {}),
    });
  }
  return out;
}

/** The newest extractive (rule) card that may still be upgraded, or null. */
export function degradedCardForUpgrade(chat, { maxAttempts = 3 } = {}) {
  const cards = ledgerCards(chat);
  for (let index = cards.length - 1; index >= 0; index -= 1) {
    const card = cards[index];
    if (card.source === 'rule' && (card.upgradeAttempts || 0) < maxAttempts) return card;
  }
  return null;
}

/** Count one more upgrade attempt on `cardId` (persisted with the cards). */
export function noteCardUpgradeAttempt(chat, cardId) {
  const cards = ledgerCards(chat);
  const index = cards.findIndex(card => card.id === cardId);
  if (index < 0) return null;
  cards[index] = { ...cards[index], upgradeAttempts: (cards[index].upgradeAttempts || 0) + 1 };
  chat.compactCards = cards;
  chat.compactUpgradeAttempts = (chat.compactUpgradeAttempts || 0) + 1;
  return cards[index];
}

export function compactCardsEqual(a, b) {
  const left = normalizeCompactCards(a), right = normalizeCompactCards(b);
  if (left.length !== right.length) return false;
  return left.every((card, index) => {
    const other = right[index];
    return card.id === other.id && card.title === other.title && card.summary === other.summary
      && card.fromMessageId === other.fromMessageId && card.toMessageId === other.toMessageId
      && card.messageCount === other.messageCount && card.at === other.at && card.source === other.source
      && Boolean(card.truncated) === Boolean(other.truncated) && Boolean(card.userEdited) === Boolean(other.userEdited);
  });
}

/** Existing cards, or the legacy single summary as one historical card. */
export function ledgerCards(chat) {
  const cards = normalizeCompactCards(chat?.compactCards);
  if (cards.length) return cards;
  const legacy = typeof chat?.compactSummary === 'string' ? chat.compactSummary.trim() : '';
  if (!legacy) return [];
  return [{
    id: 'legacy',
    title: '早期对话摘要',
    summary: legacy,
    fromMessageId: '',
    toMessageId: typeof chat?.compactBoundaryMessageId === 'string' ? chat.compactBoundaryMessageId : '',
    messageCount: Number(chat?.compactedMessageCount) || 0,
    at: typeof chat?.compactedAt === 'string' ? chat.compactedAt : '',
    source: ['cloud', 'local', 'rule'].includes(chat?.compactSummarySource) ? chat.compactSummarySource : 'cloud',
  }];
}

/**
 * Split a model summary into `{title, body}`. The compaction prompt asks
 * for a first line `# 标题`; older or off-format outputs fall back to the
 * first user line of the chunk.
 */
export function splitCardSummary(text, messages = []) {
  const raw = String(text || '').trim();
  const lines = raw.split('\n');
  const first = lines[0] || '';
  const match = /^\s*(?:#+\s*|标题[:：]\s*|Title[:：]\s*)(.+?)\s*$/.exec(first);
  if (match && match[1].trim()) {
    return { title: match[1].trim().slice(0, TITLE_MAX_CHARS), body: lines.slice(1).join('\n').trim() || raw, explicitTitle: true };
  }
  const firstUser = messages.find(message => message?.role === 'user' && typeof message.content === 'string' && message.content.trim());
  const fallback = firstUser ? firstUser.content.trim().replace(/\s+/g, ' ').slice(0, TITLE_MAX_CHARS) : '对话片段';
  return { title: fallback, body: raw, explicitTitle: false };
}

function cardId(plan, existing) {
  const base = `card-${existing.length + 1}`;
  const boundary = String(plan?.boundaryId || '').slice(0, 8);
  const id = boundary ? `${base}-${boundary}` : base;
  return existing.some(card => card.id === id) ? `${id}-${Date.now().toString(36)}` : id;
}

/**
 * Append the card produced for `plan.messages` and refresh every derived
 * compact field on the chat. Returns the card.
 */
export function appendCompactCard(chat, plan, { summary, source = 'cloud', now = new Date() } = {}) {
  const existing = ledgerCards(chat);
  const { title, body } = splitCardSummary(summary, plan?.messages || []);
  const card = {
    id: cardId(plan, existing),
    title,
    summary: truncateToTokens(body, CARD_SUMMARY_MAX_TOKENS),
    fromMessageId: String(plan?.messages?.[0]?.id || ''),
    toMessageId: String(plan?.boundaryId || plan?.messages?.at?.(-1)?.id || ''),
    // An oversized turn is folded into one excerpt message (contextCompact);
    // the card still reports how many original messages it covers (audit L14).
    messageCount: Number.isFinite(Number(plan?.coveredCount)) && Number(plan.coveredCount) > 0 ? Number(plan.coveredCount)
      : Array.isArray(plan?.messages) ? plan.messages.length : 0,
    at: now.toISOString(),
    source: ['cloud', 'local', 'rule'].includes(source) ? source : 'cloud',
    ...(plan?.truncated ? { truncated: true } : {}),
  };
  const cards = [...existing, card];
  chat.compactCards = cards;
  chat.compactSummary = renderCompactLedger(cards);
  chat.compactBoundaryMessageId = plan.boundaryId;
  chat.compactedMessageCount = plan.compactedCount;
  chat.compactedAt = card.at;
  chat.compactFailures = 0;
  chat.compactSummarySource = card.source;
  chat.compactUpgradeAttempts = 0;
  return card;
}

/**
 * Replace one card's text in place (used when a rule summary is upgraded by
 * the model). The card keeps its id and message range; the title is only
 * overridden when the model emitted a `# ` line (audit L13). The chat-level
 * source follows the newest card, so an upgraded older card no longer keeps
 * the whole ledger marked as degraded (audit L7).
 */
export function replaceCardSummary(chat, cardId, { summary, source = 'cloud', now = new Date() } = {}) {
  const cards = ledgerCards(chat);
  const index = cards.findIndex(card => card.id === cardId);
  if (index < 0) return null;
  const previous = cards[index];
  const { title, body, explicitTitle } = splitCardSummary(summary);
  const { upgradeAttempts: _attempts, ...rest } = previous;
  const next = { ...rest, title: explicitTitle && title ? title : previous.title, summary: truncateToTokens(body, CARD_SUMMARY_MAX_TOKENS), source, at: now.toISOString() };
  cards[index] = next;
  chat.compactCards = cards;
  chat.compactSummary = renderCompactLedger(cards);
  chat.compactedAt = next.at;
  chat.compactSummarySource = cards[cards.length - 1].source;
  return next;
}

/** Replace the newest card's text (legacy entry point; see replaceCardSummary). */
export function replaceLatestCardSummary(chat, options = {}) {
  const cards = ledgerCards(chat);
  if (!cards.length) return null;
  return replaceCardSummary(chat, cards[cards.length - 1].id, options);
}

function cardRange(card) {
  if (card.fromMessageId && card.toMessageId) return `消息 #${card.fromMessageId} … #${card.toMessageId}`;
  if (card.toMessageId) return `截至消息 #${card.toMessageId}`;
  return '';
}

/**
 * Render cards oldest → newest. When the total exceeds `maxTokens`, the
 * oldest cards collapse to a title line (the originals stay readable through
 * read_history). Returns '' for an empty ledger.
 */
export function renderCompactLedger(cards, { maxTokens = LEDGER_MAX_TOKENS, readHistory = true } = {}) {
  const list = normalizeCompactCards(cards);
  if (!list.length) return '';
  // The read_history hint is only true when the tool is actually exposed to
  // the model this turn (audit L18); the persisted rendering keeps it.
  const hint = readHistory ? '；需要原文时用 read_history 读取这段消息' : '';
  const full = card => {
    const head = `## ${card.title}${card.source === 'rule' ? '（抽取式摘要，可能遗漏细节）' : ''}`;
    const range = cardRange(card);
    const meta = [range, card.messageCount ? `${card.messageCount} 条` : '', card.at ? card.at.slice(0, 10) : ''].filter(Boolean).join(' · ');
    return [head, meta ? `（${meta}${hint}）` : '', card.truncated ? '[这段过长，摘要只覆盖可容纳的片段。]' : '', card.summary].filter(Boolean).join('\n');
  };
  const brief = card => `- ${card.title}（${cardRange(card) || '更早'}；详情已折叠${readHistory ? '，用 read_history 读取' : ''}）`;
  // The migrated legacy summary may stand for hundreds of messages with no
  // readable range, so it is pinned: it never collapses to a title line
  // (audit L21). Everything else collapses oldest first.
  const pinned = card => card.id === 'legacy' && !card.fromMessageId;
  const collapsible = list.map((card, index) => (pinned(card) ? -1 : index)).filter(index => index >= 0);
  const blocks = list.map(full);
  let collapsed = 0;
  const render = () => {
    const hidden = new Set(collapsible.slice(0, collapsed));
    const parts = [];
    if (hidden.size) parts.push(['### 更早的话题（已折叠）', ...list.filter((_, index) => hidden.has(index)).map(brief)].join('\n'));
    parts.push(...blocks.filter((_, index) => !hidden.has(index)));
    return parts.join('\n\n');
  };
  // The newest card always stays in full.
  const maxCollapse = Math.max(0, collapsible.length - (collapsible.at(-1) === list.length - 1 ? 1 : 0));
  let text = render();
  while (collapsed < maxCollapse && estimateTextTokens(text) > maxTokens) {
    collapsed += 1;
    text = render();
  }
  if (estimateTextTokens(text) > maxTokens) text = truncateToTokens(text, maxTokens);
  return text;
}

/** Short background for the summariser: titles + the first line of each card. */
export function ledgerDigest(cards, { maxTokens = 1500 } = {}) {
  const list = normalizeCompactCards(cards);
  if (!list.length) return '';
  const lines = list.map(card => {
    const firstLine = card.summary.split('\n').map(line => line.trim()).find(Boolean) || '';
    return `- ${card.title}：${firstLine.slice(0, 160)}`;
  });
  return truncateToTokens(['已有话题卡（只是背景，不要重复，不要改写）：', ...lines].join('\n'), maxTokens);
}

// Function words that say nothing about the topic (audit L8): a short
// acknowledgement like "好的，那我们继续吧" used to hit every card through
// its bigrams and pulled ≤3k uncached tokens of excerpts into each turn.
const STOP_TERMS = new Set([
  '好的', '我们', '这个', '那个', '可以', '继续', '那么', '一下', '一个', '什么', '怎么', '然后', '就是', '不是', '没有', '没问', '问题',
  '现在', '还是', '但是', '如果', '因为', '所以', '已经', '需要', '知道', '觉得', '时候', '这样', '那样', '这里', '那里', '一些', '不过',
  '请你', '帮我', '请问', '谢谢', '好了', '对的', '是的', '不用', '再来', '看看', '试试', '一样', '东西', '事情', '的话', '来说', '其实',
  '他们', '你们', '自己', '大家', '刚才', '之前', '之后', '以及', '或者', '还有', '以后', '开始', '结束', '告诉', '进行', '使用', '关于',
  'the', 'and', 'that', 'this', 'with', 'for', 'you', 'your', 'are', 'was', 'were', 'what', 'how', 'can', 'could', 'would', 'should',
  'please', 'thanks', 'thank', 'okay', 'yes', 'not', 'but', 'from', 'about', 'have', 'has', 'had', 'just', 'let', 'lets', 'now', 'then',
  'there', 'here', 'they', 'them', 'our', 'ours', 'also', 'any', 'some', 'more', 'into', 'out', 'one', 'all', 'get', 'got', 'make', 'sure',
]);

/**
 * Score cards against a user message (character bigrams for CJK, lowercase
 * words otherwise). Used to pick topic excerpts for the turn section.
 *
 * Terms are IDF-weighted across the ledger: a term present in at least half
 * of the cards (of a ledger with ≥4 cards) weighs nothing, rarer terms weigh
 * more; function words are dropped outright. A whole latin word counts 3,
 * a CJK bigram 1, so `minScore` 3 needs one distinctive word or three
 * overlapping bigrams (≈ a 4-character topic phrase) before any card is
 * selected.
 */
export function rankCardsForMessage(cards, text, { limit = 2, minScore = 3 } = {}) {
  const list = normalizeCompactCards(cards);
  const needle = termsOf(text);
  if (!list.length || !needle.size) return [];
  const hays = list.map(card => termsOf(`${card.title}\n${card.summary}`));
  const documentFrequency = new Map();
  for (const hay of hays) for (const term of hay) documentFrequency.set(term, (documentFrequency.get(term) || 0) + 1);
  const total = list.length;
  const weightOf = term => {
    const df = documentFrequency.get(term) || 0;
    if (!df) return 0;
    if (total >= 4 && df * 2 >= total) return 0;
    const idf = Math.log((total + 1) / df) / Math.log(total + 1); // (0, 1], 1 when the term is unique to one card
    return (/^[a-z0-9_./-]{3,}$/.test(term) ? 3 : 1) * idf;
  };
  return list
    .map((card, index) => {
      let score = 0;
      for (const term of needle) if (hays[index].has(term)) score += weightOf(term);
      return { card, score };
    })
    .filter(entry => entry.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(entry => entry.card);
}

function termsOf(text) {
  const terms = new Set();
  const value = String(text || '').toLowerCase();
  for (const word of value.match(/[a-z0-9_./-]{3,}/g) || []) if (!STOP_TERMS.has(word)) terms.add(word);
  const cjk = value.replace(/[^぀-ヿ㐀-鿿가-힯]/g, ' ');
  for (const run of cjk.split(/\s+/)) {
    for (let index = 0; index + 1 < run.length; index += 1) {
      const bigram = run.slice(index, index + 2);
      if (!STOP_TERMS.has(bigram)) terms.add(bigram);
    }
  }
  return terms;
}
