// "Memories this reply drew on" footer for assistant messages (2026-10-17
// design audit M5 / plan 2A). The data has been persisted in
// message.metadata.memoryUsage since the memory-feedback work, but the chat
// surface never showed it — users could not see what the model was given,
// nor promote a fact to the project or to their personal profile from the
// place they noticed it. Pure renderer; actions are handled in app.js.
import { t, ui } from './i18n.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function renderMessageMemoryRefs(message, { feedback = null, busy = false } = {}) {
  if (message?.role !== 'assistant') return '';
  const usage = Array.isArray(message?.metadata?.memoryUsage) ? message.metadata.memoryUsage.filter(row => row && row.id) : [];
  if (!usage.length) return '';
  // Project-book / personal-profile rows (design 2B) are session facts too; the same actions apply.
  const facts = usage.filter(row => ['session-fact', 'fact', 'verification-correction', 'project-book', 'personal-profile'].includes(row.kind));
  return ui`<details class="message-memory-refs" data-message-memory-refs="${escape(message.id)}">
    <summary>${escape(t('本回答参考的记忆'))}（${usage.length}）</summary>
    <p class="list-row-meta">${escape(t('这些内容已提供给模型作为参考，不代表回答一定采用。'))}</p>
    ${usage.map(row => ui`<div class="message-memory-ref" data-memory-id="${escape(row.id)}">
      <span class="message-memory-ref-kind">${escape(row.kind || 'memory')}</span>
      <span class="message-memory-ref-text">${escape(row.text || '')}</span>
      ${facts.includes(row) ? ui`<span class="inline-actions">
        ${feedback?.id === row.id ? ui`<span class="settings-save-status" role="status">✓ ${escape(feedback.message)}</span>` : ui`
        <button class="small-button" type="button" data-action="memory-ref-scope" data-memory-id="${escape(row.id)}" data-scope="project" ${busy ? 'disabled' : ''}>${escape(t('记到项目'))}</button>
        <button class="small-button" type="button" data-action="memory-ref-scope" data-memory-id="${escape(row.id)}" data-scope="personal" ${busy ? 'disabled' : ''}>${escape(t('记成个人'))}</button>
        <button class="small-button" type="button" data-action="memory-ref-forget" data-memory-id="${escape(row.id)}" ${busy ? 'disabled' : ''}>${escape(t('停止使用'))}</button>`}
      </span>` : ''}
    </div>`).join('')}
  </details>`;
}
