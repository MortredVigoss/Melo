// Lives in the memory layer so factRecords.js (memory) can write auto rows
// without reaching into services/ (layer gate, scripts/check-dependencies.js).
// services/project/projectMemoryBook.js re-exports this module.
// Project Memory Book (design 2026-10-17 §3.4, option 2B).
//
// The book is a projection over ordinary `session-fact` rows: namespace
// `project:<pid>`, scope 'project', audience 'local'. It is memory, not
// settings — every row keeps its source chat/message, can be forgotten or
// superseded, and syncs through the same portable-memory path as any other
// fact. Two metadata fields are specific to the book:
//
//   metadata.bookStatus ∈ {auto, confirmed, user}
//     auto       — written by reconcileChatFacts for decision/project_context
//                  facts of a local chat that belongs to a project (the one
//                  exception to "automatic facts stay in their chat")
//     confirmed  — a fact the user promoted ("记到项目") or confirmed
//     user       — hand-written on the project page
//   metadata.section ∈ BOOK_SECTIONS (mapped from category, user-editable)
//
// Rendering lives in the stable system-prompt prefix (reference
// 'project-memory', prio 104, 2000 est tokens) and only changes when a row
// changes, so the provider prompt cache survives ordinary turns.
//
// Store access goes through src/memory/store.js; nothing here opens sqlite.

import { iterateMemoryRecords, getMemoriesByIds, upsertMemory, withTransaction, isEntryInvalidated } from './store.js';
import { normalizedFact } from './factPolicy.js';
import { estimateTextTokens } from './tokenEstimate.js';
import { requestEnvironment, runWithRequestContext } from '../runtime/requestScope.js';

export const BOOK_SECTIONS = Object.freeze(['goal', 'convention', 'decision', 'progress', 'todo', 'file']);
export const BOOK_STATUSES = Object.freeze(['auto', 'confirmed', 'user']);
export const BOOK_AUTO_CATEGORIES = Object.freeze(['decision', 'project_context']);
export const BOOK_SECTION_LABELS = Object.freeze({
  goal: '目标', convention: '约定', decision: '决定', progress: '进展', todo: '待办', file: '文件',
});
export const BOOK_ID_PREFIX = 'book:';
export const bookNamespace = projectId => `project:${projectId}`;

const STATUS_RANK = { user: 0, confirmed: 1, auto: 2 };

export function sectionForCategory(category) {
  switch (String(category || '')) {
    case 'decision': return 'decision';
    case 'project_context': return 'goal';
    case 'technical_detail':
    case 'user_preference':
    case 'correction':
    case 'identity': return 'convention';
    default: return 'progress';
  }
}

export function normalizeSection(section, category) {
  const value = String(section || '').trim();
  return BOOK_SECTIONS.includes(value) ? value : sectionForCategory(category);
}

export function bookStatusOf(row) {
  const status = row?.metadata?.bookStatus;
  if (BOOK_STATUSES.includes(status)) return status;
  // Rows promoted before the book existed carry userEdited; treat them as
  // confirmed so they are never auto-superseded.
  return row?.metadata?.userEdited ? 'confirmed' : 'auto';
}

const timestamp = row => Date.parse(row?.updatedAt || row?.createdAt || row?.metadata?.validFrom || '') || 0;

function withHome(home, work) {
  if (!home) return work();
  return runWithRequestContext({ env: { ...requestEnvironment(), MELO_HOME: home } }, work);
}

/** Rows whose source is the project page, not a chat (hand-written rows, bug audit M1). */
export function isProjectOriginRow(row) {
  const m = row?.metadata || {};
  if (m.chatId) return false;
  return m.origin === 'project' || m.bookStatus === 'user' || String(row?.sourceId || '').startsWith('project:');
}

export function isProjectBookRow(row, projectId) {
  const m = row?.metadata || {};
  if (row?.kind !== 'session-fact') return false;
  if ((m.scope || 'chat') !== 'project') return false;
  if (m.audience !== 'local') return false;
  if (projectId && m.projectId !== projectId) return false;
  return true;
}

/** Every active, non-forgotten project row of the project's namespace. */
export function listProjectBook(projectId, { home = null, includeInactive = false } = {}) {
  if (!projectId) return [];
  return withHome(home, () => [...iterateMemoryRecords({ namespace: bookNamespace(projectId) })]
    .filter(row => isProjectBookRow(row, projectId) && (includeInactive || !isEntryInvalidated(row.metadata))));
}

export function bookLine(row) {
  const status = bookStatusOf(row);
  const prefix = `${status === 'auto' ? '[auto]' : ''}${row.metadata?.needsConfirmation ? '[待确认]' : ''}`;
  return `- ${prefix ? `${prefix} ` : ''}${String(row.text || '').trim()}`;
}

