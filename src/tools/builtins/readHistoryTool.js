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
import { estimateTextTokens } from '../../memory/tokenEstimate.js';
import { toolFactsLine } from '../../memory/contextCompact.js';

import { AGENT_LOOP_CONTRACT } from '../../runtime/agentLoopContract.js';

// Limits and the cut marker are shared with the iPhone read_history tool
// (shared/protocol/agent-loop.json, `readHistory`).
const READ_HISTORY = AGENT_LOOP_CONTRACT.readHistory;
export const READ_HISTORY_MAX_TOKENS = READ_HISTORY.maxTokens;
const DEFAULT_LIMIT = READ_HISTORY.defaultLimit;

function messageText(message) {
  if (typeof message?.content === 'string') return message.content.trim();
  if (Array.isArray(message?.content)) return message.content.filter(part => part?.type === 'text').map(part => part.text || '').join('\n').trim();
  return '';
}

function renderMessageParts(message, fromChar = 0) {
  const role = message.role === 'user' ? 'User' : message.role === 'assistant' ? 'Assistant' : message.role;
  const when = typeof message.createdAt === 'string' ? message.createdAt.slice(0, 16).replace('T', ' ') : '';
  const attachments = Array.isArray(message.attachments) && message.attachments.length
    ? `[attachments: ${message.attachments.map(a => a?.fileName || a?.title || a?.kind || 'file').join(', ')}]` : '';
  const fullBody = [messageText(message), attachments, toolFactsLine(message)].filter(Boolean).join('\n') || '(no text)';
  const offset = Math.max(0, Math.min(fullBody.length, Math.floor(Number(fromChar)) || 0));
  const header = `[#${message.id}] ${role}${when ? ` (${when})` : ''}${offset ? ` (continued from character ${offset})` : ''}:\n`;
  return { header, body: fullBody.slice(offset), offset };
}

function renderMessage(message, fromChar = 0) {
  const { header, body } = renderMessageParts(message, fromChar);
  return header + body;
}

const CUT_MARKER = READ_HISTORY.cutMarker;

/**
 * Bug audit T3 (2026-10-18): a single message larger than the whole budget
 * used to be truncated with `nextMessageId` pointing at itself, so the
 * model re-read the same prefix forever. Now the cut is reported as a
 * character offset inside that message's body (`continueFromChar`) which
 * the caller passes back as `fromChar`; progress is guaranteed because the
 * offset strictly increases. Returns the rendered partial text and the
 * number of body characters it covered.
 */
export function cutMessageToBudget(message, fromChar, budget) {
  const { header, body } = renderMessageParts(message, fromChar);
  const fixed = estimateTextTokens(header + CUT_MARKER);
  let lo = 0, hi = body.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fixed + estimateTextTokens(body.slice(0, mid)) <= budget) lo = mid; else hi = mid - 1;
  }
  let cut = lo;
  if (cut && cut < body.length && /[\uD800-\uDBFF]/.test(body[cut - 1])) cut -= 1;
  return { text: header + body.slice(0, cut) + (cut < body.length ? CUT_MARKER : ''), chars: cut, complete: cut >= body.length };
}

/** Pure slice: resolves the requested range inside `messages`. */
export function sliceHistory(messages = [], { fromMessageId, toMessageId, aroundMessageId, before = 0, after = 0, limit = DEFAULT_LIMIT } = {}) {
  const list = (Array.isArray(messages) ? messages : []).filter(message => message?.id && (message.role === 'user' || message.role === 'assistant'));
  const indexOf = id => (id ? list.findIndex(message => message.id === id) : -1);
  const max = Math.max(1, Math.min(READ_HISTORY.maxLimit, Math.floor(limit) || DEFAULT_LIMIT));
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
    'the summary shows ranges as "消息 #<from> … #<to>". Returns at most ~8k tokens; continue with the returned nextMessageId when truncated (plus fromChar=continueFromChar when one message was cut mid-way).',
  category: 'memory',
  isConcurrencySafe: true,
  requiresPermission: false,
  capability: 'knowledgeMemory',
  needsWorkspace: false,
  uiModule: 'files',
  inputKeys: ['chatId', 'fromMessageId', 'fromChar', 'toMessageId', 'aroundMessageId', 'before', 'after', 'limit', 'scope'],
  parametersSchema: {
    type: 'object',
    properties: {
      fromMessageId: { type: 'string', description: 'First message id to read (inclusive). Defaults to the start of the conversation.' },
      fromChar: { type: 'number', description: 'With fromMessageId: character offset inside that first message to continue from. Use the continueFromChar value returned when a single message was cut.' },
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

  async run({ chatId, fromMessageId, fromChar = 0, toMessageId, aroundMessageId, before = 2, after = 2, limit = DEFAULT_LIMIT, scope = 'project' } = {}, context = {}) {
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
    const startChar = fromMessageId && !aroundMessageId ? Math.max(0, Math.floor(Number(fromChar)) || 0) : 0;
    let used = 0, truncatedAt = '', continueFromChar = 0;
    for (const [index, message] of slice.messages.entries()) {
      const offset = index === 0 ? startChar : 0;
      const text = renderMessage(message, offset);
      const tokens = estimateTextTokens(text);
      if (used + tokens > READ_HISTORY_MAX_TOKENS) {
        if (!rendered.length) {
          // T3: one message bigger than the budget — return as much of it as
          // fits and point the continuation at the character after the cut,
          // never at the same (id, offset) pair we started from.
          const part = cutMessageToBudget(message, offset, READ_HISTORY_MAX_TOKENS);
          if (part.chars > 0 || part.complete) {
            rendered.push(part.text);
            if (!part.complete) { truncatedAt = message.id; continueFromChar = offset + part.chars; }
            else truncatedAt = slice.messages[index + 1]?.id || (slice.hasMore ? slice.nextMessageId : '');
            break;
          }
          rendered.push(`${renderMessageParts(message, offset).header}[message skipped: too large to render even partially]`);
          truncatedAt = slice.messages[index + 1]?.id || (slice.hasMore ? slice.nextMessageId : '');
          break;
        }
        truncatedAt = message.id;
        break;
      }
      rendered.push(text);
      used += tokens;
    }
    const nextMessageId = truncatedAt || (slice.hasMore ? slice.nextMessageId : '');
    const continuation = nextMessageId
      ? ` — truncated; continue with fromMessageId="${nextMessageId}"${continueFromChar ? ` fromChar=${continueFromChar} (that message was cut mid-way)` : ''}`
      : '';
    const header = `Conversation "${chat.title || 'Untitled'}" (${targetId}), ${rendered.length} of ${slice.messages.length} requested message(s)${continuation}.`;
    return {
      ok: true,
      output: [header, ...rendered].join('\n\n'),
      meta: { chatId: targetId, count: rendered.length, nextMessageId: nextMessageId || null, truncated: Boolean(truncatedAt),
        ...(continueFromChar ? { continueFromChar } : {}) },
    };
  },
};
