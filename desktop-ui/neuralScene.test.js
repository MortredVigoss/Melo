import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createNeuralScene } from './neuralScene.js';
import { neuralEntries, groupForSettings, renderNeuralNavigation } from './neuralShell.js';

test('hierarchy exposes real management pages and isolates selection per group', () => {
  assert.equal(groupForSettings({activeView:'customize',selectedCustomizeSection:'memory'}),'knowledge');
  assert.equal(groupForSettings({activeView:'customize',selectedCustomizeSection:'safety'}),'system');
  assert.equal(groupForSettings({activeView:'agent'}),'agents');
  const data={settings:{selectedChatId:'chat',selectedAgentId:'agent'},customize:{agents:[{id:'agent',name:'Research'}]},chats:[{id:'" onclick="bad',title:'<script>bad</script>'}]};
  assert.ok(neuralEntries(data,'agents').some(e=>e.action==='open-customize-section'&&e.attrs.includes('agents')));
  assert.ok(neuralEntries(data,'system').some(e=>e.attrs.includes('safety')));
  assert.match(renderNeuralNavigation(data,'agents'),/neural-branch is-active/);
  const html=renderNeuralNavigation(data,'chat');
  assert.ok(!html.includes('<script>'));assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('data-chat-id="&quot; onclick=&quot;bad"'));
});

test('foreground scene keeps animating past idle, reuses canvas and suspends only when appropriate', t => {
  const dom=new JSDOM('<div id="a"></div><div id="b"></div>');
  const raf=new Map();let id=0,drawCalls=0,mediaChange;
  const ctx=new Proxy({createRadialGradient:()=>({addColorStop(){}}),drawImage(){drawCalls++;}}, {get:(target,key)=>target[key]||(()=>{})});
  dom.window.HTMLCanvasElement.prototype.getContext=()=>ctx;
  const media={matches:false,addEventListener(event,cb){mediaChange=cb;},removeEventListener(){}};
  class Observer {observe(){} disconnect(){}}
  const bindings={window:dom.window,document:dom.window.document,devicePixelRatio:3,matchMedia:()=>media,ResizeObserver:Observer,IntersectionObserver:Observer,requestAnimationFrame:cb=>{raf.set(++id,cb);return id;},cancelAnimationFrame:key=>raf.delete(key)};
  const previous=new Map(Object.keys(bindings).map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  for(const [key,value] of Object.entries(bindings))Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});
  t.after(()=>{for(const [key,descriptor] of previous){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}dom.window.close();});
  Object.defineProperty(document,'hidden',{value:false,configurable:true});
  const a=document.querySelector('#a'),b=document.querySelector('#b');
  a.getBoundingClientRect=b.getBoundingClientRect=()=>({left:0,top:0,width:600,height:300});
  const scene=createNeuralScene(a),canvas=a.querySelector('canvas');
  assert.equal(canvas.width,750,'density capped independently of text');assert.equal(raf.size,1);
  scene.attach(b);assert.equal(b.querySelector('canvas'),canvas);assert.equal(raf.size,1);
  const start=performance.now();
  for(let frame=1;frame<=600;frame++){const callbacks=[...raf.values()];raf.clear();callbacks.forEach(cb=>cb(start+frame*40));}
  assert.equal(raf.size,1,'24 seconds without interaction still schedules frames');assert.ok(drawCalls>590);
  window.dispatchEvent(new dom.window.Event('blur'));assert.equal(raf.size,1,'visible unfocused window remains animated');
  Object.defineProperty(document,'hidden',{value:true,configurable:true});document.dispatchEvent(new dom.window.Event('visibilitychange'));assert.equal(raf.size,0);
  Object.defineProperty(document,'hidden',{value:false,configurable:true});document.dispatchEvent(new dom.window.Event('visibilitychange'));assert.equal(raf.size,1);
  scene.setRoutes({core:[150,150],ports:[[20,40],[20,90],[20,140],[20,190],[20,240]],focus:3,active:3,working:true,branch:'Memory',routes:[[[20,190],[250,160],true]],output:[[250,160],[350,50]]});
  assert.equal(canvas.dataset.focus,'3');assert.equal(canvas.dataset.connections,'5');assert.equal(canvas.dataset.branch,'Memory');
  scene.setStill(true);assert.equal(raf.size,0);
  scene.setRoutes({core:[150,150],ports:[[20,40],[20,90],[20,140],[20,190],[20,240]],focus:1,active:1,working:false,branch:'',routes:[],output:null});
  assert.equal(canvas.dataset.focus,'1','static mode still responds to functional selection');
  assert.equal(raf.size,0);
  const focusNetwork={core:[150,150],ports:[[20,40],[20,90],[20,140],[20,190],[20,240]],focus:1,active:1,stage:'overview',routes:[],hoverFocus:-1};
  scene.setRoutes(focusNetwork);const rest=JSON.parse(canvas.dataset.coreRegions)[1];
  scene.setRoutes({...focusNetwork,hoverFocus:1});const lifted=JSON.parse(canvas.dataset.coreRegions)[1];
  assert.ok(lifted.rx>rest.rx*1.09&&lifted.rx<rest.rx*1.12,'fallback projection shares the ten-percent depth lift');
  assert.equal(scene.pickCore(lifted.x,lifted.y),1,'picking follows the visible lobe');
  assert.equal(canvas.dataset.glyphAngles.split(',')[1],'0.000','static focus resolves the front view without running animation');
  scene.setStill(false);assert.equal(raf.size,1);
  media.matches=true;mediaChange();assert.equal(raf.size,0);media.matches=false;mediaChange();assert.equal(raf.size,1);
  scene.dispose();assert.equal(raf.size,0);assert.equal(canvas.width,0);assert.equal(b.children.length,0);
});
