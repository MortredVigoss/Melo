import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { LANGUAGES, setLanguage, t, ui } from './i18n.js';
import { translations } from './translations.js';
import { normalizeLocalPreferences, validateLocalPreferencePatch } from '../src/domain/settings/localPreferences.js';

test('all five catalogs cover the same interface keys and native catalog stays in sync', async () => {
  const native = JSON.parse(await readFile(new URL('../ios/Melo/Localizable.xcstrings',import.meta.url)));
  assert.equal(LANGUAGES.length,5);
  for (const [key, row] of Object.entries(translations)) for (const {id} of LANGUAGES) {
    assert.equal(typeof row[id],'string'); assert.ok(row[id].trim());
    assert.equal(native.strings[key].localizations[id==='zh-CN'?'zh-Hans':id].stringUnit.value,row[id]);
  }
});
test('language preference rejects invalid values and preserves existing preferences', () => {
  for (const {id} of LANGUAGES) assert.deepEqual(validateLocalPreferencePatch({interfaceLanguage:id}),{interfaceLanguage:id});
  assert.throws(()=>validateLocalPreferencePatch({interfaceLanguage:'<script>'}));
  const old=normalizeLocalPreferences({textSize:'large',voiceLanguage:'en-US'});
  assert.equal(old.interfaceLanguage,'zh-CN');assert.equal(old.textSize,'large');assert.equal(old.voiceLanguage,'en-US');
});
test('literal templates translate UI only, preserve user data, attributes and placeholder order', () => {
  try {
    setLanguage('en');
    const content='系统设置 <img src=x onerror=alert(1)>';
    const render=()=>ui`<section data-id="${'系统设置'}"><h1>系统设置</h1><p>${content}</p><button title="保存修改">保存修改</button><span>${3} 段对话 · ${2} 个Agent</span></section>`;
    assert.equal(render(),'<section data-id="系统设置"><h1>Settings</h1><p>'+content+'</p><button title="Save changes">Save changes</button><span>3 chats · 2 agents</span></section>');
    setLanguage('ko'); assert.match(render(),/<h1>설정<\/h1>/); assert.ok(render().includes(content));
    setLanguage('bad'); assert.equal(t('系统设置'),'系统设置');
    setLanguage('ja'); assert.equal(t('untranslated developer output'),'untranslated developer output');
  } finally { setLanguage('zh-CN'); }
});
