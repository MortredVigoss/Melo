/**
 * Built-in tool: file_mkdir
 *
 * Phase 2A round 9 (2026-05-03): create a single directory through
 * the FileSafetyGate. file_write no longer auto-creates parent
 * dirs (kernel-level race risk without openat()), so this tool
 * fills the gap. Single-level only — to make /a/b/c, the agent
 * must call file_mkdir for /a, then /a/b, then /a/b/c.
 *
 * Each mkdir is a separate user-approved operation; the parent
 * directory must already exist and pass the same safety checks
 * as file_write (sensitivity, parent-inode anchor).
 */

import { mkdir, lstat } from 'node:fs/promises';
import { isAbsolute, resolve, dirname } from 'node:path';

import {
  requestWrite,
  commitOperation,
  precheckHardBlockedWrite,
  precheckParentDir,
  assertParentDirUnchanged,
  OP_KIND,
} from '../../safety/fileSafetyGate.js';

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

    // Refuse if path already exists (whatever it is — file, dir, or symlink).
    if (precheck.exists) {
      return {
        ok: false,
        output:
          `${absPath} already exists; file_mkdir refuses to create over an ` +
          `existing entry.`,
        error: 'TARGET_EXISTS',
      };
    }

    // ── 1b. Parent dir must exist + be a regular directory ────────────
    const parentPrecheck = await precheckParentDir(absPath);
    if (!parentPrecheck.ok) {
      return {
        ok: false,
        output:
          `Cannot create ${absPath}: parent directory ${parentPrecheck.parent} ` +
          `${parentPrecheck.error}. Create the parent directory first.`,
        error: parentPrecheck.error,
      };
    }

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
      });
    } catch (err) {
      return {
        ok: false,
        output: err.message,
        error: err.code === 'FILE_SAFETY_DENIED' ? 'DENIED' : 'GATE_ERROR',
        meta: { denied: err.code === 'FILE_SAFETY_DENIED' },
      };
    }

    // ── 3. Commit + parent re-anchor ──────────────────────────────────
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

    try {
      await assertParentDirUnchanged(absPath, parentPrecheck.ino);
    } catch (err) {
      return {
        ok: false,
        output: err.message,
        error: 'COMMIT_FAILED',
        meta: { lexicalPath: absPath, raceKind: 'parent-swap' },
      };
    }

    // ── 4. mkdir (single-level, no recursive) ─────────────────────────
    // No recursive flag — if intermediate parents are missing the
    // call will fail with ENOENT, which surfaces a clear error
    // rather than silently creating un-approved scaffold dirs.
    try {
      await mkdir(absPath, { recursive: false });
    } catch (err) {
      if (err && err.code === 'EEXIST') {
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
  },
};
