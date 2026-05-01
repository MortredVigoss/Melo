// Integration tests for the new pdfTool actions added in batch A
// (merge / split / delete_pages / watermark / add_page_numbers /
// prepend_cover / render). These exercise the tool's run() adapter
// — input validation, output-path resolution, error propagation —
// without rebuilding the underlying pdfLibOps logic (which has its
// own dedicated tests).

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pdfTool } from './pdfTool.js';
import { _setPdftoppmAvailable } from '../../services/export/pdfRender.js';

async function makeFakePdf(numPages = 3) {
  const { PDFDocument, rgb } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  for (let i = 1; i <= numPages; i++) {
    const page = doc.addPage([400, 300]);
    page.drawText(`Page ${i}`, { x: 50, y: 250, size: 24, color: rgb(0, 0, 0) });
  }
  return Buffer.from(await doc.save());
}

async function withWorkspace(callback) {
  const ws = await mkdtemp(join(tmpdir(), 'melo-pdftool-test-'));
  try {
    return await callback(ws);
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
}

// ─── merge ──────────────────────────────────────────────────────────────────

test('merge: missing sources → INVALID_PARAMS', async () => {
  const result = await pdfTool.run({ action: 'merge' }, { workspacePath: '/tmp/x' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'INVALID_PARAMS');
  assert.match(result.output, /sources/);
});

test('merge: single source rejected (need 2+)', async () => {
  const result = await pdfTool.run(
    { action: 'merge', sources: ['/tmp/only.pdf'] },
    { workspacePath: '/tmp/x' },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, 'INVALID_PARAMS');
});

test('merge: happy path concatenates 3 PDFs into workspace generated/', async () => {
  await withWorkspace(async ws => {
    const a = join(ws, 'a.pdf');
    const b = join(ws, 'b.pdf');
    const c = join(ws, 'c.pdf');
    await writeFile(a, await makeFakePdf(2));
    await writeFile(b, await makeFakePdf(3));
    await writeFile(c, await makeFakePdf(1));
    const result = await pdfTool.run(
      { action: 'merge', sources: [a, b, c] },
      { workspacePath: ws },
    );
    assert.equal(result.ok, true);
    assert.match(result.output, /Merged 3 PDFs \(6 pages\)/);
    assert.match(result.meta.path, /\/generated\/pdf-/);
    assert.equal(result.meta.totalPages, 6);
    // Output URL was signed (workspace-rooted file).
    assert.match(result.meta.url, /\/api\/files\/signed\//);
    // File actually exists.
    const s = await stat(result.meta.path);
    assert.ok(s.size > 0);
  });
});

// ─── split ──────────────────────────────────────────────────────────────────

test('split: missing pageRange → INVALID_PARAMS', async () => {
  await withWorkspace(async ws => {
    const src = join(ws, 'src.pdf');
    await writeFile(src, await makeFakePdf(3));
    const result = await pdfTool.run(
      { action: 'split', path: src },
      { workspacePath: ws },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, 'INVALID_PARAMS');
    assert.match(result.output, /pageRange/);
  });
});

test('split: extracts requested pages', async () => {
  await withWorkspace(async ws => {
    const src = join(ws, 'src.pdf');
    await writeFile(src, await makeFakePdf(5));
    const result = await pdfTool.run(
      { action: 'split', path: src, pageRange: '2-3' },
      { workspacePath: ws },
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.meta.extractedPages, [2, 3]);
    assert.match(result.output, /Split 2 pages/);
  });
});

test('split: out-of-range surfaces error from pdfLibOps', async () => {
  await withWorkspace(async ws => {
    const src = join(ws, 'src.pdf');
    await writeFile(src, await makeFakePdf(3));
    const result = await pdfTool.run(
      { action: 'split', path: src, pageRange: '10' },
      { workspacePath: ws },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, 'SPLIT_FAILED');
    assert.match(result.output, /exceeds total/);
  });
});

// ─── delete_pages ───────────────────────────────────────────────────────────

test('delete_pages: removes specified, signs URL', async () => {
  await withWorkspace(async ws => {
    const src = join(ws, 'src.pdf');
    await writeFile(src, await makeFakePdf(5));
    const result = await pdfTool.run(
      { action: 'delete_pages', path: src, pageRange: '2,4' },
      { workspacePath: ws },
    );
    assert.equal(result.ok, true);
    assert.equal(result.meta.kept, 3);
    assert.equal(result.meta.deleted, 2);
    assert.match(result.output, /Removed 2 pages, kept 3/);
  });
});

test('delete_pages: deleting every page → DELETE_FAILED', async () => {
  await withWorkspace(async ws => {
    const src = join(ws, 'src.pdf');
    await writeFile(src, await makeFakePdf(2));
    const result = await pdfTool.run(
      { action: 'delete_pages', path: src, pageRange: '1-2' },
      { workspacePath: ws },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, 'DELETE_FAILED');
    assert.match(result.output, /cannot delete every page/);
  });
});

// ─── watermark ──────────────────────────────────────────────────────────────

test('watermark: missing watermarkText → INVALID_PARAMS', async () => {
  await withWorkspace(async ws => {
    const src = join(ws, 'src.pdf');
    await writeFile(src, await makeFakePdf(1));
    const result = await pdfTool.run(
      { action: 'watermark', path: src },
      { workspacePath: ws },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, 'INVALID_PARAMS');
  });
});

test('watermark: ASCII text on every page', async () => {
  await withWorkspace(async ws => {
    const src = join(ws, 'src.pdf');
    await writeFile(src, await makeFakePdf(2));
    const result = await pdfTool.run(
      { action: 'watermark', path: src, watermarkText: 'DRAFT' },
      { workspacePath: ws },
    );
    assert.equal(result.ok, true);
    assert.equal(result.meta.pages, 2);
    assert.equal(result.meta.watermarkText, 'DRAFT');
    assert.match(result.output, /Watermarked 2 pages/);
  });
});

test('watermark: CJK text → WATERMARK_FAILED with ASCII guidance', async () => {
  await withWorkspace(async ws => {
    const src = join(ws, 'src.pdf');
    await writeFile(src, await makeFakePdf(1));
    const result = await pdfTool.run(
      { action: 'watermark', path: src, watermarkText: '机密' },
      { workspacePath: ws },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, 'WATERMARK_FAILED');
    assert.match(result.output, /ASCII/);
  });
});

// ─── add_page_numbers ───────────────────────────────────────────────────────

test('add_page_numbers: default format adds numbers to all pages', async () => {
  await withWorkspace(async ws => {
    const src = join(ws, 'src.pdf');
    await writeFile(src, await makeFakePdf(3));
    const result = await pdfTool.run(
      { action: 'add_page_numbers', path: src },
      { workspacePath: ws },
    );
    assert.equal(result.ok, true);
    assert.equal(result.meta.totalPages, 3);
    assert.match(result.output, /Added page numbers to 3 pages/);
  });
});

test('add_page_numbers: invalid position → PAGE_NUMBERS_FAILED', async () => {
  await withWorkspace(async ws => {
    const src = join(ws, 'src.pdf');
    await writeFile(src, await makeFakePdf(1));
    const result = await pdfTool.run(
      { action: 'add_page_numbers', path: src, pageNumberPosition: 'middle' },
      { workspacePath: ws },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, 'PAGE_NUMBERS_FAILED');
  });
});

// ─── prepend_cover ──────────────────────────────────────────────────────────

test('prepend_cover: missing coverPath → INVALID_PARAMS', async () => {
  await withWorkspace(async ws => {
    const src = join(ws, 'src.pdf');
    await writeFile(src, await makeFakePdf(2));
    const result = await pdfTool.run(
      { action: 'prepend_cover', path: src },
      { workspacePath: ws },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, 'INVALID_PARAMS');
    assert.match(result.output, /coverPath/);
  });
});

test('prepend_cover: cover pages come before source pages', async () => {
  await withWorkspace(async ws => {
    const src = join(ws, 'src.pdf');
    const cover = join(ws, 'cover.pdf');
    await writeFile(src, await makeFakePdf(3));
    await writeFile(cover, await makeFakePdf(1));
    const result = await pdfTool.run(
      { action: 'prepend_cover', path: src, coverPath: cover },
      { workspacePath: ws },
    );
    assert.equal(result.ok, true);
    assert.equal(result.meta.coverPages, 1);
    assert.equal(result.meta.sourcePages, 3);
    assert.equal(result.meta.totalPages, 4);
  });
});

// ─── render ─────────────────────────────────────────────────────────────────

test('render: pdftoppm missing → RENDER_FAILED with brew hint', async () => {
  _setPdftoppmAvailable(false);
  await withWorkspace(async ws => {
    const src = join(ws, 'src.pdf');
    await writeFile(src, await makeFakePdf(1));
    const result = await pdfTool.run(
      { action: 'render', path: src },
      { workspacePath: ws },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, 'RENDER_FAILED');
    assert.match(result.output, /brew install poppler/);
  });
});

test('render: missing path → INVALID_PARAMS', async () => {
  _setPdftoppmAvailable(true);
  await withWorkspace(async ws => {
    const result = await pdfTool.run(
      { action: 'render' },
      { workspacePath: ws },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, 'INVALID_PARAMS');
  });
});

test('render: missing workspace → NO_OUTPUT_PATH', async () => {
  _setPdftoppmAvailable(true);
  const result = await pdfTool.run(
    { action: 'render', path: '/tmp/x.pdf' },
    {},
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, 'NO_OUTPUT_PATH');
});

test('render: non-pdf source path → INVALID_PARAMS', async () => {
  _setPdftoppmAvailable(true);
  await withWorkspace(async ws => {
    const result = await pdfTool.run(
      { action: 'render', path: '/tmp/x.png' },
      { workspacePath: ws },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, 'INVALID_PARAMS');
    assert.match(result.output, /\.pdf/);
  });
});

// ─── schema sanity ──────────────────────────────────────────────────────────

test('all 10 actions are listed in the parametersSchema enum', () => {
  const expected = [
    'read', 'write', 'structured',
    'merge', 'split', 'delete_pages',
    'watermark', 'add_page_numbers', 'prepend_cover',
    'render',
  ];
  assert.deepEqual(pdfTool.parametersSchema.properties.action.enum, expected);
});
