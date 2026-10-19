import { t, ui } from '../../i18n.js';
import { renderEditActions, EditSession } from '../../settingsEdit.js';
const escape=value=>String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
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
  return ui`<section class="quality-details memory-facts"><h3>记住的事实</h3>
    <p>自动记忆默认仅用于原对话。停止使用会保留记录供恢复，原始聊天仍然保留。</p>
    <div class="inline-actions"><input id="memory-fact-query" aria-label="搜索记忆" placeholder="搜索内容或来源对话" value="${escape(query)}"/><button class="small-button" data-action="memory-fact-search">搜索</button></div>
    ${!data?ui`<p>正在读取记忆…</p>`:data.records.length?data.records.map(r=>ui`<article class="detail-card" data-memory-record="${escape(r.id)}">
      ${feedback?.id===r.id?ui`<div class="settings-edit-toolbar" data-edit-status="saved"><span class="settings-save-status" role="status">✓ ${escape(feedback.message)}</span></div>`:''}
      <div class="list-row-meta">${r.status==='conflict'?ui`<span class="status-badge memory-conflict-badge">冲突</span> `:''}${escape(statuses[r.status] || r.status)} · ${escape(scopes[r.scope])}${r.category?` · ${escape(categories[r.category] || r.category)}`:''}${r.pinned?` · 📌 ${escape(t('固定常驻'))}`:''}</div>
      ${r.conflict?ui`<div class="memory-conflict" data-memory-conflict="${escape(r.id)}"><p>桌面与手机都修改了这条记忆，桌面版仍在使用；请选择保留哪一版。</p>
        <p><strong>桌面版</strong>（${escape(scopes[r.scope])}）：${escape(r.text)}</p>
        <p><strong>手机版</strong>（${escape(scopes[r.conflict.scope] || r.conflict.scope || '')}${r.conflict.editedAt?` · ${escape(r.conflict.editedAt)}`:''}）：${escape(r.conflict.text)}</p>
        <div class="inline-actions"><button class="small-button" data-action="memory-fact-resolve-desktop" data-id="${escape(r.id)}" ${busy?'disabled':''}>采用桌面版</button><button class="small-button" data-action="memory-fact-resolve-mobile" data-id="${escape(r.id)}" ${busy?'disabled':''}>采用手机版</button></div></div>`:''}
      ${editing===r.id?ui`<label>记忆内容<textarea id="memory-fact-text" rows="3" maxlength="2000" ${busy?'disabled':''}>${escape(draft?.text ?? r.text)}</textarea></label>
        <label>使用范围<select id="memory-fact-scope" ${busy?'disabled':''}>${Object.entries(scopes).filter(([key])=>key==='chat'?(r.sourceChatId||r.scope==='chat'):r.local&&(key!=='project'||r.projectId)).map(([key,label])=>ui`<option value="${key}" ${key===(draft?.scope ?? r.scope)?'selected':''}>${escape(label)}</option>`).join('')}</select></label>
        <label>类别<select id="memory-fact-category" ${busy?'disabled':''}>${Object.entries(categories).map(([key,label])=>ui`<option value="${key}" ${key===(draft?.category ?? defaultCategory(r.category))?'selected':''}>${escape(label)}</option>`).join('')}</select></label>
        <label class="checkbox-row"><input type="checkbox" id="memory-fact-pinned" ${(draft?.pinned ?? r.pinned)?'checked':''} ${busy?'disabled':''}/><span>固定常驻（每轮都提供给模型，不随时间衰减）</span></label>
        ${renderEditActions(session || Object.assign(new EditSession(),{status:'dirty',dirty:true}),{prefix:'memory-fact',disabled:busy})}`:ui`<p>${escape(r.text)}</p>`}
      <details><summary>来源：${escape(r.sourceTitle)}</summary><p>${escape(r.sourceText || t('旧记录未保存具体原句，不能确认原始措辞。'))}</p>${r.supersededBy?ui`<p>替代内容：${escape(r.supersededBy)}</p>`:''}
        ${r.sourceChatId?ui`<button class="small-button" data-action="open-chat" data-chat-id="${escape(r.sourceChatId)}">打开来源对话</button>`:''}</details>
      ${editing!==r.id?ui`<div class="inline-actions"><button class="small-button" data-action="memory-fact-edit" data-id="${escape(r.id)}">修改与共享范围</button>
        <button class="small-button" data-action="${r.status==='active'?'memory-fact-forget':'memory-fact-restore'}" data-id="${escape(r.id)}" ${busy?'disabled':''}>${escape(t(r.status==='active'?'停止使用':'恢复使用'))}</button></div>`:''}
    </article>`).join(''):ui`<p>没有匹配的记忆事实。</p>`}
    ${data?ui`<div class="inline-actions"><span>${data.total?data.offset+1:0}–${data.offset+data.records.length} / ${data.total}</span><button class="small-button" data-action="memory-fact-prev" ${data.offset===0?'disabled':''}>上一页</button><button class="small-button" data-action="memory-fact-next" ${data.offset+50>=data.total?'disabled':''}>下一页</button></div>`:''}
    <details><summary>最近回答提供了哪些记忆</summary><p>以下记录表示已提供给模型的上下文，不代表回答最终采用，也不是内部思考过程。旧回答没有记录时不补造。</p>
    ${(data?.turns || []).map(t=>ui`<div class="detail-card"><button class="small-button" data-action="open-chat" data-chat-id="${escape(t.chatId)}">${escape(t.title)}</button><small>${escape(t.createdAt)}</small>${t.memories.length?t.memories.map(m=>ui`<p>${escape(m.text)}</p>`).join(''):ui`<p>这轮没有提供已记录的记忆事实。</p>`}</div>`).join('') || ui`<p>新回答生成后会在这里显示。</p>`}</details>
  </section>`;
}
