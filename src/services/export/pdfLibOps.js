// pdf-lib operations — pure-JS PDF manipulation primitives.
//
// All exports are pure helpers around the `pdf-lib` npm package. Zero
// network calls, zero native deps. Each helper takes input bytes
// (read from disk by the caller) plus options, returns output bytes.
// Output is written to disk by pdfTool, not here, so unit tests don't
// need a workspace.
//
// Why a dedicated module instead of inlining in pdfTool.js
// --------------------------------------------------------
// pdfTool.js is already ~360 lines covering 3 actions. Adding 6 more
// would push it past the readable single-file budget. Splitting also
// lets the helpers be unit-tested independently of the
// permission/workspace plumbing in pdfTool.run().
//
// CJK / non-Latin caveat
// ----------------------
// The watermark + page-number actions use Helvetica (the StandardFonts
// built-in) for rendering text on top of pages. Helvetica does not
// support CJK glyphs — passing Chinese / Japanese / Korean text will
// silently render as rectangles ("tofu"). pdf-lib supports embedding
// custom fonts via embedFont(buffer), but melo doesn't currently ship
// CJK font files. So the helpers below are explicitly Latin-only and
// throw a clear error when given non-Latin text. Bilingual users can
// still merge / split / delete pages — those don't render new text.
//
// Page-range syntax
// -----------------
// parsePageRange accepts the same shape pdfTool documents:
//   "3"          → [3]
//   "1-5"        → [1,2,3,4,5]
//   "1-3,7,10-12"→ [1,2,3,7,10,11,12]
// 1-indexed (matches user mental model + pdftoppm's CLI). Out-of-range
// or malformed input throws with an explicit message.

import { readFile, writeFile } from 'node:fs/promises';

// Lazy-load pdf-lib so callers that only run other pdfTool actions
// (read / structured / render) don't pay the ~1MB import cost.
async function loadPdfLib() {
  const mod = await import('pdf-lib');
  return mod;
}

// Phase 2C (2026-05-04): every source-reading helper accepts EITHER
// a path (legacy callers) OR a Buffer (new callers that have already
// gated the read via FileSafetyGate). This lets pdfTool route every
// fs read through gatedReadIntoBuffer + atomicOpenLeaf so the path-
// to-pdf-lib re-open TOCTOU window is closed.
async function loadBytes(pathOrBuffer) {
  if (Buffer.isBuffer(pathOrBuffer)) return pathOrBuffer;
  if (typeof pathOrBuffer !== 'string' || !pathOrBuffer) {
    throw new Error('pdfLibOps: source must be a Buffer or non-empty path string');
  }
  return readFile(pathOrBuffer);
}

// ASCII-only check used by watermark + page-number text. We could
// actually render the text and let the missing-glyph fallback do its
// thing, but a silent tofu output is worse UX than a clear error.
const NON_LATIN_PATTERN = /[^\x00-\x7F]/;

/**
 * Parse a page-range string into a sorted, deduplicated 1-indexed
 * array of page numbers. Throws on malformed input or out-of-bounds
 * pages. Empty / null range returns ALL pages [1..totalPages].
 */
export function parsePageRange(range, totalPages) {
  const total = Number(totalPages);
  if (!Number.isInteger(total) || total < 1) {
    throw new Error(`parsePageRange: totalPages must be a positive integer (got ${totalPages})`);
  }
  if (!range || !String(range).trim()) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }
  const result = new Set();
  for (const part of String(range).split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) {
      throw new Error(`parsePageRange: invalid page range "${part}" (expected N or N-M)`);
    }
    const start = parseInt(m[1], 10);
    const end = m[2] ? parseInt(m[2], 10) : start;
    if (start < 1) {
      throw new Error(`parsePageRange: page numbers are 1-indexed (got ${start})`);
    }
    if (end > total) {
      throw new Error(`parsePageRange: page ${end} exceeds total ${total}`);
    }
    if (start > end) {
      throw new Error(`parsePageRange: range "${part}" has start > end`);
    }
    for (let i = start; i <= end; i++) result.add(i);
  }
  if (result.size === 0) {
    throw new Error('parsePageRange: range parsed to empty set');
  }
  return [...result].sort((a, b) => a - b);
}

// ─── merge ──────────────────────────────────────────────────────────────────

