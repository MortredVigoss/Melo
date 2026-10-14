import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadState, updateStateAtomically, persistStateAtomically } from './stateStore.js';
import { invalidateThreadCheckpointCache } from '../memory/checkpointer.js';
import { atomicWriteJson } from '../storage.js';

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'melo-checkpoint-commit-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await updateStateAtomically(s => {
    s.chats = [{ id: 'kept', title: 'Committed chat', mode: 'chat', messages: [
      { id: 'original', role: 'user', content: 'Committed message', createdAt: '2026-01-01T00:00:00.000Z' },
    ] }];
  }, { home });
  return { home, stateFilePath: join(home, 'desktop/state.json'), threadsDir: join(home, 'desktop/threads'), storePath: join(home, 'desktop/store.sqlite') };
}

test('failure before manifest commit leaves the old transcript intact and the next commit collects staged files', async t => {
  const ctx = await fixture(t);
  const committed = await readFile(ctx.stateFilePath, 'utf8');
  const candidate = await loadState({ home: ctx.home });
  candidate.chats[0].messages.push({ id: 'uncommitted', role: 'assistant', content: 'Must remain invisible' });
  await assert.rejects(persistStateAtomically(candidate, { ctx, _writeState: async () => {
    throw Object.assign(new Error('Injected manifest write failure'), { code: 'EIO' });
  } }), { code: 'EIO' });
  invalidateThreadCheckpointCache(null, { threadsDir: ctx.threadsDir });
  assert.equal(await readFile(ctx.stateFilePath, 'utf8'), committed);
  assert.deepEqual((await loadState({ home: ctx.home })).chats[0].messages.map(m => m.id), ['original']);
  assert.equal((await readdir(ctx.threadsDir)).length, 2, 'old and staged versions coexist before commit');
  await updateStateAtomically(s => { s.settings.afterFailure = true; }, { home: ctx.home });
  assert.equal((await readdir(ctx.threadsDir)).length, 1);
});

test('settings-only commits reuse checkpoints and a no-op leaves the manifest untouched', async t => {
  const ctx = await fixture(t);
  const checkpoint = (await readdir(ctx.threadsDir))[0];
  const path = join(ctx.threadsDir, checkpoint);
  const before = (await stat(path)).mtimeMs;
  await updateStateAtomically(s => { s.settings.selectionOnly = 1; }, { home: ctx.home });
  assert.deepEqual(await readdir(ctx.threadsDir), [checkpoint]);
  assert.equal((await stat(path)).mtimeMs, before);
  const manifestTime = (await stat(ctx.stateFilePath)).mtimeMs;
  await updateStateAtomically(() => {}, { home: ctx.home });
  assert.equal((await stat(ctx.stateFilePath)).mtimeMs, manifestTime);
});

test('a failed derived index never rolls back a committed message', async t => {
  const ctx = await fixture(t);
  // Force SQLite open failure using a directory in its place.
  await rm(ctx.storePath, { force: true });
  await mkdir(ctx.storePath);
  await updateStateAtomically(s => {
    s.chats[0].messages.push({ id: 'index-unavailable', role: 'assistant', content: 'Persist despite index failure' });
  }, { home: ctx.home });
  invalidateThreadCheckpointCache(null, { threadsDir: ctx.threadsDir });
  assert.ok((await loadState({ home: ctx.home })).chats[0].messages.some(m => m.id === 'index-unavailable'));
});

test('a missing committed checkpoint is reported instead of silently returning an empty chat', async t => {
  const ctx = await fixture(t);
  const files = await readdir(ctx.threadsDir);
  await rm(join(ctx.threadsDir, files[0]));
  invalidateThreadCheckpointCache(null, { threadsDir: ctx.threadsDir });
  await assert.rejects(loadState({ home: ctx.home }), { code: 'STATE_CHECKPOINT_MISSING' });
});

test('legacy inline messages migrate with an intact original backup before publishing versioned checkpoints', async t => {
  const home = await mkdtemp(join(tmpdir(), 'melo-storage-migration-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const path = join(home, 'desktop/state.json');
  await atomicWriteJson(path, { chats: [{ id: 'legacy', messages: [{ id: 'legacy-message', role: 'user', content: 'Keep original data' }] }] });
  const original = await readFile(path, 'utf8');
  await updateStateAtomically(s => { s.settings.migrated = true; }, { home });
  assert.equal(await readFile(join(home, 'desktop/backups/before-checkpoint-v2/state.json'), 'utf8'), original);
  const saved = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(saved._storageFormat, 2);
  assert.ok(saved.chats[0].checkpointId);
  invalidateThreadCheckpointCache(null, { threadsDir: join(home, 'desktop/threads') });
  assert.equal((await loadState({ home })).chats[0].messages[0].id, 'legacy-message');
});
