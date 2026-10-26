import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { notify, renderNotifications } from './feedback.js';

test('errors survive render, stay on their page, and never interpret supplied markup', t => {
  const dom = new JSDOM('<main id="app"><section class="content-shell"></section></main>');
  const previous = globalThis.document; globalThis.document = dom.window.document;
  t.after(() => { globalThis.document = previous; dom.window.close(); });
  const root = document.querySelector('#app');
  renderNotifications(root, {scope:'projects'});
  notify({level:'error',text:'<img src=x onerror=attack()> save failed'});
  assert.equal(root.querySelector('[role=alert] img'),null);
  assert.match(root.textContent,/save failed/);
  assert.equal(document.querySelector('#flash-toast'),null);
  root.innerHTML='<section class="content-shell"></section>';
  renderNotifications(root, {scope:'projects'});
  assert.match(root.textContent,/save failed/);
  renderNotifications(root, {scope:'chat'});
  assert.equal(root.querySelector('[role=alert]'),null);
  renderNotifications(root, {scope:'projects'});
  root.querySelector('[data-page-notice] button').click();
  renderNotifications(root, {scope:'projects'});
  assert.equal(root.querySelector('[role=alert]'),null);
});

test('success clears its page error and a newer toast gets its own full lifetime', t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const dom = new JSDOM('<main id="app"></main>');
  const previous = globalThis.document; globalThis.document = dom.window.document;
  t.after(() => { globalThis.document = previous; dom.window.close(); });
  const root=document.querySelector('#app');renderNotifications(root,{scope:'settings'});
  notify({level:'error',text:'save failed',toast:true});
  assert.equal(document.querySelector('#flash-toast').getAttribute('role'),'alert');
  t.mock.timers.tick(2000);
  notify({level:'success',text:'saved'});
  assert.equal(root.querySelector('[role=alert]'),null);
  assert.equal(document.querySelector('#flash-toast').getAttribute('role'),'status');
  t.mock.timers.tick(1000);
  assert.match(document.querySelector('#flash-toast').textContent,/saved/);
  t.mock.timers.tick(2000);
  assert.equal(document.querySelector('#flash-toast'),null);
});
