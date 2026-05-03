/**
 * dirfdOps.errno.test.js — pin the native addon errno → name contract.
 *
 * Codex round 13 follow-up #4 (2026-05-03): the native addon used to
 * set `err.code` to `strerror(errno)` (a human-readable string like
 * "Too many levels of symbolic links"), and JS callers compared
 * against errno *numbers* like `err.errno === 62` — both wrong:
 *   - strerror text varies by locale and is not the Node convention
 *   - errno numbers are platform-specific (ELOOP=62 on macOS, =40 on Linux)
 *
 * Fix: native maps errno → stable POSIX name via a lookup table; JS
 * compares `err.code === 'ELOOP'` everywhere. These tests pin that
 * contract so a future regression that swaps the mapping back to
 * strerror or breaks the name set is caught.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, openSync, closeSync, symlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { _raw, C } from './dirfdOps.js';

function withTmpDir(fn) {
  const tmp = mkdtempSync(join(tmpdir(), 'dirfd-errno-'));
  const dirfd = openSync(tmp, C.O_RDONLY | C.O_DIRECTORY);
  try { fn({ tmp, dirfd }); }
  finally {
    try { closeSync(dirfd); } catch {}
    try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

test('errno mapping: ENOENT (openat missing leaf)', () => {
  withTmpDir(({ dirfd }) => {
    let caught = null;
    try { _raw.openat(dirfd, 'no-such-file', C.O_RDONLY); } catch (err) { caught = err; }
    assert.ok(caught, 'expected throw');
    assert.equal(caught.code, 'ENOENT');
    assert.equal(caught.syscall, 'openat');
    // errno is still exposed but JS callers MUST NOT compare against it.
    assert.equal(typeof caught.errno, 'number');
  });
});

test('errno mapping: EEXIST (openat with O_CREAT|O_EXCL on existing leaf)', () => {
  withTmpDir(({ tmp, dirfd }) => {
    writeFileSync(join(tmp, 'x'), '');
    let caught = null;
    try {
      _raw.openat(dirfd, 'x', C.O_RDWR | C.O_CREAT | C.O_EXCL, 0o644);
    } catch (err) { caught = err; }
    assert.ok(caught, 'expected throw');
    assert.equal(caught.code, 'EEXIST');
  });
});

test('errno mapping: ELOOP (openat O_NOFOLLOW on a symlink leaf)', () => {
  withTmpDir(({ tmp, dirfd }) => {
    symlinkSync('/tmp', join(tmp, 'lnk'));
    let caught = null;
    try {
      _raw.openat(dirfd, 'lnk', C.O_RDONLY | C.O_NOFOLLOW);
    } catch (err) { caught = err; }
    assert.ok(caught, 'expected throw');
    assert.equal(caught.code, 'ELOOP');
  });
});

test('errno mapping: EBADF (openat with bogus dirfd)', () => {
  let caught = null;
  try { _raw.openat(-1, 'x', C.O_RDONLY); } catch (err) { caught = err; }
  assert.ok(caught, 'expected throw');
  assert.equal(caught.code, 'EBADF');
});

test('errno mapping: code is the symbolic name, NOT strerror text', () => {
  withTmpDir(({ dirfd }) => {
    let caught = null;
    try { _raw.openat(dirfd, 'no-such-file', C.O_RDONLY); } catch (err) { caught = err; }
    assert.equal(caught.code, 'ENOENT', 'code must be POSIX symbolic name');
    // Belt-and-suspenders: not the strerror text.
    assert.doesNotMatch(caught.code, /No such file/i);
    assert.doesNotMatch(caught.code, /not found/i);
  });
});
