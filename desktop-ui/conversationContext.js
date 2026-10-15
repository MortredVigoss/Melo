import { t, ui } from './i18n.js';
export function renderConversationContext({chat,projectId,artifactIds,projects=[],artifacts=[],disabled=false}, escape) {
  const selected = new Set(chat?.contextArtifactIds || artifactIds || []);
  const currentProject = chat ? chat.projectId : projectId;
  const inherited = new Set(projects.find(p=>p.id===currentProject)?.knowledgeIds || []);
  const visibleSelected = artifacts.filter(a=>selected.has(a.id)||inherited.has(a.id)).length;
  return ui`<details class="conversation-context"><summary>项目与资料${visibleSelected ? ` · ${visibleSelected}` : ''}</summary><div class="conversation-context-menu">
    <label class="label">归入项目<select class="input" data-chat-context="project" ${disabled?'disabled':''}><option value="">独立对话</option>${projects.filter(p=>!p.archived||p.id===currentProject).map(p=>ui`<option value="${escape(p.id)}" ${p.id===currentProject?'selected':''}>${escape(p.name)}${p.archived?'（已归档）':''}</option>`).join('')}</select></label>
    <strong>选用知识资料</strong><p>项目共享与对话选用资料一起发送，去重后最多 8 份、合计 24000 字。</p>
    <div class="context-materials">${artifacts.filter(a=>typeof a.content==='string' && a.content.trim()).map(a=>inherited.has(a.id)?ui`<p>✓ ${escape(a.title)} · 项目共享</p>`:ui`<label><input type="checkbox" data-chat-context="artifact" value="${escape(a.id)}" ${selected.has(a.id)?'checked':''} ${disabled?'disabled':''}><span>${escape(a.title)}</span></label>`).join('') || ui`<p>先在知识 → 资料与成果中保存资料。</p>`}</div>
  </div></details>`;
}
