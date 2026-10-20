import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { bindExecutionPicking } from '../../desktop-ui/executionPicking.js';

test('phone adapter replays local evidence, persists the view and opens sources only through the native bridge', async t => {
  const dom = new JSDOM('<div id="app"></div>', {url:'https://melo.invalid'});
  const originals = new Map(), events = [], timers = [];
  const install = (key,value) => { originals.set(key,Object.getOwnPropertyDescriptor(globalThis,key)); Object.defineProperty(globalThis,key,{configurable:true,writable:true,value}); };
  for (const key of ['window','document','Storage','localStorage','WheelEvent']) install(key, dom.window[key]);
  install('setInterval',()=>0); install('setTimeout',(fn,ms)=>{timers.push({fn,ms});return timers.length;}); install('clearTimeout',()=>{});
  install('matchMedia',()=>({matches:false}));
  dom.window.webkit = {messageHandlers:{meloScene:{postMessage:value=>events.push(value)}}};
  install('fetch',(...args)=>window.fetch(...args));
  t.after(()=>{dom.window.close();for(const [key,value] of originals) { if(value) Object.defineProperty(globalThis,key,value);else delete globalThis[key]; }});
  const moduleURL = code => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
  // WebGL itself is checked in the simulator; here only the GPU is stubbed.
  const renderer = moduleURL('export const createExecutionScene3D=()=>({update(){},setStill(){},setOpen(){},setZoom(){},dispose(){}})');
  const panelCode = (await readFile(new URL('../../desktop-ui/executionPanel.js',import.meta.url),'utf8'))
    .replace("'./i18n.js'",JSON.stringify(new URL('../../desktop-ui/i18n.js',import.meta.url).href))
    .replace("'/shared/executionScene.js'",JSON.stringify(new URL('../../src/shared/executionScene.js',import.meta.url).href))
    .replace("'./executionDetails.js'",JSON.stringify(new URL('../../desktop-ui/executionDetails.js',import.meta.url).href))
    .replace("'./executionViewport.js'",JSON.stringify(new URL('../../desktop-ui/executionViewport.js',import.meta.url).href))
    .replace("'./executionScene3D.js'",JSON.stringify(renderer));
  const bridgeCode = (await readFile(new URL('../SceneSource/mobile.js',import.meta.url),'utf8'))
    .replace("'./desktop-ui/i18n.js'",JSON.stringify(new URL('../../desktop-ui/i18n.js',import.meta.url).href))
    .replace("'./desktop-ui/executionPanel.js'",JSON.stringify(moduleURL(panelCode)))
    .replace("'./desktop-ui/executionScene3D.js'",JSON.stringify(renderer));
  await import(moduleURL(bridgeCode));
  assert.equal(events[0].type,'ready');
  window.meloReceive({chat:{id:'empty',messages:[]},scenes:[],views:{},still:false});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(document.querySelector('#execution-panel').hidden,false,'A chat with no tasks must still show the idle workspace');
  assert.equal(document.querySelectorAll('.execution-module').length,5);
  const sources=Array.from({length:14},(_,i)=>({id:`s${i}`,url:`https://example.com/${i}`,title:`Source ${i}`,titleProvided:true,order:i,rank:i,reading:'unknown',appeared:true,cited:i===0,providers:['fixture'],queries:[]}));
  const scene={version:1,runId:'r',chatId:'c',status:'running',sequence:1,query:'forecast',startedAt:'2026-10-07',operations:[{id:'o',module:'search',name:'web_search',status:'running'}],sources,artifacts:[],selectedImageIds:[]};
  const payload={chat:{id:'c',messages:[]},scenes:[scene],views:{r:{focus:'search',more:false,slot:0,zoom:1.8}},still:true};
  window.meloReceive(payload); await new Promise(resolve=>setImmediate(resolve));
  assert.equal(document.querySelectorAll('.execution-module').length,5);
  assert.equal(document.querySelectorAll('.execution-panel-viewport > .execution-panel-stage').length,1,'Use the desktop reading viewport directly, without a second mobile scroller');
  assert.equal(document.querySelectorAll('.execution-panel > .execution-zoom').length,1,'Touch controls must have their own row, outside source scrolling');
  assert.equal(document.querySelectorAll('.execution-source').length,5);
  assert.equal(document.querySelector('.execution-panel-stage').dataset.zoom,'1.800');
  document.querySelector('[data-execution-action="more"]').click();
  assert.equal(document.querySelectorAll('.execution-source').length,10);
  assert.ok(events.some(e=>e.type==='view' && e.runID==='r' && e.value.more));
  document.querySelector('.execution-source').click();
  assert.ok(events.some(e=>e.type==='openURL' && e.url==='https://example.com/0'));
  assert.equal(dom.window.location.href,'https://melo.invalid/');
  const unsafe=document.createElement('a');unsafe.href='https://secret:token@example.com';document.body.append(unsafe);
  const before=events.filter(e=>e.type==='openURL').length;unsafe.click();
  assert.equal(events.filter(e=>e.type==='openURL').length,before);
  assert.equal((await window.fetch('/api/chat/scenes?chatId=c')).status,200);
  assert.equal((await window.fetch('https://api.openai.com/v1/responses')).status,403);
  window.meloReceive({...payload,scenes:[{...scene,status:'completed',sequence:2}]});
  assert.equal(document.querySelectorAll('.execution-panel-viewport').length,1,'Native updates must not nest scroll viewports');
  assert.equal(document.querySelectorAll('.execution-scroll').length,0);
  assert.ok(!timers.some(timer=>timer.ms===2600),'Full-screen results must not disappear on completion');
  assert.ok(!document.querySelector('#execution-panel').classList.contains('is-collapsed'));
  const receipt = {version:1,outcome:'partial',goalState:'unverified',summary:'部分完成 · 尚无目标完成证据'};
  window.meloReceive({...payload,scenes:[{...scene,status:'completed',sequence:3,completion:receipt}]});
  assert.equal(document.querySelector('.execution-status').textContent,receipt.summary,'Transport completion must not erase the task evidence gap');
  assert.ok(document.querySelector('[data-session-event-id="r/tool/o/result"]'), 'The native scene and desktop inspector share canonical tool IDs');
  assert.ok(document.querySelector('[data-session-event-id="r/terminal/turn/finished"]'));
  document.querySelector('[data-execution-action="overview"]').click();
  assert.equal(document.querySelector('.execution-panel-stage').dataset.zoom,'1.000');
  // Phone two-finger gestures share the desktop picker, but the second finger
  // must cancel a pending tap even when the pinch never moves.
  const stage=document.querySelector('.execution-panel-stage'), canvas=document.createElement('canvas'), selected=[];
  stage.querySelector('.execution-webgl').append(canvas);
  canvas.getBoundingClientRect=()=>({left:0,top:0,width:375,height:500});
  const releasePicking=bindExecutionPicking(canvas,{pick:()=> 'search',enabled:()=>true,onSelect:id=>selected.push(id)});
  const pointer=type=>canvas.dispatchEvent(new dom.window.MouseEvent(type,{clientX:100,clientY:100,button:0,bubbles:true}));
  const touch=(type,touches)=>{const event=new dom.window.Event(type,{bubbles:true,cancelable:true});Object.defineProperty(event,'touches',{value:touches});canvas.dispatchEvent(event);return event;};
  pointer('pointerdown');pointer('pointerup');assert.deepEqual(selected,['search']);
  pointer('pointerdown');
  touch('touchstart',[{clientX:50,clientY:100},{clientX:150,clientY:100}]);
  pointer('pointerup');assert.deepEqual(selected,['search'],'Pinch start must cancel the primary cluster tap');
  assert.equal(touch('touchmove',[{clientX:25,clientY:100},{clientX:175,clientY:100}]).defaultPrevented,true);
  assert.equal(stage.dataset.zoom,'1.500');
  touch('touchcancel',[]);
  touch('touchmove',[{clientX:0,clientY:100},{clientX:200,clientY:100}]);
  assert.equal(stage.dataset.zoom,'1.500','Cancelled gestures must release pinch state');
  releasePicking();canvas.remove();
  // Phone selection follows the shared relevance ranking; citation only marks
  // a source and preserves its actual answer URL when it is in the top five.
  const citationSources=sources.map((s,i)=>({...s,title:i===11?'forecast report':s.title,cited:i>=11,citationLabel:i>=11?'回答引用页':undefined,citationUrl:i>=11?`${s.url}?utm_source=answer`:undefined}));
  const citationScene={...scene,chatId:'citation-chat',runId:'citation-run',sequence:3,status:'completed',sources:citationSources};
  window.meloReceive({...payload,chat:{id:'citation-chat',messages:[]},runId:'citation-run',scenes:[citationScene],views:{'citation-run':{focus:'search',more:false,slot:0,zoom:1.8}}});
  await new Promise(resolve=>setImmediate(resolve));
  const cards=[...document.querySelectorAll('.execution-source')];
  assert.equal(cards.length,5);
  for(const index of [11]) {
    const card=cards.find(a=>a.href===`https://example.com/${index}?utm_source=answer`);
    assert.ok(card,`Relevant cited source ${index} should be visible`);
    assert.match(card.textContent,/已引用/);
    assert.doesNotMatch(card.textContent,/已读取/);
  }
  assert.ok(!cards.some(a=>a.href.includes('/12?') || a.href.includes('/13?')), 'low ranking citations must not displace stronger sources');
  cards.find(a=>a.href.includes('/11?')).click();
  assert.ok(events.some(e=>e.type==='openURL' && e.url==='https://example.com/11?utm_source=answer'));
  document.querySelector('[data-execution-action="more"]').click();
  assert.equal(document.querySelectorAll('.execution-source').length,10);
  // Actual native public-summary records flow into the unchanged desktop inspector.
  const summaryScene={...scene,chatId:'analysis-chat',runId:'analysis-run',sequence:1,sources:[],operations:[],pipeline:[{id:'model:summary:rs',module:'compute',channel:'reasoning-summary',name:'模型公开推理摘要',status:'running',output:'正在核对条件'}]};
  const summaryPayload={chat:{id:'analysis-chat',messages:[]},scenes:[summaryScene],runId:summaryScene.runId,views:{'analysis-run':{focus:'compute',more:false,slot:0,zoom:1.8}},still:true};
  window.meloReceive(summaryPayload);
  await new Promise(resolve=>setImmediate(resolve));
  document.querySelector('[data-module="compute"]').click();
  document.querySelector('[data-operation="model:summary:rs"]').click();
  assert.match(document.querySelector('.execution-inspector').textContent,/正在核对条件/);
  assert.match(document.querySelector('.execution-panel-footer').textContent,/0 次工具调用/);
  window.meloReceive({...summaryPayload,scenes:[{...summaryScene,sequence:2,pipeline:[{...summaryScene.pipeline[0],status:'completed',output:'已核对 <script>内容作为文字显示'}]}]});
  assert.match(document.querySelector('.execution-inspector').textContent,/已核对 <script>/);
  assert.equal(document.querySelector('.execution-inspector script'),null);
  // The desktop history contract must work against local phone records too.
  const history = Array.from({length:45},(_,i)=>({...scene,chatId:'history',runId:`old-${String(i).padStart(2,'0')}`,query:`Task ${i}`,status:'completed',startedAt:'2026-10-08T00:00:00Z'}));
  history.push({...scene,chatId:'history',runId:'active',startedAt:'2026-10-01T00:00:00Z'});
  window.meloReceive({chat:{id:'history',messages:[]},scenes:history,views:{},still:true,runId:'old-44'});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(document.querySelectorAll('[data-execution-history] option').length,21,'First page plus the older active task stays visible');
  window.meloReceive({chat:{id:'history',messages:[]},scenes:history.map(s=>s.runId==='active' ? {...s,status:'completed',sequence:2} : s),views:{},still:true,runId:'old-44'});
  const historyPicker=document.querySelector('[data-execution-history]');
  historyPicker.value='active'; historyPicker.dispatchEvent(new dom.window.Event('change',{bubbles:true}));
  assert.match(document.querySelector('.execution-status').textContent,/已完成/,'An older live task must still receive its final state outside page one');
  let page = await (await window.fetch('/api/chat/scenes?chatId=history')).json();
  assert.equal(page.scenes.length,20); assert.ok(page.nextCursor);
  document.querySelector('[data-execution-action="older-scenes"]').click();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(document.querySelectorAll('[data-execution-history] option').length,41);
  document.querySelector('[data-execution-action="older-scenes"]').click();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(document.querySelectorAll('[data-execution-history] option').length,46);
  assert.equal(document.querySelector('[data-execution-action="older-scenes"]'),null);
  page = await (await window.fetch('/api/chat/scenes?chatId=history&runId=old-00')).json();
  assert.deepEqual(page.scenes.map(s=>s.runId),['old-00']);
  assert.equal((await window.fetch('/api/chat/scenes?chatId=unrelated')).status,404);
  assert.equal((await window.fetch('/api/chat/scenes?chatId=history&before=broken')).status,400);
  assert.equal((await window.fetch('/api/chat/scenes?chatId=history',{method:'POST'})).status,405);
  document.querySelector('[data-action="toggle-tts-autoplay"]').click();
  assert.ok(events.some(e=>e.type==='speechSettings'));
});