/**
 * Merge multiple PDFs (in order) into a new PDF. Returns the merged
 * bytes; caller writes them to disk.
 */
export async function mergePdfs(sourcePaths) {
  if (!Array.isArray(sourcePaths) || sourcePaths.length < 2) {
    throw new Error('mergePdfs: provide at least 2 source PDF paths');
  }
  const { PDFDocument } = await loadPdfLib();
  const merged = await PDFDocument.create();
  let totalPages = 0;
  for (const path of sourcePaths) {
    const bytes = await loadBytes(path);
    const doc = await PDFDocument.load(bytes);
    const pages = await merged.copyPages(doc, doc.getPageIndices());
    for (const p of pages) merged.addPage(p);
    totalPages += pages.length;
  }
  const out = await merged.save();
  return { bytes: out, totalPages, sources: sourcePaths.length };
}

// ─── split / extract ────────────────────────────────────────────────────────

/**
 * Extract a subset of pages from a PDF into a new document. The caller
 * decides whether this counts as "split" (extract one range) or
 * "delete pages" (extract everything but a range — see deletePages).
 */
export async function splitPdf(sourcePath, pageRange) {
  const { PDFDocument } = await loadPdfLib();
  const bytes = await loadBytes(sourcePath);
  const src = await PDFDocument.load(bytes);
  const pageNumbers = parsePageRange(pageRange, src.getPageCount());
  const out = await PDFDocument.create();
  const indices = pageNumbers.map(n => n - 1);
  const pages = await out.copyPages(src, indices);
  for (const p of pages) out.addPage(p);
  const outBytes = await out.save();
  return { bytes: outBytes, pages: pageNumbers.length, kept: pageNumbers };
}

// ─── delete pages ───────────────────────────────────────────────────────────

/**
 * Remove the specified pages and return a new PDF with what remains.
 * Throws if every page would be deleted (empty PDFs aren't valid output).
 */
export async function deletePages(sourcePath, pageRange) {
  const { PDFDocument } = await loadPdfLib();
  const bytes = await loadBytes(sourcePath);
  const src = await PDFDocument.load(bytes);
  const total = src.getPageCount();
  const toDelete = new Set(parsePageRange(pageRange, total));
  const keepIndices = [];
  for (let i = 1; i <= total; i++) {
    if (!toDelete.has(i)) keepIndices.push(i - 1);
  }
  if (keepIndices.length === 0) {
    throw new Error('deletePages: cannot delete every page (output would be empty)');
  }
  const out = await PDFDocument.create();
  const pages = await out.copyPages(src, keepIndices);
  for (const p of pages) out.addPage(p);
  const outBytes = await out.save();
  return {
    bytes: outBytes,
    kept: keepIndices.length,
    deleted: total - keepIndices.length,
  };
}

// ─── watermark ──────────────────────────────────────────────────────────────

/**
 * Stamp a text watermark across every page of the source PDF. Limits:
 *   • Latin-only text (Helvetica). Pass non-ASCII and we throw.
 *   • Single line. Newlines are ignored.
 *   • Centered, rotated -45° by default. Override via opts.
 */
export async function addWatermark(sourcePath, text, opts = {}) {
  if (!text || typeof text !== 'string') {
    throw new Error('addWatermark: text is required');
  }
  if (NON_LATIN_PATTERN.test(text)) {
    throw new Error(
      'addWatermark: text must be ASCII / Latin only (Helvetica StandardFont). ' +
        'CJK watermarks need an embedded font — not yet supported.',
    );
  }
  const {
    opacity = 0.25,
    angle = -45,
    fontSize = 60,
    colorR = 128,
    colorG = 128,
    colorB = 128,
  } = opts;
  const { PDFDocument, StandardFonts, rgb, degrees } = await loadPdfLib();
  const bytes = await loadBytes(sourcePath);
  const doc = await PDFDocument.load(bytes);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const textWidth = font.widthOfTextAtSize(text, fontSize);
  const pages = doc.getPages();
  for (const page of pages) {
    const { width, height } = page.getSize();
    page.drawText(text, {
      // Centred horizontally at the page midpoint accounting for the
      // diagonal rotation. Not pixel-perfect but visually centred.
      x: width / 2 - textWidth / 2,
      y: height / 2,
      size: fontSize,
      font,
      color: rgb(colorR / 255, colorG / 255, colorB / 255),
      opacity,
      rotate: degrees(angle),
    });
  }
  const outBytes = await doc.save();
  return { bytes: outBytes, pages: pages.length, text };
}

