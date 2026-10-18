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

// ── Desktop compact → phone (design 2026-10-17 手机对齐) ─────────────────────
import {portableCompact,preferCompact,compactAdvances} from './workspaceProtocol.js';
import {exportMobileSnapshot,importMobileSnapshot} from '../src/services/remote/mobileSync.js';
import {exportCompact,applyCompact} from '../src/services/chat/portableWorkspace.js';
const T0='2026-10-17T01:00:00.000Z', T1='2026-10-17T02:00:00.000Z', T2='2026-10-17T03:00:00.000Z';
const compactChat=(count=4,{at=T1,summary='# 早期话题\n用户决定用 sqlite。'}={})=>({id:'long-chat',title:'长对话',createdAt:T0,updatedAt:at,agentId:'main',messages:Array.from({length:8},(_,i)=>({id:`m${i+1}`,role:i%2?'assistant':'user',content:`turn ${i+1}`,createdAt:T0})),
 compactBoundaryMessageId:`m${count}`,compactedMessageCount:count,compactSummary:summary,compactSummarySource:'cloud',compactedAt:at,
 compactCards:[{id:'card-1',title:'早期话题',summary:'用户决定用 sqlite。',fromMessageId:'m1',toMessageId:`m${count}`,messageCount:count,at,source:'cloud'}]});
