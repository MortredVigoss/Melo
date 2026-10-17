/**
 * search_history tool
 *
 * Full-text search over conversation history using FTS5 BM25 ranking.
 * Searches across all indexed chat messages (user + assistant) and returns
 * excerpts with source chat context.
 *
 * Useful when the user asks "what did we discuss about X?" or wants to
 * find a previous conversation, code snippet, or decision.
 */

import { searchHistory, normalizeAudience, DESKTOP_AUDIENCE } from '../../memory/conversationIndex.js';

export const searchHistoryTool = {
  id: 'search_history',
  name: 'Search Conversation History',
  description:
    'Full-text search over past conversation messages. ' +
    'Use this to find previous discussions, decisions, code snippets, or answers the user has already received. ' +
    'Supports CJK (Chinese/Japanese/Korean) queries natively. ' +
    'Returns excerpts ranked by relevance with the source chat title and date.',
  category: 'memory',
  isConcurrencySafe: true,
  requiresPermission: false,
  // Self-description (tools/tool.js); see that file for the fallback tables.
  capability: 'knowledgeMemory',
  needsWorkspace: false,
  uiModule: 'files',
  inputKeys: ['query', 'scope', 'chatId', 'after', 'limit'],
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
      scope: {
        type: 'string',
        enum: ['project', 'all'],
        description:
          'Default "project": only conversations of the current project (or, outside a project, conversations that belong to no project). ' +
          '"all": every project on this desktop. Only honoured for the desktop user; messaging channels always stay inside their own channel and project.',
      },
    },
    required: ['query'],
  },
  examples: [
    { query: 'React component error boundary' },
    { query: '数据库设计', limit: 5 },
    { query: 'auth middleware', after: '2026-03-01' },
  ],

  async run({ query, limit = 8, after, chatId, scope = 'project' }, context = {}) {
    if (!query || typeof query !== 'string' || !query.trim()) {
      return { ok: false, output: 'Missing or empty query.', error: 'INVALID_QUERY' };
    }

    // Scope comes from the execution context, never from the model (audit
    // P0-3): a Telegram/Discord audience can only search its own channel and
    // project; the desktop owner defaults to the current project and may opt
    // into all projects.
    const audience = normalizeAudience(context?.chatSource);
    const projectId = String(context?.projectId || '');
    const allProjects = audience === DESKTOP_AUDIENCE && scope === 'all';
    const lim = Math.max(1, Math.min(20, Math.floor(limit) || 8));
    const results = searchHistory(query.trim(), { limit: lim, after, chatId, audience, projectId, allProjects });

    const filterDesc = [];
    if (after) filterDesc.push(`after=${after}`);
    if (chatId) filterDesc.push(`chatId=${chatId}`);
    if (audience !== DESKTOP_AUDIENCE) filterDesc.push(`channel=${audience}`);
    else if (!allProjects) filterDesc.push(projectId ? `project=${projectId}` : 'no-project');
    const filterSuffix = filterDesc.length ? ` (${filterDesc.join(', ')})` : '';

    if (!results.length) {
      return {
        ok: true,
        status: 'empty',
        code: 'NO_RESULTS',
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
