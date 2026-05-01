/**
 * pdfkit-based structured PDF generation.
 *
 * Unlike the Playwright path in pdfTool.js (HTML → Chromium → print-to-PDF,
 * requires Node + Playwright + Chromium installed), pdfkit is a pure-JS PDF
 * builder with no browser dependency.  It's the right tool for document
 * layouts the LLM can describe declaratively (report, invoice, one-pager)
 * rather than arbitrary HTML.
 *
 * Spec shape (stable)
 * -------------------
 *   {
 *     title?:    string,
 *     author?:   string,
 *     subject?:  string,
 *     keywords?: string[] | string,
 *     pageSize?: 'A4' | 'LETTER' | 'LEGAL' | [width, height],  // default A4
 *     margins?:  { top:60, left:60, right:60, bottom:60 },     // default
 *
 *     sections: [
 *       { type: 'heading', level: 1|2|3, text: string },
 *       { type: 'paragraph', text: string, bold?, italic?, color?, align? },
 *       { type: 'list', ordered?: boolean, items: string[] },
 *       { type: 'table', columns: [{ header, width? }], rows: string[][] },
 *       { type: 'image', path: string, fit?: [w, h], align?: 'left'|'center'|'right' },
 *       { type: 'pageBreak' },
 *       { type: 'spacer',  height?: number },    // default 12
 *       { type: 'rule' },                         // horizontal rule
 *       { type: 'code', text: string },
 *     ]
 *   }
 *
 * The `sections` list is the source of truth for layout — no implicit
 * rendering of top-level title/author, so the caller always knows exactly
 * what goes on the page.
 */

import { createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';

const DEFAULT_MARGIN = 60;
const HEADING_SIZES = { 1: 22, 2: 18, 3: 15 };
const HEADING_GAP_BEFORE = { 1: 18, 2: 14, 3: 10 };
const HEADING_GAP_AFTER = { 1: 8, 2: 6, 3: 4 };
const BODY_SIZE = 11;
const CODE_SIZE = 10;
const BODY_LINE_GAP = 2;

export async function writeStructuredPdf(outputPath, spec) {
  if (!outputPath || typeof outputPath !== 'string') {
    throw new Error('outputPath required');
  }
  const normalized = normalizeSpec(spec);

  const { default: PDFDocument } = await import('pdfkit');

  // pdfkit v0.15 PDFSecurity.generateFileID() crashes when info.*
  // values are undefined (it tries to call .valueOf() on each one).
  // Build the info object with ONLY defined keys, and always include
  // CreationDate so pdfkit's metadata serialiser has something to
  // hash. Pre-existing bug surfaced by Batch C from_spec tests; fix
  // is local and applies to both `structured` and `from_spec
  // mode='rebuild' rebuildEngine='pdfkit'`.
  const info = { CreationDate: new Date() };
  if (normalized.title) info.Title = normalized.title;
  if (normalized.author) info.Author = normalized.author;
  if (normalized.subject) info.Subject = normalized.subject;
  if (normalized.keywords) info.Keywords = normalized.keywords;

  const doc = new PDFDocument({
    size: normalized.pageSize,
    margins: normalized.margins,
    info,
    autoFirstPage: true,
  });

  const stream = createWriteStream(outputPath);
  doc.pipe(stream);

  for (const section of normalized.sections) {
    renderSection(doc, section);
  }

  doc.end();
  await new Promise((resolveP, rejectP) => {
    stream.on('finish', resolveP);
    stream.on('error', rejectP);
  });

  const st = await stat(outputPath);
  return {
    path: outputPath,
    bytes: st.size,
    mimeType: 'application/pdf',
    sections: normalized.sections.length,
  };
}

// ─── Normalization ──────────────────────────────────────────────────────────

export function normalizeSpec(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('spec must be an object');
  }

  const sections = Array.isArray(input.sections) ? input.sections : [];

  // Tolerance: if the caller passed plain text/markdown in `content`,
  // convert it to a single paragraph section so pdfkit still has something
  // to render.  Full markdown parsing is delegated to the LLM — it knows
  // the structure; we just render.
  if (!sections.length && typeof input.content === 'string' && input.content.trim()) {
    sections.push({ type: 'paragraph', text: input.content });
  }

  if (!sections.length) throw new Error('spec.sections[] required (or spec.content string)');

  const pageSize = resolvePageSize(input.pageSize);
  const margins = resolveMargins(input.margins);

  const normSections = sections.map((s, i) => normalizeSection(s, i));

  return {
    title: input.title || null,
    author: input.author || null,
    subject: input.subject || null,
    keywords: Array.isArray(input.keywords) ? input.keywords.join(', ') : (input.keywords || null),
    pageSize,
    margins,
    sections: normSections,
  };
}

function resolvePageSize(size) {
  if (!size) return 'A4';
  if (Array.isArray(size) && size.length === 2) return size.map(Number);
  const s = String(size).toUpperCase();
  if (['A4', 'A3', 'A5', 'LETTER', 'LEGAL', 'TABLOID'].includes(s)) return s;
  return 'A4';
}

function resolveMargins(m) {
  if (!m || typeof m !== 'object') {
    return { top: DEFAULT_MARGIN, left: DEFAULT_MARGIN, right: DEFAULT_MARGIN, bottom: DEFAULT_MARGIN };
  }
  return {
    top: Number.isFinite(m.top) ? m.top : DEFAULT_MARGIN,
    left: Number.isFinite(m.left) ? m.left : DEFAULT_MARGIN,
    right: Number.isFinite(m.right) ? m.right : DEFAULT_MARGIN,
    bottom: Number.isFinite(m.bottom) ? m.bottom : DEFAULT_MARGIN,
  };
}

