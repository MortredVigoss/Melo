import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {searchKnowledge,pruneKnowledgeIndex,indexKnowledgeDocuments,warmKnowledgeIndex} from './knowledgeIndex.js';
import {retrieveKnowledgeContext} from '../services/chat/knowledgeContext.js';
import {updateStateAtomically} from '../state/stateStore.js';
const offline={modelId:'none',isAvailable:async()=>false};
async function fixture(fn){const home=await mkdtemp(join(tmpdir(),'melo-knowledge-'));try{await fn(home);}finally{await rm(home,{recursive:true,force:true});}}
test('knowledge retrieval scopes allowed IDs, finds late paragraphs, replaces revisions and prunes deleted sources',()=>fixture(async home=>{
 const doc={id:'a',title:'Guide',content:'Opening information. '.repeat(400)+' kiwi shipping policy'}, secret={id:'secret',title:'secret',content:'kiwi confidential'};
 indexKnowledgeDocuments({home,documents:[doc,secret]});
 await searchKnowledge({home,documents:[doc,secret],query:'kiwi',provider:offline});
 const found=await searchKnowledge({home,documents:[doc],query:'kiwi',provider:offline,limit:1});
 assert.equal(found[0].documentId,'a');assert.ok(found[0].start>5000);assert.match(found[0].text,/kiwi/);
 doc.content='replacement';const updated=await searchKnowledge({home,documents:[doc],query:'kiwi',provider:offline});assert.equal(updated.length,1);assert.equal(updated[0].text,'replacement');
 pruneKnowledgeIndex({home,keepIds:[]});const db=new DatabaseSync(join(home,'desktop/store.sqlite'));try{assert.equal(db.prepare('SELECT count(*) n FROM knowledge_chunks').get().n,0);assert.equal(db.prepare('SELECT count(*) n FROM knowledge_fts').get().n,0);}finally{db.close();}
}));
test('local vectors are incremental and isolated by home; prompt never includes automatic results or unselected notes',()=>fixture(async home=>{
 let calls=0;const provider={modelId:'test',isAvailable:async()=>true,embed:async text=>{calls++;return text.includes('fruit')||text.includes('apple')?[1,0]:[0,1];}};
 const documents=[{id:'a',title:'food',content:'apple orchard'},{id:'b',title:'machines',content:'car engine'}];
 indexKnowledgeDocuments({home,documents});await warmKnowledgeIndex({home,provider});
 const first=await searchKnowledge({home,documents,query:'fruit',provider,limit:1});assert.equal(first[0].documentId,'a');assert.ok(first[0].semantic);assert.equal(calls,3);
 await searchKnowledge({home,documents,query:'fruit',provider});assert.equal(calls,3);
 const state={projects:[{id:'p',knowledgeIds:['a','result']}],artifacts:[...documents.map(d=>({...d,kind:'note'})),{id:'result',title:'Output',kind:'result',content:'excluded generated code'}]};
 const prompt=await retrieveKnowledgeContext({state,chat:{projectId:'p'},home,query:'fruit',provider});assert.match(prompt,/apple/);assert.doesNotMatch(prompt,/car engine|excluded/);
 await fixture(async other=>{assert.equal((await searchKnowledge({home:other,documents:[],query:'fruit',provider})).length,0);});
}));
test('retrieval is read-only under a writer lock and stale indexes never leak old content',()=>fixture(async home=>{
 const documents=[{id:'a',title:'Policy',content:'kiwi original'}];
 indexKnowledgeDocuments({home,documents});
 const path=join(home,'desktop/store.sqlite'),before=await readFile(path),db=new DatabaseSync(path);
 db.exec('BEGIN IMMEDIATE');
 try {
  for(let i=0;i<3;i++)assert.match((await searchKnowledge({home,documents,query:'kiwi',provider:offline}))[0].text,/original/);
  const fresh=await searchKnowledge({home,documents:[{...documents[0],content:'kiwi revised'}],query:'kiwi',provider:offline});
  assert.equal(fresh[0].text,'kiwi revised');
 }finally{db.exec('ROLLBACK');db.close();}
 assert.deepEqual(await readFile(path),before);
}));
test('an unindexed knowledge prompt does not create storage or wait for document embeddings',()=>fixture(async home=>{
 let calls=0;const provider={modelId:'slow',isAvailable:async()=>true,embed:()=>{calls++;return new Promise(()=>{});}};
 const state={artifacts:[{id:'a',kind:'note',title:'Policy',content:'fresh policy'}]};
 const value=await retrieveKnowledgeContext({state,chat:{contextArtifactIds:['a']},home,query:'policy',provider});
 assert.match(value,/fresh policy/);assert.equal(calls,0);await assert.rejects(access(join(home,'desktop/store.sqlite')));
}));
test('query embedding has a short deadline and uses cached document vectors without writing',()=>fixture(async home=>{
 const documents=[{id:'a',title:'Policy',content:'kiwi policy'}];indexKnowledgeDocuments({home,documents});
 await warmKnowledgeIndex({home,provider:{modelId:'slow-query',isAvailable:async()=>true,embed:async()=>[1,0]}});
 let release;const provider={modelId:'slow-query',isAvailable:async()=>true,embed:()=>new Promise(resolve=>{release=resolve;})};
 const before=await readFile(join(home,'desktop/store.sqlite')),started=Date.now();
 const rows=await searchKnowledge({home,documents,query:'kiwi',provider,queryTimeoutMs:10});
 assert.equal(rows[0].semantic,false);assert.ok(Date.now()-started<1000);release([1,0]);
 assert.deepEqual(await readFile(join(home,'desktop/store.sqlite')),before);
}));
test('committed knowledge edits and deletion update the derived index without a retrieval call',()=>fixture(async home=>{
 await updateStateAtomically(state=>{state.artifacts=[{id:'a',title:'Saved',kind:'note',content:'first version'}];return state;},{home});
 const path=join(home,'desktop/store.sqlite');
 const text=()=>{const db=new DatabaseSync(path,{readOnly:true});try{return db.prepare('SELECT text FROM knowledge_chunks WHERE document_id=?').all('a').map(r=>r.text);}finally{db.close();}};
 assert.deepEqual(text(),['first version']);
 await updateStateAtomically(state=>{state.artifacts[0].content='second version';return state;},{home});assert.deepEqual(text(),['second version']);
 await updateStateAtomically(state=>{state.artifacts[0].deletedAt=new Date().toISOString();return state;},{home});assert.deepEqual(text(),[]);
}));
test('local embedding failure falls back to lexical evidence',()=>fixture(async home=>{
 const provider={modelId:'broken',isAvailable:async()=>true,embed:async()=>{throw new Error('offline');}};
 const rows=await searchKnowledge({home,documents:[{id:'a',title:'Guide',content:'payment details'}],query:'payment',provider});assert.equal(rows[0].semantic,false);assert.match(rows[0].text,/payment/);
}));
