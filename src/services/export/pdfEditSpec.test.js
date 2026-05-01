// Tests for the edit-spec validator + engine routing helper. These
// are pure unit tests on the schema layer; the actual rendering
// (in_place_overlay via pdf-lib, rebuild via pdfkit / Playwright)
// is tested through pdfTool.fromspec.test.js — which exercises the
// integration end-to-end.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateEditSpec,
  pickRebuildEngine,
  resolveSpecInputPath,
} from './pdfEditSpec.js';

// ─── validateEditSpec — top-level + mode dispatch ───────────────────────────

test('validateEditSpec: rejects non-object input', () => {
  for (const bad of [null, undefined, 'string', 42, [], true]) {
    const r = validateEditSpec(bad);
    assert.equal(r.ok, false);
    assert.match(r.error, /must be an object/);
  }
});

test('validateEditSpec: rejects unknown mode with explicit list', () => {
  const r = validateEditSpec({ mode: 'rewrite-all', sections: [] });
  assert.equal(r.ok, false);
  assert.match(r.error, /in_place_overlay \| rebuild/);
});

test('validateEditSpec: rejects missing mode', () => {
  const r = validateEditSpec({ sections: [{ type: 'paragraph', text: 'x' }] });
  assert.equal(r.ok, false);
  assert.match(r.error, /mode/);
});

// ─── in_place_overlay validation ────────────────────────────────────────────

test('in_place_overlay: requires sourcePdf', () => {
  const r = validateEditSpec({ mode: 'in_place_overlay', overlays: [] });
  assert.equal(r.ok, false);
  assert.match(r.error, /sourcePdf/);
});

