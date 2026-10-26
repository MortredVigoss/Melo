import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile, mkdir, readFile, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bashTool } from './bashTool.js';
import { resolveFileSafety } from '../../safety/fileSafetyGate.js';
async function fixture(fn) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'melo-read-command-')));
  const workspacePath = join(root, 'workspace'); await mkdir(workspacePath);
  let prompts = 0;
  const context = { workspacePath, chatId: 'read-command', sseEmitter: (_event, payload) => { prompts++; resolveFileSafety(payload.requestId, 'deny'); } };
  try { await fn({ root, workspacePath, context, prompts: () => prompts }); }
  finally { await rm(root, { recursive: true, force: true }); }
}
test('bounded ls and cat read inside the workspace without a shell or approval', async () => fixture(async f => {
  await writeFile(join(f.workspacePath, 'note.txt'), 'fixture note');
  await mkdir(join(f.workspacePath, 'empty-dir'));
  await writeFile(join(f.workspacePath, '.hidden'), 'hidden');
  await symlink(f.root, join(f.workspacePath, 'outside-link'));
  const ls = await bashTool.run({ command: 'ls -la' }, f.context);
  assert.equal(ls.ok, true); assert.match(ls.output, /note.txt/);
  assert.match(ls.output, /empty-dir\//); assert.match(ls.output, /\.hidden/); assert.match(ls.output, /outside-link@/);
  assert.doesNotMatch((await bashTool.run({ command: 'ls' }, f.context)).output, /\.hidden/);
  const cat = await bashTool.run({ command: 'cat note.txt' }, f.context);
  assert.equal(cat.ok, true); assert.match(cat.output, /fixture note/); assert.equal(f.prompts(), 0);
}));
test('external reads, shell expansions and unsupported flags keep the explicit gate', async () => fixture(async f => {
  await writeFile(join(f.root, 'private.txt'), 'private');
  for (const command of ['cat ../private.txt', 'ls ../', 'cat note.txt > copy.txt', 'ls --dereference']) {
    assert.equal((await bashTool.run({ command }, f.context)).ok, false, command);
  }
  assert.equal(f.prompts(), 4);
}));
test('repository commands with executable configuration retain explicit consent', async () => fixture(async f => {
  execFileSync('/usr/bin/git', ['init', '-q', f.workspacePath]);
  const marker = join(f.root, 'must-not-exist');
  execFileSync('/usr/bin/git', ['-C', f.workspacePath, 'config', 'core.fsmonitor', `touch '${marker}'`]);
  await writeFile(join(f.workspacePath, 'note.txt'), 'fixture');
  const result = await bashTool.run({ command: 'git status --short' }, f.context);
  assert.equal(result.ok, false); assert.equal(f.prompts(), 1);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
}));
test('git status cannot discover a parent repository beyond the workspace', async () => fixture(async f => {
  execFileSync('/usr/bin/git', ['init', '-q', f.root]);
  assert.equal((await bashTool.run({ command: 'git status' }, f.context)).ok, false);
  assert.equal(f.prompts(), 1);
}));
