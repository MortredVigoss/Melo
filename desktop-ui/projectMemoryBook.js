// Project page «记忆本» section (design 2026-10-17 §3.4, 2B). Pure renderer:
// data comes from GET /api/projects/memory-book, actions are dispatched by
// app.js (data-action="project-book-*").
import { t, ui } from './i18n.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const BOOK_SECTION_LABELS = Object.freeze({ goal: '目标', convention: '约定', decision: '决定', progress: '进展', todo: '待办', file: '文件' });
export const BOOK_SECTION_ORDER = Object.freeze(Object.keys(BOOK_SECTION_LABELS));
const STATUS_LABELS = Object.freeze({ auto: 'auto', confirmed: '已确认', user: '手写' });

export function groupBookRecords(records = []) {
  const groups = new Map(BOOK_SECTION_ORDER.map(section => [section, []]));
  for (const row of records) {
    if (!row || row.status === 'historical') continue;
    const section = groups.has(row.section) ? row.section : 'progress';
    groups.get(section).push(row);
  }
  return [...groups].filter(([, rows]) => rows.length);
}

function sectionSelect(id, selected, { name = 'section', busy = false } = {}) {
  return ui`<select id="${escape(id)}" name="${escape(name)}" data-book-section-select="${escape(id)}" ${busy ? 'disabled' : ''}>${BOOK_SECTION_ORDER.map(section => ui`<option value="${section}" ${section === selected ? 'selected' : ''}>${escape(BOOK_SECTION_LABELS[section])}</option>`).join('')}</select>`;
}

export function renderProjectMemoryBook(project, data, { busy = false, feedback = null, draft = null } = {}) {
  if (!project?.id) return '';
  const records = Array.isArray(data?.records) ? data.records : null;
  const groups = records ? groupBookRecords(records) : [];
  return ui`<section class="surface-card project-detail-panel project-memory-book" data-project-book="${escape(project.id)}">
    <div class="header-row"><h2 class="subsection-title">记忆本</h2><span class="meta-label">${records ? `${records.filter(r => r.status === 'active').length} 条` : ''}</span></div>
    <p class="list-row-meta">项目内所有对话与 Agent 共享的约定、决定与进展。自动行带 auto 徽章并以 [auto] 提供给模型；确认后不会再被自动行替代；停止使用会保留记录。</p>
    ${feedback ? ui`<div class="settings-edit-toolbar" data-edit-status="saved"><span class="settings-save-status" role="status">✓ ${escape(feedback)}</span></div>` : ''}
    ${!records ? ui`<p>正在读取记忆本…</p>` : groups.length ? groups.map(([section, rows]) => ui`<div class="project-book-section" data-book-section="${section}">
      <h3 class="list-row-title">${escape(BOOK_SECTION_LABELS[section])}</h3>
      ${rows.map(r => ui`<article class="detail-card project-book-row" data-book-record="${escape(r.id)}">
        <div class="list-row-meta"><span class="chip ${r.bookStatus === 'auto' ? 'is-muted' : 'is-accent'}">${escape(STATUS_LABELS[r.bookStatus] || r.bookStatus)}</span>${r.needsConfirmation ? ui` <span class="chip">待确认</span>` : ''}${r.status === 'forgotten' ? ui` <span class="chip">已停止使用</span>` : ''}</div>
        <p>${escape(r.text)}</p>
        <div class="inline-actions">
          ${r.sourceChatId ? ui`<button class="small-button" type="button" data-action="open-chat" data-chat-id="${escape(r.sourceChatId)}">来源对话</button>` : ui`<span class="meta-label">${escape(r.sourceTitle || '')}</span>`}
          ${r.status === 'active' && r.bookStatus === 'auto' ? ui`<button class="small-button" type="button" data-action="project-book-confirm" data-id="${escape(r.id)}" ${busy ? 'disabled' : ''}>确认</button>` : ''}
          ${r.status === 'active' ? ui`<label class="meta-label">改节 ${sectionSelect(`project-book-section-${r.id}`, r.section, { busy })}</label>` : ''}
          <button class="small-button" type="button" data-action="${r.status === 'active' ? 'project-book-forget' : 'project-book-restore'}" data-id="${escape(r.id)}" ${busy ? 'disabled' : ''}>${r.status === 'active' ? '停止使用' : '恢复使用'}</button>
        </div>
      </article>`).join('')}
    </div>`).join('') : ui`<p>还没有记忆本内容。项目对话里的决定会自动出现在这里，也可以手写一条。</p>`}
    <form class="project-book-create" data-form="project-book-create" data-project-id="${escape(project.id)}">
      <label class="label">手写一条<textarea class="textarea" name="text" rows="2" maxlength="2000" placeholder="例如：接口统一返回 snake_case 字段" ${busy ? 'disabled' : ''}>${escape(draft?.text ?? '')}</textarea></label>
      <div class="inline-actions"><label class="meta-label">分节 ${sectionSelect('project-book-create-section', draft?.section || 'convention', { busy })}</label>
        <button class="small-button is-primary" type="submit" ${busy ? 'disabled' : ''}>${escape(t('写入记忆本'))}</button></div>
    </form>
  </section>`;
}
