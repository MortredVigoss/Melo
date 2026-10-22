// The "桌面宠物" row (desktop app only): the select carries the saved preference,
// the note shows the pet's real state, saving goes through setLocalSettings like
// launchAtLogin, and the native shell's melo-local-settings-changed event (the
// pet quit from its own menu) refreshes both without a reload.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
const source=(await readFile(new URL('./localSettings.js',import.meta.url),'utf8')).replace("'./i18n.js'",JSON.stringify(new URL('./i18n.js',import.meta.url).href)).replace("'./agentAvatar.js'",JSON.stringify(new URL('./agentAvatar.js',import.meta.url).href)).replace("'./settingsEdit.js'",JSON.stringify(new URL('./settingsEdit.js',import.meta.url).href)).replace("'/shared/localPreferences.js'",JSON.stringify(new URL('../src/services/settings/localPreferences.js',import.meta.url).href));
const load=tag=>import('data:text/javascript;base64,'+Buffer.from(source).toString('base64')+'#'+tag);

async function mount(tag,native) {
 const local=await load(tag);
 const dom=new JSDOM('<main></main>',{url:'http://localhost'});globalThis.window=dom.window;globalThis.document=dom.window.document;globalThis.localStorage=dom.window.localStorage;
 const writes=[];
 window.webkit={messageHandlers:{meloVoice:{postMessage({action,requestID,key,value}){
  if(action==='setLocalSettings'){writes.push([key,value]);native={...native,[key]:value,desktopPetRunning:key==='desktopPet'?value:native.desktopPetRunning};}
  queueMicrotask(()=>window.dispatchEvent(new window.CustomEvent('melo-local-settings',{detail:{requestID,...native}})));
 }}}};
 const data={profile:{name:'fixture'},settings:{localPreferences:{}},chats:[],customize:{agents:[]}},uiState={bootstrap:data};
 const render=()=>document.querySelector('main').innerHTML=local.renderLocalSettings(data);
 local.installLocalSettings({uiState,render,api:async()=>data,applyBootstrap(){},stopSpeech(){}});
 const click=s=>document.querySelector(s).click(),change=(s,v)=>{const el=document.querySelector(s);el.value=v;el.dispatchEvent(new window.Event('change',{bubbles:true}));},tick=()=>new Promise(r=>setTimeout(r,0));
 const row=()=>document.querySelector('[data-local-native=desktopPet]').closest('.local-setting-row');
 render();await tick();click('[data-tab=general]');
 return {writes,click,change,tick,row,setNative:value=>{native=value;},close(){dom.window.close();delete globalThis.window;delete globalThis.document;delete globalThis.localStorage;}};
}
const base={launchAtLogin:false,loginNeedsApproval:false,closeBehavior:'quit',notifications:false,desktopPet:false,desktopPetAvailable:true,desktopPetRunning:false};

test('the row shows the saved preference and the real state, and saves through the native bridge',async()=>{
 const m=await mount('save',{...base});
 try {
  assert.match(m.row().textContent,/桌面宠物/);assert.match(m.row().textContent,/未运行/);
  assert.equal(document.querySelector('[data-local-native=desktopPet]').value,'false');
  assert.equal(document.querySelector('[data-local-native=desktopPet]').matches(':disabled'),true,'read-only until 编辑');
  m.click('[data-action=settings-edit]');m.change('[data-local-native=desktopPet]','true');await m.tick();
  assert.deepEqual(m.writes,[],'nothing is written before 保存');
  m.click('[data-action=settings-save]');await m.tick();
  assert.deepEqual(m.writes,[['desktopPet',true]]);
  assert.ok(document.querySelector('[data-edit-status=saved]'));
  assert.equal(document.querySelector('[data-local-native=desktopPet]').value,'true');
  assert.match(m.row().textContent,/运行中/);
  m.click('[data-action=settings-edit]');m.change('[data-local-native=desktopPet]','false');m.click('[data-action=settings-save]');await m.tick();
  assert.deepEqual(m.writes.at(-1),['desktopPet',false]);assert.match(m.row().textContent,/未运行/);
 } finally { m.close(); }
});

test('a pet that quit on its own flips the switch off through melo-local-settings-changed, even mid-edit',async()=>{
 const m=await mount('changed',{...base,desktopPet:true,desktopPetRunning:true});
 try {
  assert.equal(document.querySelector('[data-local-native=desktopPet]').value,'true');assert.match(m.row().textContent,/运行中/);
  m.click('[data-action=settings-edit]');m.change('[data-local-pref=textSize]','large');
  m.setNative({...base,desktopPet:false,desktopPetRunning:false});
  window.dispatchEvent(new window.Event('melo-local-settings-changed'));await m.tick();await m.tick();
  assert.equal(document.querySelector('[data-local-native=desktopPet]').value,'false');assert.match(m.row().textContent,/未运行/);
  assert.equal(document.querySelector('[data-local-pref=textSize]').value,'large','the unsaved draft survives the refresh');
  m.click('[data-action=settings-cancel]');
 } finally { m.close(); }
});

test('a build without the pet disables the row and says so; the web page names the pet among desktop-only settings',async()=>{
 const m=await mount('unavailable',{...base,desktopPetAvailable:false});
 try {
  assert.equal(document.querySelector('[data-local-native=desktopPet]').matches(':disabled'),true);
  m.click('[data-action=settings-edit]');assert.equal(document.querySelector('[data-local-native=desktopPet]').matches(':disabled'),true);
  assert.match(m.row().textContent,/当前安装未包含桌面宠物/);
 } finally { m.close(); }
 const local=await load('web');
 const dom=new JSDOM('<main></main>',{url:'http://localhost'});globalThis.window=dom.window;globalThis.document=dom.window.document;globalThis.localStorage=dom.window.localStorage;
 try {
  const data={profile:{name:'fixture'},settings:{localPreferences:{}},chats:[],customize:{agents:[]}};
  local.installLocalSettings({uiState:{bootstrap:data},render(){},api:async()=>data,applyBootstrap(){},stopSpeech(){}});
  document.querySelector('main').innerHTML=local.renderLocalSettings(data);document.querySelector('[data-tab=general]').click();document.querySelector('main').innerHTML=local.renderLocalSettings(data);
  assert.equal(document.querySelector('[data-local-native=desktopPet]'),null);
  assert.match(document.querySelector('main').textContent,/桌面宠物可在桌面应用中设置/);
 } finally { dom.window.close();delete globalThis.window;delete globalThis.document;delete globalThis.localStorage; }
});
