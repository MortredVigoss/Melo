import { renderEditActions, EditSession } from './settingsEdit.js';
const escape=value=>String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const scopes={chat:'仅原对话',project:'此项目的本地对话',agent:'此角色的本地对话',personal:'我的全部本地对话'};
const statuses={active:'使用中',historical:'已失效',forgotten:'已停止使用',unconfirmed:'来源待确认'};
export function renderMemoryFacts(data,{query='',editing=null,busy=false,draft=null,session=null,feedback=null}={}) {
  return `<section class="quality-details memory-facts"><h3>记住的事实</h3>
    <p>自动记忆默认仅用于原对话。停止使用会保留记录供恢复，原始聊天仍然保留。</p>
    <div class="inline-actions"><input id="memory-fact-query" aria-label="搜索记忆" placeholder="搜索内容或来源对话" value="${escape(query)}"/><button class="small-button" data-action="memory-fact-search">搜索</button></div>
    ${!data?'<p>正在读取记忆…</p>':data.records.length?data.records.map(r=>`<article class="detail-card" data-memory-record="${escape(r.id)}">
      ${feedback?.id===r.id?`<div class="settings-edit-toolbar" data-edit-status="saved"><span class="settings-save-status" role="status">✓ ${escape(feedback.message)}</span></div>`:''}
      <div class="list-row-meta">${escape(statuses[r.status])} · ${escape(scopes[r.scope])}</div>
      ${editing===r.id?`<label>记忆内容<textarea id="memory-fact-text" rows="3" maxlength="2000" ${busy?'disabled':''}>${escape(draft?.text ?? r.text)}</textarea></label>
        <label>使用范围<select id="memory-fact-scope" ${busy?'disabled':''}>${Object.entries(scopes).filter(([key])=>key==='chat'||r.local&&(key!=='project'||r.projectId)).map(([key,label])=>`<option value="${key}" ${key===(draft?.scope ?? r.scope)?'selected':''}>${escape(label)}</option>`).join('')}</select></label>
        ${renderEditActions(session || Object.assign(new EditSession(),{status:'dirty',dirty:true}),{prefix:'memory-fact',disabled:busy})}`:`<p>${escape(r.text)}</p>`}
      <details><summary>来源：${escape(r.sourceTitle)}</summary><p>${escape(r.sourceText || '旧记录未保存具体原句，不能确认原始措辞。')}</p>${r.supersededBy?`<p>替代内容：${escape(r.supersededBy)}</p>`:''}
        ${r.sourceChatId?`<button class="small-button" data-action="open-chat" data-chat-id="${escape(r.sourceChatId)}">打开来源对话</button>`:''}</details>
      ${editing!==r.id?`<div class="inline-actions"><button class="small-button" data-action="memory-fact-edit" data-id="${escape(r.id)}">修改与共享范围</button>
        <button class="small-button" data-action="${r.status==='active'?'memory-fact-forget':'memory-fact-restore'}" data-id="${escape(r.id)}" ${busy?'disabled':''}>${r.status==='active'?'停止使用':'恢复使用'}</button></div>`:''}
    </article>`).join(''):'<p>没有匹配的记忆事实。</p>'}
    ${data?`<div class="inline-actions"><span>${data.total?data.offset+1:0}–${data.offset+data.records.length} / ${data.total}</span><button class="small-button" data-action="memory-fact-prev" ${data.offset===0?'disabled':''}>上一页</button><button class="small-button" data-action="memory-fact-next" ${data.offset+50>=data.total?'disabled':''}>下一页</button></div>`:''}
    <details><summary>最近回答提供了哪些记忆</summary><p>以下记录表示已提供给模型的上下文，不代表回答最终采用，也不是内部思考过程。旧回答没有记录时不补造。</p>
    ${(data?.turns || []).map(t=>`<div class="detail-card"><button class="small-button" data-action="open-chat" data-chat-id="${escape(t.chatId)}">${escape(t.title)}</button><small>${escape(t.createdAt)}</small>${t.memories.length?t.memories.map(m=>`<p>${escape(m.text)}</p>`).join(''):'<p>这轮没有提供已记录的记忆事实。</p>'}</div>`).join('') || '<p>新回答生成后会在这里显示。</p>'}</details>
  </section>`;
}
