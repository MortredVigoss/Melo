import { readFile, stat, realpath } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { getMeloHome } from '../config.js';
import { listBackups, restoreFromBackup, snapshotBeforeWrite } from './backup.js';
import { isHardBlockedWrite } from './sensitivePaths.js';
const previews = new Map();
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function currentFile(path) {
  try { const s = await stat(path); if (!s.isFile() || s.size > 10 * 1024 * 1024) throw new Error('仅支持预览和恢复 10 MB 以内的普通文件。'); return await readFile(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export async function previewRestore(operationId) {
  const home = getMeloHome();
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(operationId || '')) throw new Error('无效备份。');
  const backup = (await listBackups()).find(b => b.operationId === operationId);
  if (!backup) throw new Error('备份不存在。');
  const target = await realpath(backup.originalPath).catch(error => { if(error.code==='ENOENT') return backup.originalPath; throw error; });
  if (target !== backup.originalPath || isHardBlockedWrite(target)) throw new Error('恢复目标路径变化或不可写。');
  const current = await currentFile(target);
  const before = backup.wasMissing ? null : await currentFile(join(home, '.melo-backups', operationId, 'before', basename(target)));
  if (!backup.wasMissing && (!before || digest(before) !== backup.sha256)) throw new Error('备份内容校验失败。');
  const token = randomUUID();
  const preview = { token, home, operationId, path: target, currentHash: current ? digest(current) : null, expiresAt: Date.now()+300000 };
  for (const [key,value] of previews) if(value.expiresAt < Date.now()) previews.delete(key);
  if(previews.size >= 100) previews.delete(previews.keys().next().value);
  previews.set(token,preview);
  return { token, path:target, action:before ? '恢复备份内容' : '移除本次新建文件', currentBytes:current?.length || 0, restoredBytes:before?.length || 0, currentPreview:current?.toString('utf8').slice(0,3000) || '', restoredPreview:before?.toString('utf8').slice(0,3000) || '', truncated:(current?.length || 0)>3000 || (before?.length || 0)>3000 };
}
export async function confirmRestore(token) {
  const home = getMeloHome();
  const p=previews.get(token);
  if(!p || p.home!==home || p.expiresAt<Date.now() || p.busy) throw new Error('预览已过期或正在恢复，请重新预览。');
  p.busy=true;
  try {
    const bytes=await currentFile(p.path);
    if((bytes ? digest(bytes) : null)!==p.currentHash) throw new Error('预览后文件已修改，请重新预览。');
    const safetyCopy=await snapshotBeforeWrite(p.path,{requestedBy:'user',reason:'恢复前的安全备份'});
    const result=await restoreFromBackup(p.operationId,{purgeAfterRestore:false,expectedCurrentHash:p.currentHash});
    previews.delete(token);
    return {...result,safetyBackupId:safetyCopy.operationId};
  } finally { p.busy=false; }
}
