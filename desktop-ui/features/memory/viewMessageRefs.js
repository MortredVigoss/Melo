// "Memories this reply drew on" footer for assistant messages (2026-10-17
// design audit M5 / plan 2A). The data has been persisted in
// message.metadata.memoryUsage since the memory-feedback work, but the chat
// surface never showed it — users could not see what the model was given,
// nor promote a fact to the project or to their personal profile from the
// place they noticed it. Pure renderer; actions are handled in ./controller.js.
import { t, ui } from '../../i18n.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function renderMessageMemoryRefs(message, { feedback = null, busy = false, open = false } = {}) {
  if (message?.role !== 'assistant') return '';
  const usage = Array.isArray(message?.metadata?.memoryUsage) ? message.metadata.memoryUsage.filter(row => row && row.id) : [];
  if (!usage.length) return '';
  // Only session facts are editable through /api/memory/facts/update (bug
  // audit M14b / U1): `fact` / `verification-correction` rows have no editor.
  // Project-book / personal-profile rows (design 2B) are session facts too.
  const facts = usage.filter(row => ACTIONABLE_KINDS.has(row.kind));
  // Bug audit U3: every render rebuilds the <details>; it stays open when the
  // user opened it (tracked by ./controller.js) or when its feedback is being shown.
  const keepOpen = open || (!!feedback?.messageId && feedback.messageId === message.id);
  return ui`<details class="message-memory-refs" data-message-memory-refs="${escape(message.id)}" ${keepOpen ? 'open' : ''}>
    <summary>${escape(t('本回答参考的记忆'))}（${usage.length}）</summary>
    <p class="list-row-meta">${escape(t('这些内容已提供给模型作为参考，不代表回答一定采用。'))}</p>
    ${usage.map(row => ui`<div class="message-memory-ref" data-memory-id="${escape(row.id)}">
      <span class="message-memory-ref-kind">${escape(row.kind || 'memory')}</span>
      <span class="message-memory-ref-text">${escape(row.text || '')}</span>
      ${facts.includes(row) ? ui`<span class="inline-actions">
        ${feedback?.id === row.id && (!feedback.messageId || feedback.messageId === message.id) ? ui`<span class="settings-save-status" role="status">✓ ${escape(feedback.message)}</span>` : ui`
        ${row.kind !== 'project-book' ? ui`<button class="small-button" type="button" data-kind="${escape(row.kind)}" data-action="memory-ref-scope" data-memory-id="${escape(row.id)}" data-scope="project" ${busy ? 'disabled' : ''}>${escape(t('记到项目'))}</button>` : ''}
        ${row.kind !== 'personal-profile' && personalTargetId(row) ? ui`<button class="small-button" type="button" data-kind="${escape(row.kind)}" data-action="memory-ref-scope" data-memory-id="${escape(row.id)}" data-scope="personal" ${busy ? 'disabled' : ''}>${escape(t('记成个人'))}</button>` : ''}
        <button class="small-button" type="button" data-kind="${escape(row.kind)}" data-action="memory-ref-forget" data-memory-id="${escape(row.id)}" ${busy ? 'disabled' : ''}>${escape(t('停止使用'))}</button>`}
      </span>` : ''}
    </div>`).join('')}
  </details>`;
}

export const ACTIONABLE_KINDS = new Set(['session-fact', 'project-book', 'personal-profile']);

/**
 * Which row 记成个人 edits (bug audit U15): a `project-book` row that mirrors a
 * chat fact (`book:<factId>`, metadata.bookOf) promotes the underlying fact and
 * leaves the book row in place; a hand-written book row (`book:user:…`) has no
 * underlying fact, so the button is hidden; any other row is promoted itself.
 */
export function personalTargetId(row) {
  const id = String(row?.id || '');
  if (row?.kind !== 'project-book') return id || null;
  if (row?.bookOf) return String(row.bookOf);
  if (!id.startsWith('book:') || id.startsWith('book:user:')) return id.startsWith('book:') ? null : id;
  return id.slice('book:'.length);
}
