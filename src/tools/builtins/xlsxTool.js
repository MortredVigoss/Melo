/**
 * xlsx tool
 *
 * Generate .xlsx spreadsheets from a declarative sheet spec.  Output routes
 * through the same workspace + signed-URL pipeline as pdfTool/imageTool so
 * the assistant can inline a clickable link.
 *
 * Minimal example
 * ---------------
 *   {
 *     "sheets": [{
 *       "name": "Sales",
 *       "columns": ["Product", "Qty", "Price"],
 *       "rows": [
 *         ["Apple",  10, 1.20],
 *         ["Banana", 24, 0.40]
 *       ]
 *     }]
 *   }
 *
 * See src/services/export/xlsxGenerate.js for the full spec.
 */

import { mkdir } from 'node:fs/promises';
import { resolve, join, isAbsolute, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { signWorkspaceFileUrl } from '../../web/urlSigning.js';

const MAX_ROWS = 100_000;
const MAX_SHEETS = 32;

export const xlsxTool = {
  id: 'xlsx',
  name: 'Spreadsheet',
  description:
    'Generate a Microsoft Excel .xlsx spreadsheet from structured data. ' +
    'Accepts a JSON spec with `sheets[]`, each containing `name`, `columns[]` ' +
    '(string headers or {header,key,width,numFmt}), and `rows[]` (array-of-arrays or array-of-objects). ' +
    'Header row is bold+filled, first row is frozen, and an auto-filter is applied. ' +
    'Omit `path` to auto-save into the chat workspace and receive a displayable URL.',
  category: 'filesystem',
  isConcurrencySafe: true,
  requiresPermission: true,
  parametersSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Optional output file path (must end in .xlsx). Omit to auto-save into the chat workspace.',
      },
      title: { type: 'string', description: 'Workbook metadata — title/description.' },
      author: { type: 'string', description: 'Workbook metadata — author (default "Melo Desktop").' },
      sheets: {
        type: 'array',
        description: 'Array of sheet specs. See tool description for shape.',
        items: { type: 'object' },
      },
      // Single-sheet shorthand
      name:    { type: 'string',  description: 'Shorthand: single sheet name (used when top-level `rows` is provided).' },
      columns: { type: 'array',   description: 'Shorthand: single-sheet columns array.' },
      rows:    { type: 'array',   description: 'Shorthand: single-sheet rows array.' },
    },
  },
  examples: [
    {
      sheets: [
        {
          name: 'Summary',
          columns: [
            { header: 'Month', key: 'month', width: 12 },
            { header: 'Revenue', key: 'revenue', width: 14, numFmt: '"$"#,##0.00' },
          ],
          rows: [
            { month: 'Jan', revenue: 12500 },
            { month: 'Feb', revenue: 14200 },
          ],
        },
      ],
    },
    { name: 'Quick', columns: ['A', 'B'], rows: [[1, 2], [3, 4]] },
  ],

  async run(args, context = {}) {
    const { workspacePath } = context;
    const path = args?.path;

    // Resolve output path.
    let outPath;
    if (path) {
      if (!String(path).toLowerCase().endsWith('.xlsx')) {
        return { ok: false, output: 'Output path must end in .xlsx', error: 'INVALID_PARAMS' };
      }
      outPath = isAbsolute(path) ? path : (workspacePath ? resolve(workspacePath, path) : resolve(path));
    } else if (workspacePath) {
      const ts = Date.now().toString(36);
      const rand = randomBytes(4).toString('hex');
      outPath = join(workspacePath, 'generated', `xlsx-${ts}-${rand}.xlsx`);
    } else {
      return {
        ok: false,
        output: 'No workspace available and no "path" provided.',
        error: 'NO_OUTPUT_PATH',
      };
    }

    // Validate spec size so an oversized prompt can't blow up memory.
    const sheetsForCount = Array.isArray(args?.sheets) && args.sheets.length
      ? args.sheets
      : [{ rows: Array.isArray(args?.rows) ? args.rows : [] }];
    if (sheetsForCount.length > MAX_SHEETS) {
      return { ok: false, output: `Too many sheets (${sheetsForCount.length} > ${MAX_SHEETS}).`, error: 'INVALID_PARAMS' };
    }
    const totalRows = sheetsForCount.reduce((acc, s) => acc + (Array.isArray(s?.rows) ? s.rows.length : 0), 0);
    if (totalRows > MAX_ROWS) {
      return { ok: false, output: `Too many rows (${totalRows} > ${MAX_ROWS}).`, error: 'INVALID_PARAMS' };
    }

    try {
      await mkdir(dirname(outPath), { recursive: true });
    } catch { /* non-fatal */ }

    try {
      const { writeXlsx } = await import('../../services/export/xlsxGenerate.js');
      const result = await writeXlsx(outPath, args);
      let url = null;
      if (workspacePath && result.path.startsWith(workspacePath)) {
        try { url = signWorkspaceFileUrl(result.path); } catch { /* best-effort */ }
      }
      const label = url
        ? `Spreadsheet: ${url}\n(saved to ${result.path}, ${(result.bytes / 1024).toFixed(1)} KB, ${result.sheets} sheet${result.sheets === 1 ? '' : 's'})`
        : `Spreadsheet saved: ${result.path} (${(result.bytes / 1024).toFixed(1)} KB, ${result.sheets} sheet${result.sheets === 1 ? '' : 's'})`;
      return {
        ok: true,
        output: label,
        meta: { ...result, url },
      };
    } catch (err) {
      return { ok: false, output: `Failed to write xlsx: ${err.message}`, error: 'WRITE_FAILED' };
    }
  },
};
