import { readdir, readFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';

export const TEST_ROOTS = ['src','desktop-ui','mobile-sync','scripts','ios/Tests','shared/agent'];
export async function discoverTests(root = resolve('.'), roots = TEST_ROOTS) {
  const files=[];
  async function walk(dir) {
    for(const entry of await readdir(dir,{withFileTypes:true})) {
      const path=resolve(dir,entry.name);
      if(entry.isDirectory())await walk(path);
      else if(entry.isFile()&&entry.name.endsWith('.test.js'))files.push(relative(root,path));
    }
  }
  for(const dir of roots)await walk(resolve(root,dir));
  return files.sort();
}
export async function discoverRunnableTests(root = resolve('.')) {
  const files=await discoverTests(root);
  const excluded=JSON.parse(await readFile(resolve(root,'scripts/test-quarantine.json'),'utf8'));
  const now=Date.now();
  for(const [path,entry] of Object.entries(excluded)) {
    if(!files.includes(path)||!entry.reason||!Number.isFinite(Date.parse(entry.expires))||Date.parse(entry.expires)<=now)throw Error(`Invalid or expired test quarantine: ${path}`);
  }
  return { files:files.filter(file=>!Object.hasOwn(excluded,file)), excluded };
}
