// Tool-trace replay (2026-10-17 design audit T-D / option D2).
//
// When a turn ends cancelled or failed, the tools it already ran are lost to
// the next turn: the Responses chain lives only in the loop's transient
// messages and the assistant message is never written. This module turns
// the turn's ToolInvocationRecords (D1 jsonl) into one short plain-text
// assistant message — tool name + args digest + status, ≤600 chars, oldest
// first — and persists it into the chat so it enters the next turn's history
// and the compaction transcript. Plain text carries no call ids, so nothing
// protocol-specific can leak across chats.

import { randomUUID } from 'node:crypto';
import { readToolInvocationRecords, toolArgsDigest } from '../../tools/toolInvocationRecord.js';
import { updateStateAtomically } from '../../state/stateStore.js';
import { ensureSelectedEntities } from '../../state/stateSelections.js';
import { normalizeMessageBlocks } from '../../domain/message/messageBlocks.js';
import { refreshChatMemorySummary } from '../../memory/chatThreadContext.js';
import { isProviderFailureAssistantMessage } from './messageBuilder.js';
import { requestIdentity } from '../../runtime/requestContext.js';

export const TOOL_TRACE_PREFIX = '[工具轨迹]';
export const TOOL_TRACE_MAX_CHARS = 600;

const STATUS_LABEL = Object.freeze({ cancelled: '本轮已取消', failed: '本轮失败', completed: '本轮完成' });

function recordLine(record, index) {
  const envelope = record.resultEnvelope || {};
  const digest = toolArgsDigest(record.argsRedacted, { maxEntries: 2, maxValue: 60, maxChars: 90 });
  const status = envelope.status === 'ok' ? '✓' : envelope.status === 'empty' ? '○ empty' : `✗ ${envelope.code || 'error'}`;
  return `${index + 1}. ${record.toolId}(${digest}) ${status}`;
}

/**
 * Render the trace text, or '' when there is nothing to replay.
 * Oldest first; when the budget cuts the list the tail says "…等 N 次".
 */
export function buildToolTraceText(records = [], { status = 'cancelled', maxChars = TOOL_TRACE_MAX_CHARS } = {}) {
  const list = (Array.isArray(records) ? records : []).filter(record => record && typeof record === 'object' && record.toolId);
  if (!list.length) return '';
  const header = `${TOOL_TRACE_PREFIX} ${STATUS_LABEL[status] || STATUS_LABEL.cancelled}，之前已执行 ${list.length} 次工具调用（可据此继续，不必重复）：`;
  const lines = [];
  let used = header.length;
  for (let index = 0; index < list.length; index++) {
    const line = recordLine(list[index], index);
    const remaining = list.length - index;
    const tail = remaining > 1 ? `；…等 ${remaining - 1} 次` : '';
    if (used + 1 + line.length + (index + 1 < list.length ? tail.length : 0) > maxChars) {
      if (!lines.length) lines.push(line.slice(0, Math.max(20, maxChars - used - tail.length - 1)));
      lines.push(`…等 ${list.length - lines.length} 次`);
      break;
    }
    lines.push(line);
    used += 1 + line.length;
  }
  const text = `${header}\n${lines.join('；')}`;
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

/** Trace text for a run, read from its jsonl; '' when no tool ran. */
export async function readToolTraceText(context, { status = 'cancelled' } = {}) {
  if (!context?.runId || !context?.home) return '';
  const records = await readToolInvocationRecords(context.runId, { home: context.home });
  return buildToolTraceText(records, { status });
}

export function buildToolTraceMessage(context, text, { status = 'cancelled', agent = null } = {}) {
  return {
    id: randomUUID(),
    role: 'assistant',
    kind: 'tool-trace',
    content: text,
    blocks: normalizeMessageBlocks([], text),
    attachments: [],
    createdAt: new Date().toISOString(),
    metadata: { ...requestIdentity(context), ...(agent ? { agent } : {}), toolTrace: { status } },
  };
}

/**
 * Persist the run's tool trace into its chat. When this run already wrote an
 * assistant message that stays in history (a partial image reply), the trace
 * is appended to it; a provider-failure message is filtered out of history
 * by contextFilters, so the trace becomes its own message next to it.
 * Returns the message that carries the trace, or null when nothing ran.
 */
export async function persistToolTrace(context, { status = 'cancelled', text } = {}) {
  const trace = typeof text === 'string' ? text : await readToolTraceText(context, { status });
  if (!trace) return null;
  let carrier = null;
  await updateStateAtomically(state => {
    const latest = ensureSelectedEntities(state);
    const chat = latest.chats.find(entry => entry.id === context.chatId);
    if (!chat) return;
    const existing = chat.messages.find(message => message.role === 'assistant' && message.metadata?.runId === context.runId
      && !isProviderFailureAssistantMessage(message));
    if (existing) {
      if (!String(existing.content || '').includes(TOOL_TRACE_PREFIX)) {
        existing.content = `${existing.content || ''}\n\n${trace}`.trim();
        existing.blocks = normalizeMessageBlocks([], existing.content);
        existing.metadata = { ...existing.metadata, toolTrace: { status } };
      }
      carrier = existing;
    } else {
      const profile = latest.agentProfiles?.[chat.agentId];
      carrier = buildToolTraceMessage(context, trace, { status, agent: profile ? { id: profile.id || chat.agentId, name: profile.name || chat.agentId } : null });
      chat.messages.push(carrier);
    }
    chat.updatedAt = new Date().toISOString();
    refreshChatMemorySummary(chat);
  }, { home: context.home });
  return carrier;
}
