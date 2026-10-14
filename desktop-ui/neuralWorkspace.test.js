import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {updateNeuralWorkspace,syncNeuralComposer} from './neuralDom.js';
import {workspaceLayout,overviewDockWidth,resolveWorkspaceStage} from './neuralLayout.js';
const mount=()=>{const dom=new JSDOM('<div id="app"></div>');return {dom,app:dom.window.document.querySelector('#app')};};
test('persistent scene and focused input survive background updates with unchanged values',()=>{
 const {dom,app}=mount();const page=n=>`<div data-neural-key="workspace"><div class="neural-cosmos"></div><textarea id="composer">draft</textarea><span>${n}</span></div>`;
 updateNeuralWorkspace(app,page(1));const root=app.firstChild,host=app.querySelector('.neural-cosmos'),input=app.querySelector('textarea');const canvas=dom.window.document.createElement('canvas');host.append(canvas);input.focus();input.value='draft input';input.setSelectionRange(3,7);root.dataset.bound='true';
 updateNeuralWorkspace(app,page(2));assert.equal(app.firstChild,root);assert.equal(host.firstChild,canvas);assert.equal(dom.window.document.activeElement,input);assert.equal(input.value,'draft input');assert.equal(input.selectionStart,3);assert.equal(root.dataset.bound,'true');
});
test('explicit controlled send/reset clears composer even when empty markup did not change',()=>{
 const {app}=mount();updateNeuralWorkspace(app,'<textarea id="composer"></textarea>');const input=app.firstChild;input.value='send me';input.focus();updateNeuralWorkspace(app,'<textarea id="composer"></textarea>');syncNeuralComposer(app,'');assert.equal(input.value,'');assert.equal(app.firstChild,input);
});
test('form values accept explicit state changes while retaining element identity',()=>{
 const {app}=mount();updateNeuralWorkspace(app,'<textarea id="edit">old</textarea><input id="check" type="checkbox"><select id="s"><option>a</option><option selected>b</option></select>');const input=app.firstChild;input.focus();updateNeuralWorkspace(app,'<textarea id="edit">new</textarea><input id="check" type="checkbox" checked><select id="s"><option selected>a</option><option>b</option></select>');assert.equal(input,app.firstChild);assert.equal(input.value,'new');assert.equal(app.querySelector('#check').checked,true);assert.equal(app.querySelector('#s').value,'a');
});
test('keyed nodes reorder without replacing listeners and removed pages are released',()=>{
 const {app}=mount();updateNeuralWorkspace(app,'<button data-neural-key="a">a</button><button data-neural-key="b">b</button>');const a=app.firstChild,b=app.lastChild;let clicked=0;b.addEventListener('click',()=>clicked++);updateNeuralWorkspace(app,'<button data-neural-key="b">changed</button><button data-neural-key="a">a</button>');assert.equal(app.firstChild,b);b.click();assert.equal(clicked,1);updateNeuralWorkspace(app,'<button data-neural-key="b">changed</button>');assert.equal(a.isConnected,false);assert.equal(app.children.length,1);
});
test('hydrated content survives unrelated updates but real declarative changes apply',()=>{
 const {app}=mount();const html=n=>`<div><section id="viz">chart</section><span>${n}</span></div>`;updateNeuralWorkspace(app,html(1));const chart=app.querySelector('#viz');chart.innerHTML='<canvas></canvas>';updateNeuralWorkspace(app,html(2));assert.ok(chart.querySelector('canvas'));updateNeuralWorkspace(app,'<div><section id="new">new page</section></div>');assert.equal(chart.isConnected,false);
});
test('layout reserves a lower composer dock and keeps modules within the stage',()=>{
 for(const [w,h] of [[1440,900],[1024,768],[735,789],[390,700]]){const l=workspaceLayout(w,h);assert.equal(l.ports.length,5);for(const [x,y] of l.ports){assert.ok(x>0&&x<w);assert.ok(y>50&&y<h-220);}assert.ok(l.core[1]<h-245);}
 assert.equal(resolveWorkspaceStage(true,false),'overview');assert.equal(resolveWorkspaceStage(true,true),'module');assert.equal(resolveWorkspaceStage(false,true),'detail');
});

test('spatial hierarchy leaves separate navigation, branch and reading areas across desktop sizes',()=>{
 for(const [w,h] of [[900,660],[1000,720],[1100,720],[1280,720],[1920,1080]]){
  const overview=workspaceLayout(w,h),module=workspaceLayout(w,h,'module'),detail=workspaceLayout(w,h,'detail');
  assert.ok(overview.coreSize>detail.coreSize,'the core recedes in the reading stage');
  assert.ok(overview.ports[0][0]>=80&&overview.ports[2][0]<=w-80,'enlarged module targets retain a screen edge gutter');
  assert.ok(detail.ports[0][0]+50<=detail.branch[0],'module targets do not overlap branch targets');
  assert.ok(detail.branch[0]+detail.branch[2]+16<=detail.panel[0],'reading surface has its own gutter');
  assert.ok(detail.panel[2]>=570,'usable detail width');
  assert.ok(detail.panel[0]+detail.panel[2]<=w-16);
  assert.ok(module.branch[0]>detail.branch[0],'the same branch column travels inward');
 }
});

test('overview uses a larger window while reserving actual composer height',()=>{
 const laptop=workspaceLayout(1280,720),desktop=workspaceLayout(1920,1080);
 assert.ok(desktop.brainScale>laptop.brainScale*1.4,'the brain grows with available screen area');
 assert.ok(desktop.ports[2][0]-desktop.ports[0][0]>1000,'large screens use their horizontal space');
 for(const [w,h] of [[900,660],[1320,860],[1920,1080]]){
  const ordinary=workspaceLayout(w,h,'overview',260),expanded=workspaceLayout(w,h,'overview',360);
  assert.ok(expanded.brainScale<ordinary.brainScale,'expanded composer keeps space for its controls');
  for(const [,y] of expanded.ports)assert.ok(y+70<h-360-30,'lower module labels stay above the composer');
  assert.ok(overviewDockWidth(w)>560&&overviewDockWidth(w)<=w-40,'input dock grows without overflowing');
 }
 assert.ok(overviewDockWidth(390)<=350,'small screens retain side gutters');
});
