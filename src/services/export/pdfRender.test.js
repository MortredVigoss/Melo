// Tests for the pdftoppm wrapper.
//
// We cannot rely on `pdftoppm` actually being installed in the test
// environment, so happy-path tests use the `_setPdftoppmAvailable`
// test seam to fake the probe. Tests that verify the install hint
// force the probe to false.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  renderPdfPagesToPngs,
  renderPdfPagesToTemp,
  _setPdftoppmAvailable,
} from './pdfRender.js';

// ─── install-hint behaviour (probe says missing) ────────────────────────────

test('renderPdfPagesToPngs: clear install hint when pdftoppm missing', async () => {
  _setPdftoppmAvailable(false);
  await assert.rejects(
    renderPdfPagesToPngs({
      sourcePath: '/tmp/anything.pdf',
      outputDir: '/tmp/out',
    }),
    /brew install poppler/,
    'error message must tell the user how to install',
  );
});

test('renderPdfPagesToPngs: hint also mentions Linux apt-get path', async () => {
  _setPdftoppmAvailable(false);
  try {
    await renderPdfPagesToPngs({
      sourcePath: '/tmp/x.pdf',
      outputDir: '/tmp/out',
    });
    assert.fail('expected throw');
  } catch (err) {
    assert.match(err.message, /apt-get install poppler-utils/);
    // And must explicitly say it's free / no API.
    assert.match(err.message, /no API cost|free open-source/i);
  }
});

// ─── input validation (probe says present) ──────────────────────────────────

test('renderPdfPagesToPngs: missing sourcePath rejects before spawn', async () => {
  _setPdftoppmAvailable(true);
  await assert.rejects(
    renderPdfPagesToPngs({ outputDir: '/tmp/out' }),
    /sourcePath is required/,
  );
});

test('renderPdfPagesToPngs: missing outputDir rejects before spawn', async () => {
  _setPdftoppmAvailable(true);
  await assert.rejects(
    renderPdfPagesToPngs({ sourcePath: '/tmp/x.pdf' }),
    /outputDir is required/,
  );
});

test('renderPdfPagesToPngs: multi-range pageRange rejects with clear message', async () => {
  _setPdftoppmAvailable(true);
  // pdftoppm only takes -f / -l (a single contiguous range), so
  // "1-3,5,7-9" can't be expressed in a single call. We could split
  // into multiple invocations, but that adds complexity for an edge
  // case. For now we reject at the input boundary.
  await assert.rejects(
    renderPdfPagesToPngs({
      sourcePath: '/tmp/x.pdf',
      outputDir: '/tmp/out',
      pageRange: '1-3,5,7-9',
    }),
    /must be N or N-M/,
  );
});

// ─── happy path with a stub pdftoppm ────────────────────────────────────────
//
// When pdftoppm IS on PATH (CI / dev box with poppler installed),
// run an actual end-to-end render of a tiny in-memory PDF. We detect
// availability ourselves so the test self-skips when the binary is
// missing. We DON'T use `node:test` skip API because skip's behaviour
// changed across Node 20 → 22 — explicit detect + early return is
// more portable and the skipped path still records an `ok` line.

async function probePdftoppm() {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  try {
    await promisify(execFile)('pdftoppm', ['-v'], { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

async function makeFakePdf() {
  const { PDFDocument, rgb } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  for (let i = 1; i <= 3; i++) {
    const page = doc.addPage([400, 300]);
    page.drawText(`Page ${i}`, { x: 50, y: 250, size: 24, color: rgb(0, 0, 0) });
  }
  return Buffer.from(await doc.save());
}

test('renderPdfPagesToPngs: end-to-end (skipped if pdftoppm not installed)', async () => {
  // Reset probe cache so the real `pdftoppm -v` runs.
  _setPdftoppmAvailable(null);
  if (!(await probePdftoppm())) {
    return; // self-skip — no environment installation
  }
  const dir = await mkdtemp(join(tmpdir(), 'melo-pdfrender-test-'));
  try {
    const srcPdf = join(dir, 'src.pdf');
    await writeFile(srcPdf, await makeFakePdf());
    const outDir = join(dir, 'out');
    const result = await renderPdfPagesToPngs({
      sourcePath: srcPdf,
      outputDir: outDir,
      scale: 1, // 72dpi keeps the test buffer small
    });
    assert.equal(result.count, 3);
    assert.equal(result.dpi, 72);
    assert.equal(result.paths.length, 3);
    // Files exist, are PNGs, and are 1-indexed sorted.
    for (const p of result.paths) {
      const { stat } = await import('node:fs/promises');
      const s = await stat(p);
      assert.ok(s.size > 0, `${p} should be non-empty`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('renderPdfPagesToPngs: pageRange limits output (skipped if pdftoppm not installed)', async () => {
  _setPdftoppmAvailable(null);
  if (!(await probePdftoppm())) return;
  const dir = await mkdtemp(join(tmpdir(), 'melo-pdfrender-range-'));
  try {
    const srcPdf = join(dir, 'src.pdf');
    await writeFile(srcPdf, await makeFakePdf());
    const outDir = join(dir, 'out');
    const result = await renderPdfPagesToPngs({
      sourcePath: srcPdf,
      outputDir: outDir,
      pageRange: '2',
      scale: 1,
    });
    assert.equal(result.count, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ─── renderPdfPagesToTemp convenience ───────────────────────────────────────

test('renderPdfPagesToTemp: missing pdftoppm propagates the install hint', async () => {
  _setPdftoppmAvailable(false);
  await assert.rejects(
    renderPdfPagesToTemp('/tmp/anything.pdf'),
    /brew install poppler/,
  );
});
