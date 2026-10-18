// Topic excerpts for the per-turn tail (2026-10-17 design 1D-4).
//
// Once a conversation has been compacted, the model only sees the ledger
// cards for the early part. When the user's new message clearly returns to
// one of those topics, this picks the 1–2 most relevant cards and renders a
// bounded excerpt of the *original* messages they cover, so "回到 A" gets A's
// own wording without a read_history round trip. The excerpt lives in the
// turn section (priority 85), never in the cached prefix, and messages[] is
// never reordered.

import { ledgerCards, rankCardsForMessage } from '../../memory/compactLedger.js';
import { sliceHistory } from '../../tools/builtins/readHistoryTool.js';
import { estimateTextTokens, truncateToTokens } from '../../memory/tokenEstimate.js';

const MIN_QUERY_CHARS = 6;

function lineOf(message) {
  const role = message.role === 'user' ? 'User' : 'Assistant';
  const text = typeof message.content === 'string' ? message.content.trim()
    : Array.isArray(message.content) ? message.content.filter(p => p?.type === 'text').map(p => p.text || '').join('\n').trim() : '';
  return text ? `[#${message.id}] ${role}: ${text}` : '';
}

export function buildTopicExcerpts(chat, latestUserMessage, { limit = 2, maxTokensPerCard = 1500, maxMessagesPerCard = 60, readHistory = true } = {}) {
  const query = String(latestUserMessage || '').trim();
  if (query.length < MIN_QUERY_CHARS) return { text: '', cards: [] };
  const cards = ledgerCards(chat).filter(card => card.fromMessageId || card.toMessageId);
  if (!cards.length) return { text: '', cards: [] };
  const picked = rankCardsForMessage(cards, query, { limit });
  const blocks = [];
  for (const card of picked) {
    const slice = sliceHistory(chat?.messages, { fromMessageId: card.fromMessageId || undefined, toMessageId: card.toMessageId || undefined, limit: maxMessagesPerCard });
    const lines = slice.messages.map(lineOf).filter(Boolean);
    if (!lines.length) continue;
    // Keep whole messages until the card budget is spent; the last one may be cut.
    const kept = [];
    let used = 0;
    for (const line of lines) {
      const tokens = estimateTextTokens(line);
      if (used + tokens > maxTokensPerCard) {
        if (!kept.length) kept.push(truncateToTokens(line, maxTokensPerCard));
        else kept.push(readHistory ? '…（更多原文用 read_history 读取）' : '…（已截断）');
        break;
      }
      kept.push(line);
      used += tokens;
    }
    blocks.push([`## 原文摘录：${card.title}`, `（消息 #${card.fromMessageId || '?'} … #${card.toMessageId || '?'}；与当前问题相关的早期话题）`, ...kept].join('\n'));
  }
  return { text: blocks.join('\n\n'), cards: picked.filter(card => blocks.length) };
}
