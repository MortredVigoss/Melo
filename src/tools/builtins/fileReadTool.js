/**
 * Built-in tool: file_read
 *
 * Reads a file from disk and returns its content as text.
 * No permission required — read-only, safe.
 */

import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

const MAX_READ_BYTES = 200_000; // ~200 KB safety cap

export const fileReadTool = {
  id: 'file_read',
  name: 'FileRead',
  description:
    'Read the contents of a file at the given path. ' +
    'Returns the file text. ' +
    'Paths may be absolute or relative to the workspace root.',
  category: 'filesystem',
  requiresPermission: false,
  isConcurrencySafe: true,
  parametersSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute or workspace-relative path to the file.',
      },
      start_line: {
        type: 'number',
        description: 'First line to return (1-based, inclusive). Omit to start from line 1.',
      },
      end_line: {
        type: 'number',
        description: 'Last line to return (1-based, inclusive). Omit to read to end of file.',
      },
    },
    required: ['path'],
  },
  examples: [
    { path: 'src/index.js' },
    { path: 'src/index.js', start_line: 10, end_line: 50 },
  ],

  /**
   * @param {{ path: string, start_line?: number, end_line?: number }} args
   * @param {import('../tool.js').ToolRunContext} context
   * @returns {Promise<import('../tool.js').ToolResult>}
   */
  async run(args, context = {}) {
    const { path: filePath, start_line, end_line } = args;
    const { workspacePath } = context;

    const absPath = isAbsolute(filePath)
      ? filePath
      : resolve(workspacePath || process.cwd(), filePath);

    let stats;
    try {
      stats = await stat(absPath);
    } catch {
      return { ok: false, output: `File not found: ${absPath}`, error: 'ENOENT' };
    }

    if (!stats.isFile()) {
      return { ok: false, output: `Not a file: ${absPath}`, error: 'NOT_FILE' };
    }

    if (stats.size > MAX_READ_BYTES) {
      return {
        ok: false,
        output: `File too large (${(stats.size / 1024).toFixed(0)} KB). Use start_line/end_line to read a portion.`,
        error: 'FILE_TOO_LARGE',
      };
    }

    let text;
    try {
      text = await readFile(absPath, 'utf8');
    } catch (err) {
      return { ok: false, output: `Read error: ${err.message}`, error: err.message };
    }

    // Apply line range if requested
    if (start_line != null || end_line != null) {
      const lines = text.split('\n');
      const s = Math.max(1, start_line ?? 1) - 1;      // 0-indexed
      const e = Math.min(lines.length, end_line ?? lines.length); // inclusive 1-based → exclusive 0-based
      const slice = lines.slice(s, e);
      const numbered = slice.map((l, i) => `${s + i + 1}\t${l}`).join('\n');
      return {
        ok: true,
        output: numbered,
        meta: { path: absPath, lines: slice.length, totalLines: lines.length },
      };
    }

    const lines = text.split('\n');
    const numbered = lines.map((l, i) => `${i + 1}\t${l}`).join('\n');
    return {
      ok: true,
      output: numbered,
      meta: { path: absPath, lines: lines.length },
    };
  },
};
