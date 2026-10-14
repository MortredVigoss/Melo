import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectStorageInventory } from './storageInventory.js';

test('inventory separates weights and chats from cache, skips links and reports partial scans', async t => {
  const home = await mkdtemp(join(tmpdir(), 'melo-storage-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  for (const folder of ['sd-models', 'desktop/threads', 'media-cache']) await mkdir(join(home, folder), { recursive: true });
  await writeFile(join(home, 'sd-models/model.bin'), Buffer.alloc(100));
  await writeFile(join(home, 'desktop/threads/chat.json'), '{}');
  await writeFile(join(home, 'media-cache/item.json'), '{}');
  await symlink(join(home, 'sd-models'), join(home, 'media-cache/models-link'));
  const report = await collectStorageInventory({ home });
  assert.equal(report.categories.find(c => c.id === 'models').bytes, 100);
  assert.equal(report.categories.find(c => c.id === 'cache').bytes, 2);
  assert.equal(report.categories.find(c => c.id === 'data').bytes, 2);
  assert.equal(report.symlinksSkipped, 1);
  assert.equal(report.totalBytes, 104);
  assert.equal((await collectStorageInventory({ home, maxEntries: 1 })).complete, false);
});
