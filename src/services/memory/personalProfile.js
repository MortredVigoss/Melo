// Personal profile (design 2026-10-17 §3.4, option 2B).
//
// A projection over `session-fact` rows the user explicitly promoted to
// scope 'personal' (namespace `user:local`, audience 'local'). Nothing is
// written automatically; the memory page and the reply footer are the only
// writers (editMemoryFact). Rendered as the stable system-prompt reference
// 'personal-profile' (prio 106, ≤400 est tokens, ≤15 rows) for local chats
// only — remote channels never see it.

import { iterateMemoryRecords, isEntryInvalidated } from '../../memory/store.js';
import { normalizedFact } from '../../memory/factPolicy.js';
import { estimateTextTokens } from '../../memory/tokenEstimate.js';
import { requestEnvironment, runWithRequestContext } from '../../runtime/requestScope.js';

export const PERSONAL_NAMESPACE = 'user:local';
export const PROFILE_CATEGORIES = Object.freeze(['correction', 'identity', 'user_preference']);
const CATEGORY_RANK = { correction: 0, identity: 1, user_preference: 2 };
const timestamp = row => Date.parse(row?.updatedAt || row?.createdAt || row?.metadata?.validFrom || '') || 0;

export function isPersonalProfileRow(row) {
  const m = row?.metadata || {};
  return row?.kind === 'session-fact' && m.scope === 'personal' && m.audience === 'local' && PROFILE_CATEGORIES.includes(m.category);
}

export function listPersonalProfile({ home = null } = {}) {
  const work = () => [...iterateMemoryRecords({ namespace: PERSONAL_NAMESPACE })]
    .filter(row => isPersonalProfileRow(row) && !isEntryInvalidated(row.metadata));
  if (!home) return work();
  return runWithRequestContext({ env: { ...requestEnvironment(), MELO_HOME: home } }, work);
}

export const profileLine = row => `- [${row.metadata?.category}] ${String(row.text || '').trim()}`;

/**
 * correction > identity > user_preference, newest first inside a category;
 * one row per subjectKey (the latest); at most maxRows / maxTokens.
 * @returns {{text:string, rows:Array}}
 */
export function renderPersonalProfile(rows = [], { maxTokens = 400, maxRows = 15 } = {}) {
  const sorted = rows
    .filter(row => row?.text?.trim() && isPersonalProfileRow(row) && !isEntryInvalidated(row.metadata))
    .sort((a, b) => (CATEGORY_RANK[a.metadata.category] - CATEGORY_RANK[b.metadata.category]) || (timestamp(b) - timestamp(a)) || String(a.id).localeCompare(String(b.id)));
  const seenSubjects = new Set(), seenText = new Set(), selected = [];
  for (const row of sorted) {
    const subject = String(row.metadata?.subjectKey || '').trim().toLowerCase();
    const text = normalizedFact(row.text);
    if (seenText.has(text) || (subject && seenSubjects.has(subject))) continue;
    seenText.add(text); if (subject) seenSubjects.add(subject);
    selected.push(row);
    if (selected.length >= maxRows) break;
  }
  const build = list => {
    if (!list.length) return { text: '', rows: [] };
    const rendered = list.map(row => ({ ...row, renderedText: profileLine(row) }));
    const text = ['## Personal profile (facts the user chose to carry into every local chat)',
      'When a line here conflicts with the project memory book, the project book is more specific and wins.',
      ...rendered.map(row => row.renderedText)].join('\n');
    return { text, rows: rendered };
  };
  let list = selected, result = build(list);
  while (result.text && estimateTextTokens(result.text) > maxTokens && list.length) { list = list.slice(0, -1); result = build(list); }
  return result;
}