// ─── page numbers ───────────────────────────────────────────────────────────

const PAGE_NUMBER_POSITIONS = new Set([
  'bottom-center',
  'bottom-right',
  'bottom-left',
  'top-center',
  'top-right',
  'top-left',
]);

/**
 * Stamp page numbers on every page. Format string supports {n} (current
 * 1-indexed page) and {total} (page count). Position picks one of 6
 * margin slots. Latin-only (same Helvetica caveat as watermark).
 */
export async function addPageNumbers(sourcePath, opts = {}) {
  const {
    format = '{n} / {total}',
    position = 'bottom-center',
    fontSize = 10,
    margin = 30,
  } = opts;
  if (!PAGE_NUMBER_POSITIONS.has(position)) {
    throw new Error(
      `addPageNumbers: position "${position}" not one of ${[...PAGE_NUMBER_POSITIONS].join(' | ')}`,
    );
  }
  if (NON_LATIN_PATTERN.test(format)) {
    throw new Error(
      'addPageNumbers: format must be ASCII / Latin only (Helvetica StandardFont).',
    );
  }
  const { PDFDocument, StandardFonts, rgb } = await loadPdfLib();
  const bytes = await loadBytes(sourcePath);
  const doc = await PDFDocument.load(bytes);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = doc.getPages();
  const total = pages.length;
  for (let i = 0; i < total; i++) {
    const page = pages[i];
    const text = format.replace(/\{n\}/g, String(i + 1)).replace(/\{total\}/g, String(total));
    const { width, height } = page.getSize();
    const textWidth = font.widthOfTextAtSize(text, fontSize);

    let x;
    if (position.endsWith('center')) x = (width - textWidth) / 2;
    else if (position.endsWith('right')) x = width - margin - textWidth;
    else x = margin;

    let y;
    if (position.startsWith('bottom')) y = margin;
    else y = height - margin;

    page.drawText(text, {
      x,
      y,
      size: fontSize,
      font,
      color: rgb(0.4, 0.4, 0.4),
    });
  }
  const outBytes = await doc.save();
  return { bytes: outBytes, total };
}

// ─── prepend cover ──────────────────────────────────────────────────────────

/**
 * Prepend a cover PDF (first N pages) onto an existing PDF.
 * Symmetric helper for "appendPages" can be added later — same code
 * path, just reverse the copy order.
 */
export async function prependCover(sourcePath, coverPath) {
  const { PDFDocument } = await loadPdfLib();
  const srcBytes = await loadBytes(sourcePath);
  const coverBytes = await loadBytes(coverPath);
  const src = await PDFDocument.load(srcBytes);
  const cover = await PDFDocument.load(coverBytes);
  const out = await PDFDocument.create();
  const coverPages = await out.copyPages(cover, cover.getPageIndices());
  for (const p of coverPages) out.addPage(p);
  const srcPages = await out.copyPages(src, src.getPageIndices());
  for (const p of srcPages) out.addPage(p);
  const outBytes = await out.save();
  return {
    bytes: outBytes,
    coverPages: cover.getPageCount(),
    sourcePages: src.getPageCount(),
    totalPages: out.getPageCount(),
  };
}

