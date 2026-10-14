import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requestRead, resolveFileSafety } from './fileSafetyGate.js';

test('workspace root alias allows internal reads but not a symlink escaping it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'melo-alias-regression-'));
  try {
    const target = join(root, 'real');
    const alias = join(root, 'alias');
    await mkdir(target);
    await writeFile(join(target, 'inside.txt'), 'inside');
    await writeFile(join(root, 'outside.txt'), 'outside');
    await symlink(target, alias);
    await symlink(join(root, 'outside.txt'), join(target, 'escape.txt'));
    const prompts = [];
    const sseEmitter = (_event, payload) => {
      prompts.push(payload);
      queueMicrotask(() => resolveFileSafety(payload.requestId, 'deny'));
    };
    await requestRead({ path: join(alias, 'inside.txt'), workspacePath: alias, sseEmitter });
    assert.equal(prompts.length, 0);
    await assert.rejects(requestRead({ path: join(alias, 'escape.txt'), workspacePath: alias, sseEmitter }), { code: 'FILE_SAFETY_DENIED' });
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].withinWorkspace, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
