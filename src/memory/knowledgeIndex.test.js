import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {searchKnowledge,pruneKnowledgeIndex} from './knowledgeIndex.js';
import {retrieveKnowledgeContext} from '../services/chat/knowledgeContext.js';
const offline={modelId:'none',isAvailable:async()=>false};
async function fixture(fn){const home=await mkdtemp(join(tmpdir(),'melo-knowledge-'));try{await fn(home);}finally{await rm(home,{recursive:true,force:true});}}
test('knowledge retrieval scopes allowed IDs, finds late paragraphs, replaces revisions and prunes deleted sources',()=>fixture(async home=>{
 const doc={id:'a',title:'Guide',content:'Opening information. '.repeat(400)+' kiwi shipping policy'}, secret={id:'secret',title:'secret',content:'kiwi confidential'};
 await searchKnowledge({home,documents:[doc,secret],query:'kiwi',provider:offline});
 const found=await searchKnowledge({home,documents:[doc],query:'kiwi',provider:offline,limit:1});
 assert.equal(found[0].documentId,'a');assert.ok(found[0].start>5000);assert.match(found[0].text,/kiwi/);
 doc.content='replacement';const updated=await searchKnowledge({home,documents:[doc],query:'kiwi',provider:offline});assert.equal(updated.length,1);assert.equal(updated[0].text,'replacement');
 pruneKnowledgeIndex({home,keepIds:[]});const db=new DatabaseSync(join(home,'desktop/store.sqlite'));try{assert.equal(db.prepare('SELECT count(*) n FROM knowledge_chunks').get().n,0);assert.equal(db.prepare('SELECT count(*) n FROM knowledge_fts').get().n,0);}finally{db.close();}
}));
test('local vectors are incremental and isolated by home; prompt never includes automatic results or unselected notes',()=>fixture(async home=>{
 let calls=0;const provider={modelId:'test',isAvailable:async()=>true,embed:async text=>{calls++;return text.includes('fruit')||text.includes('apple')?[1,0]:[0,1];}};
 const documents=[{id:'a',title:'food',content:'apple orchard'},{id:'b',title:'machines',content:'car engine'}];
 const first=await searchKnowledge({home,documents,query:'fruit',provider,limit:1});assert.equal(first[0].documentId,'a');assert.ok(first[0].semantic);assert.equal(calls,3);
 await searchKnowledge({home,documents,query:'fruit',provider});assert.equal(calls,4);
 const state={projects:[{id:'p',knowledgeIds:['a','result']}],artifacts:[...documents.map(d=>({...d,kind:'note'})),{id:'result',title:'Output',kind:'result',content:'excluded generated code'}]};
 const prompt=await retrieveKnowledgeContext({state,chat:{projectId:'p'},home,query:'fruit',provider});assert.match(prompt,/apple/);assert.doesNotMatch(prompt,/car engine|excluded/);
 await fixture(async other=>{assert.equal((await searchKnowledge({home:other,documents:[],query:'fruit',provider})).length,0);});
}));
test('local embedding failure falls back to lexical evidence',()=>fixture(async home=>{
 const provider={modelId:'broken',isAvailable:async()=>true,embed:async()=>{throw new Error('offline');}};
 const rows=await searchKnowledge({home,documents:[{id:'a',title:'Guide',content:'payment details'}],query:'payment',provider});assert.equal(rows[0].semantic,false);assert.match(rows[0].text,/payment/);
}));
