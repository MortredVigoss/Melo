import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import * as store from './store.js';
let home,old;
test.beforeEach(()=>{home=mkdtempSync(join(tmpdir(),'melo-recall-audit-'));old=process.env.MELO_HOME;process.env.MELO_HOME=home;store._resetStoreForTests();});
test.afterEach(()=>{store._resetStoreForTests();if(old===undefined)delete process.env.MELO_HOME;else process.env.MELO_HOME=old;rmSync(home,{recursive:true,force:true});});
const row=(id,text='rareword',extra={})=>({id,namespace:'chat:a',kind:'fact',text,searchText:text,createdAt:'2020-01-01T00:00:00.000Z',updatedAt:'2020-01-01T00:00:00.000Z',metadata:{chatId:'a'},...extra});
const db=()=>new DatabaseSync(join(home,'desktop/store.sqlite'));
test('snapshot diff preserves surviving hit history and only cascades actual deletion',()=>{
 store.replaceMemories([row('a'),row('b')]);store.recordMemoryHit({memoryId:'a',queryHash:'q'});store.recordMemoryHit({memoryId:'b',queryHash:'q'});store.markMemoriesUsed(['a']);
 const before=store.getHitStats({memoryIds:['a']});store.replaceMemories([row('a','edited'),row('c')]);
 assert.deepEqual(store.getHitStats({memoryIds:['a']}),before);
 assert.equal(store.getHitStats({memoryIds:['b']}).length,0);
 const conn=db();try{assert.equal(conn.prepare('PRAGMA foreign_key_check').all().length,0);}finally{conn.close();}
});
test('recall and management searches are read-only; only confirmed use increases useCount',()=>{
 store.replaceMemories([row('a')]);
 const before=store.getMemoriesByIds(['a'])[0];
 store.recallMemories({namespaces:['chat:a'],query:'rareword'});store.searchMemories({query:'rareword'});store.recallMemoriesTiered({namespaces:['chat:a'],query:'rareword'});
 assert.deepEqual(store.getMemoriesByIds(['a'])[0],before);
 assert.equal(store.getHitStats({memoryIds:['a']}).length,0);
 store.recordMemoryHit({memoryId:'a',queryHash:'q'});store.markMemoriesUsed(['a','a']);
 assert.equal(store.getMemoriesByIds(['a'])[0].metadata.useCount,1);
});
test('merged records are absent in flat, tiered and management recall',()=>{
 store.replaceMemories([row('merged','rareword',{metadata:{mergedInto:'winner'}}),row('winner','rareword')]);
 for(const rows of [store.recallMemories({namespaces:['chat:a'],query:'rareword'}),store.searchMemories({query:'rareword'}),store.recallMemoriesTiered({namespaces:['chat:a'],query:'rareword'}).contents])assert.deepEqual(rows.map(r=>r.id),['winner']);
});
test('keyword and Chinese recall find old unembedded facts beyond the recent 512 rows',()=>{
 store.replaceMemories([row('old-en','saffron nebula code 74291'),row('old-zh','紫色神经触突'),...Array.from({length:650},(_,i)=>row(`new-${i}`,'unrelated ordinary note',{updatedAt:'2026-01-01T00:00:00.000Z'}))]);
 assert.equal(store.recallMemories({namespaces:['chat:a'],query:'74291',limit:1})[0]?.id,'old-en');
 assert.equal(store.recallMemoriesTiered({namespaces:['chat:a'],query:'神经触突',limits:{contents:1}}).contents[0]?.id,'old-zh');
});

test('per-turn feedback survives reopening and snapshots; retries do not inflate use or diversity',()=>{
 store.replaceMemories([row('a'),row('b')]);
 const feedback={candidates:[row('a'),row('b')],usedIds:['a'],requestId:'turn-1',query:'same question'};
 assert.equal(store.recordMemoryFeedback(feedback),1);
 assert.equal(store.recordMemoryFeedback(feedback),0);
 store._resetStoreForTests();
 assert.equal(store.recordMemoryFeedback(feedback),0,'reopen must keep the request id');
 store.replaceMemories([row('a','updated'),row('b')]);
 assert.equal(store.recordMemoryFeedback({...feedback,requestId:'turn-2'}),1);
 const [stats]=store.getHitStats({memoryIds:['a']});
 assert.equal(stats.hits,2);assert.equal(stats.goodOutcomes,2);assert.equal(stats.distinctQueries,1);
 assert.equal(store.getMemoriesByIds(['a'])[0].metadata.useCount,2);
 assert.equal(store.getMemoriesByIds(['b'])[0].metadata.useCount,undefined);
 const conn=db();try{assert.equal(conn.prepare('PRAGMA foreign_key_check').all().length,0);}finally{conn.close();}
});