test('compact: validation enforces enums and sizes; merge prefers the larger count, then the later at',()=>{
 const base={boundaryMessageId:'m4',compactedCount:4,source:'cloud',at:T1,summary:'s'};
 assert.deepEqual(portableCompact(base),base);
 assert.equal(portableCompact(null),null);
 assert.throws(()=>portableCompact({...base,source:'magic'}),/source/);
 assert.throws(()=>portableCompact({...base,compactedCount:0}),/count/);
 assert.throws(()=>portableCompact({...base,boundaryMessageId:'bad id'}),/boundary/);
 assert.throws(()=>portableCompact({...base,at:'yesterday'}),/timestamp/);
 assert.throws(()=>portableCompact({...base,summary:'x'.repeat(8193)}),/limit/);
 assert.throws(()=>portableCompact({...base,cards:[{id:'c',summary:'y'.repeat(2049),source:'cloud'}]}),/limit/);
 assert.throws(()=>portableCompact({...base,cards:[{id:'c',summary:'ok',source:'nope'}]}),/card/);
 assert.deepEqual(portableCompact({...base,cards:[{id:'c',summary:'ok',source:'rule'}]}).cards,[{id:'c',title:'',summary:'ok',fromMessageId:'',toMessageId:'',messageCount:0,at:'',source:'rule'}]);
 const bigger={...base,compactedCount:6,at:T0}, later={...base,at:T2};
 assert.equal(preferCompact(base,bigger),bigger);assert.equal(preferCompact(bigger,base),bigger);
 assert.equal(preferCompact(base,later),later);assert.equal(preferCompact(later,base),later);
 assert.equal(preferCompact(null,base),base);assert.equal(preferCompact(base,null),base);
 assert.equal(compactAdvances(base,bigger),true);assert.equal(compactAdvances(bigger,base),false);assert.equal(compactAdvances(base,{...base}),false);
 // Workspace records that differ only in compact collapse to the winner instead of a user conflict.
 const a=empty();putWorkspace(a,'conversation','long-chat',{agentId:'main',knowledgeIds:[],model:null,compact:base},'phone');
 const b=empty();putWorkspace(b,'conversation','long-chat',{agentId:'main',knowledgeIds:[],model:null,compact:bigger},'desktop');
 const merged=mergeWorkspaces(a,b);
 assert.equal(merged.records[0].versions.length,1);assert.deepEqual(merged.records[0].versions[0].value.compact,bigger);assert.deepEqual(merged.records[0].versions[0].clock,{phone:1,desktop:1});
 const c=empty();putWorkspace(c,'conversation','long-chat',{agentId:'other',knowledgeIds:[],model:null,compact:bigger},'desktop');
 assert.equal(mergeWorkspaces(a,c).records[0].versions.length,2,'a real field difference is still a conflict');
});
test('compact round trip: desktop export → validate → phone snapshot import applies the larger count, smaller/equal is ignored',()=>{
 const desktop={chats:[compactChat(4)],projects:[],artifacts:[],agentProfiles:{}};
 refreshPortableWorkspace(desktop);
 const exported=exportMobileSnapshot(desktop,{workspace:true});
 const wire=validateWorkspace(JSON.parse(JSON.stringify(exported.workspace)));
 const record=wire.records.find(r=>r.kind==='conversation'&&r.id==='long-chat');
 assert.equal(record.versions[0].value.compact.compactedCount,4);
 assert.equal(record.versions[0].value.compact.boundaryMessageId,'m4');
 assert.equal(record.versions[0].value.compact.summary,'# 早期话题\n用户决定用 sqlite。');
 assert.equal(record.versions[0].value.compact.cards[0].id,'card-1');
 // Phone (or another desktop) imports the snapshot: its chat gains the compact fields.
 const phone={chats:[{...compactChat(4),compactBoundaryMessageId:undefined,compactedMessageCount:0,compactSummary:'',compactCards:[],compactedAt:undefined}],projects:[],artifacts:[],agentProfiles:{}};
 importMobileSnapshot(phone,exported);
 assert.equal(phone.chats[0].compactedMessageCount,4);assert.equal(phone.chats[0].compactBoundaryMessageId,'m4');
 assert.equal(phone.chats[0].compactSummary,'# 早期话题\n用户决定用 sqlite。');assert.equal(phone.chats[0].compactCards.length,1);
 // Desktop compacts further (count 6) → the phone moves forward.
 Object.assign(desktop.chats[0],{compactBoundaryMessageId:'m6',compactedMessageCount:6,compactSummary:'# 更新\n六条已压缩。',compactedAt:T2});
 refreshPortableWorkspace(desktop);
 importMobileSnapshot(phone,exportMobileSnapshot(desktop,{workspace:true}));
 assert.equal(phone.chats[0].compactedMessageCount,6);assert.equal(phone.chats[0].compactSummary,'# 更新\n六条已压缩。');
 // A stale snapshot (count 4) or an equal one never moves the receiver backwards.
 const stale={chats:[compactChat(4,{at:T2,summary:'旧摘要'})],projects:[],artifacts:[],agentProfiles:{}};
 refreshPortableWorkspace(stale);
 importMobileSnapshot(phone,exportMobileSnapshot(stale,{workspace:true}));
 assert.equal(phone.chats[0].compactedMessageCount,6);assert.equal(phone.chats[0].compactSummary,'# 更新\n六条已压缩。');
 const equal={chats:[compactChat(6,{at:T0,summary:'同数不同文'})],projects:[],artifacts:[],agentProfiles:{}};
 refreshPortableWorkspace(equal);
 importMobileSnapshot(phone,exportMobileSnapshot(equal,{workspace:true}));
 assert.equal(phone.chats[0].compactSummary,'# 更新\n六条已压缩。','equal count with an earlier at is ignored');
 // Direct helpers: a boundary the receiver does not have is refused; oversize summaries are clipped on export.
 assert.equal(applyCompact(phone.chats[0],{boundaryMessageId:'missing',compactedCount:9,source:'local',at:T2,summary:'x'}),false);
 // Oversize desktop renderings are re-rendered for the phone within the byte
 // limit the phone enforces (audit L9), keeping the ledger cards' text.
 const huge=compactChat(4,{summary:'长'.repeat(9000)});
 assert.ok(Buffer.byteLength(exportCompact(huge).summary,'utf8')<=8192);
 assert.match(exportCompact(huge).summary,/用户决定用 sqlite/);
 const legacyHuge={...compactChat(4,{summary:'长'.repeat(9000)}),compactCards:[]};
 assert.ok(Buffer.byteLength(exportCompact(legacyHuge).summary,'utf8')<=8192,'a bare legacy summary is clipped on a byte boundary');
 assert.equal(exportCompact({...compactChat(4),compactBoundaryMessageId:'gone'}),null,'no boundary message → no compact');
 assert.equal(exportCompact({...compactChat(4),compactedMessageCount:0},{boundaryMessageId:'m4',compactedCount:4,source:'cloud',at:T1,summary:'s'}).compactedCount,4,'a previous synced record is kept');
});
