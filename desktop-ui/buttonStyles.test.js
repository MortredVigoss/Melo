import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { applyButtonStyles, BUTTON_VARIANTS } from './buttonStyles.js';
test('buttons share four visual variants without changing action or layout hooks',()=>{
 const dom=new JSDOM('<main><button class="small-button is-primary" data-action="save">Save</button><button class="small-button">Cancel</button><button class="ghost-button">More</button><button class="composer-icon-button" aria-label="Send">↑</button></main>');
 const root=dom.window.document.querySelector('main');applyButtonStyles(root);
 const buttons=[...root.querySelectorAll('button')];
 assert.deepEqual(buttons.map(b=>BUTTON_VARIANTS.filter(v=>b.classList.contains('button-'+v))),[['primary'],['secondary'],['ghost'],['icon']]);
 assert.equal(buttons[0].dataset.action,'save');assert.ok(buttons[3].classList.contains('composer-icon-button'));
 buttons[0].classList.remove('is-primary');applyButtonStyles(root);
 assert.ok(buttons[0].classList.contains('button-secondary'));assert.ok(!buttons[0].classList.contains('button-primary'));
 dom.window.close();
});
test('canvas hit areas and selectable content keep their component appearance',()=>{
 const dom=new JSDOM('<main><button class="neural-cluster button-secondary" data-group="chat">Chat</button><button class="execution-label is-active">Tool</button><button class="model-picker-option is-selected">Model</button></main>');
 const root=dom.window.document.querySelector('main');applyButtonStyles(root);
 for(const button of root.querySelectorAll('button')) assert.ok(BUTTON_VARIANTS.every(v=>!button.classList.contains('button-'+v)));
 assert.equal(root.firstChild.dataset.group,'chat');assert.ok(root.lastChild.classList.contains('is-selected'));
 dom.window.close();
});
