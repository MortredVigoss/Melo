/**
 * read_history tool (2026-10-17 design 1D-3).
 *
 * The conversation ledger (compactLedger.js) keeps one card per summarised
 * segment and names the message range it covers. This tool reads that
 * range back verbatim so the model can answer "what exactly did we decide
 * about X 200 turns ago" from the original text instead of a summary.
 *
 * Scope follows search_history (audit P0-3): the scope comes from the
 * execution context, never from the model. A messaging-channel audience can
 * only read its own chat; the desktop owner may read chats of the current
 * project (or chats outside any project when there is none) and may opt into
 * every project with scope="all".
 */

import { loadState } from '../../state/stateStore.js';
import { normalizeAudience, DESKTOP_AUDIENCE } from '../../memory/conversationIndex.js';
import { estimateTextTokens, truncateToTokens } from '../../memory/tokenEstimate.js';
import { toolFactsLine } from '../../memory/contextCompact.js';

export const READ_HISTORY_MAX_TOKENS = 8000;
const DEFAULT_LIMIT = 40;

function messageText(message) {
  if (typeof message?.content === 'string') return message.content.trim();
  if (Array.isArray(message?.content)) return message.content.filter(part => part?.type === 'text').map(part => part.text || '').join('\n').trim();
  return '';
}

function renderMessage(message) {
  const role = message.role === 'user' ? 'User' : message.role === 'assistant' ? 'Assistant' : message.role;
  const when = typeof message.createdAt === 'string' ? message.createdAt.slice(0, 16).replace('T', ' ') : '';
  const attachments = Array.isArray(message.attachments) && message.attachments.length
    ? `[attachments: ${message.attachments.map(a => a?.fileName || a?.title || a?.kind || 'file').join(', ')}]` : '';
  const body = [messageText(message), attachments, toolFactsLine(message)].filter(Boolean).join('\n');
  return `[#${message.id}] ${role}${when ? ` (${when})` : ''}:\n${body || '(no text)'}`;
}

/** Pure slice: resolves the requested range inside `messages`. */
export function sliceHistory(messages = [], { fromMessageId, toMessageId, aroundMessageId, before = 0, after = 0, limit = DEFAULT_LIMIT } = {}) {
  const list = (Array.isArray(messages) ? messages : []).filter(message => message?.id && (message.role === 'user' || message.role === 'assistant'));
  const indexOf = id => (id ? list.findIndex(message => message.id === id) : -1);
  const max = Math.max(1, Math.min(200, Math.floor(limit) || DEFAULT_LIMIT));
  let start, end;
  if (aroundMessageId) {
    const center = indexOf(aroundMessageId);
    if (center < 0) return { messages: [], missing: aroundMessageId };
    start = Math.max(0, center - Math.max(0, Math.floor(before) || 0));
    end = Math.min(list.length, center + Math.max(0, Math.floor(after) || 0) + 1);
  } else {
    const from = fromMessageId ? indexOf(fromMessageId) : 0;
    if (from < 0) return { messages: [], missing: fromMessageId };
    const to = toMessageId ? indexOf(toMessageId) : -1;
    if (toMessageId && to < 0) return { messages: [], missing: toMessageId };
    start = from;
    end = to >= 0 ? to + 1 : Math.min(list.length, from + max);
  }
  const requestedEnd = end;
  if (end - start > max) end = start + max;
  // An explicit range or neighbourhood is complete once served; only an
  // open-ended read (or one cut by `limit`) has more.
  const openEnded = !aroundMessageId && !toMessageId;
  const hasMore = end < requestedEnd || (openEnded && end < list.length);
  return { messages: list.slice(start, end), hasMore, nextMessageId: hasMore ? list[end]?.id || '' : '' };
}