// ─── in-place overlay (Batch C — edit_spec mode='in_place_overlay') ─────────
//
// Apply a sequence of overlays + metadata + form-field updates to an
// existing PDF, return the modified bytes. Inputs are pre-validated by
// pdfEditSpec.validateEditSpec so this function trusts its arguments
// — no extra defensive checks here, just the actual pdf-lib calls.
//
// All overlay text uses Helvetica StandardFont (Latin only). pdfEdit
// Spec rejects CJK overlays at validation time, so the model gets a
// clear error instead of tofu output.
//
// @param {Buffer|Uint8Array} sourceBytes  bytes of the source PDF
// @param {object} spec  validated edit-spec (mode='in_place_overlay')
// @returns {Promise<{ bytes: Uint8Array, overlaysApplied: number,
//                     metadataKeys: string[], formFieldsApplied: number }>}
export async function applyInPlaceOverlays(sourceBytes, spec) {
  const { PDFDocument, StandardFonts, rgb } = await loadPdfLib();
  const doc = await PDFDocument.load(sourceBytes);

  let overlaysApplied = 0;
  let formFieldsApplied = 0;
  const metadataKeys = [];

  // ── metadata ──────────────────────────────────────────────────────────
  if (spec.metadata) {
    if (typeof spec.metadata.title === 'string') {
      doc.setTitle(spec.metadata.title);
      metadataKeys.push('title');
    }
    if (typeof spec.metadata.author === 'string') {
      doc.setAuthor(spec.metadata.author);
      metadataKeys.push('author');
    }
    if (typeof spec.metadata.subject === 'string') {
      doc.setSubject(spec.metadata.subject);
      metadataKeys.push('subject');
    }
  }

  // ── overlays ──────────────────────────────────────────────────────────
  if (Array.isArray(spec.overlays) && spec.overlays.length > 0) {
    const helvetica = await doc.embedFont(StandardFonts.Helvetica);
    const pages = doc.getPages();
    for (const ov of spec.overlays) {
      const idx = ov.page - 1;
      const page = pages[idx];
      if (!page) {
        throw new Error(
          `applyInPlaceOverlays: overlay targets page ${ov.page} but PDF has only ${pages.length} page${pages.length === 1 ? '' : 's'}`,
        );
      }
      if (ov.type === 'text') {
        const color = Array.isArray(ov.color) ? ov.color : [0, 0, 0];
        page.drawText(ov.text, {
          x: ov.x,
          y: ov.y,
          size: ov.fontSize || 12,
          font: helvetica,
          color: rgb(color[0], color[1], color[2]),
        });
        overlaysApplied += 1;
      } else if (ov.type === 'image') {
        // Phase 2C follow-up #1 (Codex 🟠, 2026-05-04): prefer
        // `ov.imageBytes` (a Buffer the tool layer pre-read through
        // gatedReadIntoBuffer). Falls back to `ov.imagePath` for
        // legacy/internal callers and unit tests; production tools
        // (pdfTool.from_spec) MUST pre-gate and inject imageBytes
        // so the gate's sensitivity check fires for every overlay
        // image.
        const bytes = Buffer.isBuffer(ov.imageBytes)
          ? ov.imageBytes
          : await loadBytes(ov.imagePath);
        let img;
        // Magic-byte sniff so an image labelled .jpg but containing
        // PNG bytes still works (and vice versa).
        if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
          img = await doc.embedPng(bytes);
        } else if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
          img = await doc.embedJpg(bytes);
        } else {
          throw new Error(
            `applyInPlaceOverlays: image at ${ov.imagePath || '(buffer)'} is not a valid PNG or JPG (pdf-lib only embeds those two formats)`,
          );
        }
        page.drawImage(img, {
          x: ov.x,
          y: ov.y,
          width: typeof ov.width === 'number' ? ov.width : img.width,
          height: typeof ov.height === 'number' ? ov.height : img.height,
        });
        overlaysApplied += 1;
      }
    }
  }

  // ── form fields ───────────────────────────────────────────────────────
  if (Array.isArray(spec.formFields) && spec.formFields.length > 0) {
    let form;
    try {
      form = doc.getForm();
    } catch {
      throw new Error(
        'applyInPlaceOverlays: PDF has no form layer (formFields can only be set on fillable PDF forms)',
      );
    }
    for (const f of spec.formFields) {
      let field;
      try {
        field = form.getTextField(f.name);
      } catch {
        throw new Error(
          `applyInPlaceOverlays: form field "${f.name}" not found or is not a text field. Available fields can be inspected externally with form-aware PDF tools.`,
        );
      }
      field.setText(String(f.value));
      formFieldsApplied += 1;
    }
  }

  const bytes = await doc.save();
  return { bytes, overlaysApplied, metadataKeys, formFieldsApplied };
}

// ─── write helper (used by pdfTool wrapper) ─────────────────────────────────

/** Convenience: persist a `bytes` Buffer/Uint8Array to disk. */
export async function writeBytes(outputPath, bytes) {
  await writeFile(outputPath, bytes);
  return { path: outputPath, bytes: bytes.length };
}
