import { createHash } from 'node:crypto';
import { cp } from 'node:fs/promises';
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { parseStatePayload } from './statePayload.js';

// Preserve the original manifest and its legacy checkpoints before switching
// to immutable checkpoint references. Publish the backup only when complete.
export async function backupLegacyState(ctx) {
  let raw;
  try { raw = await readFile(ctx.stateFilePath, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  const { parsed } = parseStatePayload(raw);
  if (Number(parsed._storageFormat) >= 2) return;
  const root = join(ctx.home, 'desktop', 'backups');
  const target = join(root, 'before-checkpoint-v2');
  try { await access(join(target, 'complete.json')); return; } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await mkdir(root, { recursive: true });
  const staging = await mkdtemp(join(root, '.checkpoint-v2-'));
  try {
    await writeFile(join(staging, 'state.json'), raw, 'utf8');
    await mkdir(join(staging, 'threads'));
    for (const chat of parsed.chats || []) {
      const file = `${encodeURIComponent(String(chat.id || '').trim())}.json`;
      try { await copyFile(join(ctx.threadsDir, file), join(staging, 'threads', file)); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    await writeFile(join(staging, 'complete.json'), JSON.stringify({ format: 1, createdAt: new Date().toISOString() }));
    await rename(staging, target);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

// Preserve the exact pre-migration state, persona files and immutable message
// references before publishing the new Agent storage shape. Old Melo versions
// reject storage format 3 rather than silently dropping canonical instructions.
export async function backupAgentState(ctx) {
  let raw;
  try { raw = await readFile(ctx.stateFilePath); } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  const { parsed } = parseStatePayload(raw.toString('utf8'));
  if (Number(parsed._storageFormat) >= 3) return;
  const digest = createHash('sha256').update(raw).digest('hex');
  const root = join(ctx.home,'desktop','backups');
  const target = join(root,`before-agent-v3-${digest.slice(0,16)}`);
  try { await access(join(target,'complete.json')); return; } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await mkdir(root,{recursive:true,mode:0o700});
  const staging = await mkdtemp(join(root,'.agent-v3-'));
  try {
    await writeFile(join(staging,'state.json'),raw,{mode:0o600});
    for (const [source,name] of [[ctx.threadsDir,'threads'],[join(ctx.home,'desktop','agents'),'agents']]) {
      try { await cp(source,join(staging,name),{recursive:true,dereference:false}); }
      catch (error) { if(error.code!=='ENOENT') throw error; }
    }
    await writeFile(join(staging,'complete.json'),JSON.stringify({format:3,sourceSHA256:digest,createdAt:new Date().toISOString()}),{mode:0o600});
    await rename(staging,target);
  } finally { await rm(staging,{recursive:true,force:true}); }
}
