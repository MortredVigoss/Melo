import test from 'node:test';
import assert from 'node:assert/strict';
import {extractArtifacts,migrateLegacyResults,isKnowledgeArtifact,normalizeArtifact} from './artifactService.js';
import {selectedMaterials,validateConversationSelection} from '../../services/chat/conversationSelection.js';

test('assistant fences are results; manual code remains knowledge and never migrates by kind alone',()=>{
 const reply='```js\nconsole.log(1)\n```',chat={id:'c',title:'Chat',messages:[{role:'assistant',content:reply}]};
 const extracted=extractArtifacts(reply,chat);assert.equal(extracted[0].kind,'result');assert.equal(isKnowledgeArtifact(extracted[0]),false);
 const rows=migrateLegacyResults([{id:'old',chatId:'c',title:'Old name snippet 1',kind:'code',language:'js',content:'console.log(1)'},{id:'manual',chatId:'c',title:'My saved code',kind:'code',language:'js',content:'console.log(1)'},{id:'edited',chatId:'c',title:'Chat snippet 2',kind:'code',language:'js',content:'edited'}],[chat]);
 assert.equal(rows[0].kind,'result');assert.equal(rows[1].kind,'code');assert.equal(rows[2].kind,'code');
 assert.deepEqual(migrateLegacyResults(rows,[chat]),rows);assert.equal(normalizeArtifact(rows[0]).origin,'assistant-code');
 const state={artifacts:rows};assert.throws(()=>validateConversationSelection({contextArtifactIds:['old']},state,{}),/不存在/);
 assert.equal(selectedMaterials(state,{contextArtifactIds:['old']}),'');
 assert.match(selectedMaterials(state,{contextArtifactIds:['manual']}),/console.log/);
});
test('long knowledge stays intact and every selected document gets bounded reference space',()=>{
 const notes=Array.from({length:8},(_,i)=>({id:String(i),title:`Note ${i}`,content:`source ${i}: `+'x'.repeat(5000)}));
 const state={artifacts:notes}, chat={contextArtifactIds:notes.map(n=>n.id)};
 assert.deepEqual(validateConversationSelection(chat,state,{}),chat);
 const text=selectedMaterials(state,chat);assert.ok(text.length<12100);assert.match(text,/预算截取/);
 for(const n of notes){assert.ok(text.includes(n.title));assert.ok(n.content.length>5000);}
});
