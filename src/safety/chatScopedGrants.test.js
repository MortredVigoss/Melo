/**
 * chatScopedGrants.test.js — pin grant isolation between chats and
 * between operation kinds.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

async function freshModule() {
  const mod = await import(`./chatScopedGrants.js?tc=${Date.now()}-${Math.random()}`);
  return mod;
}

test('grantFile records exact-path grant; hasGrant returns true for it', async () => {
  const { grantFile, hasGrant, GRANT_KIND } = await freshModule();
  grantFile('chat-A', '/tmp/foo.txt', GRANT_KIND.READ);
  assert.equal(hasGrant('chat-A', '/tmp/foo.txt', GRANT_KIND.READ), true);
});

test('grantFile is per-chat: chat-A grant does NOT leak to chat-B', async () => {
  const { grantFile, hasGrant, GRANT_KIND } = await freshModule();
  grantFile('chat-A', '/tmp/foo.txt', GRANT_KIND.READ);
  assert.equal(hasGrant('chat-A', '/tmp/foo.txt', GRANT_KIND.READ), true);
  assert.equal(hasGrant('chat-B', '/tmp/foo.txt', GRANT_KIND.READ), false);
});

test('grantFile is per-kind: read grant does NOT silently authorize write', async () => {
  const { grantFile, hasGrant, GRANT_KIND } = await freshModule();
  grantFile('chat-A', '/tmp/foo.txt', GRANT_KIND.READ);
  assert.equal(hasGrant('chat-A', '/tmp/foo.txt', GRANT_KIND.WRITE), false);
  assert.equal(hasGrant('chat-A', '/tmp/foo.txt', GRANT_KIND.EDIT), false);
});

test('grantFile accepts an array of kinds', async () => {
  const { grantFile, hasGrant, GRANT_KIND } = await freshModule();
  grantFile('chat-A', '/tmp/foo.txt', [GRANT_KIND.READ, GRANT_KIND.WRITE]);
  assert.equal(hasGrant('chat-A', '/tmp/foo.txt', GRANT_KIND.READ), true);
  assert.equal(hasGrant('chat-A', '/tmp/foo.txt', GRANT_KIND.WRITE), true);
});

test('grantDir grants every child path under the dir', async () => {
  const { grantDir, hasGrant, GRANT_KIND } = await freshModule();
  grantDir('chat-A', '/tmp/proj', GRANT_KIND.READ);
  assert.equal(hasGrant('chat-A', '/tmp/proj/a.js', GRANT_KIND.READ), true);
  assert.equal(hasGrant('chat-A', '/tmp/proj/sub/b.js', GRANT_KIND.READ), true);
});

test('grantDir does NOT grant the directory itself (only children)', async () => {
  const { grantDir, hasGrant, GRANT_KIND } = await freshModule();
  grantDir('chat-A', '/tmp/proj', GRANT_KIND.READ);
  // The directory entry has no meaningful read/write — agent should
  // treat it as a separate prompt.
  assert.equal(hasGrant('chat-A', '/tmp/proj', GRANT_KIND.READ), false);
});

test('grantDir does NOT match a sibling dir with the same prefix', async () => {
  // /tmp/proj-other must NOT match /tmp/proj — pins the dir-boundary
  // semantics. Same trap as `~/.sshconfig` vs `~/.ssh`.
  const { grantDir, hasGrant, GRANT_KIND } = await freshModule();
  grantDir('chat-A', '/tmp/proj', GRANT_KIND.READ);
  assert.equal(hasGrant('chat-A', '/tmp/proj-other/a.js', GRANT_KIND.READ), false);
});

test('grantDir is per-chat: chat-A dir grant does NOT leak to chat-B', async () => {
  const { grantDir, hasGrant, GRANT_KIND } = await freshModule();
  grantDir('chat-A', '/tmp/proj', GRANT_KIND.WRITE);
  assert.equal(hasGrant('chat-A', '/tmp/proj/a.js', GRANT_KIND.WRITE), true);
  assert.equal(hasGrant('chat-B', '/tmp/proj/a.js', GRANT_KIND.WRITE), false);
});

test('grantDir is per-kind: write-on-dir grant does NOT authorize read on the same dir', async () => {
  const { grantDir, hasGrant, GRANT_KIND } = await freshModule();
  grantDir('chat-A', '/tmp/proj', GRANT_KIND.WRITE);
  assert.equal(hasGrant('chat-A', '/tmp/proj/a.js', GRANT_KIND.WRITE), true);
  assert.equal(hasGrant('chat-A', '/tmp/proj/a.js', GRANT_KIND.READ), false);
});

test('clearChat(chatId) wipes one chat without affecting others', async () => {
  const { grantFile, clearChat, hasGrant, GRANT_KIND } = await freshModule();
  grantFile('chat-A', '/tmp/foo.txt', GRANT_KIND.READ);
  grantFile('chat-B', '/tmp/bar.txt', GRANT_KIND.READ);
  clearChat('chat-A');
  assert.equal(hasGrant('chat-A', '/tmp/foo.txt', GRANT_KIND.READ), false);
  assert.equal(hasGrant('chat-B', '/tmp/bar.txt', GRANT_KIND.READ), true);
});

test('clearChat() with no arg wipes everything (admin reset)', async () => {
  const { grantFile, clearChat, hasGrant, GRANT_KIND } = await freshModule();
  grantFile('chat-A', '/tmp/foo.txt', GRANT_KIND.READ);
  grantFile('chat-B', '/tmp/bar.txt', GRANT_KIND.READ);
  clearChat();
  assert.equal(hasGrant('chat-A', '/tmp/foo.txt', GRANT_KIND.READ), false);
  assert.equal(hasGrant('chat-B', '/tmp/bar.txt', GRANT_KIND.READ), false);
});

test('snapshot(chatId) reports current grants for that chat', async () => {
  const { grantFile, grantDir, snapshot, GRANT_KIND } = await freshModule();
  grantFile('chat-A', '/tmp/foo.txt', GRANT_KIND.READ);
  grantDir('chat-A', '/tmp/proj', [GRANT_KIND.READ, GRANT_KIND.WRITE]);
  const snap = snapshot('chat-A');
  assert.equal(snap.files.length, 1);
  assert.equal(snap.files[0].path, '/tmp/foo.txt');
  assert.deepEqual(snap.files[0].kinds, ['read']);
  assert.equal(snap.dirs.length, 1);
  assert.equal(snap.dirs[0].path, '/tmp/proj');
  assert.deepEqual(snap.dirs[0].kinds.sort(), ['read', 'write']);
});

test('parentDir helper returns dirname of an absolute path', async () => {
  const { parentDir } = await freshModule();
  assert.equal(parentDir('/tmp/foo/bar.txt'), '/tmp/foo');
  assert.equal(parentDir(''), '');
});

test('grantFile / grantDir with empty path are no-ops (no throw)', async () => {
  const { grantFile, grantDir, hasGrant, GRANT_KIND } = await freshModule();
  grantFile('chat-A', '', GRANT_KIND.READ);
  grantDir('chat-A', '', GRANT_KIND.READ);
  assert.equal(hasGrant('chat-A', '/tmp/foo.txt', GRANT_KIND.READ), false);
});

test('hasGrant with empty path / empty kind returns false', async () => {
  const { grantFile, hasGrant, GRANT_KIND } = await freshModule();
  grantFile('chat-A', '/tmp/foo.txt', GRANT_KIND.READ);
  assert.equal(hasGrant('chat-A', '', GRANT_KIND.READ), false);
  assert.equal(hasGrant('chat-A', '/tmp/foo.txt', ''), false);
});

test('default chat scope (no chatId) is isolated from named chats', async () => {
  const { grantFile, hasGrant, GRANT_KIND } = await freshModule();
  grantFile(undefined, '/tmp/foo.txt', GRANT_KIND.READ);
  assert.equal(hasGrant(undefined, '/tmp/foo.txt', GRANT_KIND.READ), true);
  assert.equal(hasGrant('chat-A', '/tmp/foo.txt', GRANT_KIND.READ), false);
});