test('batched recall refills sparse kinds without crossing namespace or audience filters',()=>{
 store.replaceMemories([row('only-correction','rareword',{kind:'verification-correction'}),
  row('other-chat','rareword',{namespace:'chat:other'}),
  ...Array.from({length:180},(_,i)=>row(`prompt-${i}`,'rareword',{kind:'prompt'}))]);
 const result=store.recallMemoryGroups({query:'rareword',groups:[
  {id:'prompts',namespaces:['chat:a'],kinds:['prompt'],limit:4},
  {id:'corrections',namespaces:['chat:a'],kinds:['verification-correction'],limit:2},
 ],accept:r=>r.id!=='prompt-0'});
 assert.equal(result.get('prompts').length,4);
 assert.deepEqual(result.get('corrections').map(r=>r.id),['only-correction']);
 assert.ok([...result.values()].flat().every(r=>r.namespace==='chat:a' && r.id!=='prompt-0'));
});

test('prompt assembly does not repeat a visible message, session fact, current intent or duplicated attic fact',async()=>{
 const {buildAgentMemoryNodeContext}=await import('../services/agent/agentMemoryContext.js');
 const fact='rareword preferred language';
 store.replaceMemories([
  row('visible','rareword earlier message',{kind:'prompt',metadata:{chatId:'a',messageId:'m1'}}),
  row('fact',fact,{kind:'session-fact',metadata:{chatId:'a',category:'decision'}}),
  row('copy',fact,{kind:'fact',metadata:{chatId:'a'}}),
  row('candidate','rareword stored correction',{kind:'verification-correction',metadata:{chatId:'a'}}),
 ]);
 const chat={id:'a',messages:[{id:'m1',role:'user',content:'rareword earlier message'},{id:'m2',role:'user',content:'rareword'}]};
 const rendered=[];
 const text=buildAgentMemoryNodeContext({state:{settings:{},tasks:[],approvals:[]},chat,latestUserMessage:'rareword',activeAgentProfile:{id:'main'},
  includedMessageIds:['m1','m2'],excludedFacts:[{id:'fact',fact}],onRecall:r=>rendered.push(...r)});
 assert.doesNotMatch(text,/earlier message|preferred language|Current intent|Latest user turn/);
 assert.equal(text.split('rareword stored correction').length-1,1);
 assert.ok(rendered.every(r=>r.renderedText && text.includes(r.renderedText)));
 assert.equal(store.getHitStats().length,0,'building a prompt must not write usage');
});

test('dreaming sees real usage after saves, and old hits still expire',async()=>{
 const {scoreGate}=await import('./dreaming/gates.js');
 store.replaceMemories([row('a')]);
 store.recordMemoryHitsBatch([{memoryId:'a',queryHash:'ancient',hitAt:'2000-01-01T00:00:00Z'}]);
 store.recordMemoryFeedback({candidates:[row('a')],usedIds:['a'],requestId:'turn',query:'rareword'});
 store.replaceMemories([row('a','new source text')]);
 const [stats]=store.getHitStats();
 assert.equal(stats.hits,1);assert.equal(scoreGate(stats).components.outcome,1);
 assert.equal(store.pruneHits({maxDays:60}),1);assert.equal(store.getHitStats()[0].hits,1);
});

test('hot attic deduplicates copies across namespaces without writing feedback',async()=>{
 const {injectHotAttic}=await import('./attic.js');
 store.replaceMemories([row('a','same decision',{metadata:{category:'decision'}}),row('b','same decision',{namespace:'agent:main',metadata:{category:'decision'}})]);
 const rendered=[];const text=injectHotAttic({namespaces:['chat:a','agent:main'],onRecall:r=>rendered.push(...r)});
 assert.equal(text.split('same decision').length-1,1);assert.equal(rendered.length,1);assert.equal(store.getHitStats().length,0);
});

test('merged vector candidates are excluded before KNN top K',()=>{
 store.writeStoredEmbeddingModelId('test-filtered-knn');
 const embedding=new Float32Array(1024);embedding[0]=1;
 const entries=[row('winner'),...Array.from({length:190},(_,i)=>row(`merged-${i}`,'noise',{metadata:{mergedInto:'winner'}}))];
 store.replaceMemories(entries);
 for(const entry of entries)store.saveMemoryEmbedding(entry.id,entry.text,embedding,'test-filtered-knn');
 assert.deepEqual(store.recallMemories({namespaces:['chat:a'],kinds:['fact'],query:'not-a-keyword',queryEmbedding:embedding,limit:1}).map(r=>r.id),['winner']);
 assert.deepEqual(store.recallMemoriesTiered({namespaces:['chat:a'],query:'not-a-keyword',queryEmbedding:embedding,limits:{contents:1}}).contents.map(r=>r.id),['winner']);
});

test('legacy prompt-history fallback cannot resurrect a merged row',async()=>{
 const {buildAgentMemoryNodeContext}=await import('../services/agent/agentMemoryContext.js');
 const text='rareword merged old message';
 store.replaceMemories([row('prompt:chat:a:history',text,{kind:'prompt',metadata:{chatId:'a',mergedInto:'winner'}})]);
 const context=buildAgentMemoryNodeContext({state:{settings:{promptHistory:[{id:'history',chatId:'a',content:text}]},approvals:[],tasks:[]},chat:{id:'a',messages:[]},activeAgentProfile:{id:'main'},latestUserMessage:'rareword'});
 assert.doesNotMatch(context,/merged old message/);
});
