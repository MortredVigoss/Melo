// Integration tests for pdfTool.action='from_spec' — exercises the
// full pipeline: spec validation → mode dispatch → rendering →
// output write + URL signing. We don't run the Playwright path
// here (would require a working browser binary in CI); the
// rebuild-via-pdfkit path is fully covered. The Playwright path
// has its own test that self-skips when `npx playwright` isn't
// available, which mirrors how Batch A handled pdftoppm.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pdfTool } from './pdfTool.js';

async function makeFakePdf(numPages = 2) {
  const { PDFDocument, rgb } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  for (let i = 1; i <= numPages; i++) {
    const page = doc.addPage([400, 300]);
    page.drawText(`Page ${i}`, { x: 50, y: 250, size: 24, color: rgb(0, 0, 0) });
  }
  return Buffer.from(await doc.save());
}

async function makeFakePng() {
  // Minimal valid PNG (8-byte signature + IHDR + IDAT + IEND).
  // We use pdf-lib's png handling indirectly through the rendered
  // overlay — a real PNG header is enough for embedPng to load it.
  // Here we just spit out a known-valid 1×1 transparent PNG.
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41,
    0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
    0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
    0x42, 0x60, 0x82,
  ]);
}

async function withWorkspace(callback) {
  const ws = await mkdtemp(join(tmpdir(), 'melo-fromspec-'));
  try {
    return await callback(ws);
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
}

// ─── invalid spec → INVALID_SPEC error ──────────────────────────────────────

test('from_spec: missing editSpec → INVALID_SPEC', async () => {
  const result = await pdfTool.run(
    { action: 'from_spec' },
    { workspacePath: '/tmp/x' },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, 'INVALID_SPEC');
  assert.match(result.output, /editSpec must be an object/);
});

test('from_spec: malformed spec → validator error surfaces with the offending field', async () => {
  await withWorkspace(async ws => {
    const result = await pdfTool.run(
      {
        action: 'from_spec',
        editSpec: {
          mode: 'rebuild',
          sections: [{ text: 'no type field' }],
        },
      },
      { workspacePath: ws },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, 'INVALID_SPEC');
    // Specifically points at the section index and the missing key
    // — the failure cause shows up actionable, not as a deep stack
    // from inside pdf-lib.
    assert.match(result.output, /sections\[0\]\.type/);
  });
});

// ─── in_place_overlay: metadata-only ────────────────────────────────────────

test('from_spec in_place_overlay: metadata-only spec produces a PDF with the new metadata', async () => {
  await withWorkspace(async ws => {
    await writeFile(join(ws, 'src.pdf'), await makeFakePdf(2));
    const result = await pdfTool.run(
      {
        action: 'from_spec',
        editSpec: {
          mode: 'in_place_overlay',
          sourcePdf: 'src.pdf',
          metadata: { title: 'Updated Title', author: 'Alice' },
        },
      },
      { workspacePath: ws },
    );
    assert.equal(result.ok, true, result.output);
    assert.equal(result.meta.mode, 'in_place_overlay');
    assert.deepEqual(result.meta.metadataKeys.sort(), ['author', 'title']);
    // Round-trip: load the output, confirm the metadata was actually set.
    const { PDFDocument } = await import('pdf-lib');
    const out = await PDFDocument.load(await readFile(result.meta.path));
    assert.equal(out.getTitle(), 'Updated Title');
    assert.equal(out.getAuthor(), 'Alice');
  });
});

// ─── in_place_overlay: text overlay ─────────────────────────────────────────

test('from_spec in_place_overlay: text overlay applied to specific page', async () => {
  await withWorkspace(async ws => {
    await writeFile(join(ws, 'src.pdf'), await makeFakePdf(3));
    const result = await pdfTool.run(
      {
        action: 'from_spec',
        editSpec: {
          mode: 'in_place_overlay',
          sourcePdf: 'src.pdf',
          overlays: [
            { type: 'text', page: 2, x: 50, y: 100, text: 'STAMP', fontSize: 20 },
          ],
        },
      },
      { workspacePath: ws },
    );
    assert.equal(result.ok, true, result.output);
    assert.equal(result.meta.overlaysApplied, 1);
    // The output PDF still has 3 pages — overlay doesn't add or remove pages.
    const { PDFDocument } = await import('pdf-lib');
    const out = await PDFDocument.load(await readFile(result.meta.path));
    assert.equal(out.getPageCount(), 3);
  });
});

test('from_spec in_place_overlay: out-of-bounds page → FROM_SPEC_FAILED', async () => {
  await withWorkspace(async ws => {
    await writeFile(join(ws, 'src.pdf'), await makeFakePdf(2));
    const result = await pdfTool.run(
      {
        action: 'from_spec',
        editSpec: {
          mode: 'in_place_overlay',
          sourcePdf: 'src.pdf',
          overlays: [
            { type: 'text', page: 5, x: 50, y: 50, text: 'STAMP' },
          ],
        },
      },
      { workspacePath: ws },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, 'FROM_SPEC_FAILED');
    assert.match(result.output, /page 5 .* 2 page/);
  });
});

// ─── in_place_overlay: image overlay ────────────────────────────────────────

test('from_spec in_place_overlay: image overlay embeds PNG', async () => {
  await withWorkspace(async ws => {
    await writeFile(join(ws, 'src.pdf'), await makeFakePdf(1));
    await writeFile(join(ws, 'logo.png'), await makeFakePng());
    const result = await pdfTool.run(
      {
        action: 'from_spec',
        editSpec: {
          mode: 'in_place_overlay',
          sourcePdf: 'src.pdf',
          overlays: [
            { type: 'image', page: 1, x: 100, y: 100, imagePath: 'logo.png', width: 50, height: 50 },
          ],
        },
      },
      { workspacePath: ws },
    );
    assert.equal(result.ok, true, result.output);
    assert.equal(result.meta.overlaysApplied, 1);
  });
});

test('from_spec in_place_overlay: CJK overlay text rejected by validator (points at rebuild)', async () => {
  // Validator-level rejection — never reaches the renderer.
  await withWorkspace(async ws => {
    await writeFile(join(ws, 'src.pdf'), await makeFakePdf(1));
    const result = await pdfTool.run(
      {
        action: 'from_spec',
        editSpec: {
          mode: 'in_place_overlay',
          sourcePdf: 'src.pdf',
          overlays: [{ type: 'text', page: 1, x: 50, y: 50, text: '机密' }],
        },
      },
      { workspacePath: ws },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, 'INVALID_SPEC');
    assert.match(result.output, /rebuild/);
  });
});

// ─── rebuild — pdfkit engine ────────────────────────────────────────────────

test('from_spec rebuild: ASCII-only spec routes to pdfkit and produces a valid PDF', async () => {
  await withWorkspace(async ws => {
    const result = await pdfTool.run(
      {
        action: 'from_spec',
        editSpec: {
          mode: 'rebuild',
          sections: [
            { type: 'heading', level: 1, text: 'Q1 Sales Report' },
            { type: 'paragraph', text: 'Summary of Q1 performance.' },
            { type: 'list', ordered: false, items: ['North: $125k', 'South: $98k'] },
          ],
          outputStyle: { language: 'en-US', pageSize: 'A4' },
        },
      },
      { workspacePath: ws },
    );
    assert.equal(result.ok, true, result.output);
    assert.equal(result.meta.mode, 'rebuild');
    assert.equal(result.meta.engine, 'pdfkit');
    assert.equal(result.meta.sections, 3);
    // The output file actually exists and is non-empty PDF bytes.
    const s = await stat(result.meta.path);
    assert.ok(s.size > 0);
    const head = await readFile(result.meta.path);
    // PDF files start with "%PDF-".
    assert.equal(head.slice(0, 5).toString(), '%PDF-');
  });
});

test('from_spec rebuild: explicit rebuildEngine="pdfkit" overrides language hint', async () => {
  await withWorkspace(async ws => {
    const result = await pdfTool.run(
      {
        action: 'from_spec',
        editSpec: {
          mode: 'rebuild',
          sections: [{ type: 'paragraph', text: 'hello' }],
          outputStyle: { language: 'zh-CN' }, // would normally route to playwright
          rebuildEngine: 'pdfkit',
        },
      },
      { workspacePath: ws },
    );
    assert.equal(result.ok, true, result.output);
    assert.equal(result.meta.engine, 'pdfkit');
  });
});

// (Playwright integration test skipped — exercising the html_playwright
// engine end-to-end requires a working `@playwright/cli` install + a
// real chromium binary, neither reliably available in unit-test
// environments. The routing decision (CJK language → html_playwright)
// is fully covered by pickRebuildEngine tests in
// pdfEditSpec.test.js. The actual Playwright handoff via writePdf is
// shared with the existing `write` action — broken there is broken
// here, fixed there is fixed here. We don't double-test.)

// ─── path contract: input paths resolve against workspace ───────────────────

test('from_spec in_place_overlay: workspace-relative sourcePdf reads from workspace', async () => {
  // Mirrors the pdfTool path-contract tests — input paths resolve to
  // <workspace>/<p> when relative, NOT to process.cwd().
  await withWorkspace(async ws => {
    await writeFile(join(ws, 'mydoc.pdf'), await makeFakePdf(1));
    const result = await pdfTool.run(
      {
        action: 'from_spec',
        editSpec: {
          mode: 'in_place_overlay',
          sourcePdf: 'mydoc.pdf',
          metadata: { title: 'New' },
        },
      },
      { workspacePath: ws },
    );
    assert.equal(result.ok, true);
  });
});

test('from_spec in_place_overlay: workspace-relative imagePath in overlays', async () => {
  await withWorkspace(async ws => {
    await writeFile(join(ws, 'src.pdf'), await makeFakePdf(1));
    await writeFile(join(ws, 'logo.png'), await makeFakePng());
    const result = await pdfTool.run(
      {
        action: 'from_spec',
        editSpec: {
          mode: 'in_place_overlay',
          sourcePdf: 'src.pdf',
          overlays: [{ type: 'image', page: 1, x: 50, y: 50, imagePath: 'logo.png' }],
        },
      },
      { workspacePath: ws },
    );
    assert.equal(result.ok, true, result.output);
  });
});

// ─── output URL signing ─────────────────────────────────────────────────────

test('from_spec: output URL is signed when result lands in workspace', async () => {
  await withWorkspace(async ws => {
    const result = await pdfTool.run(
      {
        action: 'from_spec',
        editSpec: {
          mode: 'rebuild',
          sections: [{ type: 'heading', level: 1, text: 'Hi' }],
        },
      },
      { workspacePath: ws },
    );
    assert.equal(result.ok, true);
    assert.match(result.meta.url, /\/api\/files\/signed\//);
  });
});

// ─── schema sanity ──────────────────────────────────────────────────────────

test('from_spec: schema documents both modes + key field constraints', () => {
  const desc = pdfTool.parametersSchema.properties.editSpec.description;
  assert.match(desc, /in_place_overlay/);
  assert.match(desc, /rebuild/);
  assert.match(desc, /CJK/);
  assert.match(desc, /sourcePdf/);
  assert.match(desc, /sections/);
});
