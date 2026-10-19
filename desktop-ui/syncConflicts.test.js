import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {describeSyncVersion,renderSyncConflicts} from './syncConflicts.js';
const escape=v=>String(v).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
test('conflict choices retain content and literal text without executing it or exposing raw avatar data',()=>{
 const value={title:'<img src=x onerror=alert(1)>',content:'First version',avatarData:'base64-data',deleted:true};
 const html=renderSyncConflicts([{kind:'knowledge',id:'a',versions:[{value},{value:{...value,content:'Other version'}}]}],escape);
 const document=new JSDOM(html).window.document;
 assert.equal(document.querySelectorAll('img[onerror]').length,0);assert.equal(document.querySelectorAll('button').length,2);
 assert.match(document.body.textContent,/已删除/);assert.match(document.body.textContent,/Other version/);assert.ok(!document.querySelector('pre').textContent.includes('base64-data')); 
 assert.match(describeSyncVersion({model:{model:'chosen',name:'Provider'}}),/chosen/);
 assert.equal(describeSyncVersion({name:'Agent',mood:'sharp'}),describeSyncVersion({name:'Agent'}));
});


test('project-memory conflicts show readable versions and target their separate resolver',()=>{
 const value={kind:'project-memory-v1',content:JSON.stringify({text:'<script>literal memory</script>',scope:'project',status:'active',updatedAt:'2026-10-19'})};
 const document=new JSDOM(renderSyncConflicts([{kind:'knowledge',id:'memory_test',versions:[{value}]}],escape,'project-memory')).window.document;
 assert.equal(document.querySelectorAll('script').length,0);
 assert.match(document.querySelector('pre').textContent,/literal memory/);
 assert.equal(document.querySelector('button').dataset.settings,'project-memory');
});
