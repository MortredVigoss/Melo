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
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { resolve, extname, join, isAbsolute, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { signWorkspaceFileUrl } from '../../web/urlSigning.js';

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

async function writePdf(outputPath, content, format = 'text') {
  const absPath = resolve(outputPath);

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

  // Write temp HTML, then use Playwright to convert to PDF
  const tmpHtml = absPath.replace(/\.pdf$/i, '') + '.tmp.html';
  await writeFile(tmpHtml, fullHtml, 'utf8');

  try {
    // Navigate to local file and print to PDF
    await runPlaywrightCli(['open', `file://${tmpHtml}`], 15_000);
    await runPlaywrightCli(['pdf', absPath], 20_000);
  } finally {
    // Clean up temp HTML
    const { unlink } = await import('node:fs/promises');
    unlink(tmpHtml).catch(() => {});
  }

  // Verify output exists
  const stat = await import('node:fs/promises').then(fs => fs.stat(absPath));
  return { path: absPath, size: stat.size };
}

// ─── Tool definition ──────────────────────────────────────────────────────────

export const pdfTool = {
  id: 'pdf',
  name: 'PDF',
  description:
    'Read or write PDF files. ' +
    'Read: extract text content from a local PDF file or PDF URL, returns full text with metadata (pages, title, author). ' +
    'Write: generate a PDF from text/Markdown/HTML content via Playwright (requires @playwright/cli). ' +
    'Structured: generate a PDF from a declarative sections[] spec (heading / paragraph / list / table / image / rule / pageBreak) via pdfkit — pure Node, no browser dependency. Prefer `structured` for reports, invoices, and one-pagers.',
  category: 'files',
  isConcurrencySafe: true,
  requiresPermission: true,
  parametersSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['read', 'write', 'structured'],
        description: 'Action to perform: "read" to extract text, "write" for HTML/Markdown → PDF via Playwright, "structured" for declarative sections → PDF via pdfkit.',
      },
      path: {
        type: 'string',
        description:
          'For read: local file path or URL to a PDF. ' +
          'For write/structured: optional output file path (must end in .pdf). ' +
          'If omitted, the PDF is auto-saved into the chat workspace and a displayable URL is returned.',
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
        description: 'For read only: page range to extract, e.g. "1-5", "3", "10-20". Default: all pages.',
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
    const { action, path, content, format = 'text', pages } = args || {};
    const { signal, workspacePath } = context;
    if (!action) {
      return { ok: false, output: 'Missing required parameter: action.', error: 'INVALID_PARAMS' };
    }

    if (action === 'read') {
      if (!path) {
        return { ok: false, output: 'Missing "path" for read action.', error: 'INVALID_PARAMS' };
      }
      try {
        const isUrl = /^https?:\/\//i.test(path);
        const result = isUrl ? await readPdfFromUrl(path) : await readPdfFromFile(path);

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

      // Resolve the target path. Priority:
      //   1. Explicit absolute path → use as-is.
      //   2. Explicit relative path + workspacePath → relative to workspace.
      //   3. No path given + workspacePath → auto-allocate in `generated/`.
      //   4. Otherwise → INVALID_PARAMS, since we won't silently dump PDFs into cwd.
      let outPath;
      if (path) {
        if (!path.toLowerCase().endsWith('.pdf')) {
          return { ok: false, output: 'Output path must end in .pdf', error: 'INVALID_PARAMS' };
        }
        outPath = isAbsolute(path) ? path : (workspacePath ? resolve(workspacePath, path) : resolve(path));
      } else if (workspacePath) {
        const ts = Date.now().toString(36);
        const rand = randomBytes(4).toString('hex');
        outPath = join(workspacePath, 'generated', `pdf-${ts}-${rand}.pdf`);
      } else {
        return {
          ok: false,
          output: 'No workspace available and no "path" provided.',
          error: 'NO_OUTPUT_PATH',
        };
      }

      try {
        await mkdir(dirname(outPath), { recursive: true });
      } catch { /* non-fatal — writePdf will surface any real write failure */ }

      try {
        const result = await writePdf(outPath, content, format);
        let url = null;
        if (workspacePath && result.path.startsWith(workspacePath)) {
          try { url = signWorkspaceFileUrl(result.path); } catch { /* best-effort */ }
        }
        const label = url
          ? `PDF: ${url}\n(saved to ${result.path}, ${(result.size / 1024).toFixed(1)} KB)`
          : `PDF created: ${result.path} (${(result.size / 1024).toFixed(1)} KB)`;
        return {
          ok: true,
          output: label,
          meta: { ...result, url },
        };
      } catch (err) {
        return { ok: false, output: `Failed to write PDF: ${err.message}`, error: 'WRITE_FAILED' };
      }
    }

    if (action === 'structured') {
      // Resolve output path (same rules as write).
      let outPath;
      if (path) {
        if (!path.toLowerCase().endsWith('.pdf')) {
          return { ok: false, output: 'Output path must end in .pdf', error: 'INVALID_PARAMS' };
        }
        outPath = isAbsolute(path) ? path : (workspacePath ? resolve(workspacePath, path) : resolve(path));
      } else if (workspacePath) {
        const ts = Date.now().toString(36);
        const rand = randomBytes(4).toString('hex');
        outPath = join(workspacePath, 'generated', `pdf-${ts}-${rand}.pdf`);
      } else {
        return { ok: false, output: 'No workspace available and no "path" provided.', error: 'NO_OUTPUT_PATH' };
      }

      try { await mkdir(dirname(outPath), { recursive: true }); } catch { /* non-fatal */ }

      try {
        const { writeStructuredPdf } = await import('../../services/export/pdfkitGenerate.js');
        const result = await writeStructuredPdf(outPath, args);
        let url = null;
        if (workspacePath && result.path.startsWith(workspacePath)) {
          try { url = signWorkspaceFileUrl(result.path); } catch { /* best-effort */ }
        }
        const label = url
          ? `PDF: ${url}\n(saved to ${result.path}, ${(result.bytes / 1024).toFixed(1)} KB, ${result.sections} section${result.sections === 1 ? '' : 's'}, engine=pdfkit)`
          : `PDF created: ${result.path} (${(result.bytes / 1024).toFixed(1)} KB, engine=pdfkit)`;
        return { ok: true, output: label, meta: { ...result, url } };
      } catch (err) {
        return { ok: false, output: `Failed to write structured PDF: ${err.message}`, error: 'WRITE_FAILED' };
      }
    }

    return { ok: false, output: `Unknown action: "${action}". Use "read", "write", or "structured".`, error: 'INVALID_ACTION' };
  },
};
