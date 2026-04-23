// ─── Activity log normalizers ────────────────────────────────────────────────
// Pure shape helpers for the three transient "log" slices of state — the
// user-visible history of what the agent just did. Each normalizer caps its
// list length so the state blob doesn't grow unbounded during long
// sessions, and sorts newest-first so the UI doesn't need to re-sort.
//
// This module owns:
//   - MAX_COMMAND_RUNS / MAX_EXTERNAL_TOOL_RUNS / MAX_PROMPT_HISTORY — caps
//     for the three lists, re-exported so the trim sites in desktopStore
//     (which slice on append/mutate, not just on load) stay authoritative
//   - normalizeCommandRuns(list) — shell-command output history
//   - normalizeExternalToolRuns(list) — per-connector tool invocations
//     (stringifies object inputs so they render in the UI table)
//   - normalizePromptHistory(list) — past user prompts; accepts legacy
//     string-form entries and upgrades them to the object shape
//
// Extracted from desktopStore.js in the Phase 9a refactor (see
// _refactor-backup/REFACTOR_PLAN.md). Pure module — only uses shared date
// helpers.

import { randomUUID } from 'node:crypto';
import { coerceIso, nowIso } from '../../shared/helpers.js';

export const MAX_COMMAND_RUNS = 16;
export const MAX_EXTERNAL_TOOL_RUNS = 16;
export const MAX_PROMPT_HISTORY = 40;

export function normalizeCommandRuns(commandRuns) {
  if (!Array.isArray(commandRuns)) {
    return [];
  }

  return commandRuns
    .map(run => ({
      ...run,
      executedAt: coerceIso(run.executedAt),
      output: typeof run.output === 'string' ? run.output : '',
      query: typeof run.query === 'string' ? run.query : '',
    }))
    .sort((left, right) => new Date(right.executedAt).getTime() - new Date(left.executedAt).getTime())
    .slice(0, MAX_COMMAND_RUNS);
}

export function normalizeExternalToolRuns(toolRuns) {
  if (!Array.isArray(toolRuns)) {
    return [];
  }

  return toolRuns
    .map(run => ({
      id: run?.id || randomUUID(),
      connectorId: run?.connectorId || '',
      connectorName: run?.connectorName || 'External connector',
      toolName: run?.toolName || 'tool',
      success: Boolean(run?.success),
      input:
        typeof run?.input === 'string'
          ? run.input
          : JSON.stringify(run?.input || {}, null, 2),
      output: typeof run?.output === 'string' ? run.output : '',
      executedAt: coerceIso(run?.executedAt),
    }))
    .sort((left, right) => new Date(right.executedAt).getTime() - new Date(left.executedAt).getTime())
    .slice(0, MAX_EXTERNAL_TOOL_RUNS);
}

/**
 * Accepts either a list of strings (legacy format — no ids, no timestamps)
 * or a list of objects ({id, content, createdAt, chatId, messageId}).
 * Empty strings and non-objects are filtered out.
 */
export function normalizePromptHistory(history) {
  if (!Array.isArray(history)) {
    return [];
  }

  return history
    .map(entry => {
      if (typeof entry === 'string') {
        const content = entry.trim();
        if (!content) {
          return null;
        }

        return {
          id: randomUUID(),
          content,
          createdAt: nowIso(),
          chatId: null,
          messageId: null,
        };
      }

      if (!entry || typeof entry !== 'object') {
        return null;
      }

      const content = typeof entry.content === 'string' ? entry.content.trim() : '';
      if (!content) {
        return null;
      }

      return {
        id: entry.id || randomUUID(),
        content,
        createdAt: coerceIso(entry.createdAt),
        chatId: entry.chatId || null,
        messageId: entry.messageId || null,
      };
    })
    .filter(Boolean)
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
    .slice(0, MAX_PROMPT_HISTORY);
}
