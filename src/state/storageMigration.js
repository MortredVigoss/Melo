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
