/**
 * Built-in tool: file_edit
 *
 * Replaces an exact string occurrence in a file.
 * Requires user permission — mutates disk.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

export const fileEditTool = {
  id: 'file_edit',
  name: 'FileEdit',
  description:
    'Replace an exact string in a file with new content. ' +
    'The old_string must match exactly (including whitespace/indentation). ' +
    'Use file_read first to confirm the exact text to replace.',
  category: 'filesystem',
  requiresPermission: true,
  isConcurrencySafe: false,
  parametersSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute or workspace-relative path to the file.',
      },
      old_string: {
        type: 'string',
        description: 'Exact text to find and replace.',
      },
      new_string: {
        type: 'string',
        description: 'Text to substitute in place of old_string.',
      },
      replace_all: {
        type: 'boolean',
        description: 'Replace every occurrence of old_string instead of requiring a unique match. Useful for renaming variables/identifiers. Default: false.',
      },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  examples: [
    {
      path: 'src/index.js',
      old_string: 'const foo = 1;',
      new_string: 'const foo = 2;',
    },
    {
      path: 'src/index.js',
      old_string: 'oldFunctionName',
      new_string: 'newFunctionName',
      replace_all: true,
    },
  ],

  /**
   * @param {{ path: string, old_string: string, new_string: string, replace_all?: boolean }} args
   * @param {import('../tool.js').ToolRunContext} context
   * @returns {Promise<import('../tool.js').ToolResult>}
   */
  async run(args, context = {}) {
    const { path: filePath, old_string, new_string, replace_all = false } = args;
    const { workspacePath } = context;

    const absPath = isAbsolute(filePath)
      ? filePath
      : resolve(workspacePath || process.cwd(), filePath);

    let original;
    try {
      original = await readFile(absPath, 'utf8');
    } catch (err) {
      return { ok: false, output: `Cannot read file: ${err.message}`, error: err.message };
    }

    const count = original.split(old_string).length - 1;
    if (count === 0) {
      return {
        ok: false,
        output: `old_string not found in ${absPath}.\nMake sure to copy the exact text (including whitespace) from file_read output.`,
        error: 'NOT_FOUND',
      };
    }
    if (count > 1 && !replace_all) {
      return {
        ok: false,
        output: `old_string appears ${count} times in ${absPath}. Provide more surrounding context to make it unique, or set replace_all: true to replace all occurrences.`,
        error: 'AMBIGUOUS',
      };
    }

    // Replace one or all occurrences
    let updated;
    if (replace_all) {
      updated = original.split(old_string).join(new_string);
    } else {
      updated = original.replace(old_string, new_string);
    }

    try {
      await writeFile(absPath, updated, 'utf8');
    } catch (err) {
      return { ok: false, output: `Write error: ${err.message}`, error: err.message };
    }

    const oldLines = old_string.split('\n').length;
    const newLines = new_string.split('\n').length;
    const replaced = replace_all ? count : 1;

    return {
      ok: true,
      output: `Edited ${absPath} — replaced ${replaced} occurrence(s) of ${oldLines} line(s) with ${newLines} line(s).`,
      meta: { path: absPath, oldLines, newLines, occurrencesReplaced: replaced },
    };
  },
};
