/**
 * sensitivePaths.test.js — pin classifier output for every category +
 * the public predicates.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

async function freshModule() {
  const mod = await import(`./sensitivePaths.js?tc=${Date.now()}-${Math.random()}`);
  return mod;
}

async function withTempMeloHome(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'melo-sensitive-'));
  const prev = process.env.MELO_HOME;
  process.env.MELO_HOME = dir;
  try {
    await fn(dir);
  } finally {
    if (prev === undefined) delete process.env.MELO_HOME;
    else process.env.MELO_HOME = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

const HOME = homedir();
const IS_DARWIN = platform() === 'darwin';

test('credential paths: ~/.ssh and children classify as credential', async () => {
  const { classifyPath, PATH_CATEGORY } = await freshModule();
  assert.equal(classifyPath(join(HOME, '.ssh')), PATH_CATEGORY.CREDENTIAL);
  assert.equal(classifyPath(join(HOME, '.ssh/id_rsa')), PATH_CATEGORY.CREDENTIAL);
  assert.equal(classifyPath(join(HOME, '.aws/credentials')), PATH_CATEGORY.CREDENTIAL);
  assert.equal(classifyPath(join(HOME, '.netrc')), PATH_CATEGORY.CREDENTIAL);
});

test('system paths: /etc, /usr, /bin, /sbin classify as system', async () => {
  const { classifyPath, PATH_CATEGORY } = await freshModule();
  assert.equal(classifyPath('/etc'), PATH_CATEGORY.SYSTEM);
  assert.equal(classifyPath('/etc/hosts'), PATH_CATEGORY.SYSTEM);
  assert.equal(classifyPath('/usr/bin/node'), PATH_CATEGORY.SYSTEM);
  assert.equal(classifyPath('/bin/sh'), PATH_CATEGORY.SYSTEM);
  assert.equal(classifyPath('/sbin/launchd'), PATH_CATEGORY.SYSTEM);
});

if (IS_DARWIN) {
  test('darwin: macOS-specific system + credential dirs', async () => {
    const { classifyPath, PATH_CATEGORY } = await freshModule();
    assert.equal(classifyPath('/System/Library/Frameworks'), PATH_CATEGORY.SYSTEM);
    assert.equal(classifyPath('/Library/Preferences'), PATH_CATEGORY.SYSTEM);
    assert.equal(
      classifyPath(join(HOME, 'Library/Keychains/login.keychain-db')),
      PATH_CATEGORY.CREDENTIAL,
    );
    assert.equal(
      classifyPath(join(HOME, 'Library/Cookies/Cookies.binarycookies')),
      PATH_CATEGORY.CREDENTIAL,
    );
  });
}

test('melo_internal: paths under MELO_HOME classify as melo_internal', async () => {
  await withTempMeloHome(async (dir) => {
    const { classifyPath, PATH_CATEGORY } = await freshModule();
    assert.equal(classifyPath(dir), PATH_CATEGORY.MELO_INTERNAL);
    assert.equal(classifyPath(join(dir, 'config.json')), PATH_CATEGORY.MELO_INTERNAL);
    assert.equal(
      classifyPath(join(dir, 'desktop/web-search-debug.log')),
      PATH_CATEGORY.MELO_INTERNAL,
    );
  });
});

test('safe: regular user paths under home (not credentials) classify as safe', async () => {
  await withTempMeloHome(async () => {
    const { classifyPath, PATH_CATEGORY } = await freshModule();
    assert.equal(classifyPath(join(HOME, 'Documents/notes.txt')), PATH_CATEGORY.SAFE);
    assert.equal(classifyPath(join(HOME, 'Desktop/melo/foo.js')), PATH_CATEGORY.SAFE);
    assert.equal(classifyPath('/tmp/foo'), PATH_CATEGORY.SAFE);
  });
});

test('isHardBlockedWrite: covers system + credential + melo_internal', async () => {
  await withTempMeloHome(async (dir) => {
    const { isHardBlockedWrite } = await freshModule();
    assert.equal(isHardBlockedWrite('/etc/hosts'), true);
    assert.equal(isHardBlockedWrite(join(HOME, '.ssh/id_rsa')), true);
    assert.equal(isHardBlockedWrite(join(dir, 'config.json')), true);
    assert.equal(isHardBlockedWrite(join(HOME, 'Documents/notes.txt')), false);
  });
});

test('isHardBlockedDelete: same set as write (deletes are higher risk)', async () => {
  await withTempMeloHome(async (dir) => {
    const { isHardBlockedDelete, isHardBlockedWrite } = await freshModule();
    const cases = [
      '/etc/hosts',
      join(HOME, '.ssh/id_rsa'),
      join(dir, 'config.json'),
      join(HOME, 'Documents/notes.txt'),
      '/tmp/foo',
    ];
    for (const p of cases) {
      assert.equal(isHardBlockedDelete(p), isHardBlockedWrite(p), `mismatch on ${p}`);
    }
  });
});

test('readRequiresApproval: true for system + credential, false for melo_internal + safe', async () => {
  await withTempMeloHome(async (dir) => {
    const { readRequiresApproval } = await freshModule();
    assert.equal(readRequiresApproval('/etc/hosts'), true);
    assert.equal(readRequiresApproval(join(HOME, '.ssh/id_rsa')), true);
    // melo_internal reads are OK (we DO want agents to read their own
    // workspace, history, generated files).
    assert.equal(readRequiresApproval(join(dir, 'config.json')), false);
    assert.equal(readRequiresApproval(join(HOME, 'Documents/notes.txt')), false);
  });
});

test('classifyPath: empty / non-string / relative inputs default to SAFE', async () => {
  const { classifyPath, PATH_CATEGORY } = await freshModule();
  assert.equal(classifyPath(''), PATH_CATEGORY.SAFE);
  assert.equal(classifyPath(null), PATH_CATEGORY.SAFE);
  assert.equal(classifyPath(undefined), PATH_CATEGORY.SAFE);
  assert.equal(classifyPath(42), PATH_CATEGORY.SAFE);
  // Relative paths can't reliably be matched against absolute prefixes;
  // we don't pretend to know which dir they resolve into.
  assert.equal(classifyPath('foo/bar'), PATH_CATEGORY.SAFE);
});

test('classifyPath: trailing slashes do not change classification', async () => {
  const { classifyPath, PATH_CATEGORY } = await freshModule();
  assert.equal(classifyPath('/etc/'), PATH_CATEGORY.SYSTEM);
  assert.equal(classifyPath(join(HOME, '.ssh/')), PATH_CATEGORY.CREDENTIAL);
});

test('classifyPath: a "near miss" path (sibling of credential dir) stays SAFE', async () => {
  // ~/.sshconfig (not under ~/.ssh) must NOT match the ~/.ssh prefix.
  // This pins the dir-not-prefix-string semantics.
  const { classifyPath, PATH_CATEGORY } = await freshModule();
  assert.equal(classifyPath(join(HOME, '.sshconfig')), PATH_CATEGORY.SAFE);
  assert.equal(classifyPath(join(HOME, '.awsbackup/notes')), PATH_CATEGORY.SAFE);
});
