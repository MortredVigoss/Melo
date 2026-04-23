/**
 * Built-in tool: file_write
 *
 * Creates a new file or completely overwrites an existing one.
 * Requires user permission — mutates disk.
 *
 * Use file_edit for targeted in-place edits; use file_write when:
 *   - Creating a file from scratch
 *   - The new content is entirely different from the original
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { isAbsolute, resolve, dirname } from 'node:path';

export const fileWriteTool = {
  id: 'file_write',
  name: 'FileWrite',
  description:
    'Create a new file or overwrite an existing file with the given content. ' +
    'Parent directories are created automatically. ' +
    'Use file_edit for targeted string replacements; use file_write for new files or full rewrites.',
  category: 'filesystem',
  requiresPermission: true,
  isConcurrencySafe: false,
  parametersSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute or workspace-relative path to write.',
      },
      content: {
        type: 'string',
        description: 'Full file content to write.',
      },
    },
    required: ['path', 'content'],
  },
  examples: [
    {
      path: 'src/utils/helpers.js',
      content: 'export function clamp(n, min, max) {\n  return Math.min(Math.max(n, min), max);\n}\n',
    },
  ],

  /**
   * @param {{ path: string, content: string }} args
   * @param {import('../tool.js').ToolRunContext} context
   * @returns {Promise<import('../tool.js').ToolResult>}
   */
  async run(args, context = {}) {
    const { path: filePath, content } = args;
    const { workspacePath } = context;

    if (typeof content !== 'string') {
      return { ok: false, output: 'content must be a string.', error: 'INVALID_CONTENT' };
    }

    const absPath = isAbsolute(filePath)
      ? filePath
      : resolve(workspacePath || process.cwd(), filePath);

    // Ensure parent directory exists
    try {
      await mkdir(dirname(absPath), { recursive: true });
    } catch (err) {
      return { ok: false, output: `Cannot create directory: ${err.message}`, error: err.message };
    }

    try {
      await writeFile(absPath, content, 'utf8');
    } catch (err) {
      return { ok: false, output: `Write error: ${err.message}`, error: err.message };
    }

    const lineCount = content.split('\n').length;
    return {
      ok: true,
      output: `Written ${absPath} — ${lineCount} line(s), ${content.length} bytes.`,
      meta: { path: absPath, lines: lineCount, bytes: content.length },
    };
  },
};
