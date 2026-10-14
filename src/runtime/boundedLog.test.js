import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendBoundedLog } from './boundedLog.js';

test('log budget refuses growth without truncating existing logs or following symlinks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'melo-log-budget-'));
  try {
    const log = join(dir, 'app.log');
    assert.equal(appendBoundedLog(log, 'hello', { maxBytes: 6 }), true);
    assert.equal(appendBoundedLog(log, 'world', { maxBytes: 6 }), false);
    assert.equal(await readFile(log, 'utf8'), 'hello');
    const userFile = join(dir, 'notes.txt');
    await writeFile(userFile, 'keep');
    await symlink(userFile, join(dir, 'linked.log'));
    assert.equal(appendBoundedLog(join(dir, 'linked.log'), 'unsafe'), false);
    assert.equal(await readFile(userFile, 'utf8'), 'keep');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
