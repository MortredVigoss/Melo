import { readFile, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { loadConfig, saveConfig, withConfigLock } from '../config.js';
import { currentRequestContext } from '../runtime/requestScope.js';
import { scopeMatches } from './permissionContext.js';
import { recordPermission } from './permissionAudit.js';
export async function commandTemplate(command, cwd) {
  if (!/^npm (?:test|run (?:test|build|lint|check))$/.test(command || '') || !cwd) return null;
  try {
    const path=await realpath(cwd), s=await stat(path);
    const manifest=await readFile(join(path,'package.json'),'utf8');
    return { command, cwd:path, device:String(s.dev), inode:String(s.ino), manifestHash:createHash('sha256').update(manifest).digest('hex') };
  } catch { return null; }
}
export async function findCommandRule(template) {
  if(!template) return null;
  const scope=currentRequestContext()?.permissionScope || null;
  const config=await loadConfig();
  const rule=(config.commandPermissionRules || []).find(r=>JSON.stringify(r.template)===JSON.stringify(template) && scopeMatches(r.permissionScope,scope));
  if(rule) recordPermission({operation:'bash',decision:'allow',reason:'匹配固定 npm 命令、工作目录与 package.json',ruleId:rule.id,path:template.cwd});
  return rule || null;
}
export async function saveCommandRule(template) {
  const permissionScope=currentRequestContext()?.permissionScope || null;
  const currentTemplate=await commandTemplate(template.command,template.cwd);
  if(JSON.stringify(template)!==JSON.stringify(currentTemplate)) throw new Error('命令所属项目发生变化，请重新确认。');
  return withConfigLock(async()=>{
    const config=await loadConfig(), rules=config.commandPermissionRules || [];
    if(!rules.some(r=>JSON.stringify(r.template)===JSON.stringify(template) && JSON.stringify(r.permissionScope)===JSON.stringify(permissionScope))) rules.push({id:randomUUID(),template,permissionScope,createdAt:Date.now()});
    await saveConfig({...config,commandPermissionRules:rules});
  });
}
export async function removeCommandRule(id) {
  return withConfigLock(async()=>{const config=await loadConfig();await saveConfig({...config,commandPermissionRules:(config.commandPermissionRules || []).filter(r=>r.id!==id)});return {ok:true};});
}
