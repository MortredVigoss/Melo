import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

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
  // WebGL itself is checked in the simulator and the browser suite; here the
  // 3D scene is a stub that records what the war room asks of it.
  const sceneCalls = [];
  globalThis.__warSceneCalls = sceneCalls;
  const renderer = moduleURL(`export const createWarRoomScene=(host)=>{const calls=globalThis.__warSceneCalls;host.dataset.frames='1';return {update(){},setStill(){},setOpen(v){calls.push(['open',v]);},setView(mode){calls.push(['view',mode]);},focusRegion(id){calls.push(['region',id]);},zoomBy(f){calls.push(['zoom',f]);},rotateBy(){},get view(){return {mode:'global',zoom:1,region:null};},clawPoint(){return null;},corePoint(){return {x:0,y:0,visible:true};},dispose(){}};};`);
  t.after(() => { delete globalThis.__warSceneCalls; });
  const file = path => JSON.stringify(new URL(path, import.meta.url).href);
  const warRoomCode = (await readFile(new URL('../../desktop-ui/warRoom.js',import.meta.url),'utf8'))
    .replace("'./i18n.js'",file('../../desktop-ui/i18n.js'))
    .replace("'/shared/executionScene.js'",file('../../src/shared/executionScene.js'))
    .replace("'/shared/executionBoard.js'",file('../../src/shared/executionBoard.js'))
    .replace("'/shared/warRoom.js'",file('../../src/shared/warRoom.js'))
    .replace("'./warRoomScene3D.js'",JSON.stringify(renderer));
  const panelCode = (await readFile(new URL('../../desktop-ui/executionPanel.js',import.meta.url),'utf8'))
    .replace("'./buttonStyles.js'",file('../../desktop-ui/buttonStyles.js'))
    .replace("'./html.js'",file('../../desktop-ui/html.js'))
    .replaceAll("'./i18n.js'",file('../../desktop-ui/i18n.js'))
    .replace("'/shared/executionScene.js'",file('../../src/shared/executionScene.js'))
    .replace("'./executionDetails.js'",file('../../desktop-ui/executionDetails.js'))
    .replace("'/shared/executionBoard.js'",file('../../src/shared/executionBoard.js'))
    .replace("'/shared/warRoom.js'",file('../../src/shared/warRoom.js'))
    .replace("'./warRoom.js'",JSON.stringify(moduleURL(warRoomCode)));
  const bridgeCode = (await readFile(new URL('../SceneSource/mobile.js',import.meta.url),'utf8'))
    .replace("'./desktop-ui/i18n.js'",file('../../desktop-ui/i18n.js'))
    .replace("'./desktop-ui/executionPanel.js'",JSON.stringify(moduleURL(panelCode)))
    .replace("'./desktop-ui/warRoomScene3D.js'",JSON.stringify(renderer));
  await import(moduleURL(bridgeCode));
  assert.equal(events[0].type,'ready');
  assert.equal(document.documentElement.dataset.sceneHost,'phone');
  window.meloReceive({interfaceLanguage:'zh-CN',chat:{id:'empty',messages:[]},scenes:[],views:{},still:false});
  await new Promise(resolve=>setImmediate(resolve));
  const room=document.querySelector('#execution-war-room');
  assert.equal(room.hidden,false,'A chat with no tasks must still show the idle workspace');
  assert.equal(room.querySelectorAll('.war-regions li').length,5);
  const sources=Array.from({length:14},(_,i)=>({id:`s${i}`,url:`https://example.com/${i}`,title:`Source ${i}`,titleProvided:true,order:i,rank:i,reading:'unknown',appeared:true,cited:i===0,providers:['fixture'],queries:[]}));
  const scene={version:1,runId:'r',chatId:'c',status:'running',sequence:1,query:'forecast',startedAt:'2026-10-07',operations:[{id:'o',module:'search',name:'web_search',status:'running'}],sources,artifacts:[],selectedImageIds:[]};
  const payload={interfaceLanguage:'zh-CN',chat:{id:'c',messages:[]},scenes:[scene],views:{r:{focus:'search',more:false,slot:0,zoom:1.8}},still:true};
  window.meloReceive(payload); await new Promise(resolve=>setImmediate(resolve));
  assert.equal(document.querySelectorAll('#execution-war-room').length,1,'One war room; native updates never add a second screen');
  assert.equal(room.hidden,false);
  assert.equal(room.querySelector('[data-cell="detail"] .war-count').textContent,'1 条记录','The remembered region reopens with its own calls');
  assert.equal(room.querySelectorAll('.execution-source').length,5);
  room.querySelector('[data-execution-action="more"]').click();
  assert.equal(room.querySelectorAll('.execution-source').length,10);
  assert.ok(events.some(e=>e.type==='view' && e.runID==='r' && e.value.more && e.value.focus==='search'));
  room.querySelector('.execution-source').click();
  assert.ok(events.some(e=>e.type==='openURL' && e.url==='https://example.com/0'));
  assert.equal(dom.window.location.href,'https://melo.invalid/');
  const unsafe=document.createElement('a');unsafe.href='https://secret:token@example.com';document.body.append(unsafe);
  const before=events.filter(e=>e.type==='openURL').length;unsafe.click();
  assert.equal(events.filter(e=>e.type==='openURL').length,before);
  assert.equal((await window.fetch('/api/chat/scenes?chatId=c')).status,200);
  assert.equal((await window.fetch('https://api.openai.com/v1/responses')).status,403);
  window.meloReceive({...payload,scenes:[{...scene,status:'completed',sequence:2}]});
  assert.equal(document.querySelectorAll('#execution-war-room').length,1,'Native updates must not nest screens');
  assert.ok(!timers.some(timer=>timer.ms===2600),'Full-screen results must not disappear on completion');
  assert.equal(room.hidden,false);
  const receipt = {version:1,outcome:'partial',goalState:'unverified',summary:'部分完成 · 尚无目标完成证据'};
  window.meloReceive({...payload,scenes:[{...scene,status:'completed',sequence:3,completion:receipt}]});
  assert.equal(document.querySelector('.execution-status').textContent,receipt.summary,'Transport completion must not erase the task evidence gap');
  assert.match(room.querySelector('.war-now').textContent,/部分完成 · 尚无目标完成证据/);
  room.querySelector('.war-status [data-war-trace="calls"]').click();
  assert.equal(room.querySelector('[data-cell="detail"] .war-count').textContent,'1 条记录','The status number opens exactly the calls it counts');
  assert.ok(room.querySelector('[data-session-event-id="r/tool/o/result"]'), 'The native scene and desktop inspector share canonical tool IDs');
  assert.ok(room.querySelector('[data-session-event-id="r/terminal/turn/finished"]'));
  // Rotation and pinch are the canvas's own pointer gestures (the browser
  // suite drives them); here the controls must reach the scene, and the
  // canvas must keep every touch for itself.
  room.querySelector('[data-war-zoom="in"]').click();
  room.querySelector('[data-war-view="follow"]').click();
  assert.ok(sceneCalls.some(([kind,value])=>kind==='zoom' && value>1));
  assert.ok(sceneCalls.some(([kind,value])=>kind==='view' && value==='follow'));
  assert.match(await readFile(new URL('../../desktop-ui/warRoom.css',import.meta.url),'utf8'),/\.war-gl canvas \{[^}]*touch-action: none/);
  // 回到对话 is the app's: the bridge asks it to close the screen, and the war room stays ready.
  room.querySelector('[data-war-close]').click();
  assert.ok(events.some(e=>e.type==='close')); assert.equal(room.hidden,false);
  room.dispatchEvent(new dom.window.Event('pointerdown',{bubbles:true}));
  room.dispatchEvent(new dom.window.Event('pointerdown',{bubbles:true}));
  assert.equal(events.filter(e=>e.type==='interacted').length,1,'The app hears about the first touch once');
  // Phone selection follows the shared relevance ranking; citation only marks
  // a source and preserves its actual answer URL when it is in the top five.
  const citationSources=sources.map((s,i)=>({...s,title:i===11?'forecast report':s.title,cited:i>=11,citationLabel:i>=11?'回答引用页':undefined,citationUrl:i>=11?`${s.url}?utm_source=answer`:undefined}));
  const citationScene={...scene,chatId:'citation-chat',runId:'citation-run',sequence:3,status:'completed',sources:citationSources};
  window.meloReceive({...payload,chat:{id:'citation-chat',messages:[]},runId:'citation-run',scenes:[citationScene],views:{'citation-run':{focus:'search',more:false,slot:0,zoom:1.8}}});
  await new Promise(resolve=>setImmediate(resolve));
  const cards=[...room.querySelectorAll('.execution-source')];
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
  room.querySelector('[data-execution-action="more"]').click();
  assert.equal(room.querySelectorAll('.execution-source').length,10);
  // Actual native public-summary records flow into the unchanged desktop inspector.
  const summaryScene={...scene,chatId:'analysis-chat',runId:'analysis-run',sequence:1,sources:[],operations:[],pipeline:[{id:'model:summary:rs',module:'compute',channel:'reasoning-summary',name:'模型公开推理摘要',status:'running',output:'正在核对条件'}]};
  const summaryPayload={interfaceLanguage:'zh-CN',chat:{id:'analysis-chat',messages:[]},scenes:[summaryScene],runId:summaryScene.runId,views:{'analysis-run':{focus:'compute',more:false,slot:0,zoom:1.8}},still:true};
  window.meloReceive(summaryPayload);
  await new Promise(resolve=>setImmediate(resolve));
  room.querySelector('[data-operation="model:summary:rs"]').click();
  const detail=()=>room.querySelector('[data-cell="detail"]');
  assert.match(detail().textContent,/正在核对条件/);
  assert.match(room.querySelector('.war-status').textContent,/工具调用 0/);
  window.meloReceive({...summaryPayload,scenes:[{...summaryScene,sequence:2,pipeline:[{...summaryScene.pipeline[0],status:'completed',output:'已核对 <script>内容作为文字显示'}]}]});
  assert.match(detail().textContent,/已核对 <script>/);
  assert.equal(detail().querySelector('script'),null);
  // The desktop history contract must work against local phone records too.
  const history = Array.from({length:45},(_,i)=>({...scene,chatId:'history',runId:`old-${String(i).padStart(2,'0')}`,query:`Task ${i}`,status:'completed',startedAt:'2026-10-08T00:00:00Z'}));
  history.push({...scene,chatId:'history',runId:'active',startedAt:'2026-10-01T00:00:00Z'});
  window.meloReceive({interfaceLanguage:'zh-CN',chat:{id:'history',messages:[]},scenes:history,views:{},still:true,runId:'old-44'});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(room.querySelectorAll('[data-execution-history] option').length,21,'First page plus the older active task stays visible');
  window.meloReceive({interfaceLanguage:'zh-CN',chat:{id:'history',messages:[]},scenes:history.map(s=>s.runId==='active' ? {...s,status:'completed',sequence:2} : s),views:{},still:true,runId:'old-44'});
  const historyPicker=room.querySelector('[data-execution-history]');
  historyPicker.value='active'; historyPicker.dispatchEvent(new dom.window.Event('change',{bubbles:true}));
  assert.match(document.querySelector('.execution-status').textContent,/已完成/,'An older live task must still receive its final state outside page one');
  let page = await (await window.fetch('/api/chat/scenes?chatId=history')).json();
  assert.equal(page.scenes.length,20); assert.ok(page.nextCursor);
  room.querySelector('[data-execution-action="older-scenes"]').click();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(room.querySelectorAll('[data-execution-history] option').length,41);
  room.querySelector('[data-execution-action="older-scenes"]').click();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(room.querySelectorAll('[data-execution-history] option').length,46);
  assert.equal(room.querySelector('[data-execution-action="older-scenes"]'),null);
  page = await (await window.fetch('/api/chat/scenes?chatId=history&runId=old-00')).json();
  assert.deepEqual(page.scenes.map(s=>s.runId),['old-00']);
  assert.equal((await window.fetch('/api/chat/scenes?chatId=unrelated')).status,404);
  assert.equal((await window.fetch('/api/chat/scenes?chatId=history&before=broken')).status,400);
  assert.equal((await window.fetch('/api/chat/scenes?chatId=history',{method:'POST'})).status,405);
  room.querySelector('[data-action="toggle-tts-autoplay"]').click();
  assert.ok(events.some(e=>e.type==='speechSettings'),'Reading settings stay reachable on the phone screen');
});
