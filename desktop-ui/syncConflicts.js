import { t, ui } from './i18n.js';
const labels={agent:'Agent',project:'项目',knowledge:'资料',conversation:'对话设置',message:'回复来源'};
const fields={name:'名称',title:'标题',subtitle:'一句话描述',content:'内容',instructions:'回复要求 / 项目指引',goal:'目标',identity:'身份',soul:'回复风格',systemPrompt:'补充要求',symbol:'图标',model:'模型',agentId:'Agent',projectId:'项目',chatId:'对话'};
export function describeSyncVersion(value) {
  const lines=[];
  for(const [key,label] of Object.entries(fields))if(typeof value[key]==='string'&&value[key])lines.push(`${label}：${value[key]}`);
  if(Object.hasOwn(value,'deleted'))lines.push(`资料状态：${value.deleted?'已删除':'可选用'}`);
  if(Object.hasOwn(value,'archived'))lines.push(`项目状态：${value.archived?'已归档':t("进行中")}`);
  if(value.avatarData)lines.push('头像：已保存自定义头像');
  if(value.knowledgeIds?.length)lines.push(`选用资料：${value.knowledgeIds.join('、')}`);
  if(value.model&&typeof value.model==='object')lines.push(`连接：${value.model.name || value.model.baseURL || '本机连接'}\n模型：${value.model.model}`);
  if(value.agentOverrides&&Object.keys(value.agentOverrides).length)lines.push(`项目Agent：${Object.values(value.agentOverrides).map(a=>describeSyncVersion(a)).join('\n')}`);
  if(value.agent)lines.push(`回复Agent：${value.agent.name}`);
  for(const model of value.models || [])lines.push(`请求模型：${model.requestedModel}\n服务返回：${model.reportedModel || '未提供'}`);
  if(value.scene)lines.push(`执行状态：${value.scene.status}\n来源：${value.scene.sources.map(s=>`${s.title} · ${s.url}${s.cited?'（已引用）':''}`).join('\n')}`);
  for(const stage of [...(value.scene?.operations || []),...(value.scene?.pipeline || [])])lines.push(`${stage.name} · ${stage.status}\n${stage.input || ''}\n${stage.output || stage.resultSummary || ''}`);
  return lines.join('\n\n') || '没有附加内容';
}
export function renderSyncConflicts(records=[],escape,settings=false) {
  if(!records.length)return '';
  return ui`<details class="sync-conflicts"><summary>有 ${records.length} 项跨设备修改冲突 · 所有版本均已保留</summary><p>以下内容尚未互相覆盖。选择要继续使用的版本，下次同步会把选择发送到其他设备。</p>${records.map(row=>ui`<details><summary>${labels[row.kind] || '记录'} · ${escape(row.versions[0]?.value?.name || row.versions[0]?.value?.title || row.id)}</summary><div class="sync-version-grid">${row.versions.map((version,index)=>ui`<section><strong>版本 ${index+1}</strong>${version.value.avatarData?ui`<img alt="此版本的头像" width="56" height="56" src="data:image/jpeg;base64,${escape(version.value.avatarData)}">`:""}<pre>${escape(describeSyncVersion(version.value))}</pre><button class="small-button" data-action="resolve-sync-conflict" data-settings="${settings?'true':'false'}" data-kind="${escape(row.kind)}" data-id="${escape(row.id)}" data-index="${index}">采用版本 ${index+1}</button></section>`).join('')}</div></details>`).join('')}</details>`;
}