function dropPriority(row) {
  const status = bookStatusOf(row);
  const section = normalizeSection(row.metadata?.section, row.metadata?.category);
  const category = row.metadata?.category;
  if (status === 'auto' && (category === 'technical_detail' || section === 'file')) return 0;
  if (status === 'auto') return 1;
  if (status === 'confirmed') return 2;
  return 3;
}

/**
 * Render the book grouped by section. Inside a section: user > confirmed >
 * auto, then updatedAt desc. Overflow beyond maxTokens drops auto
 * technical_detail/file rows first, then other auto rows, then confirmed,
 * oldest first within a bucket. Hand-written rows go last.
 *
 * @returns {{text:string, rows:Array}} rows actually rendered, each with renderedText
 */
export function renderProjectBook(rows = [], { maxTokens = 2000, title = 'Project memory book' } = {}) {
  const seen = new Map();
  for (const row of rows) {
    if (!row?.text?.trim() || isEntryInvalidated(row.metadata)) continue;
    const key = normalizedFact(row.text);
    const prior = seen.get(key);
    // The same statement promoted by hand and extracted automatically renders once.
    if (!prior || STATUS_RANK[bookStatusOf(row)] < STATUS_RANK[bookStatusOf(prior)] || (STATUS_RANK[bookStatusOf(row)] === STATUS_RANK[bookStatusOf(prior)] && timestamp(row) > timestamp(prior))) seen.set(key, row);
  }
  // Bug audit M3: one oversized row (a ~2000-char hand-written row) used to
  // empty the whole book — every other row was dropped first, then the giant
  // row itself. A single row may take at most a third of the budget; longer
  // text is truncated (marked with …) so the other rows stay.
  const rowBudget = Math.max(40, Math.floor(maxTokens / 3));
  let kept = [...seen.values()].map(row => truncateRowToBudget(row, rowBudget, list => estimateTextTokens(bookLine(list[0]))));
  const build = (list = kept) => {
    const grouped = new Map(BOOK_SECTIONS.map(section => [section, []]));
    for (const row of list) grouped.get(normalizeSection(row.metadata?.section, row.metadata?.category)).push(row);
    const rendered = [], blocks = [];
    for (const section of BOOK_SECTIONS) {
      const list = grouped.get(section).sort((a, b) => (STATUS_RANK[bookStatusOf(a)] - STATUS_RANK[bookStatusOf(b)]) || (timestamp(b) - timestamp(a)) || String(a.id).localeCompare(String(b.id)));
      if (!list.length) continue;
      const lines = list.map(row => { const renderedText = bookLine(row); rendered.push({ ...row, renderedText }); return renderedText; });
      blocks.push(`### ${BOOK_SECTION_LABELS[section]} (${section})\n${lines.join('\n')}`);
    }
    if (!blocks.length) return { text: '', rows: [] };
    const text = [`## ${title}`,
      'Shared by every chat and agent of this project. [auto] rows were extracted automatically and may be unconfirmed; [待确认] rows conflict with a confirmed row — prefer the confirmed one.',
      ...blocks].join('\n\n');
    return { text, rows: rendered };
  };
  let result = build();
  while (result.text && estimateTextTokens(result.text) > maxTokens && kept.length) {
    const victim = [...kept].sort((a, b) => (dropPriority(a) - dropPriority(b)) || (timestamp(a) - timestamp(b)))[0];
    // The last candidate is truncated to the remaining budget, never dropped.
    if (kept.length === 1) {
      kept = [truncateRowToBudget(victim, maxTokens, list => estimateTextTokens(build(list).text))];
      result = build();
      break;
    }
    kept = kept.filter(row => row !== victim);
    result = build();
  }
  return result;
}

function truncateRowToBudget(row, budget, measure) {
  let text = String(row.text || '').trim(), candidate = row;
  for (let i = 0; i < 12 && text.length > 20; i += 1) {
    const used = measure([candidate]);
    if (used <= budget) return candidate;
    const ratio = Math.min(0.9, Math.max(0.1, budget / used));
    text = text.slice(0, Math.max(20, Math.floor(text.length * ratio))).trimEnd();
    candidate = { ...row, text: `${text}…`, truncated: true };
  }
  return candidate;
}

/**
 * Pure supersession planner. `candidate` is the row about to become active in
 * `existing` (same namespace). Returns which rows retire and whether the
 * candidate must be flagged for confirmation.
 */
