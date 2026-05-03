/**
 * Built-in tool: file_mkdir
 *
 * Round 13 (2026-05-03): use `mkdirat` syscall through a parent
 * dirfd. The parent dir is opened as O_DIRECTORY|O_NOFOLLOW (catches
 * symlinked-parent attack) then mkdirat creates the leaf relative to
 * the dirfd's inode — atomic with the dir-binding, no parent-swap
 * race window.
 *
 * Single-level only: to make /a/b/c, the agent must call file_mkdir
 * for /a, then /a/b, then /a/b/c. Each level is a separate
 * user-approved op (bypassGrants: true on the gate prompt).
 */

import { isAbsolute, resolve } from 'node:path';

import {
  requestWrite,
  commitOperation,
  precheckHardBlockedWrite,
  OP_KIND,
} from '../../safety/fileSafetyGate.js';
import {
  openParentDirFd,
  splitParentLeaf,
  _raw,
} from '../../safety/dirfdOps.js';
import { closeSync as closeFdSync, fstatSync } from 'node:fs';

export const fileMkdirTool = {
  id: 'file_mkdir',
  name: 'FileMkdir',
  description:
    'Create a single new directory at the given path. ' +
    'The parent directory must already exist as a regular directory; ' +
    'this tool does NOT recursively create intermediate parents — to ' +
    'make /a/b/c call file_mkdir three times. ' +
    'Sensitive paths (system, credential, $MELO_HOME) are hard-rejected. ' +
    'The user sees a confirmation dialog before any disk write.',
  category: 'filesystem',
  requiresPermission: true,
  isConcurrencySafe: false,
  parametersSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute or workspace-relative path of the directory to create.',
      },
    },
    required: ['path'],
  },
  examples: [
    { path: 'src/utils' },
  ],

  async run(args, context = {}) {
    const { path: dirPath } = args;
    const { workspacePath, sseEmitter, signal, chatId } = context;

    if (typeof dirPath !== 'string' || !dirPath) {
      return { ok: false, output: 'path must be a non-empty string.', error: 'INVALID_PATH' };
    }

    const absPath = isAbsolute(dirPath)
      ? dirPath
      : resolve(workspacePath || process.cwd(), dirPath);

    // ── 1. Sensitivity pre-check ───────────────────────────────────────
    const precheck = await precheckHardBlockedWrite(absPath);
    if (precheck.blocked) {
      return {
        ok: false,
        output: precheck.denyReason,
        error: 'DENIED',
        meta: { denied: true, category: precheck.category },
      };
    }

    if (precheck.exists) {
      return {
        ok: false,
        output: `${absPath} already exists; file_mkdir refuses to create over an existing entry.`,
        error: 'TARGET_EXISTS',
      };
    }

    const [parentDir, leafName] = splitParentLeaf(absPath);

    // ── 1b. Open parent dirfd (probe: must exist, real dir, not symlink) ──
    let parentFd = -1;
    let parentDevAtPrecheck;
    let parentInoAtPrecheck;
    try {
      parentFd = openParentDirFd(parentDir);
      const st = fstatSync(parentFd);
      parentDevAtPrecheck = st.dev;
      parentInoAtPrecheck = st.ino;
    } catch (err) {
      if (parentFd !== -1) { try { closeFdSync(parentFd); } catch {} }
      if (err.code === 'ENOENT') {
        return {
          ok: false,
          output: `Cannot create ${absPath}: parent directory ${parentDir} does not exist. Create the parent directory first.`,
          error: 'PARENT_NOT_FOUND',
        };
      }
      if (err.code === 'ELOOP') {
        return {
          ok: false,
          output: `Cannot create ${absPath}: parent ${parentDir} is a symlink.`,
          error: 'PARENT_NOT_DIR',
        };
      }
      if (err.code === 'ENOTDIR') {
        return {
          ok: false,
          output: `Cannot create ${absPath}: parent ${parentDir} is not a directory.`,
          error: 'PARENT_NOT_DIR',
        };
      }
      return {
        ok: false,
        output: `Cannot open parent ${parentDir}: ${err.message}`,
        error: err.message,
      };
    }
    // Close the precheck dirfd — we'll reopen for the real op so the
    // approval window can't hold a stale fd open. The fd lifecycle
    // here is just to capture {dev, ino} for cross-check.
    try { closeFdSync(parentFd); } catch {}
    parentFd = -1;

    // ── 2. UI approval ────────────────────────────────────────────────
    let approved;
    try {
      approved = await requestWrite({
        path: absPath,
        chatId,
        sseEmitter,
        signal,
        workspacePath,
        baseDir: workspacePath,
        isCreate: true,
        contentSize: 0,
        contentPreview: '(directory create — no content)',
        oldHash: null,
        newHash: null,
        diffPreview: null,
        bypassGrants: true,
      });
    } catch (err) {
      return {
        ok: false,
        output: err.message,
        error: err.code === 'FILE_SAFETY_DENIED' ? 'DENIED' : 'GATE_ERROR',
        meta: { denied: err.code === 'FILE_SAFETY_DENIED' },
      };
    }

    // ── 3. Commit ─────────────────────────────────────────────────────
    try {
      await commitOperation(approved.operationToken, {
        expectedKinds: [OP_KIND.WRITE_NEW, OP_KIND.WRITE_OVERWRITE],
      });
    } catch (err) {
      return {
        ok: false,
        output: `Atomic commit failed: ${err.message}`,
        error: 'COMMIT_FAILED',
      };
    }

    // ── 4. Reopen parent dirfd + cross-check + mkdirat ────────────────
    try {
      parentFd = openParentDirFd(parentDir);
    } catch (err) {
      if (err.code === 'ELOOP') {
        return {
          ok: false,
          output: `Parent ${parentDir} became a symlink between approval and mkdir.`,
          error: 'COMMIT_FAILED',
          meta: { lexicalPath: absPath, raceKind: 'parent-swap' },
        };
      }
      return {
        ok: false,
        output: `Cannot reopen parent ${parentDir}: ${err.message}`,
        error: err.message,
      };
    }

    try {
      const st = fstatSync(parentFd);
      if (st.dev !== parentDevAtPrecheck || st.ino !== parentInoAtPrecheck) {
        return {
          ok: false,
          output: `Parent ${parentDir} was replaced (inode/device changed) between approval and mkdir.`,
          error: 'COMMIT_FAILED',
          meta: { lexicalPath: absPath, raceKind: 'parent-swap' },
        };
      }

      try {
        _raw.mkdirat(parentFd, leafName, 0o755);
      } catch (err) {
        if (err.code === 'EEXIST' || err.errno === 17) {
          return {
            ok: false,
            output: `Target ${absPath} appeared between approval and mkdir.`,
            error: 'STALE_CONTENT',
            meta: { lexicalPath: absPath, raceKind: 'create-eexist' },
          };
        }
        return { ok: false, output: `Mkdir error: ${err.message}`, error: err.message };
      }

      return {
        ok: true,
        output: `Created directory ${absPath}.`,
        meta: { path: absPath, lexicalPath: absPath },
      };
    } finally {
      try { closeFdSync(parentFd); } catch {}
    }
  },
};
