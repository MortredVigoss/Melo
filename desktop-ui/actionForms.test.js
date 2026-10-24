import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { beginFormSubmission,decorateActionForms } from './actionForms.js';
test('re-rendered forms cannot submit twice, retain values, and become usable after failure',()=>{
 const dom=new JSDOM('<form data-form="command-run" data-template-id="one"><input name="command" value="safe"><button>Run</button></form>');
 const doc=dom.window.document,form=doc.querySelector('form');
 const finish=beginFormSubmission(form);assert.equal(beginFormSubmission(form),null);
 assert.equal(new dom.window.FormData(form).get('command'),'safe');
 doc.body.innerHTML=form.outerHTML;decorateActionForms(doc);
 assert.equal(beginFormSubmission(doc.querySelector('form')),null);
 finish();assert.equal(doc.querySelector('form').getAttribute('aria-busy'),'false');
 assert.equal(doc.querySelector('input').value,'safe');
 const retry=beginFormSubmission(doc.querySelector('form'));assert.equal(typeof retry,'function');retry();dom.window.close();
});

test('streaming composer keeps stop and supplemental input outside form save locks',()=>{
 const dom=new JSDOM('<form data-form="composer"><textarea></textarea><button data-action="stop-send">Stop</button></form>');
 const form=dom.window.document.querySelector('form');
 const finish=beginFormSubmission(form);decorateActionForms(dom.window.document);
 assert.equal(form.hasAttribute('inert'),false);
 assert.equal(form.hasAttribute('aria-busy'),false);
 assert.equal(form.querySelector('button').disabled,false);
 assert.equal(typeof beginFormSubmission(form),'function');
 finish();dom.window.close();
});