export function planBookSupersession(existing = [], candidate, { nowMs = Date.now() } = {}) {
  const nowIso = new Date(nowMs).toISOString();
  const retire = [];
  let needsConfirmation = false, duplicateOf = null;
  const status = bookStatusOf(candidate);
  const subject = String(candidate?.metadata?.subjectKey || '').trim().toLowerCase();
  const text = normalizedFact(candidate?.text);
  for (const row of existing) {
    if (!row || row.id === candidate.id) continue;
    const m = row.metadata || {};
    if (normalizedFact(row.text) === text) {
      // Same statement already in the book (active or deliberately stopped):
      // never write a second copy, never resurrect a forgotten one.
      if (m.forgotten || !isEntryInvalidated(m)) duplicateOf = duplicateOf || row;
      continue;
    }
    if (isEntryInvalidated(m) || !subject) continue;
    if (String(m.subjectKey || '').trim().toLowerCase() !== subject) continue;
    const priorStatus = bookStatusOf(row);
    if (status === 'auto' && priorStatus !== 'auto') { needsConfirmation = true; continue; }
    retire.push({ id: row.id, validTo: nowIso, supersededByFact: candidate.text, supersededById: candidate.id });
  }
  return { retire, needsConfirmation, duplicateOf };
}

/**
 * Write (or refresh) a project-book row with namespace-level supersession.
 * Returns the stored row, the existing duplicate, or null when nothing was
 * written.
 */
export function upsertProjectBookRow(candidate, { home = null, nowMs = Date.now() } = {}) {
  const projectId = candidate?.metadata?.projectId;
  if (!projectId || !candidate?.id || !String(candidate.text || '').trim()) return null;
  return withHome(home, () => withTransaction(() => {
    const namespace = bookNamespace(projectId);
    const existing = [...iterateMemoryRecords({ namespace })];
    const plan = planBookSupersession(existing, candidate, { nowMs });
    if (plan.duplicateOf) return plan.duplicateOf;
    for (const change of plan.retire) {
      const row = existing.find(r => r.id === change.id);
      if (!row) continue;
      upsertMemory({ ...row, metadata: { ...row.metadata, validTo: change.validTo, supersededByFact: change.supersededByFact, supersededById: change.supersededById } });
    }
    const nowIso = new Date(nowMs).toISOString();
    const entry = {
      ...candidate, namespace, kind: 'session-fact', searchText: normalizedFact(candidate.text),
      createdAt: candidate.createdAt || nowIso, updatedAt: candidate.updatedAt || nowIso,
      metadata: { ...candidate.metadata, scope: 'project', audience: 'local', projectId,
        bookStatus: bookStatusOf(candidate), section: normalizeSection(candidate.metadata?.section, candidate.metadata?.category),
        needsConfirmation: plan.needsConfirmation || candidate.metadata?.needsConfirmation === true },
    };
    upsertMemory(entry);
    return entry;
  }));
}

/**
 * Apply namespace-level supersession for a row that is already stored (bug
 * audit M4): confirming an auto row, or promoting a chat fact whose auto twin
 * exists, retires the other rows on the same subject exactly like a fresh
 * write through upsertProjectBookRow would. Returns the retired changes.
 */
export function retireSupersededBookRows(candidate, { nowMs = Date.now() } = {}) {
  const projectId = candidate?.metadata?.projectId;
  if (!projectId || !candidate?.id) return [];
  return withTransaction(() => {
    const existing = [...iterateMemoryRecords({ namespace: bookNamespace(projectId) })];
    const plan = planBookSupersession(existing, candidate, { nowMs });
    for (const change of plan.retire) {
      const row = existing.find(r => r.id === change.id);
      if (!row) continue;
      upsertMemory({ ...row, metadata: { ...row.metadata, validTo: change.validTo, supersededByFact: change.supersededByFact, supersededById: change.supersededById } });
    }
    return plan.retire;
  });
}

// Hand-written and promoted rows are prompt text on every turn of the project
// (bug audit M3): keep them short so one row cannot crowd out the book.
export const BOOK_ROW_MAX_CHARS = 600;

/** Auto path: mirror an extracted chat fact into the book (id `book:<factId>`). */
export function writeAutoBookRow(entry, chat, { nowMs = Date.now() } = {}) {
  const m = entry?.metadata || {};
  if (!chat?.projectId || !BOOK_AUTO_CATEGORIES.includes(m.category)) return null;
  if (m.audience !== 'local' || m.forgotten || m.validTo || m.quarantined) return null;
  const id = `${BOOK_ID_PREFIX}${entry.id}`;
  if (getMemoriesByIds([id]).length) return null; // replaying a checkpoint never rewrites user state
  return upsertProjectBookRow({
    id, text: entry.text, sourceId: entry.sourceId, createdAt: entry.createdAt, updatedAt: entry.updatedAt,
    metadata: { category: m.category, originalFact: m.originalFact, chatId: m.chatId, chatTitle: m.chatTitle, projectId: chat.projectId,
      agentId: m.agentId, source: m.source, sourceChatId: m.chatId, sourceMessageId: m.sourceMessageId || null, sourceSenderId: m.sourceSenderId || null,
      sourceRole: m.sourceRole || null, sourceText: m.sourceText || null, subjectKey: m.subjectKey || null,
      validFrom: m.validFrom || null, validTo: null, bookStatus: 'auto', section: sectionForCategory(m.category), bookOf: entry.id },
  }, { nowMs });
}

