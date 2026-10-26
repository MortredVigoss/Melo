// This fixture asserts Chinese copy explicitly; production defaults follow the device.
import { setLanguage as setFixtureLanguage } from '../../i18n.js';
setFixtureLanguage('zh-CN');
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { renderProjectMemoryBook } from '../memory/viewProjectBook.js';
import { installProjectsFeature } from './index.js';
import { renderProjectsDetailView, renderProjectAgentDefaults } from './view.js';

// The renderers moved from app.js to ./view.js (architecture plan P2) and now
// get the bootstrap and the memory book only through the narrow context.
function install(bootstrap = {}, overrides = {}) {
  return installProjectsFeature({
    getBootstrap: () => bootstrap,
    api: async () => { throw new Error('no request expected'); },
    render() {}, showError() {}, patchSettings: async () => {}, applyBootstrap() {}, applyBootstrapPreservingDrafts() {},
    startProjectSession: async () => {},
    activeProject: () => bootstrap.activeProject || null,
    activeProjectChats: () => [], activeProjectArtifacts: () => [],
    renderMemoryBook: project => renderProjectMemoryBook(project, { records: [] }),
    escapeHtml: s => String(s ?? ''), truncate: s => s, icon: { chevronLeft: '', save: '', folder: '', plus: '', bubble: '', box: '' },
    ...overrides,
  });
}

test('project detail renders its real chats, artifacts and editable goals',()=>{
 install({artifacts:[{id:'a',title:'笔记',content:'阅读笔记'}]},{activeProjectChats:()=>[{id:'c',title:'安排',preview:'继续讨论'}],activeProjectArtifacts:()=>[{id:'a',title:'笔记',content:'阅读笔记'}]});
 const doc=new JSDOM(renderProjectsDetailView({id:'p',name:'阅读计划',summary:'每天二十分钟',tag:'学习',workspacePath:'/project',instructions:'简洁'})).window.document;
 assert.equal(doc.querySelector('[name=name]').value,'阅读计划');assert.equal(doc.querySelector('[name=instructions]').value,'简洁');
 assert.equal(doc.querySelector('[data-action=open-chat]').dataset.chatId,'c');assert.equal(doc.querySelector('[data-action=open-artifact]').dataset.artifactId,'a');
 assert.ok(doc.querySelector('[data-project-default-agent]'),'project page shows its Agent defaults');assert.match(doc.body.textContent,/1 段对话/); assert.doesNotMatch(doc.body.textContent,/undefined/); assert.match(doc.body.textContent,/开启项目对话/);assert.match(doc.body.textContent,/项目目标/);
 assert.ok(doc.querySelector('[data-project-book=p]'),'project page shows its memory book');assert.ok(doc.querySelector('form[data-form=project-book-create]'));
 assert.deepEqual([...doc.querySelectorAll('[name=knowledgeIds]')].map(i=>i.value),['a'],'project shared materials list the saved artifacts');
});

test('project Agent defaults show the chosen Agent and the saved team, led by that Agent',()=>{
 const agents=[{id:'main',name:'Main',capabilities:{delegate:true},collaboration:{canDelegate:true,delegateTargets:['research','reviewer']}},{id:'research',name:'Research',capabilities:{delegate:false},collaboration:{canDelegate:false,delegateTargets:[]}},{id:'reviewer',name:'Reviewer'}];
 install({customize:{agents}},{escapeHtml:s=>String(s??'').replaceAll('<','&lt;')});
 let doc=new JSDOM(renderProjectAgentDefaults({id:'p',defaultAgentId:'',teamPlan:{templateId:'parallel-research',members:['reviewer','research']}})).window.document;
 assert.equal(doc.querySelector('[data-project-default-agent]').value,'');
 assert.deepEqual([...doc.querySelectorAll('input[name=team-member]:checked')].map(i=>[i.value,i.dataset.order]),[['research','1'],['reviewer','0']]);
 assert.equal(doc.querySelector('[data-team-template]').value,'parallel-research');
 assert.match(doc.body.textContent,/已保存默认团队：Reviewer、Research/);assert.ok(doc.querySelector('[data-action=clear-project-team]'));
 doc=new JSDOM(renderProjectAgentDefaults({id:'p',defaultAgentId:'research',teamPlan:null})).window.document;
 assert.equal(doc.querySelector('[data-project-default-agent]').value,'research');
 assert.match(doc.body.textContent,/「Research」未开启委派/);assert.equal(doc.querySelector('[data-action=clear-project-team]'),null);
});
