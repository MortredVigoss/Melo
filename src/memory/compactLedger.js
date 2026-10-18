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
    });
  }
  return out;
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
    return { title: match[1].trim().slice(0, TITLE_MAX_CHARS), body: lines.slice(1).join('\n').trim() || raw };
  }
  const firstUser = messages.find(message => message?.role === 'user' && typeof message.content === 'string' && message.content.trim());
  const fallback = firstUser ? firstUser.content.trim().replace(/\s+/g, ' ').slice(0, TITLE_MAX_CHARS) : '对话片段';
  return { title: fallback, body: raw };
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
    messageCount: Array.isArray(plan?.messages) ? plan.messages.length : 0,
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

/** Replace the newest card's text (used when a rule summary is upgraded). */
export function replaceLatestCardSummary(chat, { summary, source = 'cloud', now = new Date() } = {}) {
  const cards = ledgerCards(chat);
  if (!cards.length) return null;
  const last = cards[cards.length - 1];
  const { title, body } = splitCardSummary(summary);
  const next = { ...last, title: title || last.title, summary: truncateToTokens(body, CARD_SUMMARY_MAX_TOKENS), source, at: now.toISOString() };
  cards[cards.length - 1] = next;
  chat.compactCards = cards;
  chat.compactSummary = renderCompactLedger(cards);
  chat.compactedAt = next.at;
  chat.compactSummarySource = cards.some(card => card.source === 'rule') ? 'rule' : source;
  return next;
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
export function renderCompactLedger(cards, { maxTokens = LEDGER_MAX_TOKENS } = {}) {
  const list = normalizeCompactCards(cards);
  if (!list.length) return '';
  const full = card => {
    const head = `## ${card.title}${card.source === 'rule' ? '（抽取式摘要，可能遗漏细节）' : ''}`;
    const range = cardRange(card);
    const meta = [range, card.messageCount ? `${card.messageCount} 条` : '', card.at ? card.at.slice(0, 10) : ''].filter(Boolean).join(' · ');
    return [head, meta ? `（${meta}；需要原文时用 read_history 读取这段消息）` : '', card.truncated ? '[这段过长，摘要只覆盖可容纳的片段。]' : '', card.summary].filter(Boolean).join('\n');
  };
  const brief = card => `- ${card.title}（${cardRange(card) || '更早'}；详情已折叠，用 read_history 读取）`;
  const blocks = list.map(full);
  let collapsed = 0;
  const render = () => {
    const parts = [];
    if (collapsed > 0) parts.push(['### 更早的话题（已折叠）', ...list.slice(0, collapsed).map(brief)].join('\n'));
    parts.push(...blocks.slice(collapsed));
    return parts.join('\n\n');
  };
  let text = render();
  while (collapsed < list.length - 1 && estimateTextTokens(text) > maxTokens) {
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

/**
 * Score cards against a user message (character bigrams for CJK, lowercase
 * words otherwise). Used to pick topic excerpts for the turn section.
 */
export function rankCardsForMessage(cards, text, { limit = 2, minScore = 2 } = {}) {
  const list = normalizeCompactCards(cards);
  const needle = termsOf(text);
  if (!list.length || !needle.size) return [];
  return list
    .map(card => {
      const hay = termsOf(`${card.title}\n${card.summary}`);
      let score = 0;
      for (const term of needle) if (hay.has(term)) score += term.length >= 3 ? 2 : 1;
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
  for (const word of value.match(/[a-z0-9_./-]{3,}/g) || []) terms.add(word);
  const cjk = value.replace(/[^぀-ヿ㐀-鿿가-힯]/g, ' ');
  for (const run of cjk.split(/\s+/)) {
    for (let index = 0; index + 1 < run.length; index += 1) terms.add(run.slice(index, index + 2));
  }
  return terms;
}
