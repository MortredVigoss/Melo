import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { translations } from '../desktop-ui/translations.js';
import { nativeTranslations } from '../ios/native-translations.js';

test('native authored static controls have five-language catalog coverage', async()=>{
  const native=JSON.parse(await readFile(new URL('../ios/Melo/Localizable.xcstrings',import.meta.url)));
  for(const [key,values] of Object.entries(nativeTranslations)) {
    assert.equal(translations[key],undefined,`Duplicate catalog key: ${key}`);
    for(const lang of ['zh-CN','en','ja','ko','es']) {
      assert.ok(values[lang]?.trim(),`${lang}: ${key}`);
      assert.equal(native.strings[key]?.localizations[lang==='zh-CN'?'zh-Hans':lang]?.stringUnit.value,values[lang]);
      assert.deepEqual(values[lang].match(/%(?:lld|@)/g)||[],key.match(/%(?:lld|@)/g)||[],`Native placeholders: ${key}`);
    }
  }
  const missing=[];
  for(const file of await readdir(new URL('../ios/Melo/',import.meta.url))) {
    if(!file.endsWith('.swift')||file.includes('Verification'))continue;
    const source=await readFile(new URL('../ios/Melo/'+file,import.meta.url),'utf8');
    if(!source.includes('import SwiftUI'))continue;
    // Static authored labels only. Interpolated formats and user-derived strings
    // need explicit review; never turn arbitrary model output into a catalog key.
    for(const match of source.matchAll(/\b(?:Text|Button|Label|Section|TextField|SecureField|Toggle|Picker|PhotosPicker|NavigationLink|ContentUnavailableView|DisclosureGroup|navigationTitle|accessibilityLabel|alert|confirmationDialog)\(\s*"((?:\\.|[^"\\])*)"/g)) {
      const key=match[1];
      if(/[\u3400-\u9fff]/.test(key)&&!key.includes('\\(')&&!native.strings[key])missing.push(`${file}: ${key}`);
    }
  }
  assert.deepEqual(missing,[]);
  for(const key of ['图片模式','生成图片','修改图片','看图分析','主体','项目与资料%@','照片','一句话介绍','Agent详情','创建Agent','查看模式 · 点编辑后修改','未保存 · 请处理后重试','不同Agent，同样默契。','为每一种工作，选择合适的思考方式。','查看%@','与%@对话','此 Agent 的新版人设尚未同步。全文已保留在本机，其他聊天继续同步。'])assert.ok(native.strings[key].localizations.en.stringUnit.value);
});
