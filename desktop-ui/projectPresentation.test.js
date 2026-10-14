import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
const source=readFileSync(new URL('./app.js',import.meta.url),'utf8');
function renderer(name,bindings) {
 const start=source.indexOf(`function ${name}(`),end=source.indexOf('\nfunction ',start+1);
 return new Function(...Object.keys(bindings), source.slice(start,end)+';return '+name)(...Object.values(bindings));
}
test('project detail renders its real chats, artifacts and editable goals',()=>{
 const render=renderer('renderProjectsDetailView',{uiState:{bootstrap:{artifacts:[{id:'a',title:'笔记',content:'阅读笔记'}]}},activeProjectChats:()=>[{id:'c',title:'安排',preview:'继续讨论'}],activeProjectArtifacts:()=>[{id:'a',title:'笔记',content:'阅读笔记'}],escapeHtml:s=>String(s??''),truncate:s=>s,icon:{chevronLeft:'',save:''}});
 const doc=new JSDOM(render({id:'p',name:'阅读计划',summary:'每天二十分钟',tag:'学习',workspacePath:'/project',instructions:'简洁'})).window.document;
 assert.equal(doc.querySelector('[name=name]').value,'阅读计划');assert.equal(doc.querySelector('[name=instructions]').value,'简洁');
 assert.equal(doc.querySelector('[data-action=open-chat]').dataset.chatId,'c');assert.equal(doc.querySelector('[data-action=open-artifact]').dataset.artifactId,'a');
 assert.match(doc.body.textContent,/1 段对话/); assert.doesNotMatch(doc.body.textContent,/undefined/); assert.match(doc.body.textContent,/开启项目对话/);assert.match(doc.body.textContent,/项目目标/);
});