/**
 * Bug audit M12: the auto row is written once, when the fact first appears.
 * When the source chat later joins or changes project, the mirror follows:
 * a missing row is written, an active row moves to the new namespace (with
 * supersession there), retired/forgotten rows stay where the user left them.
 */
export function moveAutoBookRow(entry, chat, { nowMs = Date.now() } = {}) {
  if (!entry?.id || !chat?.projectId) return null;
  const row = getMemoriesByIds([`${BOOK_ID_PREFIX}${entry.id}`])[0];
  if (!row) return writeAutoBookRow(entry, chat, { nowMs });
  if (row.kind !== 'session-fact' || row.metadata?.projectId === chat.projectId) return null;
  if (row.metadata?.forgotten || isEntryInvalidated(row.metadata) || row.metadata?.quarantined) return null;
  return withTransaction(() => {
    const moved = upsertProjectBookRow({ ...row, metadata: { ...row.metadata, projectId: chat.projectId, chatTitle: chat.title || row.metadata.chatTitle || '', needsConfirmation: false } }, { nowMs });
    if (moved && moved.id !== row.id) {
      // The new project already holds the same statement: retire the old mirror instead of keeping two.
      upsertMemory({ ...row, metadata: { ...row.metadata, validTo: new Date(nowMs).toISOString(), supersededByFact: moved.text, supersededById: moved.id } });
    }
    return moved;
  });
}

/** Hand-written path (project page "手写一条"). */
export function createUserBookRow({ projectId, text, section, category = 'project_context', home = null } = {}) {
  const content = String(text || '').trim();
  if (!projectId) throw new Error('缺少项目。');
  if (!content) throw new Error('记忆内容需要在 1–2000 字之间。');
  if (content.length > BOOK_ROW_MAX_CHARS) throw new Error(`记忆本手写内容需要在 ${BOOK_ROW_MAX_CHARS} 字以内。`);
  const now = new Date().toISOString();
  const id = `${BOOK_ID_PREFIX}user:${projectId}:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const row = upsertProjectBookRow({
    id, text: content, sourceId: `project:${projectId}`, createdAt: now, updatedAt: now,
    // `origin:'project'` (bug audit M1): the row's source is the project
    // itself, whatever scope the user later moves it to; reconcileLegacyFacts
    // must never quarantine it for lacking a source chat.
    metadata: { category, originalFact: content, projectId, chatId: null, chatTitle: '', agentId: 'main', source: 'desktop', audience: 'local', origin: 'project',
      scope: 'project', userEdited: true, editedAt: now, bookStatus: 'user', section: normalizeSection(section, category), validFrom: now, validTo: null },
  }, { home });
  if (row?.id !== id) throw new Error('记忆本里已有同样的内容。');
  return row;
}

/** Management projection for the project page. */
export function projectBookRecords(projectId, { home = null, state = null } = {}) {
  const rows = listProjectBook(projectId, { home, includeInactive: true })
    .filter(row => !row.metadata?.mergedInto && !row.metadata?.quarantined);
  return rows.map(row => {
    const m = row.metadata || {};
    const chat = state?.chats?.find(c => c.id === m.chatId) || null;
    return {
      id: row.id, text: row.text, section: normalizeSection(m.section, m.category), bookStatus: bookStatusOf(row), category: m.category || null,
      needsConfirmation: m.needsConfirmation === true,
      status: m.forgotten ? 'forgotten' : isEntryInvalidated(m) ? 'historical' : 'active',
      sourceChatId: chat?.id || m.chatId || null, sourceMessageId: m.sourceMessageId || null,
      sourceTitle: chat?.title || m.chatTitle || (m.bookStatus === 'user' || isProjectOriginRow(row) ? '项目页手写' : '来源对话已删除'),
      supersededBy: m.supersededByFact || null, updatedAt: row.updatedAt,
    };
  }).sort((a, b) => BOOK_SECTIONS.indexOf(a.section) - BOOK_SECTIONS.indexOf(b.section) || (STATUS_RANK[a.bookStatus] - STATUS_RANK[b.bookStatus]) || String(b.updatedAt).localeCompare(String(a.updatedAt)));
}
