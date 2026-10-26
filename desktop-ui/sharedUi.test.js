import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { formatTime, formatNumber } from './format.js';
import { escapeHtml } from './html.js';
import { setLanguage } from './i18n.js';
import { requestText, notify } from './feedback.js';
test('formatting respects language and timezone and never invents invalid dates',()=>{
  const date='2026-10-24T01:00:00Z';
  assert.match(formatTime(date,{style:'full',locale:'en',timeZone:'UTC'}),/01:00:00/);
  assert.match(formatTime(date,{style:'full',locale:'en',timeZone:'Australia/Melbourne'}),/12:00:00/);
  assert.equal(formatTime('invalid'),'');
  assert.notEqual(formatNumber(12345,'es'),formatNumber(12345,'en'));
  assert.equal(escapeHtml('<img src=x onerror="x">&\''),'&lt;img src=x onerror=&quot;x&quot;&gt;&amp;&#39;');
});
test('application input validates without closing, cancels safely, and restores focus',async t=>{
  const dom=new JSDOM('<button id="origin">start</button>');
  const old=globalThis.document;globalThis.document=dom.window.document;
  dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  t.after(()=>{globalThis.document=old;dom.window.close();});
  setLanguage('en');
  const origin=document.querySelector('#origin');origin.focus();
  const response=requestText({title:'Link',value:'https://',validate:v=>v==='https://valid.test'?'':'Invalid'});
  const form=document.querySelector('form'),input=document.querySelector('input');
  form.dispatchEvent(new dom.window.Event('submit',{cancelable:true}));
  assert.ok(document.querySelector('dialog'));assert.equal(input.getAttribute('aria-invalid'),'true');
  input.value='https://valid.test';form.dispatchEvent(new dom.window.Event('submit',{cancelable:true}));
  assert.equal(await response,'https://valid.test');assert.equal(document.activeElement,origin);
  const cancelled=requestText({title:'Link',value:'saved draft'});
  document.querySelector('dialog').dispatchEvent(new dom.window.Event('cancel',{cancelable:true}));
  assert.equal(await cancelled,null);assert.equal(document.activeElement,origin);
  notify({level:'error',text:'<b>failure</b>',toast:true});
  assert.equal(document.querySelector('#flash-toast').getAttribute('role'),'alert');
  assert.equal(document.querySelector('#flash-toast b'),null);
  document.querySelector('#flash-toast button').click();assert.equal(document.querySelector('#flash-toast'),null);
});

test('saved completion copy follows interface language while model explanations remain opaque', async()=>{
 const { runtimeCompletionText }=await import('./i18n.js');
 const { setLanguage }=await import('./i18n.js');
 try {
  setLanguage('en');assert.equal(runtimeCompletionText({summary:'受阻 · 尚无目标完成证据'}),'Blocked · Goal completion is unverified');
  assert.equal(runtimeCompletionText({summary:'受阻 · 已完成',task:{explanation:'已完成'}}),'Blocked · 已完成');
  assert.equal(runtimeCompletionText({summary:'Legacy diagnostic not in catalog'}),'Legacy diagnostic not in catalog');
  setLanguage('ja');assert.equal(runtimeCompletionText({summary:'回答已交付'}),'回答を提供しました');
 } finally {setLanguage('zh-CN');}
});
