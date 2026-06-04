/**
 * pdf tool
 *
 * Read: Extract text from local PDF files or PDF URLs using pdf-parse.
 * Write: Generate PDF from text/HTML/Markdown content using Playwright.
 *
 * Output routing (write action)
 * -----------------------------
 * When `path` is omitted, the generated PDF is written into the chat
 * workspace (`${workspacePath}/generated/pdf-<timestamp>-<rand>.pdf`) and the
 * tool returns a short-lived signed URL via `signWorkspaceFileUrl`. The UI
 * renders the URL as a linked attachment so the user can open or download the
 * file without knowing its on-disk path.
 *
 * If the caller supplies an explicit `path`, legacy behaviour is preserved:
 * write there, return the path.
 */

import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile, access, stat } from 'node:fs/promises';
import { resolve, extname, join, isAbsolute, dirname, basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import { signWorkspaceFileUrl } from '../../web/urlSigning.js';
import { gatedReadIntoBuffer } from '../../safety/gatedRead.js';
import {
  mergePdfs,
  splitPdf,
  deletePages,
  addWatermark,
  addPageNumbers,
  prependCover,
  applyInPlaceOverlays,
  writeBytes,
} from '../../services/export/pdfLibOps.js';
import { renderPdfPagesToPngs } from '../../services/export/pdfRender.js';
import {
  validateEditSpec,
  pickRebuildEngine,
  resolveSpecInputPath,
} from '../../services/export/pdfEditSpec.js';

const MAX_PDF_BYTES = 30 * 1024 * 1024; // 30MB
const PW_CLI_SESSION = 'melo-search';

// ─── Playwright CLI helper (shared with webSearchTool) ──────────────────────

function runPlaywrightCli(args, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'npx',
      ['-y', '@playwright/cli@latest', `-s=${PW_CLI_SESSION}`, '--raw', ...args],
      { timeout: timeoutMs, maxBuffer: 5 * 1024 * 1024, env: { ...process.env, NODE_NO_WARNINGS: '1' } },
      (err, stdout) => {
        if (err) return reject(err);
        resolve(stdout || '');
      },
    );
    child.stderr?.resume();
  });
}

// ─── Read PDF ───────────────────────────────────────────────────────────────

async function readPdfFromBuffer(buffer, source = '') {
  const { default: pdfParse } = await import('pdf-parse');
  const data = await pdfParse(buffer);
  const text = String(data?.text || '').trim();

  const meta = {
    pages: data.numpages || 0,
    title: data.info?.Title || '',
    author: data.info?.Author || '',
    creator: data.info?.Creator || '',
    source,
  };

  const metaLines = [
    `**Pages:** ${meta.pages}`,
    meta.title ? `**Title:** ${meta.title}` : '',
    meta.author ? `**Author:** ${meta.author}` : '',
    `**Source:** ${source}`,
  ].filter(Boolean);

  return {
    text: text.slice(0, 50_000),
    meta,
    formatted: metaLines.join('\n') + '\n\n---\n\n' + text.slice(0, 50_000),
  };
}

async function readPdfFromFile(filePath) {
  const absPath = resolve(filePath);
  await access(absPath); // throws if not found
  const buffer = await readFile(absPath);
  if (buffer.length > MAX_PDF_BYTES) {
    throw new Error(`PDF too large: ${(buffer.length / 1024 / 1024).toFixed(1)}MB (max ${MAX_PDF_BYTES / 1024 / 1024}MB)`);
  }
  return readPdfFromBuffer(buffer, absPath);
}

async function readPdfFromUrl(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > MAX_PDF_BYTES) {
    throw new Error(`PDF too large: ${(buffer.length / 1024 / 1024).toFixed(1)}MB`);
  }
  return readPdfFromBuffer(buffer, url);
}

// ─── Write PDF ──────────────────────────────────────────────────────────────

// HTML escape used by sectionsToHtml below. Escapes the four
// XML-significant characters so user content can't break out of
// the HTML structure we generate.
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// CSS-unit → PDF-points conversion. PDF points are the universal
// pdfkit/PDF unit (1 in = 72 pt). Browsers interpret `px` as 1/96 in
// regardless of physical DPI, so a 96 dpi conversion gives parity
// between an `<style>margin: 40px</style>` rendered by Playwright
// and a `margins: { top: 30 }` (= 40px in pt) on pdfkit.
//
// Supported units (everything else returns null → caller falls back
// to default per side):
//   pt — identity
//   px — 0.75 pt
//   in — 72 pt
//   cm — 28.3464567 pt
//   mm — 2.83464567 pt
//   em / rem — NOT supported (depends on font-size which we don't
//              know at conversion time). Returning null is honest.
const CSS_UNIT_TO_POINTS = {
  pt: 1,
  px: 0.75,
  in: 72,
  cm: 28.3464567,
  mm: 2.83464567,
};

