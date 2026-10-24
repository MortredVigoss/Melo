import { readFile,writeFile } from 'node:fs/promises';
const css=await readFile(new URL('../desktop-ui/tokens.css',import.meta.url),'utf8');
const values=Object.fromEntries([...css.matchAll(/--visual-([a-z0-9-]+):\s*(#[a-f0-9]{6});/g)].map(row=>[row[1],row[2]]));
const output='// Generated from desktop-ui/tokens.css by scripts/generate-visual-tokens.js.\nconst defaults = Object.freeze('+JSON.stringify(values,null,2)+');\n'+
"export function visualColor(name) {\n  const authored = typeof document !== 'undefined' && typeof getComputedStyle === 'function' ? getComputedStyle(document.documentElement).getPropertyValue('--visual-'+name).trim() : '';\n  return authored || defaults[name];\n}\n"+
"export function visualRgb(name) {\n  const color = visualColor(name);\n  if (/^#[a-f0-9]{6}$/i.test(color)) return [1,3,5].map(offset=>parseInt(color.slice(offset,offset+2),16)).join(',');\n  const values=color?.match(/^rgba?\\(([^)]+)\\)/)?.[1].split(',').slice(0,3).map(v=>v.trim());\n  return values?.join(',') || [1,3,5].map(offset=>parseInt(defaults[name].slice(offset,offset+2),16)).join(',');\n}\n";
const path=new URL('../src/shared/visualTokens.js',import.meta.url);
if(process.argv.includes('--check')) {if(await readFile(path,'utf8')!==output)throw new Error('Visual tokens are stale');}
else await writeFile(path,output);
