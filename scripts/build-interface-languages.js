import { writeFile, readFile } from 'node:fs/promises';
import { translations } from '../desktop-ui/translations.js';
import { nativeTranslations } from '../ios/native-translations.js';
for (const key of Object.keys(nativeTranslations)) if (translations[key]) throw new Error(`Duplicate shared/native translation: ${key}`);
const strings = Object.fromEntries(Object.entries({...translations, ...nativeTranslations}).map(([key,values]) => [key, {
  extractionState: 'manual',
  localizations: Object.fromEntries(Object.entries(values).map(([language,value]) => [language === 'zh-CN' ? 'zh-Hans' : language, {stringUnit:{state:'translated',value}}])),
}]));
const output = JSON.stringify({sourceLanguage:'zh-Hans',strings,version:'1.0'},null,2)+'\n';
const path = new URL('../ios/Melo/Localizable.xcstrings',import.meta.url);
if (process.argv.includes('--check')) {
  if (await readFile(path,'utf8') !== output) throw new Error('Run node scripts/build-interface-languages.js');
} else await writeFile(path,output);
console.log(`${Object.keys(strings).length} shared and native interface strings, 5 languages`);
