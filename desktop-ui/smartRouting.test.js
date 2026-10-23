import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { renderSmartRouting, editSmartRouting, handleSmartRouting } from './smartRouting.js';
import { renderModelPicker } from './modelPresentation.js';
const candidate={connectionId:'fixture',model:'opaque-model',name:'Fixture',capabilities:{}};
const settings=()=>({revision:0,defaultMode:'fixed',preference:'balanced',allowCrossConnection:false,allowEscalation:true,tiers:{light:[],standard:[],strong:[]},candidates:[candidate]});
test('smart settings stay read-only, keep failed drafts and allow cancellation without requests',async()=>{
 const config={smartRouting:settings()};const dom=new JSDOM('<main></main>');let saves=0,fail=true;
 const render=()=>{dom.window.document.querySelector('main').innerHTML=renderSmartRouting(config);};
 const hooks={config,render,refresh:async()=>{},api:async(url,{body})=>{saves++;if(fail)throw Error('offline');return {...body,candidates:[candidate]};}};
 render();assert.equal(dom.window.document.querySelector('[name=defaultMode]').disabled,true);
 await handleSmartRouting('smart-routing-save',hooks);assert.equal(saves,0);
 await handleSmartRouting('smart-routing-edit',hooks);
 let field=dom.window.document.querySelector('[name=defaultMode]');field.value='smart';editSmartRouting(field);
 await handleSmartRouting('smart-routing-save',hooks);assert.equal(saves,1);assert.equal(dom.window.document.querySelector('[name=defaultMode]').value,'smart');assert.equal(config.smartRouting.defaultMode,'fixed');
 fail=false;await handleSmartRouting('smart-routing-save',hooks);assert.equal(config.smartRouting.defaultMode,'smart');assert.equal(saves,2);
 await handleSmartRouting('smart-routing-edit',hooks);field=dom.window.document.querySelector('[name=defaultMode]');field.value='fixed';editSmartRouting(field);
 await handleSmartRouting('smart-routing-cancel',hooks);assert.equal(dom.window.document.querySelector('[name=defaultMode]').value,'smart');assert.equal(saves,2);dom.window.close();
});
test('revision conflict rebases without replacing the draft or issuing a probe',async()=>{
 const config={smartRouting:settings()};const dom=new JSDOM('<main></main>');let count=0;
 const render=()=>{dom.window.document.querySelector('main').innerHTML=renderSmartRouting(config);};
 const hooks={config,render,refresh:async()=>{},api:async(url,options)=>{
  if(url==='/api/bootstrap')return {settings:{config:{smartRouting:{...settings(),revision:2}}}};
  count++;if(count===1)throw Error('智能模式设置已被更新，草稿保留');assert.equal(options.body.revision,2);return {...options.body,revision:3,candidates:[candidate]};}};
 render();await handleSmartRouting('smart-routing-edit',hooks);
 const field=dom.window.document.querySelector('[name=defaultMode]');field.value='smart';editSmartRouting(field);
 await handleSmartRouting('smart-routing-save',hooks);assert.equal(dom.window.document.querySelector('[data-action=smart-routing-save]').disabled,true);
 await handleSmartRouting('smart-routing-rebase',hooks);assert.equal(dom.window.document.querySelector('[name=defaultMode]').value,'smart');
 await handleSmartRouting('smart-routing-save',hooks);assert.equal(config.smartRouting.defaultMode,'smart');assert.equal(count,2);dom.window.close();
});
test('conversation menu offers opaque fixed models alongside smart, respecting pinned agent display',()=>{
 const config={model:'opaque-model',smartRouting:settings(),llmConnections:{activeId:'fixture',profiles:[]}};
 const dom=new JSDOM(renderModelPicker({config,models:['opaque-model','another-model'],selection:{mode:'smart'},open:true},String));
 assert.equal(dom.window.document.querySelectorAll('[data-model-mode=smart]').length,1);
 assert.equal(dom.window.document.querySelectorAll('[data-model="opaque-model"]').length,1);
 assert.match(dom.window.document.querySelector('.model-picker-trigger').textContent,/智能/);dom.window.close();
});
