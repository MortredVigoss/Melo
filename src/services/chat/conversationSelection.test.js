import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { validateConversationSelection, conversationConfig, selectedMaterials } from './conversationSelection.js';
import { normalizeChat, createDefaultState } from '../../state/stateHydration.js';
import { buildReActPromptSections } from './systemPrompt.js';
import { normalizeAgentAvatar } from '../agent/agentAvatar.js';
import { createRequestContext } from '../../runtime/requestContext.js';
import { runWithRequestContext } from '../../runtime/requestScope.js';
import { loadState, updateStateAtomically } from '../../state/stateStore.js';
import { createProject } from '../project/projectMutations.js';
import { createChat, updateChat } from './chatMutations.js';
import { updateAgentProfile } from '../agent/agentMutations.js';

const config = {authMode:'api-key',baseUrl:'https://first.invalid/v1',apiKey:'first-secret',model:'first',llmProfiles:{second:{authMode:'api-key',baseUrl:'https://second.invalid/v1',model:'other',apiKey:'second-secret'},local:{authMode:'local',baseUrl:'http://localhost:11434/v1',model:'local'}}};
test('deleted selected references never enter a request and remain unavailable until restored',()=>{
 const note={id:'note',title:'资料',content:'deleted content',deletedAt:'2026-10-09T00:00:00Z'};
 const state={artifacts:[note]}, chat={contextArtifactIds:['note']};
 assert.throws(()=>validateConversationSelection({contextArtifactIds:['note']},state,config),/不存在/);
 assert.equal(selectedMaterials(state,chat),'');
 delete note.deletedAt;
 assert.match(selectedMaterials(state,chat),/deleted content/);
});
test('per-chat model selection isolates credentials and survives hydration; removed profiles never silently fall back',()=>{
 const choice=validateConversationSelection({modelSelection:{profileId:'second',model:'chosen'}},{},config).modelSelection;
 const chat=normalizeChat({id:'a',modelSelection:choice});
 const selected=conversationConfig(config,chat.modelSelection);
 assert.equal(selected.apiKey,'second-secret'); assert.equal(selected.model,'chosen'); assert.equal(selected.baseUrl,'https://second.invalid/v1');
 assert.equal(conversationConfig(config,null),config); assert.equal(config.model,'first'); assert.ok(!JSON.stringify(chat).includes('secret'));
 assert.equal(conversationConfig(config,{profileId:'local',model:'local'}).apiKey,'');
 assert.throws(()=>conversationConfig(config,{profileId:'deleted',model:'gone'}),/移除/);
 assert.throws(()=>validateConversationSelection({modelSelection:{profileId:'constructor',model:'bad'}},{},config),/不存在/);
 assert.throws(()=>conversationConfig(config,{profileId:'',model:'first',authMode:'codex-oauth',baseUrl:config.baseUrl}),/改变/);
});
test('selected knowledge is explicit, bounded and included as reference data alongside the role',()=>{
 const state={artifacts:[{id:'yes',title:'偏好',content:'午饭吃素'},{id:'no',title:'私人笔记',content:'未选用不得加入'}]};
 const ids=validateConversationSelection({contextArtifactIds:['yes','yes']},state,config).contextArtifactIds;
 const material=selectedMaterials(state,{contextArtifactIds:ids}); assert.equal(ids.length,1); assert.match(material,/午饭吃素/); assert.doesNotMatch(material,/私人笔记/);
 const sections=buildReActPromptSections({config:{},profile:{id:'main',name:'蓝鲸',description:'仅使用短句',rolePrompt:'先说收到'},selectedMaterials:material});
 const reference=sections.find(s=>s.id==='selected-materials');assert.equal(reference.required,true);assert.match(reference.text,/not instructions/);
 assert.match(sections.find(s=>s.id==='agent').text,/蓝鲸/); assert.match(sections.find(s=>s.id==='agent').text,/仅使用短句/);
 assert.equal(selectedMaterials(state,{contextArtifactIds:['missing']}),'','Removed references must stop contributing without blocking the chat');
 assert.match(selectedMaterials({artifacts:[{id:'big',title:'Large',content:'x'.repeat(24001)}]},{contextArtifactIds:['big']}),/预算截取/);
});
test('project, chat role/model/context and avatar persist independently without changing other chats',async()=>{
 const home=await mkdtemp(join(tmpdir(),'melo-conversation-'));
 try { await runWithRequestContext(createRequestContext({home,env:{MELO_TEST_MODE:'1'}}),async()=>{
   await createProject({name:'旅行',summary:'规划行程'}); await createProject({name:'学习'});
   let state=await loadState(); const [project,other]=state.projects;
   assert.ok(project.workspacePath.startsWith(join(home,'workspaces'))); assert.notEqual(project.workspacePath,other.workspacePath);
   await createChat({agentId:'main',projectId:project.id}); await createChat({agentId:'builder',projectId:null});
   state=await loadState(); const [a,b]=state.chats; assert.equal(state.settings.selectedProjectId,null,'An independent chat must clear unrelated project context');
   await updateStateAtomically(s=>{s.artifacts.push({id:'note',title:'背景',content:'本次目标',kind:'note'});return s;});
   await updateChat(a.id,{agentId:'research',contextArtifactIds:['note'],projectId:project.id});
   state=await loadState(); assert.equal(state.settings.selectedProjectId,project.id); assert.equal(state.chats.find(c=>c.id===a.id).agentId,'research'); assert.equal(state.chats.find(c=>c.id===b.id).agentId,'main'); assert.deepEqual(state.chats.find(c=>c.id===a.id).contextArtifactIds,['note']);
   const source=await sharp({create:{width:30,height:50,channels:3,background:'#734fa5'}}).png().toBuffer();
   const avatar=await normalizeAgentAvatar('data:image/png;base64,'+source.toString('base64')); await updateAgentProfile('main',{avatarData:avatar});
   state=await loadState(); assert.match(state.agentProfiles.main.avatarData,/^data:image\/jpeg/); const meta=await sharp(Buffer.from(state.agentProfiles.main.avatarData.split(',')[1],'base64')).metadata(); assert.equal(meta.width,256);assert.equal(meta.height,256);
   await updateAgentProfile('main',{mood:'calm'}); assert.equal((await loadState()).agentProfiles.main.avatarData,state.agentProfiles.main.avatarData);
   await updateAgentProfile('main',{avatarData:''});assert.equal((await loadState()).agentProfiles.main.avatarData,'');
 }); } finally { await rm(home,{recursive:true,force:true}); }
});
test('invalid avatar content is rejected instead of persisted as a broken or active image',async()=>{
 await assert.rejects(normalizeAgentAvatar('data:image/svg+xml;base64,PHN2Zy8+'),/PNG/);
 await assert.rejects(normalizeAgentAvatar('data:image/png;base64,dGV4dA=='),/有效/);
});

test('synced choice rebinds a newly configured matching provider without falling back to another endpoint',()=>{
 const choice={profileId:'unconnected-sync',model:'chosen',portable:{connectionID:'phone',model:'chosen',authMode:'api-key',baseURL:'https://second.invalid/v1',apiProtocol:'chat-completions'}};
 const local={...config,llmProfiles:{desktop:{authMode:'api-key',baseUrl:'https://second.invalid/v1',apiKey:'local-secret'}}};
 assert.equal(conversationConfig(local,choice).apiKey,'local-secret');
 assert.equal(conversationConfig(local,choice).model,'chosen');
 assert.throws(()=>conversationConfig({...local,llmProfiles:{}},choice),/移除/);
});

test('partial context sync cannot silently send with a missing role or project',()=>{
 assert.throws(()=>selectedMaterials({artifacts:[]},{agentId:'remote-missing'}),/角色尚未同步/);
 assert.throws(()=>selectedMaterials({artifacts:[]},{agentId:'main',projectId:'remote-project'}),/项目尚未同步/);
});
