/**
 * dirfdOps.checked.test.js — pin the same-dirfd contract for
 * unlinkatChecked / symlinkatChecked (Codex round 13 follow-up #5).
 *
 * These primitives MUST do `open + fstat + compare + syscall + close`
 * inside one synchronous chain on a single dirfd — never re-open the
 * parent. The bare atomicUnlink / atomicSymlink helpers re-open the
 * parent on each call, which is fine for fresh approval flows but
 * unsafe when the caller has already validated parent {dev, ino} in
 * an earlier phase: a rmdir+mkdir between the validation and the
 * bare call would silently rebind to the new (different-inode)
 * parent and act on its same-named leaf.
 *
 * Tests verify:
 *   1. unlinkatChecked refuses with FILE_SAFETY_DENIED when the
 *      parent {dev, ino} provided no longer matches what the parent
 *      dirfd resolves to (parent was rmdir+mkdir replaced).
 *   2. symlinkatChecked refuses on the same condition (and does NOT
 *      create the link in the new parent).
 *   3. unlinkatChecked on a parent that still matches works.
 *   4. symlinkatChecked on a parent that still matches works.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  statSync,
  existsSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { unlinkatChecked, symlinkatChecked, openParentDirFd, _raw, C } from './dirfdOps.js';

async function withTmpParent(fn) {
  // realpathSync canonicalizes ancestor symlinks (e.g. macOS /tmp →
  // /private/tmp). openDirNoFollowChain (Phase 2B follow-up #4) walks
  // every component with O_NOFOLLOW, so non-canonical paths whose
  // ancestors traverse symlinks would ELOOP. Production callers pass
  // gate.resolvedTarget which is already realpath-canonical; tests
  // mirror that.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dirfd-checked-')));
  const parent = join(root, 'parent');
  mkdirSync(parent);
  try { await fn({ root, parent }); }
  finally { try { rmSync(root, { recursive: true, force: true }); } catch {} }
}

test('unlinkatChecked: parent {dev, ino} match → unlinkat succeeds', async () => {
  await withTmpParent(async ({ parent }) => {
    const leaf = 'a.txt';
    writeFileSync(join(parent, leaf), 'data');
    const st = statSync(parent);
    await unlinkatChecked(parent, leaf, st.dev, st.ino);
    assert.equal(existsSync(join(parent, leaf)), false);
  });
});

test('unlinkatChecked: parent rmdir+mkdir → FILE_SAFETY_DENIED, leaf NOT deleted', async () => {
  await withTmpParent(async ({ parent }) => {
    const leaf = 'a.txt';
    writeFileSync(join(parent, leaf), 'real');
    const stOld = statSync(parent);

    // Simulate "between probe and unlink" attacker swap: rmdir +
    // mkdir same path. New parent has a different inode + an
    // attacker-placed file at the same leaf name.
    rmSync(parent, { recursive: true });
    mkdirSync(parent);
    writeFileSync(join(parent, leaf), 'attacker');

    // Caller passes the OLD (stale) {dev, ino} — checked primitive
    // must catch it before unlinkat fires.
    let caught = null;
    try { await unlinkatChecked(parent, leaf, stOld.dev, stOld.ino); }
    catch (err) { caught = err; }
    assert.ok(caught, 'expected FILE_SAFETY_DENIED throw');
    assert.equal(caught.code, 'FILE_SAFETY_DENIED');
    assert.match(caught.message, /replaced \(inode\/device changed\)/);
    // Attacker file at the new parent's same leaf MUST be intact —
    // unlinkat must not have run.
    const fs = await import('node:fs');
    assert.equal(fs.readFileSync(join(parent, leaf), 'utf8'), 'attacker');
  });
});

test('symlinkatChecked: parent {dev, ino} match → symlink created with target string', async () => {
  await withTmpParent(async ({ parent }) => {
    const leaf = 'mylink';
    const st = statSync(parent);
    await symlinkatChecked(parent, leaf, '/some/target/path', st.dev, st.ino);
    assert.equal(readlinkSync(join(parent, leaf)), '/some/target/path');
  });
});

test('symlinkatChecked: parent rmdir+mkdir → FILE_SAFETY_DENIED, no link created', async () => {
  await withTmpParent(async ({ parent }) => {
    const leaf = 'mylink';
    const stOld = statSync(parent);

    rmSync(parent, { recursive: true });
    mkdirSync(parent);

    let caught = null;
    try { await symlinkatChecked(parent, leaf, '/etc/hosts', stOld.dev, stOld.ino); }
    catch (err) { caught = err; }
    assert.ok(caught, 'expected FILE_SAFETY_DENIED throw');
    assert.equal(caught.code, 'FILE_SAFETY_DENIED');
    // No link was created in the new parent.
    assert.equal(existsSync(join(parent, leaf)), false);
  });
});

// ─── Round 13 Phase 2B follow-up #4: openDirNoFollowChain ──────────

test('openParentDirFd: refuses path whose ancestor is a symlink (chain walk catches O_NOFOLLOW)', async () => {
  // Round 13 Phase 2B follow-up #4 (Codex 🔴): openParentDirFd now
  // walks every component of the path with O_DIRECTORY|O_NOFOLLOW.
  // If any ANCESTOR is a symlink (not just the leaf), the walk
  // throws ELOOP — closing the long-standing "single open() with
  // O_NOFOLLOW only protects the trailing component" hole.
  await withTmpParent(async ({ root }) => {
    // Plant a real dir + a symlink to it INSIDE the canonical root.
    // Using the canonical root sidesteps macOS's /tmp → /private/tmp
    // ancestor symlink (which we'd legitimately ELOOP on too).
    mkdirSync(join(root, 'realdir'));
    mkdirSync(join(root, 'realdir', 'subdir'));
    const linkParent = join(root, 'linkparent');
    symlinkSync(join(root, 'realdir'), linkParent);

    // Direct open of the canonical path works.
    const fd = openParentDirFd(join(root, 'realdir', 'subdir'));
    assert.ok(fd > 0, 'canonical chain opens');
    _raw.closeFd(fd);

    // But going through the symlinked ancestor must throw at the
    // "linkparent" segment — even though "subdir" is a real dir.
    // The exact error is platform-dependent: Linux throws ELOOP,
    // macOS throws ENOTDIR for openat(O_DIRECTORY|O_NOFOLLOW) on a
    // symlink. Both are valid rejection signals — what matters is
    // that we DO NOT silently traverse the symlink.
    let caught = null;
    try {
      openParentDirFd(join(linkParent, 'subdir'));
    } catch (err) { caught = err; }
    assert.ok(caught, 'expected throw');
    assert.ok(
      caught.code === 'ELOOP' || caught.code === 'ENOTDIR',
      `expected ELOOP or ENOTDIR, got ${caught.code}`,
    );
  });
});

test('openParentDirFd: ancestor swapped to symlink mid-walk → still throws ELOOP (no race window)', async () => {
  // Even though the symlink wasn't there when caller computed the
  // path, openDirNoFollowChain catches it at the segment that's
  // now a symlink. The chain is safe at every step.
  await withTmpParent(async ({ root }) => {
    mkdirSync(join(root, 'a'));
    mkdirSync(join(root, 'a', 'b'));

    // Now externally swap "a" to a symlink (race injection BEFORE
    // openParentDirFd runs — equivalent to attacker winning the race).
    rmSync(join(root, 'a'), { recursive: true });
    symlinkSync('/etc', join(root, 'a'));

    let caught = null;
    try { openParentDirFd(join(root, 'a', 'b')); }
    catch (err) { caught = err; }
    assert.ok(caught, 'expected throw at swapped ancestor');
    assert.ok(
      caught.code === 'ELOOP' || caught.code === 'ENOTDIR',
      `expected ELOOP or ENOTDIR, got ${caught.code}`,
    );
  });
});