test('in_place_overlay: sourcePdf must end in .pdf', () => {
  const r = validateEditSpec({
    mode: 'in_place_overlay',
    sourcePdf: '/path/to/doc.txt',
    metadata: { title: 'X' },
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /\.pdf/);
});

test('in_place_overlay: at least one of overlays/metadata/formFields required', () => {
  const r = validateEditSpec({
    mode: 'in_place_overlay',
    sourcePdf: '/x.pdf',
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /at least one of: `overlays`/);
});

test('in_place_overlay: metadata-only spec is OK', () => {
  const r = validateEditSpec({
    mode: 'in_place_overlay',
    sourcePdf: '/x.pdf',
    metadata: { title: 'Q1 Report', author: 'Alice' },
  });
  assert.equal(r.ok, true);
});

test('in_place_overlay: rejects unknown metadata keys', () => {
  const r = validateEditSpec({
    mode: 'in_place_overlay',
    sourcePdf: '/x.pdf',
    metadata: { producer: 'melo' }, // not in title/author/subject set
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /metadata.producer/);
});

test('in_place_overlay: text overlay must have all required fields', () => {
  // missing y
  const r = validateEditSpec({
    mode: 'in_place_overlay',
    sourcePdf: '/x.pdf',
    overlays: [{ type: 'text', page: 1, x: 50, text: 'hello' }],
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /overlays\[0\].y/);
});

test('in_place_overlay: text overlay rejects non-ASCII (CJK reroute message)', () => {
  const r = validateEditSpec({
    mode: 'in_place_overlay',
    sourcePdf: '/x.pdf',
    overlays: [{ type: 'text', page: 1, x: 50, y: 50, text: '机密' }],
  });
  assert.equal(r.ok, false);
  // Must explicitly point users at rebuild mode.
  assert.match(r.error, /rebuild/);
  assert.match(r.error, /CJK|ASCII/);
});

test('in_place_overlay: text overlay color must be RGB in [0,1]', () => {
  const r = validateEditSpec({
    mode: 'in_place_overlay',
    sourcePdf: '/x.pdf',
    overlays: [{ type: 'text', page: 1, x: 50, y: 50, text: 'hi', color: [255, 0, 0] }], // 0..255 wrong
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /color/);
});

test('in_place_overlay: text overlay accepts valid color', () => {
  const r = validateEditSpec({
    mode: 'in_place_overlay',
    sourcePdf: '/x.pdf',
    overlays: [{ type: 'text', page: 1, x: 50, y: 50, text: 'hi', color: [1, 0, 0] }],
  });
  assert.equal(r.ok, true);
});

test('in_place_overlay: image overlay requires imagePath', () => {
  const r = validateEditSpec({
    mode: 'in_place_overlay',
    sourcePdf: '/x.pdf',
    overlays: [{ type: 'image', page: 1, x: 50, y: 50 }],
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /imagePath/);
});

test('in_place_overlay: page must be 1-indexed positive integer', () => {
  for (const badPage of [0, -1, 1.5, 'one']) {
    const r = validateEditSpec({
      mode: 'in_place_overlay',
      sourcePdf: '/x.pdf',
      overlays: [{ type: 'text', page: badPage, x: 50, y: 50, text: 'hi' }],
    });
    assert.equal(r.ok, false, `page=${badPage} should fail`);
    assert.match(r.error, /page/);
  }
});

test('in_place_overlay: formFields require name + value', () => {
  const r = validateEditSpec({
    mode: 'in_place_overlay',
    sourcePdf: '/x.pdf',
    formFields: [{ name: 'Email' }], // missing value
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /value/);
});

test('in_place_overlay: complex valid spec passes', () => {
  const r = validateEditSpec({
    mode: 'in_place_overlay',
    sourcePdf: '/source.pdf',
    overlays: [
      { type: 'text', page: 1, x: 50, y: 50, text: 'CONFIDENTIAL', fontSize: 18 },
      { type: 'image', page: 2, x: 100, y: 200, imagePath: '/logo.png', width: 80 },
    ],
    metadata: { title: 'Report', author: 'Alice' },
    formFields: [{ name: 'Name', value: 'Bob' }],
  });
  assert.equal(r.ok, true);
});

// ─── rebuild validation ─────────────────────────────────────────────────────

test('rebuild: requires non-empty sections', () => {
  for (const bad of [{ mode: 'rebuild' }, { mode: 'rebuild', sections: [] }, { mode: 'rebuild', sections: 'x' }]) {
    const r = validateEditSpec(bad);
    assert.equal(r.ok, false);
    assert.match(r.error, /sections/);
  }
});

test('rebuild: each section needs a type', () => {
  const r = validateEditSpec({
    mode: 'rebuild',
    sections: [{ text: 'no type field' }],
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /sections\[0\].type/);
});

test('rebuild: minimal valid spec passes', () => {
  const r = validateEditSpec({
    mode: 'rebuild',
    sections: [{ type: 'paragraph', text: 'hi' }],
  });
  assert.equal(r.ok, true);
});

test('rebuild: outputStyle.pageSize must be one of the known sizes', () => {
  const r = validateEditSpec({
    mode: 'rebuild',
    sections: [{ type: 'paragraph', text: 'hi' }],
    outputStyle: { pageSize: 'A5' },
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /pageSize/);
});

test('rebuild: rebuildEngine validation', () => {
  const valid = ['auto', 'pdfkit', 'html_playwright'];
  for (const v of valid) {
    const r = validateEditSpec({
      mode: 'rebuild',
      sections: [{ type: 'paragraph', text: 'hi' }],
      rebuildEngine: v,
    });
    assert.equal(r.ok, true, `engine=${v} should be valid`);
  }
  const bad = validateEditSpec({
    mode: 'rebuild',
    sections: [{ type: 'paragraph', text: 'hi' }],
    rebuildEngine: 'wkhtmltopdf',
  });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /rebuildEngine/);
});

test('rebuild: outputStyle CSS-style margin string accepted', () => {
  const r = validateEditSpec({
    mode: 'rebuild',
    sections: [{ type: 'paragraph', text: 'x' }],
    outputStyle: { margins: '1in' },
  });
  assert.equal(r.ok, true);
});

test('rebuild: outputStyle margin object accepted', () => {
  const r = validateEditSpec({
    mode: 'rebuild',
    sections: [{ type: 'paragraph', text: 'x' }],
    outputStyle: { margins: { top: '1in', right: '0.5in', bottom: '1in', left: '0.5in' } },
  });
  assert.equal(r.ok, true);
});

// ─── pickRebuildEngine — language → engine routing ──────────────────────────

test('pickRebuildEngine: explicit pdfkit always wins', () => {
  assert.equal(pickRebuildEngine({ rebuildEngine: 'pdfkit', outputStyle: { language: 'zh-CN' } }), 'pdfkit');
});

test('pickRebuildEngine: explicit html_playwright always wins', () => {
  assert.equal(pickRebuildEngine({ rebuildEngine: 'html_playwright', outputStyle: { language: 'en-US' } }), 'html_playwright');
});

test('pickRebuildEngine: auto + CJK languages → html_playwright', () => {
  for (const lang of ['zh-CN', 'zh-TW', 'zh', 'ja-JP', 'ja', 'ko-KR', 'ko', 'ZH-CN', 'JA']) {
    assert.equal(
      pickRebuildEngine({ outputStyle: { language: lang } }),
      'html_playwright',
      `lang=${lang} → html_playwright`,
    );
  }
});

test('pickRebuildEngine: auto + Latin / no-lang → pdfkit (smaller footprint)', () => {
  for (const lang of ['en-US', 'fr', 'de', 'es-ES', 'pt', undefined, '']) {
    assert.equal(
      pickRebuildEngine({ outputStyle: { language: lang } }),
      'pdfkit',
      `lang=${JSON.stringify(lang)} → pdfkit`,
    );
  }
});

test('pickRebuildEngine: explicit "auto" routes the same as no engine', () => {
  assert.equal(
    pickRebuildEngine({ rebuildEngine: 'auto', outputStyle: { language: 'zh-CN' } }),
    'html_playwright',
  );
  assert.equal(
    pickRebuildEngine({ rebuildEngine: 'auto', outputStyle: { language: 'en-US' } }),
    'pdfkit',
  );
});

// ─── resolveSpecInputPath ───────────────────────────────────────────────────

test('resolveSpecInputPath: absolute path passes through', () => {
  assert.equal(resolveSpecInputPath('/abs/x.pdf', '/ws'), '/abs/x.pdf');
});

test('resolveSpecInputPath: relative path resolves against workspace', () => {
  assert.equal(resolveSpecInputPath('x.pdf', '/ws'), '/ws/x.pdf');
  assert.equal(resolveSpecInputPath('sub/y.pdf', '/ws'), '/ws/sub/y.pdf');
});

test('resolveSpecInputPath: relative path with no workspace falls back to cwd', () => {
  const result = resolveSpecInputPath('x.pdf', null);
  // resolve(p) against cwd. We just check the path ends with x.pdf and is absolute.
  assert.match(result, /\/x\.pdf$/);
  assert.ok(result.startsWith('/'));
});

test('resolveSpecInputPath: bad input returns null', () => {
  for (const bad of [null, undefined, '', '   ', 42, {}, []]) {
    assert.equal(resolveSpecInputPath(bad, '/ws'), null);
  }
});
