// This fixture asserts Chinese copy explicitly; production defaults follow the device.
import { setLanguage as setFixtureLanguage } from './i18n.js';
setFixtureLanguage('zh-CN');
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
const source=(await readFile(new URL('./localSettings.js',import.meta.url),'utf8')).replace("'./i18n.js'",JSON.stringify(new URL('./i18n.js',import.meta.url).href)).replace("'./agentAvatar.js'",JSON.stringify(new URL('./agentAvatar.js',import.meta.url).href)).replace("'./settingsEdit.js'",JSON.stringify(new URL('./settingsEdit.js',import.meta.url).href)).replace("'/shared/localPreferences.js'",JSON.stringify(new URL('../src/services/settings/localPreferences.js',import.meta.url).href));
const module=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
test('send shortcut respects IME, line breaks, and selected modifier',()=>{
 const enter={key:'Enter'};
 assert.equal(module.shouldSendOnEnter(enter,{sendShortcut:'enter'}),true);
 assert.equal(module.shouldSendOnEnter(enter,{sendShortcut:'command-enter'}),false);
 assert.equal(module.shouldSendOnEnter({...enter,metaKey:true},{sendShortcut:'command-enter'}),true);
 for(const extra of [{shiftKey:true},{isComposing:true},{altKey:true}])assert.equal(module.shouldSendOnEnter({...enter,...extra},{sendShortcut:'enter'}),false);
});
test('profile save and preference changes use real delegated controls; failures retain draft',async()=>{
 const dom=new JSDOM('<main></main>',{url:'http://localhost'});globalThis.window=dom.window;globalThis.document=dom.window.document;globalThis.localStorage=dom.window.localStorage;
 const data={profile:{name:'Old',avatarData:''},settings:{localPreferences:{}},chats:[],customize:{agents:[]}},uiState={bootstrap:data};
 const calls=[];let fail=true;
 const render=()=>{document.querySelector('main').innerHTML=module.renderLocalSettings(data);};
 module.installLocalSettings({uiState,render,api:async(path,options)=>{calls.push([path,options.body]);if(fail)throw new Error('disk unavailable');data.profile={...data.profile,...options.body};return data;},applyBootstrap:()=>{},patchSettings:()=>{},stopSpeech:()=>{}});
 render();assert.equal(document.querySelector('[name=localName]').matches(':disabled'),true);document.querySelector('[data-action=settings-edit]').click();const input=document.querySelector('[name=localName]');input.value='新的昵称';input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));
 document.querySelector('form').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));await new Promise(r=>setTimeout(r,0));
 assert.match([...document.querySelectorAll('[role=alert]')].map(n=>n.textContent).join(' '),/disk unavailable/);assert.equal(document.querySelector('[name=localName]').value,'新的昵称');assert.equal(data.profile.name,'Old');
 fail=false;document.querySelector('form').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));await new Promise(r=>setTimeout(r,0));assert.equal(data.profile.name,'新的昵称');assert.equal(calls[0][0],'/api/settings/local');
 assert.equal(document.querySelector('[name=localName]').matches(':disabled'),true);assert.ok(document.querySelector('[data-edit-status=saved]'));
 document.querySelector('[data-tab=general]').click();assert.equal(document.querySelector('[data-local-pref=sendShortcut]').matches(':disabled'),true);document.querySelector('[data-action=settings-edit]').click();const callsBefore=calls.length;document.querySelector('[data-local-pref=sendShortcut]').value='command-enter';document.querySelector('[data-local-pref=sendShortcut]').dispatchEvent(new dom.window.Event('change',{bubbles:true}));await new Promise(r=>setTimeout(r,0));assert.equal(calls.length,callsBefore);document.querySelector('[data-action=settings-save]').click();await new Promise(r=>setTimeout(r,0));assert.deepEqual(calls.at(-1)[1],{preferences:{sendShortcut:'command-enter'}});
 dom.window.close();delete globalThis.window;delete globalThis.document;delete globalThis.localStorage;
});

test('partial native save identifies committed fields, retries only pending changes and keeps navigation unlocked',async()=>{
 const local=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64')+'#partial');
 const dom=new JSDOM('<main></main>',{url:'http://localhost'});globalThis.window=dom.window;globalThis.document=dom.window.document;globalThis.localStorage=dom.window.localStorage;
 let fail=true,preferenceWrites=0,nativeWrites=0;
 let native={launchAtLogin:false,loginNeedsApproval:true,closeBehavior:'quit',notifications:false};
 window.webkit={messageHandlers:{meloVoice:{postMessage({action,requestID,key,value}){
  let result=native;
  if(action==='setLocalSettings'){nativeWrites++;if(fail)result={error:'system write failed'};else result=native={...native,[key]:value};}
  queueMicrotask(()=>window.dispatchEvent(new window.CustomEvent('melo-local-settings',{detail:{requestID,...result}})));
 }}}};
 const data={profile:{name:'fixture'},settings:{localPreferences:{textSize:'standard'}},chats:[],customize:{agents:[]}},uiState={bootstrap:data};
 const render=()=>document.querySelector('main').innerHTML=local.renderLocalSettings(data);
 local.installLocalSettings({uiState,render,api:async(_path,{body})=>{preferenceWrites++;Object.assign(data.settings.localPreferences,body.preferences);return data;},applyBootstrap(){},stopSpeech(){}});
 const click=s=>document.querySelector(s).click(),change=(s,v)=>{const el=document.querySelector(s);el.value=v;el.dispatchEvent(new window.Event('change',{bubbles:true}));},tick=()=>new Promise(r=>setTimeout(r,0));
 try {
  render();await tick();click('[data-tab=general]');assert.equal(document.querySelector('[data-action=settings-login-items]').matches(':disabled'),false);
  click('[data-action=settings-edit]');change('[data-local-pref=textSize]','large');change('[data-local-native=closeBehavior]','background');click('[data-action=settings-save]');await tick();
  assert.equal(data.settings.localPreferences.textSize,'large');assert.match(document.querySelector('.local-error').textContent,/已保存：界面与操作偏好.*尚未完成：关闭窗口行为/);assert.match(document.querySelector('[data-action=settings-cancel]').textContent,/放弃未保存部分/);
  fail=false;click('[data-action=settings-save]');await tick();assert.equal(preferenceWrites,1);assert.equal(nativeWrites,2);assert.equal(native.closeBehavior,'background');assert.ok(document.querySelector('[data-edit-status=saved]'));
  fail=true;click('[data-action=settings-edit]');change('[data-local-pref=textSize]','larger');change('[data-local-native=closeBehavior]','quit');click('[data-action=settings-save]');await tick();click('[data-action=settings-cancel]');assert.match(document.querySelector('.local-notice').textContent,/已保存的界面与操作偏好仍然生效/);assert.equal(document.querySelector('[data-local-pref=textSize]').value,'larger');
  click('[data-tab=voice]');for(const selector of ['[data-action=settings-voice-options]','[data-action=settings-microphone]','[data-view=model]'])assert.equal(document.querySelector(selector).matches(':disabled'),false);assert.equal(document.querySelector('[data-local-pref=voiceLanguage]').matches(':disabled'),true);
 }finally{dom.window.close();delete globalThis.window;delete globalThis.document;delete globalThis.localStorage;}
});
