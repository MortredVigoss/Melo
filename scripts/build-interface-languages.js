import { generateInterfaceLanguages } from './generate-interface-languages.js';
await generateInterfaceLanguages({check:process.argv.includes('--check')});
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

const launchPath = new URL('../desktop-ui/launchScreen.js',import.meta.url);
const launchSource = await readFile(launchPath,'utf8');
const launchKeys = ['正在启动 Melo','连接本地工作空间','正在打开你的工作空间','载入对话与偏好设置','暂时无法打开工作空间','可以重试，已有内容会保留。','没有可用的诊断详情。','Melo 启动','重新打开','查看诊断信息'];
const launchBlock = '  // BEGIN GENERATED LAUNCH COPY\n  const launchCopy = '+JSON.stringify(Object.fromEntries(launchKeys.map(key=>[key,translations[key]])))+';\n  // END GENERATED LAUNCH COPY';
const nextLaunch = launchSource.replace(/  \/\/ BEGIN GENERATED LAUNCH COPY[\s\S]*?  \/\/ END GENERATED LAUNCH COPY/,launchBlock);
if(process.argv.includes('--check')) {if(nextLaunch!==launchSource)throw new Error('Launch translations are stale');}
else await writeFile(launchPath,nextLaunch);