function normalizeSection(section, idx) {
  if (!section || typeof section !== 'object') {
    throw new Error(`sections[${idx}] must be an object`);
  }
  const type = String(section.type || '').toLowerCase();
  if (!type) throw new Error(`sections[${idx}].type required`);
  return { ...section, type };
}

// ─── Renderers ──────────────────────────────────────────────────────────────

function renderSection(doc, s) {
  switch (s.type) {
    case 'heading':   return renderHeading(doc, s);
    case 'paragraph': return renderParagraph(doc, s);
    case 'list':      return renderList(doc, s);
    case 'table':     return renderTable(doc, s);
    case 'image':     return renderImage(doc, s);
    case 'code':      return renderCode(doc, s);
    case 'pagebreak': return doc.addPage();
    case 'spacer':    return doc.moveDown(Number.isFinite(s.height) ? s.height / 12 : 1);
    case 'rule':      return renderRule(doc);
    default:
      // Unknown section — best-effort: render as a paragraph describing it.
      return renderParagraph(doc, { type: 'paragraph', text: `[unsupported section "${s.type}"]`, italic: true, color: '#888' });
  }
}

function renderHeading(doc, s) {
  const level = Math.max(1, Math.min(3, Number(s.level) || 1));
  const size = HEADING_SIZES[level];
  if (HEADING_GAP_BEFORE[level]) doc.moveDown(HEADING_GAP_BEFORE[level] / 12);
  doc.font('Helvetica-Bold').fontSize(size).fillColor('#111');
  doc.text(String(s.text || ''), { lineGap: 2 });
  if (HEADING_GAP_AFTER[level]) doc.moveDown(HEADING_GAP_AFTER[level] / 12);
}

function renderParagraph(doc, s) {
  const font = s.bold && s.italic ? 'Helvetica-BoldOblique'
             : s.bold              ? 'Helvetica-Bold'
             : s.italic            ? 'Helvetica-Oblique'
             :                       'Helvetica';
  doc.font(font).fontSize(BODY_SIZE).fillColor(s.color || '#222');
  doc.text(String(s.text || ''), {
    lineGap: BODY_LINE_GAP,
    align: s.align || 'left',
  });
  doc.moveDown(0.5);
}

function renderList(doc, s) {
  const items = Array.isArray(s.items) ? s.items : [];
  doc.font('Helvetica').fontSize(BODY_SIZE).fillColor('#222');
  items.forEach((item, idx) => {
    const bullet = s.ordered ? `${idx + 1}. ` : '•  ';
    doc.text(bullet + String(item), {
      indent: 12,
      lineGap: BODY_LINE_GAP,
    });
  });
  doc.moveDown(0.5);
}

function renderCode(doc, s) {
  doc.font('Courier').fontSize(CODE_SIZE).fillColor('#333');
  doc.text(String(s.text || ''), { lineGap: 1 });
  doc.moveDown(0.5);
}

function renderRule(doc) {
  const y = doc.y + 4;
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  doc.save().strokeColor('#ccc').lineWidth(0.5).moveTo(left, y).lineTo(right, y).stroke().restore();
  doc.moveDown(0.75);
}

function renderImage(doc, s) {
  if (!s.path) return;
  try {
    const opts = {};
    if (Array.isArray(s.fit) && s.fit.length === 2) opts.fit = s.fit.map(Number);
    if (s.align) opts.align = s.align;
    doc.image(s.path, opts);
    doc.moveDown(0.5);
  } catch (e) {
    renderParagraph(doc, {
      type: 'paragraph',
      text: `[image failed: ${s.path} — ${e.message}]`,
      italic: true,
      color: '#a00',
    });
  }
}

function renderTable(doc, s) {
  const columns = Array.isArray(s.columns) ? s.columns : [];
  const rows = Array.isArray(s.rows) ? s.rows : [];
  if (!columns.length || !rows.length) return;

  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const usable = right - left;

  // Column widths — honour explicit widths, distribute the rest.
  const explicit = columns.map((c) => (Number.isFinite(c.width) ? c.width : null));
  const explicitSum = explicit.reduce((a, w) => a + (w || 0), 0);
  const flexCount = explicit.filter((w) => w === null).length;
  const flexWidth = flexCount ? Math.max(40, (usable - explicitSum) / flexCount) : 0;
  const widths = explicit.map((w) => (w === null ? flexWidth : w));

  const rowH = BODY_SIZE * 1.6;
  const headerH = BODY_SIZE * 1.8;
  const padX = 6;

  let y = doc.y;

  // Header
  doc.save();
  doc.rect(left, y, usable, headerH).fill('#f3f3f3').stroke('#ccc');
  doc.restore();
  doc.font('Helvetica-Bold').fontSize(BODY_SIZE).fillColor('#111');
  let x = left;
  columns.forEach((col, i) => {
    doc.text(String(col.header || ''), x + padX, y + 4, { width: widths[i] - padX * 2 });
    x += widths[i];
  });
  y += headerH;

  // Rows
  doc.font('Helvetica').fontSize(BODY_SIZE).fillColor('#222');
  for (const row of rows) {
    // Page break
    if (y + rowH > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      y = doc.page.margins.top;
    }
    doc.save();
    doc.rect(left, y, usable, rowH).stroke('#e5e5e5');
    doc.restore();
    x = left;
    for (let i = 0; i < columns.length; i++) {
      const cell = Array.isArray(row) ? row[i] : row?.[columns[i].key];
      doc.text(cell == null ? '' : String(cell), x + padX, y + 4, {
        width: widths[i] - padX * 2,
        ellipsis: true,
      });
      x += widths[i];
    }
    y += rowH;
  }

  // Move cursor below the table.
  doc.y = y + 4;
  doc.moveDown(0.5);
}