export const readHistoryTool = {
  id: 'read_history',
  name: 'Read Conversation History',
  description:
    'Read original messages of a conversation verbatim by message id. ' +
    'Use it when the conversation summary ("topic cards") mentions a message range or a decision you need the exact wording, numbers or code of — ' +
    'the summary shows ranges as "消息 #<from> … #<to>". Returns at most ~8k tokens; continue with the returned nextMessageId when truncated.',
  category: 'memory',
  isConcurrencySafe: true,
  requiresPermission: false,
  capability: 'knowledgeMemory',
  needsWorkspace: false,
  uiModule: 'files',
  inputKeys: ['chatId', 'fromMessageId', 'toMessageId', 'aroundMessageId', 'before', 'after', 'limit', 'scope'],
  parametersSchema: {
    type: 'object',
    properties: {
      fromMessageId: { type: 'string', description: 'First message id to read (inclusive). Defaults to the start of the conversation.' },
      toMessageId: { type: 'string', description: 'Last message id to read (inclusive). Defaults to fromMessageId + limit.' },
      aroundMessageId: { type: 'string', description: 'Read one message plus `before`/`after` neighbours instead of a range.' },
      before: { type: 'number', description: 'With aroundMessageId: how many earlier messages to include (default 2).' },
      after: { type: 'number', description: 'With aroundMessageId: how many later messages to include (default 2).' },
      limit: { type: 'number', description: 'Maximum number of messages (1–200, default 40).' },
      chatId: { type: 'string', description: 'Optional chat id (from search_history results). Defaults to the current conversation.' },
      scope: { type: 'string', enum: ['project', 'all'], description: 'Default "project": chats of the current project only. "all": any project on this desktop (desktop user only).' },
    },
  },
  examples: [
    { fromMessageId: '0f3c…', toMessageId: '9a1b…' },
    { aroundMessageId: '0f3c…', before: 3, after: 3 },
  ],

  async run({ chatId, fromMessageId, toMessageId, aroundMessageId, before = 2, after = 2, limit = DEFAULT_LIMIT, scope = 'project' } = {}, context = {}) {
    const audience = normalizeAudience(context?.chatSource);
    const currentChatId = String(context?.chatId || '');
    const targetId = String(chatId || currentChatId);
    if (!targetId) return { ok: false, output: 'No conversation to read.', error: 'INVALID_ARGS' };
    if (audience !== DESKTOP_AUDIENCE && targetId !== currentChatId) {
      return { ok: false, output: 'This channel can only read its own conversation.', error: 'PERMISSION_DENIED' };
    }
    const state = await loadState({ home: context.meloHome });
    const chat = (state?.chats || []).find(entry => entry.id === targetId);
    if (!chat) return { ok: false, output: `Conversation ${targetId} not found.`, error: 'NOT_FOUND' };
    if (audience === DESKTOP_AUDIENCE && targetId !== currentChatId && scope !== 'all') {
      const project = String(context?.projectId || '');
      if (String(chat.projectId || '') !== project) {
        return { ok: false, output: 'That conversation belongs to another project. Pass scope="all" to read across projects.', error: 'PERMISSION_DENIED' };
      }
    }
    if (audience !== DESKTOP_AUDIENCE && normalizeAudience(chat.source || chat.channel?.kind) !== audience) {
      return { ok: false, output: 'This channel can only read its own conversation.', error: 'PERMISSION_DENIED' };
    }

    const slice = sliceHistory(chat.messages, { fromMessageId, toMessageId, aroundMessageId, before, after, limit });
    if (slice.missing) return { ok: false, output: `Message ${slice.missing} is not in conversation ${targetId}.`, error: 'NOT_FOUND' };
    if (!slice.messages.length) return { ok: true, status: 'empty', code: 'NO_RESULTS', output: 'No messages in that range.', meta: { chatId: targetId, count: 0 } };

    const rendered = [];
    let used = 0, truncatedAt = '';
    for (const message of slice.messages) {
      const text = renderMessage(message);
      const tokens = estimateTextTokens(text);
      if (used + tokens > READ_HISTORY_MAX_TOKENS) {
        if (!rendered.length) rendered.push(truncateToTokens(text, READ_HISTORY_MAX_TOKENS));
        truncatedAt = message.id;
        break;
      }
      rendered.push(text);
      used += tokens;
    }
    const nextMessageId = truncatedAt || (slice.hasMore ? slice.nextMessageId : '');
    const header = `Conversation "${chat.title || 'Untitled'}" (${targetId}), ${rendered.length} of ${slice.messages.length} requested message(s)${nextMessageId ? ` — truncated; continue with fromMessageId="${nextMessageId}"` : ''}.`;
    return {
      ok: true,
      output: [header, ...rendered].join('\n\n'),
      meta: { chatId: targetId, count: rendered.length, nextMessageId: nextMessageId || null, truncated: Boolean(truncatedAt) },
    };
  },
};
