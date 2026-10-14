import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveRuntimePaths } from './paths.js';

const LABELS = { models: 'Local models', data: 'Chats and settings', cache: 'Rebuildable cache', logs: 'Logs', tools: 'Local tools and source', other: 'Other files' };

export function storageCategory(relativePath) {
  if (/^(sd-models|whisper-models|models)(\/|$)/.test(relativePath)) return 'models';
  if (/^(sd-src|sd-bin)(\/|$)/.test(relativePath)) return 'tools';
  if (/(^|\/)(media-cache|search\.sqlite(?:-wal|-shm)?|embedding-cache)(\/|$)/.test(relativePath)) return 'cache';
  if (/(^|\/)([^/]+\.log|[^/]+-debug\.txt|search-trail-log)(\/|$)/.test(relativePath)) return 'logs';
  if (/^(desktop|config\.json)(\/|$)/.test(relativePath)) return 'data';
  return 'other';
}

// Inventory never follows symlinks or deletes anything, including expired data.
export async function collectStorageInventory({ home = resolveRuntimePaths().home, maxEntries = 20000, budgetMs = 3000 } = {}) {
  const deadline = Date.now() + budgetMs;
  const categories = Object.fromEntries(Object.entries(LABELS).map(([id, label]) => [id, { id, label, bytes: 0, files: 0 }]));
  let scanned = 0;
  let complete = true;
  let symlinksSkipped = 0;
  const pending = [''];
  while (pending.length) {
    if (scanned >= maxEntries || Date.now() > deadline) { complete = false; break; }
    const relative = pending.pop();
    const path = join(home, relative);
    try {
      const info = await lstat(path);
      scanned++;
      if (info.isSymbolicLink()) { symlinksSkipped++; continue; }
      if (info.isDirectory()) {
        const children = await readdir(path);
        for (const child of children) pending.push(relative ? `${relative}/${child}` : child);
      } else if (info.isFile()) {
        const category = categories[storageCategory(relative)];
        category.bytes += info.size;
        category.files++;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') complete = false;
    }
  }
  return {
    home, complete, scanned, symlinksSkipped,
    totalBytes: Object.values(categories).reduce((sum, entry) => sum + entry.bytes, 0),
    categories: Object.values(categories),
    // Budgets apply only to disposable cache / logs, never model weights or chats.
    budgets: { cache: 256 * 1024 * 1024, logs: 128 * 1024 * 1024 },
    cleanupPolicy: 'report-only; user data and models are preserved',
  };
}
