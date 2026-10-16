/**
 * search_history tool
 *
 * Full-text search over conversation history using FTS5 BM25 ranking.
 * Searches the indexed messages (user + assistant) of the chats this chat may
 * read — the same project, or the other chats outside projects — and returns
 * excerpts with source chat context.
 *
 * Useful when the user asks "what did we discuss about X?" or wants to
 * find a previous conversation, code snippet, or decision.
 */

import { searchHistory } from '../../memory/conversationIndex.js';
import { loadState } from '../../state/stateStore.js';
import { historySearchChatIds } from '../../services/chat/historyScope.js';

export const searchHistoryTool = {
  id: 'search_history',
  name: 'Search Conversation History',
  description:
    'Full-text search over past conversation messages in this project (or, outside projects, in other chats outside projects). ' +
    'Use this to find previous discussions, decisions, code snippets, or answers the user has already received. ' +
    'Supports CJK (Chinese/Japanese/Korean) queries natively. ' +
    'Returns excerpts ranked by relevance with the source chat title and date.',
  category: 'memory',
  isConcurrencySafe: true,
  requiresPermission: false,
  parametersSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query. Can be in any language. Be specific to get better results.',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of results to return (1–20). Default: 8.',
        default: 8,
      },
      after: {
        type: 'string',
        description:
          'Optional ISO 8601 date (or "YYYY-MM-DD"). Only include messages created on or after this instant. ' +
          'Useful for "what did we discuss this week about X?" queries.',
      },
      chatId: {
        type: 'string',
        description:
          'Optional chat id. Restrict results to a single conversation. ' +
          'Use when the user references a specific chat or you want to drill down inside one thread.',
      },
    },
    required: ['query'],
  },
  examples: [
    { query: 'React component error boundary' },
    { query: '数据库设计', limit: 5 },
    { query: 'auth middleware', after: '2026-03-01' },
  ],

  async run({ query, limit = 8, after, chatId }, context = {}) {
    if (!query || typeof query !== 'string' || !query.trim()) {
      return { ok: false, output: 'Missing or empty query.', error: 'INVALID_QUERY' };
    }

    const lim = Math.max(1, Math.min(20, Math.floor(limit) || 8));
    // Bound the search to chats the current one may read (no crossing projects).
    let chatIds;
    if (context.chatId) {
      const state = await loadState({ home: context.meloHome });
      chatIds = historySearchChatIds(state, context.chatId);
    }
    const results = searchHistory(query.trim(), { limit: lim, after, chatId, chatIds });

    const filterDesc = [];
    if (after) filterDesc.push(`after=${after}`);
    if (chatId) filterDesc.push(`chatId=${chatId}`);
    const filterSuffix = filterDesc.length ? ` (${filterDesc.join(', ')})` : '';

    if (!results.length) {
      return {
        ok: true,
        output: `No conversation history found matching "${query}"${filterSuffix}.`,
        meta: { query, resultCount: 0, results: [], after: after || null, chatId: chatId || null },
      };
    }

    const lines = [
      `Conversation history search results for: "${query}"${filterSuffix}`,
      '',
    ];

    for (let i = 0; i < results.length; i++) {
      const { chatTitle, role, snippet, createdAt } = results[i];
      const dateStr = createdAt ? new Date(createdAt).toLocaleDateString() : '';
      lines.push(`### ${i + 1}. [${role}] in "${chatTitle || 'Untitled chat'}"${dateStr ? ` — ${dateStr}` : ''}`);
      if (snippet) lines.push(snippet);
      lines.push('');
    }

    return {
      ok: true,
      output: lines.join('\n').trim(),
      meta: {
        query,
        resultCount: results.length,
        results,
        after: after || null,
        chatId: chatId || null,
      },
    };
  },
};
