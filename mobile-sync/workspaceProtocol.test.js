import test from 'node:test';
import assert from 'node:assert/strict';
import {putWorkspace,mergeWorkspaces,resolveWorkspace,validateWorkspace} from './workspaceProtocol.js';
import {mergeSnapshots} from './protocol.js';
import {refreshPortableWorkspace,applyPortableWorkspace,importModelSelection} from '../src/services/chat/portableWorkspace.js';

test('intent-judge purpose survives desktop export and mobile workspace roundtrip',()=>{
 const models=[{requestedModel:'fast',reportedModel:'fast',simulated:false,purpose:'intent-judge'}];
 const state={chats:[{id:'receipt-chat',source:'desktop',title:'A',messages:[{id:'answer',role:'assistant',content:'done',metadata:{modelResponses:models}}]}],projects:[],artifacts:[],agentProfiles:{}};
 refreshPortableWorkspace(state);
 const wire=validateWorkspace(JSON.parse(JSON.stringify(state.mobileWorkspaceSync)));
 assert.deepEqual(wire.records.find(r=>r.kind==='message').versions[0].value.models,models);
});
const empty=()=>({version:1,records:[]});
test('offline edits converge without discarding either version, and explicit resolution survives stale retries',()=>{
 const a=empty();putWorkspace(a,'knowledge','note',{title:'标题',content:'原文'},'a');
 const b=structuredClone(a);putWorkspace(a,'knowledge','note',{title:'标题',content:'手机修改'},'a');putWorkspace(b,'knowledge','note',{title:'标题',content:'桌面修改'},'b');
 const merged=mergeWorkspaces(a,b);assert.equal(merged.records[0].versions.length,2);assert.deepEqual(merged,mergeWorkspaces(b,a));
 const chosen=resolveWorkspace(merged,'knowledge','note',0,'a');assert.equal(mergeWorkspaces(chosen,b).records[0].versions.length,1);
 assert.deepEqual(mergeWorkspaces(chosen,merged),chosen);
});
test('legacy text clients preserve server workspace registers, and wire schema strips credentials and paths',()=>{
 const workspace=empty();putWorkspace(workspace,'project','p',{name:'项目',workspacePath:'/private',apiKey:'secret',knowledgeIds:['note']},'desktop');
 const merged=mergeSnapshots({version:1,chats:[],workspace},{version:1,chats:[]});assert.deepEqual(merged.workspace,workspace);assert.doesNotMatch(JSON.stringify(merged),/private|secret|workspacePath|apiKey/);
 assert.throws(()=>validateWorkspace({version:1,records:[{kind:'knowledge',id:'constructor',versions:[]}]}));
});
test('portable context round trip preserves role, project, references, avatars and receipts while keeping local credentials and permissions local',()=>{
 const source={agentProfiles:{custom:{name:'蓝鲸',description:'简短',rolePrompt:'先说收到',identity:'身份',soulMd:'风格',tools:['local-command']}},projects:[{id:'p',name:'阅读',summary:'每天阅读',instructions:'坚持',knowledgeIds:['note'],archived:true,workspacePath:'/private/project'}],artifacts:[{id:'note',title:'偏好',content:'阅读二十分钟',kind:'note',language:'text'}],chats:[{id:'c',agentId:'custom',projectId:'p',contextArtifactIds:['note'],modelSelection:{profileId:'a',model:'chosen'},messages:[{id:'m',role:'assistant',content:'收到',metadata:{agent:{id:'custom',name:'蓝鲸'},modelResponses:[{requestedModel:'chosen',reportedModel:'actual'}]}}]}]};
 const config={llmProfiles:{a:{name:'测试',authMode:'api-key',baseUrl:'https://example.com/v1',apiKey:'TOP_SECRET',apiProtocol:'chat-completions'}}};
 const workspace=refreshPortableWorkspace(source,{config});assert.doesNotMatch(JSON.stringify(workspace),/TOP_SECRET|\/private|local-command/);
 const target={chats:[{id:'c',messages:[{id:'m',role:'assistant',content:'收到'}]}]};applyPortableWorkspace(target,workspace,{home:'/tmp/isolated',config:{}});
 assert.equal(target.chats[0].agentId,'custom');assert.equal(target.agentProfiles.custom.name,'蓝鲸');assert.equal(target.projects[0].archived,true);assert.deepEqual(target.projects[0].knowledgeIds,['note']);assert.equal(target.chats[0].modelSelection.profileId,'unconnected-sync');assert.equal(target.chats[0].messages[0].metadata.modelResponses[0].reportedModel,'actual');assert.deepEqual(target.agentProfiles.custom.enabledConnectorIds,[]);
 assert.equal(importModelSelection(workspace.records.find(r=>r.kind==='conversation').versions[0].value.model,config).profileId,'a');
});
