import { escapeHtml } from '../../i18n.js';
import { t, ui } from '../../i18n.js';
import { renderEditActions, EditSession } from '../../settingsEdit.js';
// Bug audit U6: static labels go through t() at render time (the interface
// language is chosen after import). '仅原对话' is a native-catalog key
// (ios/native-translations.js) that the shared catalog may not duplicate.
const scopeLabels=()=>({chat:'仅原对话',project:t('此项目的本地对话'),agent:t('此Agent的本地对话'),personal:t('我的全部本地对话')});
const statusLabels=()=>({active:t('使用中'),historical:t('已失效'),forgotten:t('已停止使用'),unconfirmed:t('来源待确认'),conflict:t('冲突')});
const categoryLabels=()=>({user_preference:t('偏好'),project_context:t('项目背景'),technical_detail:t('技术细节'),decision:t('决定'),correction:t('纠正'),identity:t('身份')});
const CATEGORY_KEYS=Object.freeze(['user_preference','project_context','technical_detail','decision','correction','identity']);
// Bug audit M5: legacy rows carry 'general' / '' — the editor must start on a category the server accepts.
export const defaultCategory=category=>CATEGORY_KEYS.includes(category)?category:'technical_detail';
export function renderMemoryFacts(data,{query='',editing=null,busy=false,draft=null,session=null,feedback=null}={}) {
  const scopes=scopeLabels(), statuses=statusLabels(), categories=categoryLabels();
  return ui`<section class="quality-details memory-facts"><h3 class="subsection-title">记住的事实</h3>
    <p>自动记忆默认仅用于原对话。停止使用会保留记录供恢复，原始对话仍然保留。</p>
    <div class="inline-actions"><input id="memory-fact-query" aria-label="搜索记忆" placeholder="搜索内容或来源对话" value="${escapeHtml(query)}"/><button class="small-button" data-action="memory-fact-search">搜索</button></div>
    ${!data?ui`<p>正在读取记忆…</p>`:data.records.length?data.records.map(r=>ui`<article class="detail-card" data-memory-record="${escapeHtml(r.id)}">
      ${feedback?.id===r.id?ui`<div class="settings-edit-toolbar" data-edit-status="saved"><span class="settings-save-status" role="status" aria-live="polite">✓ ${escapeHtml(feedback.message)}</span></div>`:''}
      <div class="list-row-meta">${r.status==='conflict'?ui`<span class="status-badge memory-conflict-badge">冲突</span> `:''}${escapeHtml(statuses[r.status] || r.status)} · ${escapeHtml(scopes[r.scope])}${r.category?` · ${escapeHtml(categories[r.category] || r.category)}`:''}${r.pinned?` · 📌 ${escapeHtml(t('固定常驻'))}`:''}</div>
      ${r.conflict?ui`<div class="memory-conflict" data-memory-conflict="${escapeHtml(r.id)}"><p>桌面与手机都修改了这条记忆，桌面版仍在使用；请选择保留哪一版。</p>
        <p><strong>桌面版</strong>（${escapeHtml(scopes[r.scope])}）：${escapeHtml(r.text)}</p>
        <p><strong>手机版</strong>（${escapeHtml(scopes[r.conflict.scope] || r.conflict.scope || '')}${r.conflict.editedAt?` · ${escapeHtml(r.conflict.editedAt)}`:''}）：${escapeHtml(r.conflict.text)}</p>
        <div class="inline-actions"><button class="small-button" data-action="memory-fact-resolve-desktop" data-id="${escapeHtml(r.id)}" ${busy?'disabled':''}>采用桌面版</button><button class="small-button" data-action="memory-fact-resolve-mobile" data-id="${escapeHtml(r.id)}" ${busy?'disabled':''}>采用手机版</button></div></div>`:''}
      ${editing===r.id?ui`<label>记忆内容<textarea id="memory-fact-text" rows="3" maxlength="2000" ${busy?'disabled':''}>${escapeHtml(draft?.text ?? r.text)}</textarea></label>
        <label>使用范围<select id="memory-fact-scope" ${busy?'disabled':''}>${Object.entries(scopes).filter(([key])=>key==='chat'?(r.sourceChatId||r.scope==='chat'):r.local&&(key!=='project'||r.projectId)).map(([key,label])=>ui`<option value="${key}" ${key===(draft?.scope ?? r.scope)?'selected':''}>${escapeHtml(label)}</option>`).join('')}</select></label>
        <label>类别<select id="memory-fact-category" ${busy?'disabled':''}>${Object.entries(categories).map(([key,label])=>ui`<option value="${key}" ${key===(draft?.category ?? defaultCategory(r.category))?'selected':''}>${escapeHtml(label)}</option>`).join('')}</select></label>
        <label class="checkbox-row"><input type="checkbox" id="memory-fact-pinned" ${(draft?.pinned ?? r.pinned)?'checked':''} ${busy?'disabled':''}/><span>固定常驻（每轮都提供给模型，不随时间衰减）</span></label>
        ${renderEditActions(session || Object.assign(new EditSession(),{status:'dirty',dirty:true}),{prefix:'memory-fact',disabled:busy})}`:ui`<p>${escapeHtml(r.text)}</p>`}
      <details><summary>来源：${escapeHtml(r.sourceTitle)}</summary><p>${escapeHtml(r.sourceText || t('旧记录未保存具体原句，不能确认原始措辞。'))}</p>${r.supersededBy?ui`<p>替代内容：${escapeHtml(r.supersededBy)}</p>`:''}
        ${r.sourceChatId?ui`<button class="small-button" data-action="open-chat" data-chat-id="${escapeHtml(r.sourceChatId)}">打开来源对话</button>`:''}</details>
      ${editing!==r.id?ui`<div class="inline-actions"><button class="small-button" data-action="memory-fact-edit" data-id="${escapeHtml(r.id)}">修改与共享范围</button>
        <button class="small-button" data-action="${r.status==='active'?'memory-fact-forget':'memory-fact-restore'}" data-id="${escapeHtml(r.id)}" ${busy?'disabled':''}>${escapeHtml(t(r.status==='active'?'停止使用':'恢复使用'))}</button></div>`:''}
    </article>`).join(''):ui`<p>没有匹配的记忆事实。</p>`}
    ${data?ui`<div class="inline-actions"><span>${data.total?data.offset+1:0}–${data.offset+data.records.length} / ${data.total}</span><button class="small-button" data-action="memory-fact-prev" ${data.offset===0?'disabled':''}>上一页</button><button class="small-button" data-action="memory-fact-next" ${data.offset+50>=data.total?'disabled':''}>下一页</button></div>`:''}
    <details><summary>最近回答提供了哪些记忆</summary><p>以下记录表示已提供给模型的上下文，不代表回答最终采用，也不是内部思考过程。旧回答没有记录时不补造。</p>
    ${(data?.turns || []).map(t=>ui`<div class="detail-card"><button class="small-button" data-action="open-chat" data-chat-id="${escapeHtml(t.chatId)}">${escapeHtml(t.title)}</button><small>${escapeHtml(t.createdAt)}</small>${t.memories.length?t.memories.map(m=>ui`<p>${escapeHtml(m.text)}</p>`).join(''):ui`<p>这轮没有提供已记录的记忆事实。</p>`}</div>`).join('') || ui`<p>新回答生成后会在这里显示。</p>`}</details>
  </section>`;
}
