// PDF → page-image renderer.
//
// Why we shell out to pdftoppm
// ----------------------------
// Codex review and the user audit both agreed: do NOT introduce
// network-paid services or native-canvas npm packages just to render
// a PDF page to an image. The simplest cost-zero options are:
//
//   1. pdftoppm (poppler-utils CLI) — industry-standard, fast,
//      ~50ms/page, output is clean PNG with no PDF-viewer toolbar.
//      Installed once via `brew install poppler` (or apt-get install
//      poppler-utils on Linux). About 10MB of binaries.
//   2. macOS `qlmanage` — built in, but emits webp by default with
//      a Quick Look watermark frame. Output isn't clean.
//   3. Playwright + chromium PDF viewer — chromium's built-in PDF
//      viewer has a toolbar, screenshots include it, output is
//      ugly. Trying to hide the toolbar requires content-script
//      hacks per chromium version.
//   4. pdfjs-dist + node-canvas — node-canvas is a native
//      compile (cairo / pango) that eats install reliability.
//
// We picked option 1. Users already accept brew installs for codex /
// playwright; poppler is one more in the same league.
//
// Failure mode UX
// ---------------
// First render call probes for `pdftoppm` on PATH. Missing → a
// thrown error whose message tells the user exactly what to do
// (`brew install poppler`). This is far more useful than "ENOENT
// pdftoppm" because tool-call errors get surfaced to the model and
// the model often relays the install hint to the user.

import { execFile } from 'node:child_process';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Cache the probe result per-process so we don't shell out for
// every single render call.
let _pdftoppmAvailable = null;

async function pdftoppmIsAvailable() {
  if (_pdftoppmAvailable !== null) return _pdftoppmAvailable;
  try {
    await execFileAsync('pdftoppm', ['-v'], { timeout: 3000 });
    _pdftoppmAvailable = true;
  } catch {
    // -v exits 0 on stderr-output, but if `which` style says missing
    // the spawn errors with ENOENT. We treat both as "not installed".
    _pdftoppmAvailable = false;
  }
  return _pdftoppmAvailable;
}

// Test seam: lets unit tests force the probe result without actually
// spawning pdftoppm.
export function _setPdftoppmAvailable(value) {
  _pdftoppmAvailable = value;
}

const POPPLER_INSTALL_HINT =
  'pdftoppm is required for PDF rendering. Install poppler:\n' +
  '  • macOS:  brew install poppler\n' +
  '  • Linux:  sudo apt-get install poppler-utils\n' +
  'Then retry. (poppler is free open-source — no API cost.)';

/**
 * Render the requested pages of a source PDF into a folder of PNG
 * files. Returns the on-disk paths in 1-indexed page order.
 *
 * @param {object} opts
 * @param {string} opts.sourcePath  absolute path to the source PDF
 * @param {string} opts.outputDir   absolute path to a directory pdftoppm
 *                                  will write into (created if missing)
 * @param {string} [opts.namePrefix] basename for outputs (default 'page').
 *                                  pdftoppm appends '-<n>.png' itself.
 * @param {number} [opts.scale]     2 → 144dpi (default; legible),
 *                                  1 → 72dpi  (smaller / faster).
 * @param {string} [opts.pageRange] e.g. '1-3'. Default: all pages.
 *                                  Multi-range like '1-3,5,7-9' is
 *                                  NOT supported by pdftoppm in one
 *                                  call — caller has to split into
 *                                  multiple invocations and merge.
 * @param {number} [opts.timeoutMs] hard timeout (default 60s).
 * @returns {Promise<{paths: string[], dpi: number, count: number}>}
 */
export async function renderPdfPagesToPngs({
  sourcePath,
  outputDir,
  namePrefix = 'page',
  scale = 2,
  pageRange,
  timeoutMs = 60_000,
}) {
  if (!(await pdftoppmIsAvailable())) {
    throw new Error(POPPLER_INSTALL_HINT);
  }
  if (!sourcePath || typeof sourcePath !== 'string') {
    throw new Error('renderPdfPagesToPngs: sourcePath is required');
  }
  if (!outputDir || typeof outputDir !== 'string') {
    throw new Error('renderPdfPagesToPngs: outputDir is required');
  }
  const dpi = 72 * Math.max(1, Math.min(8, Number(scale) || 2));

  await mkdir(outputDir, { recursive: true });
  const prefix = join(outputDir, namePrefix);

  const args = [sourcePath, prefix, '-png', '-r', String(dpi)];
  if (pageRange) {
    const m = String(pageRange).trim().match(/^(\d+)(?:-(\d+))?$/);
    if (!m) {
      throw new Error(
        `renderPdfPagesToPngs: pageRange "${pageRange}" must be N or N-M (multi-range not supported in one call)`,
      );
    }
    args.push('-f', m[1]);
    args.push('-l', m[2] || m[1]);
  }

  try {
    await execFileAsync('pdftoppm', args, { timeout: timeoutMs });
  } catch (err) {
    // pdftoppm's stderr is usually the actual reason. err.stderr is
    // populated by execFileAsync.
    const stderr = (err.stderr || '').trim();
    const detail = stderr || err.message;
    throw new Error(`pdftoppm failed: ${detail}`);
  }

  // pdftoppm emits page-1.png, page-2.png, … (1-indexed). For multi-
  // digit page counts it pads with zeros (page-01.png) when -l is set.
  // Read the output dir, pick our prefix, sort numerically.
  const files = await readdir(outputDir);
  const ours = files
    .filter(f => f.startsWith(`${namePrefix}-`) && f.endsWith('.png'))
    .map(f => ({
      name: f,
      path: join(outputDir, f),
      n: parseInt(f.slice(namePrefix.length + 1).replace(/\.png$/i, ''), 10) || 0,
    }))
    .sort((a, b) => a.n - b.n);

  if (ours.length === 0) {
    throw new Error('pdftoppm produced no output files');
  }
  return {
    paths: ours.map(o => o.path),
    dpi,
    count: ours.length,
  };
}

/**
 * Convenience: render to a temp directory, return paths. Caller is
 * responsible for cleanup if the temp dir matters; otherwise leave
 * it under /tmp where the OS will reap it.
 */
export async function renderPdfPagesToTemp(sourcePath, opts = {}) {
  const { tmpdir } = await import('node:os');
  const { mkdtemp } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'melo-pdf-render-'));
  try {
    return await renderPdfPagesToPngs({ sourcePath, outputDir: dir, ...opts });
  } catch (err) {
    // Best-effort cleanup on failure so we don't leak temp dirs.
    rm(dir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}
