import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeMemoryFacts, filterActiveFacts } from './sessionMemory.js';
import { extractFactsRuleBased } from './offline/extractor.js';
import { promoteAndPersistFacts, _setGetEmbeddingForTests } from './memoryPromotion.js';
import * as store from './store.js';
import { buildAgentMemoryNodeContext } from '../services/agent/agentMemoryContext.js';
import { editMemoryFact, resolveSessionFacts, reconcileLegacyFacts } from './factRecords.js';
import { memoryFacts } from '../services/memory/memoryManagement.js';

let home, previous;
test.beforeEach(async () => { previous=process.env.MELO_HOME; home=await mkdtemp(join(tmpdir(),'melo-memory-integrity-')); process.env.MELO_HOME=home; store._resetStoreForTests(); _setGetEmbeddingForTests(async()=>null); });
test.afterEach(async () => { store._resetStoreForTests(); _setGetEmbeddingForTests(null); if(previous===undefined) delete process.env.MELO_HOME; else process.env.MELO_HOME=previous; await rm(home,{recursive:true,force:true}); });

test('Chinese negative preferences preserve polarity and source', () => {
  const facts=extractFactsRuleBased([{id:'u1',role:'user',content:'我不喜欢咖啡。我讨厌排队。'}]);
  assert.ok(facts.every(f=>!/prefers/.test(f.fact)));
  assert.ok(facts.every(f=>f.sourceMessageId==='u1'));
});
test('unrelated corrections coexist; a matching subject supersedes only its own value', () => {
  let facts=mergeMemoryFacts([],[{fact:'部署端口改为 8081',category:'correction',subjectKey:'deploy.port'}]);
  facts=mergeMemoryFacts(facts,[{fact:'回复使用中文',category:'correction',subjectKey:'reply.language'}]);
  assert.equal(filterActiveFacts(facts).length,2);
  facts=mergeMemoryFacts(facts,[{fact:'部署端口改为 9000',category:'correction',subjectKey:'deploy.port'}]);
  assert.deepEqual(filterActiveFacts(facts).map(f=>f.fact),['回复使用中文','部署端口改为 9000']);
});
test('recent facts are not crowded out by twelve facts from old messages', () => {
  const facts=extractFactsRuleBased([...Array.from({length:12},(_,i)=>({role:'user',content:`我喜欢历史偏好${i}。`})),{id:'recent',role:'user',content:'其实部署端口是 9000。'}]);
  assert.ok(facts.some(f=>f.fact.includes('9000')));
});
test('invalidated facts cannot reappear in long-term recall or another audience',async()=>{
  const chat={id:'private',source:'desktop',sessionMemory:[{fact:'私人偏好',category:'correction',validTo:'2020-01-01T00:00:00Z'},{fact:'私人项目决定',category:'decision'}]};
  await promoteAndPersistFacts(chat,'agent',{});
  const rows=store.recallMemories({namespaces:['chat:private','agent:agent'],kinds:['session-fact'],limit:20,sideEffects:false});
  assert.ok(!rows.some(r=>r.text==='私人偏好'));
  const ctx=buildAgentMemoryNodeContext({state:{chats:[],tasks:[],approvals:[],settings:{}},chat:{id:'group',source:'telegram',chatType:'group',messages:[]},latestUserMessage:'请介绍你自己',activeAgentProfile:{id:'agent'}});
  assert.ok(!ctx.includes('私人项目决定'));
});
test('hybrid recall retains a new exact keyword match without an embedding',()=>{
  store.upsertMemory({id:'old',namespace:'chat:a',kind:'fact',text:'coffee preference'});
  store.upsertMemory({id:'new',namespace:'chat:a',kind:'fact',text:'部署端口 9876'});
  const v=new Float32Array(1024);v[0]=1;store.saveMemoryEmbedding('old','coffee preference',v);
  const rows=store.recallMemories({namespaces:['chat:a'],kinds:['fact'],query:'9876',queryEmbedding:v,sideEffects:false,limit:1});
  assert.equal(rows[0]?.id,'new');
});

