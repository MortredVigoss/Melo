import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {translations,interfaceTermKeys as desktop} from '../desktop-ui/translations.js';
import {nativeTranslations,interfaceTermKeys as phone} from '../ios/native-translations.js';
import {term} from '../desktop-ui/i18n.js';
test('desktop and phone use the same four concept IDs with device-specific scope',async()=>{
 const spec=JSON.parse(await readFile(new URL('../shared/protocol/interface-terms.json',import.meta.url)));
 assert.deepEqual(Object.keys(desktop),Object.keys(phone));assert.deepEqual(Object.keys(desktop),Object.keys(spec));
 for(const [id,keys] of Object.entries(spec)){
  assert.equal(desktop[id],keys.desktop);assert.equal(phone[id],keys.ios);
  if(id!=='device')assert.equal(keys.desktop,keys.ios);
  for(const language of ['zh-CN','en','ja','ko','es']){
   assert.ok(({...translations,...nativeTranslations})[keys.ios]?.[language]);
   assert.equal(term(id,language),translations[keys.desktop][language]);
  }
 }
 assert.equal(desktop.device,'这台电脑上');assert.equal(phone.device,'这台手机上');
});
