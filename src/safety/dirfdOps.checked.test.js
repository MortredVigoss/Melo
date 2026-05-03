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
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { unlinkatChecked, symlinkatChecked } from './dirfdOps.js';

async function withTmpParent(fn) {
  const root = mkdtempSync(join(tmpdir(), 'dirfd-checked-'));
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