test('edit and forgetting survive checkpoint replay, index rebuild and store reopen',async()=>{
  const chat={id:'owned',source:'desktop',agentId:'a',sessionMemory:[{fact:'User prefers coffee',category:'user_preference'}]};
  await promoteAndPersistFacts(chat,'a',{});
  const id=store.listMemoryRecords()[0].id;
  editMemoryFact(id,{text:'User dislikes coffee',scope:'personal'});
  assert.equal(resolveSessionFacts(chat)[0].fact,'User dislikes coffee');
  editMemoryFact(id,{forgotten:true});
  store.replaceMemories([]);store._resetStoreForTests();
  assert.deepEqual(resolveSessionFacts(chat),[]);
  assert.equal(store.listMemoryRecords()[0].metadata.forgotten,true);
  editMemoryFact(id,{forgotten:false});
  assert.equal(resolveSessionFacts(chat)[0].fact,'User dislikes coffee');
});
test('explicit personal sharing works locally but never enters a channel audience',async()=>{
  const chat={id:'owned',source:'desktop',agentId:'a',sessionMemory:[{fact:'Owner likes tea',category:'decision'}]};
  await promoteAndPersistFacts(chat,'a',{});editMemoryFact(store.listMemoryRecords()[0].id,{scope:'personal'});
  const ctx=source=>buildAgentMemoryNodeContext({state:{chats:[chat],tasks:[],approvals:[],settings:{}},chat:{id:'other',source,messages:[]},latestUserMessage:'tea',activeAgentProfile:{id:'b'}});
  assert.match(ctx('desktop'),/Owner likes tea/);assert.doesNotMatch(ctx('telegram'),/Owner likes tea/);
  const deleted = buildAgentMemoryNodeContext({state:{chats:[],tasks:[],approvals:[],settings:{}},chat:{id:'other',source:'desktop',messages:[]},latestUserMessage:'tea',activeAgentProfile:{id:'b'}});
  assert.doesNotMatch(deleted,/Owner likes tea/,'a late index job must not expose a deleted source before cleanup catches up');
});
test('legacy migration carries validity and repairs only provable Chinese polarity',()=>{
  const chat={id:'old',source:'desktop',messages:[{id:'u1',role:'user',content:'我不喜欢咖啡。'}],sessionMemory:[{fact:'User prefers 咖啡',category:'user_preference'},{fact:'旧端口',category:'correction',validTo:'2020-01-01T00:00:00Z'}]};
  store.upsertMemory({id:'promoted:legacy',namespace:'agent:main',kind:'session-fact',text:'User prefers 咖啡',metadata:{chatId:'old'}});
  reconcileLegacyFacts({chats:[chat]});
  assert.deepEqual(resolveSessionFacts(chat).map(f=>f.fact),['User dislikes 咖啡']);
  assert.equal(store.listMemoryRecords().find(r=>r.id==='promoted:legacy').metadata.sourceMessageId,'u1');
});
test('scoped filtering occurs before the limit and tiered empty scope never searches globally',()=>{
  store.upsertMemory({id:'denied',namespace:'chat:x',kind:'fact',text:'coffee',metadata:{chatId:'wrong'}});
  store.upsertMemory({id:'allowed',namespace:'chat:x',kind:'fact',text:'coffee with milk',metadata:{chatId:'right'}});
  assert.equal(store.recallMemories({namespaces:['chat:x'],query:'coffee',limit:1,sideEffects:false,accept:r=>r.metadata.chatId==='right'})[0].id,'allowed');
  const v=new Float32Array(1024);v[0]=1;store.saveMemoryEmbedding('allowed','coffee with milk',v);
  assert.deepEqual(store.recallMemoriesTiered({namespaces:[],queryEmbedding:v,query:'coffee'}),{scenes:[],frames:[],contents:[],conflicts:[]});
});
test('tiered retrieval also includes fresh unembedded content',()=>{
  store.upsertMemory({id:'old',namespace:'chat:a',kind:'prompt',text:'coffee preference'});
  store.upsertMemory({id:'new',namespace:'chat:a',kind:'prompt',text:'部署端口 9876'});
  const v=new Float32Array(1024);v[0]=1;store.saveMemoryEmbedding('old','coffee preference',v);
  const rows=store.recallMemoriesTiered({namespaces:['chat:a'],query:'9876',queryEmbedding:v,limits:{contents:1}});
  assert.equal(rows.contents[0]?.id,'new');
});

test('a missing URL search parameter lists saved facts instead of searching for null',async()=>{
  const chat={id:'owned',source:'desktop',agentId:'a',sessionMemory:[{fact:'Owner likes tea'}]};
  await promoteAndPersistFacts(chat,'a',{});
  assert.equal((await memoryFacts({query:null})).total,1);
  assert.equal((await memoryFacts({query:'not present'})).total,0);
});

test('an embedding completed after editing cannot restore the previous text vector',async()=>{
  const chat={id:'owned',source:'desktop',agentId:'a',sessionMemory:[{fact:'Owner likes coffee'}]};
  await promoteAndPersistFacts(chat,'a',{});
  const row=store.listMemoryRecords()[0];
  editMemoryFact(row.id,{text:'Owner likes tea'});
  const v=new Float32Array(1024);v[0]=1;
  store.saveMemoryEmbedding(row.id,row.searchText,v);
  assert.equal(store.getMemoriesByIds([row.id])[0].text,'Owner likes tea');
  assert.equal(store.getMemoriesByIds([row.id])[0].embedding,null);
});

test('other namespaces and kinds cannot crowd scoped semantic candidates out of the ANN window',()=>{
  const q=new Float32Array(1024);q[0]=1;
  const near=new Float32Array(1024);near[0]=0.9;near[1]=Math.sqrt(0.19);
  const far=new Float32Array(1024);far[1]=1;
  for(let i=0;i<70;i++) {
    store.upsertMemory({id:`noise${i}`,namespace:i%2?'chat:other':'chat:a',kind:'prompt',text:`noise ${i}`});
    store.saveMemoryEmbedding(`noise${i}`,`noise ${i}`,q);
  }
  for(const kind of ['fact','scene','frame']) {
    store.upsertMemory({id:`relevant-${kind}`,namespace:'chat:a',kind,text:'tea preference',updatedAt:'2026-01-01T00:00:00Z'});
    store.saveMemoryEmbedding(`relevant-${kind}`,'tea preference',near);
    store.upsertMemory({id:`unrelated-${kind}`,namespace:'chat:a',kind,text:'typescript deployment',updatedAt:'2026-10-01T00:00:00Z'});
    store.saveMemoryEmbedding(`unrelated-${kind}`,'typescript deployment',far);
  }
  assert.equal(store.recallMemories({namespaces:['chat:a'],kinds:['fact'],queryEmbedding:q,limit:1,sideEffects:false})[0]?.id,'relevant-fact');
  const tiered=store.recallMemoriesTiered({namespaces:['chat:a'],queryEmbedding:q,limits:{scenes:1,frames:1,contents:1}});
  assert.equal(tiered.scenes[0]?.id,'relevant-scene');
  assert.equal(tiered.frames[0]?.id,'relevant-frame');
});
