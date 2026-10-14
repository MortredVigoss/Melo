import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { EditSession, createSettingsFormEditors } from './settingsEdit.js';
import { updateNeuralWorkspace } from './neuralDom.js';

test('cancel restores a model select without removing an unchanged reconciled form',()=>{
 const dom=new JSDOM('<main></main>'),doc=dom.window.document,root=doc.querySelector('main');
 const render=()=>{updateNeuralWorkspace(root,'<section><form data-form="default-model-config"><select name="model"><option value="sol" selected>Sol</option><option value="astra">Astra</option></select></form></section>');controls.decorate(doc);};
 const controls=createSettingsFormEditors({render,onCancel(){}});controls.install(doc);render();
 doc.querySelector('[data-action=form-settings-edit]').click();const select=doc.querySelector('select');
 select.value='astra';select.dispatchEvent(new dom.window.Event('change',{bubbles:true}));render();
 assert.equal(doc.querySelector('select').value,'astra');
 doc.querySelector('[data-action=form-settings-cancel]').click();
 assert.equal(doc.querySelector('select'),select);assert.equal(select.value,'sol');assert.equal(select.disabled,true);
 dom.window.close();
});

test('save feedback reflects acknowledgement, prevents duplicate submissions and retains failed drafts',()=>{
 const s=new EditSession();assert.equal(s.start(),false);s.begin();assert.equal(s.start(),false);s.change();assert.equal(s.start(),true);assert.equal(s.status,'saving');assert.equal(s.start(),false);s.cancel();assert.equal(s.status,'saving');s.failed(new Error('disk full'));assert.equal(s.editing,true);assert.equal(s.dirty,true);assert.equal(s.start(),true);s.saved();assert.equal(s.editing,false);assert.equal(s.dirty,false);
});
test('existing settings forms lock initially, edit explicitly, cancel, and lock after acknowledged save',()=>{
 const dom=new JSDOM('<main></main>');const doc=dom.window.document;let draft='persisted';
 const render=()=>{doc.querySelector('main').innerHTML=`<form data-form="agent-profile-update" data-agent-id="main"><input name="name" value="${draft}"><button type="submit">Old save</button><button type="button" data-action="select-agent-editor-tab">tab</button></form>`;controls.decorate(doc);};
 const controls=createSettingsFormEditors({render,onCancel(){draft='persisted';}});controls.install(doc);render();
 assert.equal(doc.querySelector('input').disabled,true);assert.equal(doc.querySelector('[data-action=select-agent-editor-tab]').disabled,false);
 assert.equal(controls.start(doc.querySelector('form')),false);
 doc.querySelector('[data-action=form-settings-edit]').click();assert.equal(doc.querySelector('input').disabled,false);
 draft='draft';doc.querySelector('input').value=draft;doc.querySelector('input').dispatchEvent(new dom.window.Event('input',{bubbles:true}));assert.equal(doc.querySelector('[data-action=form-settings-save]').disabled,false);
 doc.querySelector('[data-action=form-settings-cancel]').click();assert.equal(doc.querySelector('input').value,'persisted');assert.equal(doc.querySelector('input').disabled,true);
 doc.querySelector('[data-action=form-settings-edit]').click();doc.querySelector('input').dispatchEvent(new dom.window.Event('input',{bubbles:true}));
 const key=controls.start(doc.querySelector('form'));render();assert.equal(doc.querySelector('input').disabled,true);assert.ok(doc.querySelector('[data-edit-status=saving]'));
 controls.finish(key,new Error('disk full'));assert.equal(doc.querySelector('input').disabled,false);assert.match(doc.querySelector('[role=alert]').textContent,/disk full/);
 controls.start(doc.querySelector('form'));controls.finish(key);assert.equal(doc.querySelector('input').disabled,true);assert.match(doc.querySelector('[role=status]').textContent,/已保存/);dom.window.close();
});

test('blur preserves the save target, drafts survive renders, and connection tests cannot commit drafts',()=>{
 const dom=new JSDOM('<main></main>'),doc=dom.window.document;
 const render=()=>{doc.querySelector('main').innerHTML='<form data-form="agent-profile-update" data-agent-id="main"><textarea name="description">persisted</textarea><button type="button" data-action="test-agent-channel">Test</button></form>';controls.decorate(doc);};
 const controls=createSettingsFormEditors({render,onCancel(){}});controls.install(doc);render();
 assert.equal(doc.querySelector('[data-action=test-agent-channel]').disabled,false);
 doc.querySelector('[data-action=form-settings-edit]').click();
 assert.equal(doc.querySelector('[data-action=test-agent-channel]').disabled,true);
 const editStillActive=controls.editToken(doc.querySelector('form'));assert.equal(editStillActive(),true);
 const input=doc.querySelector('textarea');input.value='unsaved';input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));
 const save=doc.querySelector('[data-action=form-settings-save]');
 input.dispatchEvent(new dom.window.Event('change',{bubbles:true}));
 assert.equal(doc.querySelector('[data-action=form-settings-save]'),save,'blur must not replace the button between pointerdown and click');
 render();assert.equal(doc.querySelector('textarea').value,'unsaved');
 const key=controls.start(doc.querySelector('form'));controls.finish(key,new Error('offline'));
 assert.equal(doc.querySelector('textarea').value,'unsaved');
 doc.querySelector('[data-action=form-settings-cancel]').click();assert.equal(doc.querySelector('textarea').value,'persisted');assert.equal(editStillActive(),false);doc.querySelector('[data-action=form-settings-edit]').click();assert.equal(editStillActive(),false,'late avatar decoding cannot affect a new edit session');dom.window.close();
});

test('dirty settings across pages guard browser reload and native quit until saved or cancelled', async()=>{
 const {hasUnsavedSettings,installUnsavedSettingsGuard}=await import('./settingsEdit.js');
 const dom=new JSDOM('');installUnsavedSettingsGuard(dom.window);
 const blocked=()=>!dom.window.dispatchEvent(new dom.window.Event('beforeunload',{cancelable:true}));
 assert.equal(blocked(),false);
 const first=new EditSession(),second=new EditSession();first.begin();assert.equal(blocked(),false);
 first.change();second.begin();second.change();assert.equal(blocked(),true);assert.equal(dom.window.MeloHasUnsavedSettings(),true);
 first.start();first.cancel();assert.equal(hasUnsavedSettings(),true,'in-flight save cannot be dismissed');
 first.saved();assert.equal(blocked(),true,'another page still owns an unsaved draft');
 second.failed(new Error('offline'));assert.equal(blocked(),true);second.cancel();assert.equal(blocked(),false);
 dom.window.close();
});
