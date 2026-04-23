/**
 * xlsx generation service (exceljs-based).
 *
 * Accepts a declarative sheet spec and writes a real .xlsx file.  The LLM
 * tool layer (src/tools/builtins/xlsxTool.js) owns parameter validation and
 * workspace path resolution; this module stays pure-IO.
 *
 * Spec shape (stable)
 * -------------------
 *   {
 *     title?:    string,        // workbook title (metadata)
 *     author?:   string,        // workbook author (metadata)
 *     sheets: [
 *       {
 *         name:     string,     // sheet tab label (required)
 *         columns?: [{ header: string, key: string, width?: number,
 *                      numFmt?: string, style?: Style }],
 *         rows:     Array<Array<Cell> | Record<string, Cell>>,
 *         freezeHeader?: boolean,   // default true
 *         autoFilter?:   boolean,   // default true when columns present
 *         merges?: string[],        // e.g. ["A1:C1"]
 *       }
 *     ]
 *   }
 *
 * Style is forwarded straight to exceljs (font/alignment/border/fill).
 */

import { stat } from 'node:fs/promises';

const DEFAULT_CREATOR = 'Melo Desktop';

export async function writeXlsx(outputPath, spec) {
  if (!outputPath || typeof outputPath !== 'string') {
    throw new Error('outputPath required');
  }
  const normalized = normalizeSpec(spec);

  // Lazy-load so plain `node --import` flows don't pay the exceljs cost.
  const ExcelJS = (await import('exceljs')).default;

  const wb = new ExcelJS.Workbook();
  wb.creator = normalized.author || DEFAULT_CREATOR;
  wb.created = new Date();
  if (normalized.title) wb.description = normalized.title;

  for (const sheetSpec of normalized.sheets) {
    const sheet = wb.addWorksheet(sheetSpec.name);

    // Columns
    if (sheetSpec.columns.length) {
      sheet.columns = sheetSpec.columns.map((col) => ({
        header: col.header,
        key: col.key,
        width: Number.isFinite(col.width) ? col.width : Math.max(10, String(col.header).length + 2),
        style: col.style || undefined,
      }));
      // Header styling — bold + light grey fill by default.
      sheet.getRow(1).font = { bold: true };
      sheet.getRow(1).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFF3F3F3' },
      };
      // Per-column numFmt.
      sheetSpec.columns.forEach((col, idx) => {
        if (col.numFmt) sheet.getColumn(idx + 1).numFmt = col.numFmt;
      });
    }

    // Rows
    for (const row of sheetSpec.rows) {
      sheet.addRow(row);
    }

    // Merges
    for (const range of sheetSpec.merges || []) {
      try { sheet.mergeCells(range); } catch { /* bad range — skip */ }
    }

    // Freeze header row
    if (sheetSpec.freezeHeader !== false && sheetSpec.columns.length) {
      sheet.views = [{ state: 'frozen', ySplit: 1 }];
    }

    // Auto-filter over the whole table
    if (sheetSpec.autoFilter !== false && sheetSpec.columns.length && sheetSpec.rows.length) {
      const lastCol = sheet.columnCount;
      const lastRow = sheet.rowCount;
      sheet.autoFilter = {
        from: { row: 1, column: 1 },
        to: { row: lastRow, column: lastCol },
      };
    }
  }

  await wb.xlsx.writeFile(outputPath);
  const st = await stat(outputPath);
  return {
    path: outputPath,
    bytes: st.size,
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    sheets: normalized.sheets.length,
  };
}

/**
 * Normalize input — tolerate a range of shorthand inputs:
 *
 *   - Single sheet without wrapper:      { rows: [...] }
 *   - Columns as string array:           columns: ["Name", "Email"]
 *   - Rows as array-of-objects:          rows: [{ name: "A", email: "a@x" }]
 *
 * Normalization keeps the writer simple and the tool layer tolerant of
 * what the LLM actually emits.
 *
 * Exported for tests.
 */
export function normalizeSpec(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('spec must be an object');
  }

  // Single-sheet shorthand
  let sheets = input.sheets;
  if (!Array.isArray(sheets) || sheets.length === 0) {
    if (Array.isArray(input.rows)) {
      sheets = [{ name: input.name || 'Sheet1', columns: input.columns, rows: input.rows }];
    } else {
      throw new Error('spec.sheets[] or spec.rows[] required');
    }
  }

  const normSheets = sheets.map((s, i) => normalizeSheet(s, i));
  return {
    title: input.title || null,
    author: input.author || null,
    sheets: normSheets,
  };
}

function normalizeSheet(sheet, index) {
  if (!sheet || typeof sheet !== 'object') {
    throw new Error(`sheets[${index}] must be an object`);
  }
  const name = String(sheet.name || `Sheet${index + 1}`).slice(0, 31); // xlsx limit
  const rawColumns = sheet.columns;
  const rawRows = Array.isArray(sheet.rows) ? sheet.rows : [];

  // Columns can arrive as ["Header", ...] OR [{ header, key, ... }]
  let columns = [];
  if (Array.isArray(rawColumns)) {
    columns = rawColumns.map((c, idx) => {
      if (typeof c === 'string') {
        return { header: c, key: safeKey(c, idx), width: undefined };
      }
      if (c && typeof c === 'object') {
        const header = String(c.header || c.name || `Column ${idx + 1}`);
        return {
          header,
          key: c.key || safeKey(header, idx),
          width: Number.isFinite(c.width) ? c.width : undefined,
          numFmt: c.numFmt || c.format || undefined,
          style: c.style || undefined,
        };
      }
      return { header: `Column ${idx + 1}`, key: safeKey(null, idx) };
    });
  } else if (rawRows.length > 0 && rawRows[0] && typeof rawRows[0] === 'object' && !Array.isArray(rawRows[0])) {
    // Infer columns from first object row
    columns = Object.keys(rawRows[0]).map((k) => ({ header: k, key: k }));
  }

  // Rows — leave arrays alone (positional).  For object rows with an inferred
  // column set, exceljs resolves by key so no transformation needed.
  return {
    name,
    columns,
    rows: rawRows,
    freezeHeader: sheet.freezeHeader,
    autoFilter: sheet.autoFilter,
    merges: sheet.merges,
  };
}

function safeKey(header, idx) {
  const base = String(header || `c${idx}`)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return base || `c${idx}`;
}