// Parse a length value in CSS or numeric form. Returns the numeric
// PDF-points value, or null when the input is empty / unparseable /
// uses an unsupported unit.
function parseLengthToPoints(value) {
  if (value == null) return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const m = trimmed.match(/^(-?\d+(?:\.\d+)?)\s*([a-z%]*)$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = (m[2] || 'pt').toLowerCase();
  const factor = CSS_UNIT_TO_POINTS[unit];
  if (factor == null) return null;
  return n * factor;
}

// pdfkit's resolveMargins fallback per side.
const PDFKIT_DEFAULT_MARGIN_PT = 60;

// Normalise outputStyle.margins to a numeric points object that
// pdfkit's resolveMargins will accept. Codex review (Batch C round 2,
// 2026-05-01) caught that pdfkit silently ignored string / object-of-
// strings margins; without this helper the engine returned to its
// 60pt default whenever the user passed a CSS-shaped value.
//
// Three input shapes (matches marginsToCss):
//   string   — single CSS length applied to all 4 sides
//   number   — interpreted as pt, applied to all 4 sides
//   object   — { top, right, bottom, left }, each side parsed
//              independently. Missing or unparseable sides fall back
//              to PDFKIT_DEFAULT_MARGIN_PT for that side only.
//   anything else / null / undefined → 4 × default
//
// Exported for tests so the conversion table can be pinned without
// rendering an actual PDF.
export function marginsToPoints(margins) {
  const def = PDFKIT_DEFAULT_MARGIN_PT;
  if (margins == null) {
    return { top: def, right: def, bottom: def, left: def };
  }
  if (typeof margins === 'string' || typeof margins === 'number') {
    const v = parseLengthToPoints(margins);
    const x = v != null ? v : def;
    return { top: x, right: x, bottom: x, left: x };
  }
  if (typeof margins === 'object' && !Array.isArray(margins)) {
    const each = key => {
      const v = parseLengthToPoints(margins[key]);
      return v != null ? v : def;
    };
    return {
      top: each('top'),
      right: each('right'),
      bottom: each('bottom'),
      left: each('left'),
    };
  }
  return { top: def, right: def, bottom: def, left: def };
}

// CSS-value sanitizer. Codex review (Batch C round 2) flagged that
// fontFamily and margin values were being inlined into the
// `<style>` block without checking — a model could emit
// "}body{...}</style><script>fetch(...)</script><style>{" and break
// out of the style block. Playwright runs file:// URLs with full
// JavaScript privileges, so injection here is genuinely exploitable.
//
// Rule: allow only the characters that legitimately appear in CSS
// font-family / length values:
//   • letters, digits
//   • whitespace
//   • single + double quotes (font names: 'Noto Sans SC')
//   • hyphen, underscore, dot (font names: -apple-system, .SF Pro)
//   • comma (font fallback list)
//   • percent sign (lengths: 100%)
//   • forward slash (compound shorthands occasionally)
//
// Anything else — including `<`, `>`, `{`, `}`, `;`, `*`, `@`, `(`,
// `)`, `\` — gets the value rejected and we substitute the safe
// fallback (the helper returns null for the caller to react).
//
// Not a full CSS parser, on purpose. The point is to make injection
// impossible, not to validate every CSS spec edge case. If a user
// has a legitimate CSS value that contains restricted characters
// (rare), they can stop using from_spec and call writePdf with raw
// HTML directly.
const SAFE_CSS_VALUE_PATTERN = /^[\w\s'",\-_.%/]*$/;

export function sanitizeCssValue(value) {
  if (value == null) return null;
  const s = String(value);
  if (!s.trim()) return null;
  if (!SAFE_CSS_VALUE_PATTERN.test(s)) return null;
  return s;
}

// Normalise outputStyle.margins to a CSS shorthand string.
//
// pdfEditSpec.validateEditSpec accepts three shapes for `margins`:
//   • string  — "1in" / "20px" — passed through verbatim
//   • number  — interpreted as PDF points → "<n>pt"
//   • object {top,right,bottom,left} — shorthand
//                                      "<top> <right> <bottom> <left>"
//                                      (CSS expects all four for the
//                                      shorthand to apply per side;
//                                      missing sides fall back to the
//                                      40px default for that side)
//
// Codex review (2026-05-01 Batch C round) flagged that the html_
// playwright path silently reverted any object-form margins to the
// 40px default. Both the pdfkit and html_playwright engines now
// honour all three shapes.
//
// Exported for tests.
export function marginsToCss(margins) {
  if (margins == null) return '40px';
  if (typeof margins === 'string') return margins;
  if (typeof margins === 'number') {
    if (!Number.isFinite(margins)) return '40px';
    return `${margins}pt`;
  }
  if (typeof margins === 'object' && !Array.isArray(margins)) {
    const fmt = side => {
      const v = margins[side];
      if (v == null) return '40px';
      if (typeof v === 'number') return Number.isFinite(v) ? `${v}pt` : '40px';
      if (typeof v === 'string') return v;
      return '40px';
    };
    return `${fmt('top')} ${fmt('right')} ${fmt('bottom')} ${fmt('left')}`;
  }
  return '40px';
}

// Convert a rebuild spec's sections[] array into a self-contained
// HTML body. Used by from_spec when the rebuild engine routes to
// Playwright (CJK content / outputStyle.fontFamily wants browser
// font fallback). Keeps the same section vocabulary as the
// pdfkit-based action='structured' path so the model's spec is
// engine-agnostic — the renderer picks the engine based on
// language + style needs.
//
// Exported for tests so the document shape (single, non-nested,
// inline-style block) can be pinned without spinning up Playwright.
// Default fontFamily — used when outputStyle.fontFamily is absent
// OR fails CSS sanitization. Constant string ensures the default
// never mutates; the sanitizer is checked here too as a defence-in-
// depth assertion (would catch a refactor that breaks the constant).
const DEFAULT_HTML_FONT_FAMILY =
  "-apple-system, 'Noto Sans SC', 'Noto Sans JP', 'Noto Sans KR', sans-serif";

const DEFAULT_HTML_MARGIN_CSS = '40px';

export function sectionsToHtml(sections, outputStyle = {}) {
  // Sanitize style values BEFORE inlining into <style> block.
  // Sanitizer returns null on any input containing CSS-injection
  // chars (`<`, `>`, `{`, `}`, `;`, `@`, etc.) — falling back to
  // the constant defaults guarantees no model output can break out
  // of the style block to inject scripts. Playwright runs file://
  // pages with full JS privileges, so this matters.
  const fontFamily =
    sanitizeCssValue(outputStyle?.fontFamily) || DEFAULT_HTML_FONT_FAMILY;
  const marginCss = marginsToCss(outputStyle?.margins);
  const margin = sanitizeCssValue(marginCss) || DEFAULT_HTML_MARGIN_CSS;

  const body = sections.map(s => {
    if (!s || typeof s !== 'object' || typeof s.type !== 'string') return '';
    if (s.type === 'heading') {
      const level = Math.min(Math.max(parseInt(s.level, 10) || 1, 1), 6);
      return `<h${level}>${escapeHtml(s.text)}</h${level}>`;
    }
    if (s.type === 'paragraph') {
      return `<p>${escapeHtml(s.text)}</p>`;
    }
    if (s.type === 'list') {
      const tag = s.ordered ? 'ol' : 'ul';
      const items = (Array.isArray(s.items) ? s.items : [])
        .map(item => `<li>${escapeHtml(item)}</li>`)
        .join('');
      return `<${tag}>${items}</${tag}>`;
    }
    if (s.type === 'table') {
      const cols = Array.isArray(s.columns) ? s.columns : [];
      const rows = Array.isArray(s.rows) ? s.rows : [];
      const thead = cols
        .map(c => `<th>${escapeHtml(c?.header || '')}</th>`)
        .join('');
      // Mirror pdfkitGenerate.renderTable's read path:
      //   Array.isArray(row) ? row[i] : row?.[columns[i].key]
      // Codex review (Batch C round 5, 2026-05-02) caught that the
      // previous cut only handled array-form rows, swapping object-
      // form rows for an empty array. The result was `<tr></tr>` —
      // CJK row content silently lost. Now both row shapes render
      // correctly, and a column without a `key` declaration on an
      // object-form row outputs an empty `<td></td>` (same behaviour
      // as pdfkit, where an undeclared key yields an empty cell).
      const tbody = rows
        .map(row => {
          if (Array.isArray(row)) {
            return `<tr>${row.map(cell => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`;
          }
          if (row && typeof row === 'object') {
            const cells = cols
              .map(col => {
                if (!col || typeof col.key !== 'string') return '<td></td>';
                return `<td>${escapeHtml(row[col.key])}</td>`;
              })
              .join('');
            return `<tr>${cells}</tr>`;
          }
          return '<tr></tr>';
        })
        .join('');
      return `<table><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table>`;
    }
    if (s.type === 'image' && s.path) {
      // file:// gives Playwright direct disk access. Playwright's
      // default sandbox already restricts to local files, so this
      // is no extra exposure — same path the existing write+html
      // path uses.
      return `<img src="file://${escapeHtml(s.path)}" alt="" />`;
    }
    if (s.type === 'code') {
      return `<pre><code>${escapeHtml(s.text)}</code></pre>`;
    }
    if (s.type === 'rule') return '<hr />';
    if (s.type === 'spacer') return '<div style="height:24px"></div>';
    if (s.type === 'pageBreak') return '<div style="page-break-after: always;"></div>';
    return '';
  }).join('\n');

  return [
    '<!DOCTYPE html>',
    '<html><head><meta charset="utf-8">',
    '<style>',
    `  body { font-family: ${fontFamily}; margin: ${margin}; line-height: 1.6; color: #222; }`,
    '  h1 { font-size: 24px; margin-bottom: 8px; }',
    '  h2 { font-size: 20px; margin-bottom: 6px; }',
    '  h3 { font-size: 16px; margin-bottom: 4px; }',
    '  table { border-collapse: collapse; width: 100%; margin: 12px 0; }',
    '  th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }',
    '  th { background: #f5f5f5; }',
    '  pre code { display: block; padding: 12px; background: #f4f4f4; }',
    '  img { max-width: 100%; height: auto; }',
    '</style>',
    '</head><body>',
    body,
    '</body></html>',
  ].join('\n');
}

function markdownToHtml(md) {
  // Lightweight markdown → HTML for PDF generation
  return md
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>')
    .replace(/^\d+\. (.+)$/gm, '<li>$1</li>')
    .replace(/\n{2,}/g, '</p><p>')
    .replace(/\n/g, '<br>');
}

// Shared Playwright handoff. Takes a COMPLETE HTML document
// (`<!DOCTYPE html>` + `<html>` + `<head>` + `<body>`) and renders
// it to a PDF via the bundled @playwright/cli session.
//
// Why this is a separate helper from `writePdf`:
//   • `writePdf` is for the legacy `write` action which receives
//     raw user-supplied content (text/markdown/html) and needs to
//     wrap it in our default scaffold + style.
//   • `from_spec rebuild html_playwright` already has a complete
//     HTML document built by sectionsToHtml — wrapping it again
//     creates a nested document where the outer style block is
//     dead. Codex review (2026-05-01 round) flagged this.
//   • Sharing the temp-file + spawn cleanup logic means a future
//     fix to the Playwright invocation lives in one place.
async function htmlToPdfWithPlaywright(fullHtml, outputPath) {
  const absPath = resolve(outputPath);
  const tmpHtml = absPath.replace(/\.pdf$/i, '') + '.tmp.html';
  await writeFile(tmpHtml, fullHtml, 'utf8');
  try {
    await runPlaywrightCli(['open', `file://${tmpHtml}`], 15_000);
    await runPlaywrightCli(['pdf', absPath], 20_000);
  } finally {
    const { unlink } = await import('node:fs/promises');
    unlink(tmpHtml).catch(() => {});
  }
  const st = await stat(absPath);
  return { path: absPath, size: st.size };
}

async function writePdf(outputPath, content, format = 'text') {
  let htmlBody;
  if (format === 'html') {
    htmlBody = content;
  } else if (format === 'markdown') {
    htmlBody = markdownToHtml(content);
  } else {
    // plain text
    htmlBody = `<pre style="white-space:pre-wrap;word-wrap:break-word;font-family:sans-serif;font-size:14px;line-height:1.6">${
      content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    }</pre>`;
  }

  const fullHtml = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  body { font-family: -apple-system, 'Noto Sans SC', 'Noto Sans KR', sans-serif;
         margin: 40px; line-height: 1.6; color: #222; }
  h1 { font-size: 24px; margin-bottom: 8px; }
  h2 { font-size: 20px; margin-bottom: 6px; }
  h3 { font-size: 16px; margin-bottom: 4px; }
  code { background: #f4f4f4; padding: 2px 4px; border-radius: 3px; font-size: 13px; }
  pre code { display: block; padding: 12px; overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0; }
  th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
  th { background: #f5f5f5; }
</style>
</head><body>${htmlBody}</body></html>`;

  return await htmlToPdfWithPlaywright(fullHtml, outputPath);
}

// ─── Tool definition ──────────────────────────────────────────────────────────

export const pdfTool = {
  id: 'pdf',
  name: 'PDF',
  description:
    'PDF tool — read, generate, manipulate, and render PDF files. Actions:\n' +
    '• read       — extract text from a local PDF file or URL (pdf-parse).\n' +
    '• write      — generate a PDF from text/Markdown/HTML via Playwright. PREFERRED for content-heavy or CJK output (handles Chinese/Japanese/Korean reliably).\n' +
    '• structured — declarative sections[] → PDF via pdfkit (no browser dep). Best for invoices, one-pagers, simple reports.\n' +
    '• merge      — concatenate multiple source PDFs in order.\n' +
    '• split      — extract a page range from a PDF into a new PDF.\n' +
    '• delete_pages — remove specified pages, keep the rest.\n' +
    '• watermark  — stamp a Latin-only text watermark on every page (Helvetica, no CJK).\n' +
    '• add_page_numbers — stamp Latin-only page numbers (Helvetica, no CJK).\n' +
    '• prepend_cover — concatenate a cover PDF onto the front of an existing PDF.\n' +
'• render     — rasterise pages of a PDF to PNG images (pdftoppm; user must `brew install poppler` once). Returns signed image URLs you can read back as visual references.\n' +
    '• from_spec  — execute a structured PDF edit-spec (JSON) describing either an in-place overlay (text/image/metadata/form fields on top of an existing PDF) OR a full rebuild (sections[] → new PDF, engine auto-picked by language hint). Use this when the model wants to plan the edit in JSON first instead of stringing together multiple tool calls. See the schema notes on the `editSpec` parameter below.\n' +
    'CJK caveat: watermark / add_page_numbers use Helvetica StandardFont and reject non-ASCII text. Use write/structured + Playwright for CJK content.\n\n' +
    'VISUAL REVIEW WORKFLOW — apply this whenever you generate a non-trivial PDF (write / structured / merge / multi-step pipeline):\n' +
    '1. Generate the PDF as usual. Save the output URL — that\'s what the user gets in the end.\n' +
    '2. Immediately call `render` on the same PDF (pageRange: "1-3" is enough for sanity, full doc for reports), then read the returned page-image URLs as visual references.\n' +
    '3. Self-check the rendered pages for: layout (titles centred? table cells aligned? content overflowing the margin?), font (CJK rendering or showing as ▢▢ tofu? characters cut off? bold/italic preserved?), content fidelity (every section the user asked for present? page order correct? page numbers / footers right?).\n' +
    '4. If something is broken, FIX and re-render — common fixes: switch from `structured` (pdfkit) to `write` (HTML+Playwright) for CJK / complex layout; widen margins; chunk long sections across pages; embed images via base64 in the HTML.\n' +
    '5. Once visually verified, return the FINAL PDF URL to the user. Do NOT echo the rendered page-PNG URLs to the user — those were just for your own QA. The user wants the document, not its screenshots.\n' +
    'Skip the loop only when: (a) the user explicitly says "don\'t bother reviewing" / "just generate it", (b) the PDF is trivial (single short page), or (c) `render` errors with the poppler-not-installed hint — then surface the install hint to the user and skip self-review.',
  category: 'filesystem',
  isConcurrencySafe: true,
  requiresPermission: true,
  parametersSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [
          'read',
          'write',
          'structured',
          'merge',
          'split',
          'delete_pages',
          'watermark',
          'add_page_numbers',
          'prepend_cover',
          'render',
          'from_spec',
        ],
        description: 'See tool description for the action menu.',
      },
      path: {
        type: 'string',
        description:
          'For read: local file path or URL to a PDF. ' +
          'For write/structured/merge/split/delete_pages/watermark/add_page_numbers/prepend_cover: optional output file path (must end in .pdf). ' +
          'For split / delete_pages / watermark / add_page_numbers / prepend_cover / render: this is also the SOURCE PDF when source is omitted (the action operates in place into a new file). ' +
          'If omitted on write/structured, the PDF is auto-saved into the chat workspace and a displayable URL is returned.',
      },
      content: {
        type: 'string',
        description: 'For write only: the content to put in the PDF.',
      },
      format: {
        type: 'string',
        enum: ['text', 'markdown', 'html'],
        description: 'For write only: format of the content. Default: "text".',
        default: 'text',
      },
      sections: {
        type: 'array',
        description:
          'For structured only: array of section objects, each with a `type` field. ' +
          'Supported types: heading (level 1-3), paragraph, list (ordered?, items[]), table (columns[], rows[]), image (path), code, rule, spacer, pageBreak.',
        items: { type: 'object' },
      },
      title:    { type: 'string', description: 'For structured: document title metadata.' },
      author:   { type: 'string', description: 'For structured: document author metadata.' },
      subject:  { type: 'string', description: 'For structured: document subject metadata.' },
      pageSize: { type: 'string', description: 'For structured: A4 | LETTER | LEGAL. Default A4.' },
      pages: {
        type: 'string',
        description: 'For read: page range note in output, e.g. "1-5", "3", "10-20". Default: all pages.',
      },
      // ─── Action-specific inputs (all optional unless documented) ───────────
      source: {
        type: 'string',
        description:
          'For split / delete_pages / watermark / add_page_numbers / prepend_cover / render: source PDF path. ' +
          'Either `source` or `path` is required. When both are provided, `source` is the input and `path` is the output (must end in .pdf). When only `path` is provided, it is treated as the input and a new output path is auto-allocated. ' +
          'Relative paths resolve against the chat workspace (matches the rest of melo) — pass an absolute path to escape that.',
      },
      sources: {
        type: 'array',
        description:
          'For merge only: list of 2+ source PDF paths to concatenate in order. Required.',
        items: { type: 'string' },
      },
      pageRange: {
        type: 'string',
        description:
          'For split / delete_pages / render: page range to operate on. Examples: "3" (single page), "1-5", "1-3,7,10-12" (multi-range, split/delete only — render takes a single range). 1-indexed.',
      },
      watermarkText: {
        type: 'string',
        description: 'For watermark: ASCII / Latin-only text to stamp on every page (Helvetica StandardFont; CJK not supported).',
      },
      watermarkOpacity: {
        type: 'number',
        description: 'For watermark: opacity 0.0–1.0. Default 0.25.',
      },
      watermarkAngle: {
        type: 'number',
        description: 'For watermark: rotation in degrees. Default -45.',
      },
      watermarkFontSize: {
        type: 'number',
        description: 'For watermark: font size in points. Default 60.',
      },
      pageNumberFormat: {
        type: 'string',
        description: 'For add_page_numbers: format with {n} and {total} placeholders. Default "{n} / {total}". ASCII only.',
      },
      pageNumberPosition: {
        type: 'string',
        enum: ['bottom-center', 'bottom-right', 'bottom-left', 'top-center', 'top-right', 'top-left'],
        description: 'For add_page_numbers: which margin slot. Default "bottom-center".',
      },
      coverPath: {
        type: 'string',
        description: 'For prepend_cover: path to the cover PDF that will be inserted before the source.',
      },
      renderScale: {
        type: 'number',
        description: 'For render: pixel scale (2 → 144dpi default; 1 → 72dpi). Range 1–8.',
      },
      editSpec: {
        type: 'object',
        description:
          'For from_spec only: structured PDF edit specification.\n' +
          'Shape:\n' +
          '  { mode: "in_place_overlay" | "rebuild",\n' +
          '    // mode="in_place_overlay" — pdf-lib operations on an existing PDF.\n' +
          '    // Cannot do textual replacement (pdf-lib doesn\'t reflow); use rebuild for that.\n' +
          '    sourcePdf: string,            // required for in_place_overlay\n' +
          '    overlays?: [\n' +
          '      { type: "text", page: 1+, x, y, text, fontSize?, color?: [r,g,b in 0..1] },\n' +
          '      { type: "image", page: 1+, x, y, imagePath, width?, height? },\n' +
          '    ],\n' +
          '    metadata?: { title?, author?, subject? },\n' +
          '    formFields?: [{ name, value }],\n' +
          '\n' +
          '    // mode="rebuild" — generate a fresh PDF from sections[].\n' +
          '    sections: [...],              // required, same shape as action="structured" sections[]\n' +
          '    sourcePdf?: string,           // optional reference (e.g. for the model\'s own context)\n' +
          '    outputStyle?: { language?: "zh-CN" | "en-US" | ..., fontFamily?: CSS string,\n' +
          '                    pageSize?: "A4" | "LETTER" | "LEGAL", margins?: string | {top,right,bottom,left} },\n' +
          '    rebuildEngine?: "auto" | "pdfkit" | "html_playwright"  // auto routes by language\n' +
          '  }\n' +
          'CJK in overlays is rejected (Helvetica StandardFont has no CJK). Use mode="rebuild" for CJK content.\n' +
          'in_place_overlay caveat: PDF format does NOT support reliable text REPLACEMENT — overlays add new content on top, they do not modify existing text. To swap "5.5" for "gpt", use mode="rebuild".',
      },
    },
    required: ['action'],
  },
  examples: [
    { action: 'read', path: '/Users/me/doc.pdf' },
    { action: 'read', path: 'https://example.com/report.pdf' },
    { action: 'write', path: '/Users/me/output.pdf', content: '# Report\n\nHello world', format: 'markdown' },
    {
      action: 'structured',
      title: 'Q1 Sales',
      sections: [
        { type: 'heading', level: 1, text: 'Q1 Sales Report' },
        { type: 'paragraph', text: 'Summary of Q1 performance.' },
        {
          type: 'table',
          columns: [{ header: 'Region' }, { header: 'Revenue' }],
          rows: [['North', '$125k'], ['South', '$98k']],
        },
      ],
    },
  ],

  async run(args, context = {}) {
    const {
      action,
      path,
      content,
      format = 'text',
      pages,
      // ── new action-specific args ───────────────────────────────────────────
      source,
      sources,
      pageRange,
      watermarkText,
      watermarkOpacity,
      watermarkAngle,
      watermarkFontSize,
      pageNumberFormat,
      pageNumberPosition,
      coverPath,
      renderScale,
      editSpec,
    } = args || {};
    const { signal, workspacePath, sseEmitter, chatId } = context;
    if (!action) {
      return { ok: false, output: 'Missing required parameter: action.', error: 'INVALID_PARAMS' };
    }

    // Resolve a writable .pdf output path. Same rules as the original
    // write/structured branches:
    //   1. explicit absolute path  → use as-is
    //   2. explicit relative path + workspacePath → relative to workspace
    //   3. no path + workspacePath → auto-allocate <ws>/generated/pdf-…pdf
    //   4. otherwise → null (caller returns NO_OUTPUT_PATH)
    function allocatePdfOutputPath(maybePath) {
      if (maybePath) {
        if (!maybePath.toLowerCase().endsWith('.pdf')) {
          return { error: 'Output path must end in .pdf', errorCode: 'INVALID_PARAMS' };
        }
        const abs = isAbsolute(maybePath)
          ? maybePath
          : workspacePath
            ? resolve(workspacePath, maybePath)
            : resolve(maybePath);
        return { path: abs };
      }
      if (!workspacePath) {
        return {
          error: 'No workspace available and no "path" provided.',
          errorCode: 'NO_OUTPUT_PATH',
        };
      }
      const ts = Date.now().toString(36);
      const rand = randomBytes(4).toString('hex');
      return { path: join(workspacePath, 'generated', `pdf-${ts}-${rand}.pdf`) };
    }

    // Resolve the source PDF for in-place actions
    // (split / delete_pages / watermark / add_page_numbers / prepend_cover /
    // render). The user can either:
    //   a) pass `source` explicitly + `path` as the output target, or
    //   b) pass only `path` — we treat it as the source AND auto-allocate
    //      a sibling output path under workspace/generated/.
    // Codex review (2026-05-01) caught the path-asymmetry bug: outputs
    // resolved relative to `workspacePath`, but inputs (source / path-
    // as-source / coverPath) resolved relative to process.cwd(). The
    // user mental model is "everything in the workspace unless absolute"
    // — same as every other melo tool — so input paths now use this
    // helper. Returns null on bad input (caller produces the user-
    // facing error so it can mention which field).
    function resolveInputPdfPath(p) {
      if (typeof p !== 'string' || !p.trim()) return null;
      if (isAbsolute(p)) return p;
      if (workspacePath) return resolve(workspacePath, p);
      return resolve(p);
    }

    // Phase 2C (2026-05-04): every source PDF read goes through the
    // FileSafetyGate + dirfd-bound atomicOpenLeaf and returns a
    // Buffer. Callers pass the buffer to pdfLibOps (which now accepts
    // either a path or a Buffer via loadBytes). Result: pdf-lib never
    // re-opens a path, so the post-approval TOCTOU window is closed.
    //
    // Returns { ok:true, buffer } or a Tool-shape error result the
    // caller can early-return.
    async function gateAndRead(absPath) {
      const gated = await gatedReadIntoBuffer(absPath, { workspacePath, sseEmitter, signal, chatId }, {
        maxBytes: MAX_PDF_BYTES,
        toolName: `pdf:${action}`,
      });
      if (!gated.ok) return { ok: false, output: gated.output, error: gated.error, meta: gated.meta };
      return { ok: true, buffer: gated.buffer, realPath: gated.realPath };
    }

    function resolveSourceAndOutput() {
      if (source) {
        if (!source.toLowerCase().endsWith('.pdf')) {
          return { error: '`source` must end in .pdf', errorCode: 'INVALID_PARAMS' };
        }
        const srcPath = resolveInputPdfPath(source);
        const out = allocatePdfOutputPath(path);
        if (out.error) return { error: out.error, errorCode: out.errorCode };
        return { srcPath, outPath: out.path };
      }
      // No explicit source → `path` is the source. Auto-allocate output.
      if (!path) {
        return {
          error: 'Provide either `source` (with optional `path` output) or `path` (used as source).',
          errorCode: 'INVALID_PARAMS',
        };
      }
      if (!path.toLowerCase().endsWith('.pdf')) {
        return { error: '`path` must end in .pdf when used as source', errorCode: 'INVALID_PARAMS' };
      }
      const srcPath = resolveInputPdfPath(path);
      const out = allocatePdfOutputPath(null);
      if (out.error) return { error: out.error, errorCode: out.errorCode };
      return { srcPath, outPath: out.path };
    }

    // Wrap the result of a successful write into the standard
    // {ok, output, meta} response, including the signed URL when the
    // output landed inside the chat workspace.
    function buildWriteResponse(outPath, byteCount, extraMeta = {}, label) {
      let url = null;
      if (workspacePath && outPath.startsWith(workspacePath)) {
        try { url = signWorkspaceFileUrl(outPath); } catch { /* best-effort */ }
      }
      const sizeKb = (byteCount / 1024).toFixed(1);
      const lead = label || 'PDF';
      const text = url
        ? `${lead}: ${url}\n(saved to ${outPath}, ${sizeKb} KB)`
        : `${lead} created: ${outPath} (${sizeKb} KB)`;
      return {
        ok: true,
        output: text,
        meta: { path: outPath, bytes: byteCount, url, ...extraMeta },
      };
    }

    if (action === 'read') {
      if (!path) {
        return { ok: false, output: 'Missing "path" for read action.', error: 'INVALID_PARAMS' };
      }
      try {
        const isUrl = /^https?:\/\//i.test(path);
        let result;
        if (isUrl) {
          // URL fetches don't touch local fs — no gate needed.
          result = await readPdfFromUrl(path);
        } else {
          // Phase 2C (2026-05-04): gate the local read. The buffer
          // returned by gatedReadIntoBuffer is what pdf-parse consumes,
          // so the underlying library never re-opens the path (no
          // post-approval TOCTOU window).
          const absPath = isAbsolute(path) ? path : resolve(workspacePath || process.cwd(), path);
          const gated = await gatedReadIntoBuffer(absPath, { workspacePath, sseEmitter, signal, chatId }, {
            maxBytes: MAX_PDF_BYTES,
            toolName: 'pdf:read',
          });
          if (!gated.ok) {
            return { ok: false, output: gated.output, error: gated.error, meta: gated.meta };
          }
          result = await readPdfFromBuffer(gated.buffer, gated.realPath);
        }

        // Page filtering
        if (pages && result.text) {
          // pdf-parse doesn't give per-page offsets easily, so we just note the range in output
          return {
            ok: true,
            output: `${result.formatted}\n\n*(Note: page range "${pages}" requested — pdf-parse extracts all text; page boundaries are approximate.)*`,
            meta: result.meta,
          };
        }

        return { ok: true, output: result.formatted, meta: result.meta };
      } catch (err) {
        return { ok: false, output: `Failed to read PDF: ${err.message}`, error: 'READ_FAILED' };
      }
    }

    if (action === 'write') {
      if (!content) {
        return { ok: false, output: 'Missing "content" for write action.', error: 'INVALID_PARAMS' };
      }
      const outAlloc = allocatePdfOutputPath(path);
      if (outAlloc.error) {
        return { ok: false, output: outAlloc.error, error: outAlloc.errorCode || 'INVALID_PARAMS' };
      }
      try { await mkdir(dirname(outAlloc.path), { recursive: true }); } catch { /* non-fatal */ }
      try {
        const result = await writePdf(outAlloc.path, content, format);
        return buildWriteResponse(result.path, result.size);
      } catch (err) {
        return { ok: false, output: `Failed to write PDF: ${err.message}`, error: 'WRITE_FAILED' };
      }
    }

    if (action === 'structured') {
      const outAlloc = allocatePdfOutputPath(path);
      if (outAlloc.error) {
        return { ok: false, output: outAlloc.error, error: outAlloc.errorCode || 'INVALID_PARAMS' };
      }
      try { await mkdir(dirname(outAlloc.path), { recursive: true }); } catch { /* non-fatal */ }
      try {
        const { writeStructuredPdf } = await import('../../services/export/pdfkitGenerate.js');
        const result = await writeStructuredPdf(outAlloc.path, args);
        return buildWriteResponse(result.path, result.bytes, {
          sections: result.sections,
          engine: 'pdfkit',
        });
      } catch (err) {
        return { ok: false, output: `Failed to write structured PDF: ${err.message}`, error: 'WRITE_FAILED' };
      }
    }

    // ─── merge ───────────────────────────────────────────────────────────────
    if (action === 'merge') {
      if (!Array.isArray(sources) || sources.length < 2) {
        return { ok: false, output: 'merge: provide `sources` (array of 2+ PDF paths).', error: 'INVALID_PARAMS' };
      }
      const outAlloc = allocatePdfOutputPath(path);
      if (outAlloc.error) {
        return { ok: false, output: outAlloc.error, error: outAlloc.errorCode || 'INVALID_PARAMS' };
      }
      try { await mkdir(dirname(outAlloc.path), { recursive: true }); } catch { /* non-fatal */ }
      try {
        // Workspace-relative inputs resolve to <workspace>/foo.pdf,
        // matching the contract every other melo tool follows. Codex
        // review 2026-05-01 caught the previous cwd-relative behaviour.
        const absSources = sources.map(s => resolveInputPdfPath(s));
        if (absSources.some(p => !p)) {
          return { ok: false, output: 'merge: every entry in `sources` must be a non-empty path string.', error: 'INVALID_PARAMS' };
        }
        // Gate each source individually so sensitive sources are
        // refused / per-call prompted (round 13 contract).
        const sourceBuffers = [];
        for (const absSrc of absSources) {
          const r = await gateAndRead(absSrc);
          if (!r.ok) return r;
          sourceBuffers.push(r.buffer);
        }
        const result = await mergePdfs(sourceBuffers);
        await writeBytes(outAlloc.path, result.bytes);
        return buildWriteResponse(outAlloc.path, result.bytes.length, {
          totalPages: result.totalPages,
          sourcesCount: result.sources,
        }, `Merged ${result.sources} PDFs (${result.totalPages} pages)`);
      } catch (err) {
        return { ok: false, output: `merge failed: ${err.message}`, error: 'MERGE_FAILED' };
      }
    }

    // ─── split ───────────────────────────────────────────────────────────────
    if (action === 'split') {
      if (!pageRange) {
        return { ok: false, output: 'split: missing `pageRange` (e.g. "1-3" or "1-3,5,7-9").', error: 'INVALID_PARAMS' };
      }
      const resolved = resolveSourceAndOutput();
      if (resolved.error) {
        return { ok: false, output: resolved.error, error: resolved.errorCode || 'INVALID_PARAMS' };
      }
      try { await mkdir(dirname(resolved.outPath), { recursive: true }); } catch { /* non-fatal */ }
      try {
        const r = await gateAndRead(resolved.srcPath);
        if (!r.ok) return r;
        const result = await splitPdf(r.buffer, pageRange);
        await writeBytes(resolved.outPath, result.bytes);
        return buildWriteResponse(resolved.outPath, result.bytes.length, {
          extractedPages: result.kept,
        }, `Split ${result.pages} page${result.pages === 1 ? '' : 's'} (range "${pageRange}")`);
      } catch (err) {
        return { ok: false, output: `split failed: ${err.message}`, error: 'SPLIT_FAILED' };
      }
    }

    // ─── delete_pages ────────────────────────────────────────────────────────
    if (action === 'delete_pages') {
      if (!pageRange) {
        return { ok: false, output: 'delete_pages: missing `pageRange` (e.g. "2,4-5").', error: 'INVALID_PARAMS' };
      }
      const resolved = resolveSourceAndOutput();
      if (resolved.error) {
        return { ok: false, output: resolved.error, error: resolved.errorCode || 'INVALID_PARAMS' };
      }
      try { await mkdir(dirname(resolved.outPath), { recursive: true }); } catch { /* non-fatal */ }
      try {
        const r = await gateAndRead(resolved.srcPath);
        if (!r.ok) return r;
        const result = await deletePages(r.buffer, pageRange);
        await writeBytes(resolved.outPath, result.bytes);
        return buildWriteResponse(resolved.outPath, result.bytes.length, {
          kept: result.kept,
          deleted: result.deleted,
        }, `Removed ${result.deleted} page${result.deleted === 1 ? '' : 's'}, kept ${result.kept}`);
      } catch (err) {
        return { ok: false, output: `delete_pages failed: ${err.message}`, error: 'DELETE_FAILED' };
      }
    }

    // ─── watermark ───────────────────────────────────────────────────────────
    if (action === 'watermark') {
      if (!watermarkText) {
        return { ok: false, output: 'watermark: missing `watermarkText`.', error: 'INVALID_PARAMS' };
      }
      const resolved = resolveSourceAndOutput();
      if (resolved.error) {
        return { ok: false, output: resolved.error, error: resolved.errorCode || 'INVALID_PARAMS' };
      }
      try { await mkdir(dirname(resolved.outPath), { recursive: true }); } catch { /* non-fatal */ }
      try {
        const r = await gateAndRead(resolved.srcPath);
        if (!r.ok) return r;
        const result = await addWatermark(r.buffer, watermarkText, {
          opacity: watermarkOpacity,
          angle: watermarkAngle,
          fontSize: watermarkFontSize,
        });
        await writeBytes(resolved.outPath, result.bytes);
        return buildWriteResponse(resolved.outPath, result.bytes.length, {
          watermarkText,
          pages: result.pages,
        }, `Watermarked ${result.pages} page${result.pages === 1 ? '' : 's'}`);
      } catch (err) {
        return { ok: false, output: `watermark failed: ${err.message}`, error: 'WATERMARK_FAILED' };
      }
    }

    // ─── add_page_numbers ────────────────────────────────────────────────────
    if (action === 'add_page_numbers') {
      const resolved = resolveSourceAndOutput();
      if (resolved.error) {
        return { ok: false, output: resolved.error, error: resolved.errorCode || 'INVALID_PARAMS' };
      }
      try { await mkdir(dirname(resolved.outPath), { recursive: true }); } catch { /* non-fatal */ }
      try {
        const r = await gateAndRead(resolved.srcPath);
        if (!r.ok) return r;
        const result = await addPageNumbers(r.buffer, {
          format: pageNumberFormat,
          position: pageNumberPosition,
        });
        await writeBytes(resolved.outPath, result.bytes);
        return buildWriteResponse(resolved.outPath, result.bytes.length, {
          totalPages: result.total,
        }, `Added page numbers to ${result.total} page${result.total === 1 ? '' : 's'}`);
      } catch (err) {
        return { ok: false, output: `add_page_numbers failed: ${err.message}`, error: 'PAGE_NUMBERS_FAILED' };
      }
    }

    // ─── prepend_cover ───────────────────────────────────────────────────────
    if (action === 'prepend_cover') {
      if (!coverPath) {
        return { ok: false, output: 'prepend_cover: missing `coverPath`.', error: 'INVALID_PARAMS' };
      }
      const resolved = resolveSourceAndOutput();
      if (resolved.error) {
        return { ok: false, output: resolved.error, error: resolved.errorCode || 'INVALID_PARAMS' };
      }
      try { await mkdir(dirname(resolved.outPath), { recursive: true }); } catch { /* non-fatal */ }
      try {
        const absCover = resolveInputPdfPath(coverPath);
        if (!absCover) {
          return { ok: false, output: 'prepend_cover: `coverPath` is required.', error: 'INVALID_PARAMS' };
        }
        const srcR = await gateAndRead(resolved.srcPath);
        if (!srcR.ok) return srcR;
        const coverR = await gateAndRead(absCover);
        if (!coverR.ok) return coverR;
        const result = await prependCover(srcR.buffer, coverR.buffer);
        await writeBytes(resolved.outPath, result.bytes);
        return buildWriteResponse(resolved.outPath, result.bytes.length, {
          coverPages: result.coverPages,
          sourcePages: result.sourcePages,
          totalPages: result.totalPages,
        }, `Prepended ${result.coverPages}-page cover to ${result.sourcePages}-page source (total ${result.totalPages})`);
      } catch (err) {
        return { ok: false, output: `prepend_cover failed: ${err.message}`, error: 'PREPEND_FAILED' };
      }
    }

    // ─── render ──────────────────────────────────────────────────────────────
    if (action === 'render') {
      // Schema documents both `source` and `path` for symmetry with the
      // other in-place actions. Codex review 2026-05-01 flagged that the
      // earlier draft only honoured `path` while the schema advertised
      // `source` — fixed: either is accepted, `source` wins when both
      // are passed (matches resolveSourceAndOutput's ordering).
      const renderSource = source || path;
      if (!renderSource) {
        return { ok: false, output: 'render: missing `source` (or `path`) — pass the PDF you want rasterised.', error: 'INVALID_PARAMS' };
      }
      if (!renderSource.toLowerCase().endsWith('.pdf')) {
        return { ok: false, output: 'render: source path must end in .pdf', error: 'INVALID_PARAMS' };
      }
      const srcPath = resolveInputPdfPath(renderSource);
      if (!srcPath) {
        return { ok: false, output: 'render: source path is required.', error: 'INVALID_PARAMS' };
      }
      // Output PNGs always go into the workspace's generated/ dir under
      // a per-render subfolder so multiple renders don't fight for the
      // same `page-1.png` filename.
      if (!workspacePath) {
        return { ok: false, output: 'render: no workspace available to save page images.', error: 'NO_OUTPUT_PATH' };
      }
      const ts = Date.now().toString(36);
      const rand = randomBytes(4).toString('hex');
      const outDir = join(workspacePath, 'generated', `pdf-render-${ts}-${rand}`);
      // Phase 2C: gate the source read into a buffer; pdftoppm is
      // an external binary that re-opens by path, so we materialize
      // the gate-approved buffer into a SYSTEM PRIVATE tmp dir (NOT
      // workspace) so any agent / symlink in workspace can't reach
      // it. mkdtempSync on os.tmpdir() with mode 0o700 gives us a
      // dir only the current process user can list; the file inside
      // is written 0o600. Phase 2C follow-up #2 (Codex 🔴) — the
      // earlier workspace `.melo-tmp` location moved the original
      // path-race into the workspace itself.
      const srcR = await gateAndRead(srcPath);
      if (!srcR.ok) return srcR;
      const { mkdtempSync, writeFileSync, chmodSync } = await import('node:fs');
      const { tmpdir: osTmpdir } = await import('node:os');
      // Phase 2C follow-up #3 (Codex 🟠): tmp lifecycle starts at
      // mkdtempSync, BEFORE chmod / writeFile / render. Wrap the
      // entire sequence in try/finally so an exception anywhere
      // (chmod failure, writeFile failure, renderPdfPagesToPngs
      // throw) still removes the gate-approved PDF copy from
      // system tmp. The earlier code had try{} starting after
      // writeFileSync, so a write failure leaked the dir.
      const tmpDir = mkdtempSync(join(osTmpdir(), 'melo-pdfrender-'));
      try {
        try { chmodSync(tmpDir, 0o700); } catch { /* best-effort */ }
        const tmpPdfPath = join(tmpDir, `render-src-${ts}-${rand}.pdf`);
        writeFileSync(tmpPdfPath, srcR.buffer, { mode: 0o600 });
        const result = await renderPdfPagesToPngs({
          sourcePath: tmpPdfPath,
          outputDir: outDir,
          scale: renderScale,
          pageRange,
        });
        // Sign every page URL so the chat can render them inline as
        // images (the assistant can then vision-check the result).
        const urls = [];
        for (const p of result.paths) {
          try { urls.push(signWorkspaceFileUrl(p)); } catch { urls.push(null); }
        }
        // Codex review 2026-05-01 caught a system-prompt conflict:
        // the global tool-prompt rule says "echo every generated-file
        // URL to the user", but render output is QA-only and must
        // NOT be echoed to the user (those PNGs are intermediate
        // artifacts; the user wants the FINAL PDF). The fix is two
        // layered signals so the model can't miss the distinction:
        //
        //   (a) every URL line is suffixed `(QA only — do NOT
        //       include in final reply)` — an in-context marker
        //       attached to each URL itself, the strongest
        //       priority signal because it sits in the most-recent
        //       tool result the model is reasoning about;
        //   (b) `meta.artifactRole = 'review'` — programmatic
        //       marker for any framework code that wants to filter
        //       review URLs out of attachment promotion;
        //   (c) the global URL rule in systemPrompt.js now carries
        //       an explicit EXCEPTION for review/QA artifacts.
        //
        // Pinned by the workflow tests (no-echo regression + the
        // global-rule-has-exception assertions).
        const QA_ONLY_SUFFIX = ' (QA only — do NOT include in final reply)';
        const linesOut = result.paths.map((p, i) => {
          const url = urls[i];
          return url
            ? `Page ${i + 1}: ${url}${QA_ONLY_SUFFIX}`
            : `Page ${i + 1}: ${p}${QA_ONLY_SUFFIX}`;
        });
        return {
          ok: true,
          output:
            `Rendered ${result.count} page${result.count === 1 ? '' : 's'} ` +
            `(${result.dpi} dpi). These are visual-review artifacts for your own QA — ` +
            `do NOT echo them to the user; reply with the FINAL PDF URL only.\n` +
            `${linesOut.join('\n')}`,
          meta: {
            paths: result.paths,
            urls,
            dpi: result.dpi,
            count: result.count,
            outputDir: outDir,
            artifactRole: 'review',
          },
        };
      } catch (err) {
        return { ok: false, output: `render failed: ${err.message}`, error: 'RENDER_FAILED' };
      } finally {
        // Clean up the entire private tmp dir (file + dir).
        try {
          const { rm: rmAsync } = await import('node:fs/promises');
          await rmAsync(tmpDir, { recursive: true, force: true });
        } catch { /* best-effort */ }
      }
    }

    // ─── from_spec ───────────────────────────────────────────────────────────
    if (action === 'from_spec') {
      // 1. Validate the spec object up front so the model gets a
      //    structured error pointing at the offending field, not a
      //    deep stack trace from inside pdf-lib / Playwright.
      const validation = validateEditSpec(editSpec);
      if (!validation.ok) {
        return { ok: false, output: `from_spec: ${validation.error}`, error: 'INVALID_SPEC' };
      }
      const spec = validation.spec;
      const outAlloc = allocatePdfOutputPath(path);
      if (outAlloc.error) {
        return { ok: false, output: outAlloc.error, error: outAlloc.errorCode || 'INVALID_PARAMS' };
      }
      try { await mkdir(dirname(outAlloc.path), { recursive: true }); } catch { /* non-fatal */ }

      // ── Branch by mode ────────────────────────────────────────────────
      try {
        if (spec.mode === 'in_place_overlay') {
          // Resolve sourcePdf + overlay imagePaths against workspace
          // (matches the rest of pdfTool's path contract).
          const srcPath = resolveSpecInputPath(spec.sourcePdf, workspacePath);
          if (!srcPath) {
            return { ok: false, output: 'from_spec.sourcePdf could not be resolved', error: 'INVALID_PARAMS' };
          }
          // Phase 2C: gate the source PDF read; pass Buffer to overlay
          // engine so pdf-lib never re-opens the path.
          const srcR = await gateAndRead(srcPath);
          if (!srcR.ok) return srcR;
          const sourceBytes = srcR.buffer;
          // Phase 2C follow-up #1 (Codex 🟠): every image-overlay
          // imagePath ALSO goes through gateAndRead so sensitive PNG/
          // JPG can't be silently embedded into the output PDF.
          // applyInPlaceOverlays prefers `imageBytes` (Buffer)
          // over `imagePath`; tool layer sets imageBytes here.
          const overlays = Array.isArray(spec.overlays) ? spec.overlays : [];
          const resolvedOverlays = [];
          for (const ov of overlays) {
            if (ov.type !== 'image') {
              resolvedOverlays.push(ov);
              continue;
            }
            const absImg = resolveSpecInputPath(ov.imagePath, workspacePath);
            if (!absImg) {
              return {
                ok: false,
                output: `from_spec: image overlay imagePath could not be resolved (${ov.imagePath})`,
                error: 'INVALID_PARAMS',
              };
            }
            const imgR = await gateAndRead(absImg);
            if (!imgR.ok) return imgR;
            resolvedOverlays.push({ ...ov, imagePath: absImg, imageBytes: imgR.buffer });
          }
          const resolvedSpec = { ...spec, overlays: resolvedOverlays };
          const result = await applyInPlaceOverlays(sourceBytes, resolvedSpec);
          await writeBytes(outAlloc.path, result.bytes);
          return buildWriteResponse(outAlloc.path, result.bytes.length, {
            mode: 'in_place_overlay',
            overlaysApplied: result.overlaysApplied,
            metadataKeys: result.metadataKeys,
            formFieldsApplied: result.formFieldsApplied,
          }, `In-place edit (${result.overlaysApplied} overlay${result.overlaysApplied === 1 ? '' : 's'}, ${result.metadataKeys.length} metadata field${result.metadataKeys.length === 1 ? '' : 's'}, ${result.formFieldsApplied} form field${result.formFieldsApplied === 1 ? '' : 's'})`);
        }

        // mode === 'rebuild'
        const engine = pickRebuildEngine(spec);
        if (engine === 'pdfkit') {
          const { writeStructuredPdf } = await import('../../services/export/pdfkitGenerate.js');
          // pdfkit's resolveMargins only accepts a NUMERIC object —
          // string forms ("1in") and CSS-shaped objects silently
          // revert to the 60pt default. Codex review (Batch C round
          // 2, 2026-05-01) caught this. We pre-convert via
          // marginsToPoints so the user-specified margins survive
          // intact regardless of input shape.
          // fontFamily is the only outputStyle field that doesn't
          // map onto pdfkit (StandardFonts only); the schema
          // description tells the model.
          const structuredArgs = {
            sections: spec.sections,
            title: spec.outputStyle?.title,
            author: spec.outputStyle?.author,
            subject: spec.outputStyle?.subject,
            pageSize: spec.outputStyle?.pageSize,
            margins:
              spec.outputStyle?.margins != null
                ? marginsToPoints(spec.outputStyle.margins)
                : undefined,
          };
          const result = await writeStructuredPdf(outAlloc.path, structuredArgs);
          return buildWriteResponse(result.path, result.bytes, {
            mode: 'rebuild',
            engine: 'pdfkit',
            sections: result.sections,
          }, `Rebuilt PDF via pdfkit (${result.sections} section${result.sections === 1 ? '' : 's'})`);
        }

        // engine === 'html_playwright' — sectionsToHtml already
        // produces a COMPLETE HTML document (with <!doctype>, <html>,
        // <head><style>, <body>). We hand it directly to the shared
        // Playwright helper rather than going through writePdf,
        // which would wrap a SECOND complete document around it
        // (Codex review 2026-05-01 caught the nested-doc bug —
        // outer styles became dead code).
        const html = sectionsToHtml(spec.sections, spec.outputStyle);
        const result = await htmlToPdfWithPlaywright(html, outAlloc.path);
        return buildWriteResponse(result.path, result.size, {
          mode: 'rebuild',
          engine: 'html_playwright',
          sections: spec.sections.length,
        }, `Rebuilt PDF via Playwright (${spec.sections.length} section${spec.sections.length === 1 ? '' : 's'})`);
      } catch (err) {
        return { ok: false, output: `from_spec failed: ${err.message}`, error: 'FROM_SPEC_FAILED' };
      }
    }

    return {
      ok: false,
      output: `Unknown action: "${action}". See tool description for the menu.`,
      error: 'INVALID_ACTION',
    };
  },
};
