import { allAgentIdsFromProfiles } from '../../domain/agent/agentLibrary.js';
import { isKnowledgeArtifact } from '../../domain/artifact/artifactService.js';
import { importModelSelection } from './portableWorkspace.js';
export function validateConversationSelection(patch, state, config) {
  const result = {};
  if (Object.hasOwn(patch, 'agentId')) {
    if (!allAgentIdsFromProfiles(state.agentProfiles).includes(patch.agentId)) throw new Error('角色不存在，请重新选择。');
    result.agentId = patch.agentId;
  }
  if (Object.hasOwn(patch, 'modelSelection')) {
    const choice = patch.modelSelection;
    if (choice == null) result.modelSelection = null;
    else {
      const profileId = String(choice.profileId || '');
      const profile = profileId ? (Object.hasOwn(config.llmProfiles || {}, profileId) ? config.llmProfiles[profileId] : null) : config;
      if (!profile) throw new Error('模型连接不存在，请重新选择。');
      const model = typeof choice.model === 'string' ? choice.model.trim() : '';
      if (!model || model.length > 180 || /[\x00-\x1f]/.test(model)) throw new Error('模型 ID 无效。');
      result.modelSelection = {profileId, model, authMode:profile.authMode, baseUrl:profile.baseUrl};
    }
  }
  if (Object.hasOwn(patch, 'projectId')) {
    if (patch.projectId != null && !state.projects.some(p=>p.id===patch.projectId)) throw new Error('项目不存在。');
    result.projectId = patch.projectId || null;
  }
  if (Object.hasOwn(patch, 'contextArtifactIds')) {
    if (!Array.isArray(patch.contextArtifactIds)) throw new Error('资料选择无效。');
    const ids = [...new Set(patch.contextArtifactIds)];
    const notes = ids.map(id=>state.artifacts.find(a=>a.id===id && isKnowledgeArtifact(a)));
    if (notes.some(n=>!n)) throw new Error('资料已不存在，请重新选择。');
    if (notes.length > 8) throw new Error('每个对话最多选用 8 份资料。');
    result.contextArtifactIds = ids;
  }
  return result;
}
export function conversationConfig(config, choice) {
  if (!choice) return config;
  if (choice.portable) choice = importModelSelection(choice.portable, config);
  const profile = choice.profileId ? (Object.hasOwn(config.llmProfiles || {}, choice.profileId) ? config.llmProfiles[choice.profileId] : null) : config;
  if (!profile) throw new Error('本对话的模型连接已被移除，请重新选择。');
  if (!choice.profileId && (profile.authMode !== choice.authMode || profile.baseUrl !== choice.baseUrl)) throw new Error('原默认连接已改变，请为本对话重新选择模型。');
  return {...config, ...Object.fromEntries(['authMode','baseUrl','apiKey','apiProtocol'].map(k=>[k,profile[k] || (k==='apiProtocol'?'chat-completions':'')])), activeLlmProfileId:choice.profileId || '__conversation__', conversationModelSelected:true, model:choice.model};
}

export function selectedMaterials(state, chat) {
  if (chat.agentId && !allAgentIdsFromProfiles(state.agentProfiles || {}).includes(chat.agentId)) throw new Error('本对话的角色尚未同步完成，请处理同步冲突或重新选择。');
  const project = (state.projects || []).find(p=>p.id===chat.projectId);
  if (chat.projectId && !project) throw new Error('本对话所属项目尚未同步完成，请同步或重新选择项目。');
  const ids = [...new Set([...(project?.knowledgeIds || []), ...(chat.contextArtifactIds || [])])];
  const notes = ids.map(id=>state.artifacts.find(a=>a.id===id)).filter(isKnowledgeArtifact);
  const budget=12000;let remaining=budget;
  const text=notes.slice(0,8).map((n,index)=>{
    const prefix=`资料：${n.title}\n`;
    const allowance=Math.max(0,Math.floor(remaining/(Math.min(8,notes.length)-index))-prefix.length-2);
    const content=n.content.slice(0,allowance);remaining-=prefix.length+content.length+2;
    return prefix+content;
  }).join('\n\n');
  const truncated=notes.length>8 || notes.reduce((sum,n)=>sum+n.content.length+n.title?.length+5,0)>budget;
  return (truncated?'[资料按上下文预算截取，全文保留；未展示的部分不能视为已经读取。]\n':'')+text;
}
