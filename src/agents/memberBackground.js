// Background a delegated member or team member receives alongside its task.
//
// Before 2026-10-17 a member only saw the task sentence (audit B-6): in a
// conversation with twenty turns of discussion, "按上面方案实施" arrived with
// no idea what the plan was. The block below is deliberately small and
// bounded — it is background, not the member's instructions — and it is
// injected into the first USER turn (never the system prompt) so the
// member's system contract cannot be rewritten through it.

import { estimateTextTokens, truncateToTokens } from '../memory/tokenEstimate.js';

const RECENT_TURNS = 6;
const TURN_CHARS = 360;
const MAX_BLOCK_TOKENS = 2400;

function turnText(message) {
  const content = message?.content;
  const text = Array.isArray(content) ? content.map(part => part?.text || '').join(' ') : String(content ?? '');
  return text.replace(/\s+/g, ' ').trim();
}

export function buildMemberBackground({ chat = null, projectContext = '', compactSummary = '' } = {}) {
  const parts = [];
  const project = String(projectContext || '').trim();
  if (project) parts.push(`Project:\n${project}`);
  const summary = String(compactSummary || chat?.compactSummary || '').trim();
  if (summary) parts.push(`Conversation so far (summary):\n${truncateToTokens(summary, 900)}`);
  const messages = Array.isArray(chat?.messages) ? chat.messages : [];
  const recent = messages
    .filter(message => ['user', 'assistant'].includes(message?.role) && !message?.isToolResult)
    .slice(-RECENT_TURNS)
    .map(message => `${message.role === 'user' ? 'User' : 'Assistant'}: ${turnText(message).slice(0, TURN_CHARS)}`)
    .filter(line => line.length > 'Assistant: '.length);
  if (recent.length) parts.push(`Recent turns:\n${recent.join('\n')}`);
  if (!parts.length) return '';
  const block = parts.join('\n\n');
  return estimateTextTokens(block) > MAX_BLOCK_TOKENS ? truncateToTokens(block, MAX_BLOCK_TOKENS) : block;
}
