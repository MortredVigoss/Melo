// Tests for the pdf-lib operations module. Each test starts by
// generating a tiny in-memory PDF (via pdf-lib directly) so we don't
// need any fixture files on disk.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parsePageRange,
  mergePdfs,
  splitPdf,
  deletePages,
  addWatermark,
  addPageNumbers,
  prependCover,
  writeBytes,
} from './pdfLibOps.js';

// Helpers ─────────────────────────────────────────────────────────────────────

async function makeFakePdf(numPages = 3) {
  const { PDFDocument, rgb } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  for (let i = 1; i <= numPages; i++) {
    const page = doc.addPage([400, 300]);
    // Draw something so the page isn't empty.
    page.drawText(`Page ${i}`, {
      x: 50, y: 250, size: 24,
      color: rgb(0, 0, 0),
    });
  }
  return await doc.save();
}

async function withTempPdfs(numPages, callback) {
  const dir = await mkdtemp(join(tmpdir(), 'melo-pdfops-test-'));
  try {
    return await callback(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function pageCountOf(bytes) {
  const { PDFDocument } = await import('pdf-lib');
  const doc = await PDFDocument.load(bytes);
  return doc.getPageCount();
}

// ─── parsePageRange ─────────────────────────────────────────────────────────

test('parsePageRange: empty / null → all pages', () => {
  assert.deepEqual(parsePageRange('', 5), [1, 2, 3, 4, 5]);
  assert.deepEqual(parsePageRange(null, 3), [1, 2, 3]);
  assert.deepEqual(parsePageRange(undefined, 2), [1, 2]);
  assert.deepEqual(parsePageRange('   ', 4), [1, 2, 3, 4]);
});

test('parsePageRange: single page → array of one', () => {
  assert.deepEqual(parsePageRange('3', 5), [3]);
});

test('parsePageRange: dash range → inclusive', () => {
  assert.deepEqual(parsePageRange('2-4', 5), [2, 3, 4]);
});

test('parsePageRange: comma-separated ranges → merged + sorted + deduped', () => {
  assert.deepEqual(parsePageRange('1-3,7,10-12', 12), [1, 2, 3, 7, 10, 11, 12]);
  assert.deepEqual(parsePageRange('5,3,1', 5), [1, 3, 5], 'output is sorted');
  assert.deepEqual(parsePageRange('1-3,2-4', 5), [1, 2, 3, 4], 'overlaps deduped');
});

test('parsePageRange: out-of-bounds throws', () => {
  assert.throws(() => parsePageRange('1-10', 5), /exceeds total/);
  assert.throws(() => parsePageRange('0', 5), /1-indexed/);
  assert.throws(() => parsePageRange('5-3', 10), /start > end/);
});

test('parsePageRange: malformed throws', () => {
  assert.throws(() => parsePageRange('abc', 5), /invalid page range/);
  assert.throws(() => parsePageRange('1-', 5), /invalid page range/);
  assert.throws(() => parsePageRange('-3', 5), /invalid page range/);
});

test('parsePageRange: bad totalPages throws', () => {
  assert.throws(() => parsePageRange('1', 0), /positive integer/);
  assert.throws(() => parsePageRange('1', 'three'), /positive integer/);
});

// ─── mergePdfs ──────────────────────────────────────────────────────────────

test('mergePdfs: concatenates pages in source order', async () => {
  await withTempPdfs(0, async dir => {
    const a = join(dir, 'a.pdf');
    const b = join(dir, 'b.pdf');
    const c = join(dir, 'c.pdf');
    await writeFile(a, await makeFakePdf(2));
    await writeFile(b, await makeFakePdf(3));
    await writeFile(c, await makeFakePdf(1));
    const result = await mergePdfs([a, b, c]);
    assert.equal(result.totalPages, 6);
    assert.equal(result.sources, 3);
    assert.equal(await pageCountOf(result.bytes), 6);
  });
});

test('mergePdfs: requires at least 2 sources', async () => {
  await assert.rejects(mergePdfs([]), /at least 2/);
  await assert.rejects(mergePdfs(['only-one.pdf']), /at least 2/);
  await assert.rejects(mergePdfs(null), /at least 2/);
});

// ─── splitPdf ───────────────────────────────────────────────────────────────

test('splitPdf: extract a single page → 1-page PDF', async () => {
  await withTempPdfs(0, async dir => {
    const src = join(dir, 'src.pdf');
    await writeFile(src, await makeFakePdf(5));
    const result = await splitPdf(src, '3');
    assert.equal(result.pages, 1);
    assert.deepEqual(result.kept, [3]);
    assert.equal(await pageCountOf(result.bytes), 1);
  });
});

test('splitPdf: extract multi-range → preserves order', async () => {
  await withTempPdfs(0, async dir => {
    const src = join(dir, 'src.pdf');
    await writeFile(src, await makeFakePdf(10));
    const result = await splitPdf(src, '1-3,7,10');
    assert.equal(result.pages, 5);
    assert.deepEqual(result.kept, [1, 2, 3, 7, 10]);
    assert.equal(await pageCountOf(result.bytes), 5);
  });
});

test('splitPdf: out-of-range throws clean error', async () => {
  await withTempPdfs(0, async dir => {
    const src = join(dir, 'src.pdf');
    await writeFile(src, await makeFakePdf(3));
    await assert.rejects(splitPdf(src, '5'), /exceeds total/);
  });
});

// ─── deletePages ────────────────────────────────────────────────────────────

test('deletePages: removes specified, keeps the rest', async () => {
  await withTempPdfs(0, async dir => {
    const src = join(dir, 'src.pdf');
    await writeFile(src, await makeFakePdf(5));
    const result = await deletePages(src, '2,4');
    assert.equal(result.kept, 3);
    assert.equal(result.deleted, 2);
    assert.equal(await pageCountOf(result.bytes), 3);
  });
});

test('deletePages: deleting all pages throws (output would be empty)', async () => {
  await withTempPdfs(0, async dir => {
    const src = join(dir, 'src.pdf');
    await writeFile(src, await makeFakePdf(3));
    await assert.rejects(deletePages(src, '1-3'), /cannot delete every page/);
  });
});

// ─── addWatermark ───────────────────────────────────────────────────────────

test('addWatermark: ASCII text on every page', async () => {
  await withTempPdfs(0, async dir => {
    const src = join(dir, 'src.pdf');
    await writeFile(src, await makeFakePdf(2));
    const result = await addWatermark(src, 'CONFIDENTIAL');
    assert.equal(result.text, 'CONFIDENTIAL');
    assert.equal(result.pages, 2);
    // Output PDF still has the same page count.
    assert.equal(await pageCountOf(result.bytes), 2);
  });
});

test('addWatermark: rejects non-ASCII text (Helvetica StandardFont limitation)', async () => {
  await withTempPdfs(0, async dir => {
    const src = join(dir, 'src.pdf');
    await writeFile(src, await makeFakePdf(1));
    await assert.rejects(addWatermark(src, '机密'), /ASCII/);
    await assert.rejects(addWatermark(src, 'Café'), /ASCII/);
  });
});

test('addWatermark: requires non-empty text', async () => {
  await withTempPdfs(0, async dir => {
    const src = join(dir, 'src.pdf');
    await writeFile(src, await makeFakePdf(1));
    await assert.rejects(addWatermark(src, ''), /text is required/);
    await assert.rejects(addWatermark(src, null), /text is required/);
  });
});

// ─── addPageNumbers ─────────────────────────────────────────────────────────

test('addPageNumbers: default format adds "{n} / {total}" to all pages', async () => {
  await withTempPdfs(0, async dir => {
    const src = join(dir, 'src.pdf');
    await writeFile(src, await makeFakePdf(4));
    const result = await addPageNumbers(src);
    assert.equal(result.total, 4);
    assert.equal(await pageCountOf(result.bytes), 4);
  });
});

test('addPageNumbers: custom format substitutes {n} and {total}', async () => {
  await withTempPdfs(0, async dir => {
    const src = join(dir, 'src.pdf');
    await writeFile(src, await makeFakePdf(2));
    const result = await addPageNumbers(src, { format: 'page {n} of {total}' });
    assert.equal(result.total, 2);
  });
});

test('addPageNumbers: invalid position throws', async () => {
  await withTempPdfs(0, async dir => {
    const src = join(dir, 'src.pdf');
    await writeFile(src, await makeFakePdf(1));
    await assert.rejects(
      addPageNumbers(src, { position: 'middle-middle' }),
      /position/,
    );
  });
});

test('addPageNumbers: rejects non-ASCII format string', async () => {
  await withTempPdfs(0, async dir => {
    const src = join(dir, 'src.pdf');
    await writeFile(src, await makeFakePdf(1));
    await assert.rejects(addPageNumbers(src, { format: '第 {n} 页' }), /ASCII/);
  });
});

test('addPageNumbers: each margin slot accepted', async () => {
  await withTempPdfs(0, async dir => {
    const src = join(dir, 'src.pdf');
    await writeFile(src, await makeFakePdf(1));
    for (const pos of [
      'bottom-center', 'bottom-right', 'bottom-left',
      'top-center',    'top-right',    'top-left',
    ]) {
      const result = await addPageNumbers(src, { position: pos });
      assert.equal(result.total, 1);
    }
  });
});

// ─── prependCover ───────────────────────────────────────────────────────────

test('prependCover: cover pages come before source pages', async () => {
  await withTempPdfs(0, async dir => {
    const src = join(dir, 'src.pdf');
    const cover = join(dir, 'cover.pdf');
    await writeFile(src, await makeFakePdf(3));
    await writeFile(cover, await makeFakePdf(1));
    const result = await prependCover(src, cover);
    assert.equal(result.coverPages, 1);
    assert.equal(result.sourcePages, 3);
    assert.equal(result.totalPages, 4);
    assert.equal(await pageCountOf(result.bytes), 4);
  });
});

test('prependCover: multi-page cover is OK', async () => {
  await withTempPdfs(0, async dir => {
    const src = join(dir, 'src.pdf');
    const cover = join(dir, 'cover.pdf');
    await writeFile(src, await makeFakePdf(2));
    await writeFile(cover, await makeFakePdf(3));
    const result = await prependCover(src, cover);
    assert.equal(result.totalPages, 5);
  });
});

// ─── writeBytes ─────────────────────────────────────────────────────────────

test('writeBytes: persists buffer and returns size', async () => {
  await withTempPdfs(0, async dir => {
    const out = join(dir, 'out.pdf');
    const bytes = await makeFakePdf(1);
    const result = await writeBytes(out, bytes);
    assert.equal(result.path, out);
    assert.equal(result.bytes, bytes.length);
    const onDisk = await readFile(out);
    assert.equal(onDisk.length, bytes.length);
  });
});
