import { t, ui } from './i18n.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { renderTeamPanel } from './teamPanel.js';
import { renderProjectMemoryBook } from './features/memory/viewProjectBook.js';
const source=readFileSync(new URL('./app.js',import.meta.url),'utf8');
function renderer(name,bindings) {
 bindings={t,ui,...bindings};
 const start=source.indexOf(`function ${name}(`),end=source.indexOf('\nfunction ',start+1);
 return new Function(...Object.keys(bindings), source.slice(start,end)+';return '+name)(...Object.values(bindings));
}
test('project detail renders its real chats, artifacts and editable goals',()=>{
 const render=renderer('renderProjectsDetailView',{uiState:{bootstrap:{artifacts:[{id:'a',title:'笔记',content:'阅读笔记'}]}},activeProjectChats:()=>[{id:'c',title:'安排',preview:'继续讨论'}],activeProjectArtifacts:()=>[{id:'a',title:'笔记',content:'阅读笔记'}],escapeHtml:s=>String(s??''),truncate:s=>s,icon:{chevronLeft:'',save:''},renderProjectAgentDefaults:()=>'<section data-project-agents></section>',renderProjectMemoryBook,projectBookData:()=>({records:[]})});
 const doc=new JSDOM(render({id:'p',name:'阅读计划',summary:'每天二十分钟',tag:'学习',workspacePath:'/project',instructions:'简洁'})).window.document;
 assert.equal(doc.querySelector('[name=name]').value,'阅读计划');assert.equal(doc.querySelector('[name=instructions]').value,'简洁');
 assert.equal(doc.querySelector('[data-action=open-chat]').dataset.chatId,'c');assert.equal(doc.querySelector('[data-action=open-artifact]').dataset.artifactId,'a');
 assert.ok(doc.querySelector('[data-project-agents]'),'project page shows its Agent defaults');assert.match(doc.body.textContent,/1 段对话/); assert.doesNotMatch(doc.body.textContent,/undefined/); assert.match(doc.body.textContent,/开启项目对话/);assert.match(doc.body.textContent,/项目目标/);
 assert.ok(doc.querySelector('[data-project-book=p]'),'project page shows its memory book');assert.ok(doc.querySelector('form[data-form=project-book-create]'));
});

test('project Agent defaults show the chosen Agent and the saved team, led by that Agent',()=>{
 const agents=[{id:'main',name:'Main',capabilities:{delegate:true},collaboration:{canDelegate:true,delegateTargets:['research','reviewer']}},{id:'research',name:'Research',capabilities:{delegate:false},collaboration:{canDelegate:false,delegateTargets:[]}},{id:'reviewer',name:'Reviewer'}];
 const render=renderer('renderProjectAgentDefaults',{uiState:{bootstrap:{}},conversationAgents:()=>agents,renderTeamPanel,escapeHtml:s=>String(s??'').replaceAll('<','&lt;')});
 let doc=new JSDOM(render({id:'p',defaultAgentId:'',teamPlan:{templateId:'parallel-research',members:['reviewer','research']}})).window.document;
 assert.equal(doc.querySelector('[data-project-default-agent]').value,'');
 assert.deepEqual([...doc.querySelectorAll('input[name=team-member]:checked')].map(i=>[i.value,i.dataset.order]),[['research','1'],['reviewer','0']]);
 assert.equal(doc.querySelector('[data-team-template]').value,'parallel-research');
 assert.match(doc.body.textContent,/已保存默认团队：Reviewer、Research/);assert.ok(doc.querySelector('[data-action=clear-project-team]'));
 doc=new JSDOM(render({id:'p',defaultAgentId:'research',teamPlan:null})).window.document;
 assert.equal(doc.querySelector('[data-project-default-agent]').value,'research');
 assert.match(doc.body.textContent,/「Research」未开启委派/);assert.equal(doc.querySelector('[data-action=clear-project-team]'),null);
});
