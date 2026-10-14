// ─── Workspace file service ──────────────────────────────────────────────────
// Path sanitation + safe read/write/list helpers for a project's workspace
// directory. Every function that touches the filesystem goes through the
// path-escape guard in resolveWorkspaceFilePath — callers cannot reach
// outside the workspace root even with `..` segments.
//
// This module owns:
//   - sanitizeWorkspacePath(rawPath, fallbackRoot) — normalize user input
//     (absolute vs relative) to an absolute path, falling back to the app
//     root when empty
//   - toRelativePath(rootPath, filePath) — relative() + POSIX-style slashes
//   - resolveWorkspaceFilePath(rootPath, relativePath) — throws if the
//     resolved path escapes rootPath; used by every file operation below
//   - extensionToLanguage(filePath) — file extension → highlight token for
//     the UI code viewer
//   - readWorkspaceFile(rootPath, relativeFilePath) — reads the file,
//     returns a preview object; handles binary detection (NUL byte sniff)
//     and truncation past MAX_FILE_PREVIEW_CHARS
//   - writeWorkspaceFile(rootPath, relativeFilePath, content) — mkdir -p
//     parent + write + re-read for the caller's UI refresh
//   - listWorkspaceEntries(rootPath) — depth-2 file tree with ignored dirs
//     (.git, node_modules, etc.) and capped at MAX_TREE_ENTRIES /
//     MAX_WORKSPACE_INDEXED_FILES
//
// Extracted from desktopStore.js in the Phase 7a refactor (see
// _refactor-backup/REFACTOR_PLAN.md). Pure module — only imports from
// node: modules. Constants are exported so desktopStore can keep its
// canonical copy too without drift.

import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { invalidateWorkspaceTree } from './workspaceTreeCache.js';
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  relative,
  resolve,
} from 'node:path';

export const MAX_TREE_ENTRIES = 160;
export const MAX_WORKSPACE_INDEXED_FILES = 4000;
export const MAX_FILE_PREVIEW_CHARS = 18000;

export const IGNORED_DIR_NAMES = new Set([
  '.git',
  '.tmp',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
  '.vite',
  'Melo.app',
]);

/**
 * Turn a possibly-empty / possibly-relative path into an absolute one.
 * Falls back to `fallbackRoot` when rawPath is missing — used by callers
 * that treat an unset workspace path as "use the app install directory".
 */
export { sanitizeWorkspacePath } from '../../domain/workspacePath.js';

export function toRelativePath(rootPath, filePath) {
  const relativePath = relative(rootPath, filePath);
  if (!relativePath || relativePath === '') {
    return '';
  }
  return relativePath.split('\\').join('/');
}

/**
 * Resolve a relative path under rootPath, throwing if the result escapes
 * the workspace (defence against ../ traversal).
 */
export function resolveWorkspaceFilePath(rootPath, relativePathValue) {
  const candidate = resolve(rootPath, relativePathValue || '.');
  const rel = relative(rootPath, candidate);

  if (rel.startsWith('..') || rel.includes(`..${basename('/')}`)) {
    throw new Error('File path escapes the workspace root.');
  }

  return candidate;
}

export function extensionToLanguage(filePath) {
  const ext = extname(filePath).replace(/^\./, '').toLowerCase();
  switch (ext) {
    case 'js':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'ts':
    case 'tsx':
      return 'typescript';
    case 'jsx':
      return 'jsx';
    case 'json':
      return 'json';
    case 'md':
      return 'markdown';
    case 'css':
      return 'css';
    case 'html':
      return 'html';
    case 'swift':
      return 'swift';
    case 'sh':
      return 'bash';
    case 'yml':
    case 'yaml':
      return 'yaml';
    case 'py':
      return 'python';
    default:
      return ext || 'text';
  }
}

export async function readWorkspaceFile(rootPath, relativeFilePath) {
  const absolutePath = resolveWorkspaceFilePath(rootPath, relativeFilePath);
  const fileStat = await stat(absolutePath);

  if (!fileStat.isFile()) {
    throw new Error('Selected path is not a file.');
  }

  const raw = await readFile(absolutePath);
  if (raw.includes(0)) {
    return {
      path: relativeFilePath,
      name: basename(relativeFilePath),
      language: extensionToLanguage(relativeFilePath),
      content: '[Binary file preview is not available.]',
      truncated: false,
      size: fileStat.size,
      isBinary: true,
    };
  }

  const text = raw.toString('utf8');
  const truncated = text.length > MAX_FILE_PREVIEW_CHARS;
  return {
    path: relativeFilePath,
    name: basename(relativeFilePath),
    language: extensionToLanguage(relativeFilePath),
    content: truncated ? `${text.slice(0, MAX_FILE_PREVIEW_CHARS)}\n\n... [truncated]` : text,
    truncated,
    size: fileStat.size,
    isBinary: false,
  };
}

export async function writeWorkspaceFile(rootPath, relativeFilePath, content) {
  const absolutePath = resolveWorkspaceFilePath(rootPath, relativeFilePath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, 'utf8');
  invalidateWorkspaceTree(rootPath);
  return readWorkspaceFile(rootPath, relativeFilePath);
}

export async function listWorkspaceEntries(rootPath) {
  const entries = [];
  const filePaths = [];

  async function walk(relativeDir, depth) {
    const absoluteDir = resolveWorkspaceFilePath(rootPath, relativeDir);
    const dirEntries = await readdir(absoluteDir, { withFileTypes: true });
    dirEntries.sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }));

    for (const entry of dirEntries) {
      if (entry.name === '.DS_Store') {
        continue;
      }

      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isDirectory() && IGNORED_DIR_NAMES.has(entry.name)) {
        continue;
      }

      if (entries.length < MAX_TREE_ENTRIES) {
        entries.push({
          id: relativePath,
          path: relativePath,
          name: entry.name,
          type: entry.isDirectory() ? 'directory' : 'file',
          depth,
          language: entry.isDirectory() ? null : extensionToLanguage(relativePath),
        });
      }

      if (entry.isDirectory()) {
        if (depth >= 2) {
          continue;
        }

        await walk(relativePath, depth + 1);
      } else if (filePaths.length < MAX_WORKSPACE_INDEXED_FILES) {
        filePaths.push(relativePath);
      }
    }
  }

  await walk('', 0);
  return { entries, filePaths };
}
