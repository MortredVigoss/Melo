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
  sectionsContainCjk,
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

// ─── sectionsContainCjk content scanner ─────────────────────────────────────
//
// Codex review (Batch C round 3, 2026-05-01) caught: models often
// emit CJK content in `sections` without setting outputStyle.language,
// and the previous router put them on pdfkit → tofu output. The
// content-scan fallback in pickRebuildEngine relies on this helper.
// Tests pin the Unicode block coverage so a future tightening or
// regex-style refactor can't silently miss a script.

test('sectionsContainCjk: returns false for ASCII-only sections', () => {
  assert.equal(
    sectionsContainCjk([
      { type: 'heading', level: 1, text: 'Q1 Sales' },
      { type: 'paragraph', text: 'Summary of performance.' },
    ]),
    false,
  );
});

test('sectionsContainCjk: detects Chinese (CJK Unified Ideographs)', () => {
  assert.equal(
    sectionsContainCjk([{ type: 'paragraph', text: '这是中文内容' }]),
    true,
  );
});

test('sectionsContainCjk: detects Japanese (Hiragana + Katakana)', () => {
  assert.equal(
    sectionsContainCjk([{ type: 'paragraph', text: 'これはひらがな' }]),
    true,
  );
  assert.equal(
    sectionsContainCjk([{ type: 'paragraph', text: 'カタカナです' }]),
    true,
  );
});

test('sectionsContainCjk: detects Korean (Hangul Syllables)', () => {
  assert.equal(
    sectionsContainCjk([{ type: 'paragraph', text: '한국어 내용' }]),
    true,
  );
});

test('sectionsContainCjk: detects CJK in list items', () => {
  assert.equal(
    sectionsContainCjk([
      { type: 'list', items: ['Apples', '橘子', 'Pears'] },
    ]),
    true,
  );
});

test('sectionsContainCjk: detects CJK in table headers + cells', () => {
  assert.equal(
    sectionsContainCjk([
      {
        type: 'table',
        columns: [{ header: 'Region' }, { header: '地区' }],
        rows: [
          ['North', '北京'],
          ['South', 'Shanghai'],
        ],
      },
    ]),
    true,
  );
});

test('sectionsContainCjk: latin-extended (é, ñ, ü) does NOT trigger CJK detection', () => {
  // Codex Q1 decision: only CJK ranges, not "any non-ASCII".
  // pdfkit Helvetica handles Latin-extended adequately, so a
  // French / Spanish / German document should still route to
  // pdfkit when no language hint is given.
  assert.equal(
    sectionsContainCjk([
      { type: 'paragraph', text: 'Café résumé naïveté' },
      { type: 'paragraph', text: 'mañana señor' },
    ]),
    false,
  );
});

// ─── CJK Unicode block coverage — pin every block we promised ───────────────
//
// Codex review round 4 (2026-05-02) caught the hand-coded BMP range
// list missing CJK Extension A, Compatibility Ideographs, Hangul
// Jamo, and BMP-outside Han. Unicode property regex
// (\p{Script=Han|Hiragana|Katakana|Hangul} /u) covers all of those
// automatically. These tests pin specific boundary characters from
// each block so a future refactor that downgrades to manual ranges
// regresses noisily.

test('sectionsContainCjk: detects CJK Extension A (U+3400–4DBF, e.g. U+34DA)', () => {
  // 鼕 (U+9B95) is BMP standard Han; 㓚 (U+34DA) is Extension A.
  assert.equal(
    sectionsContainCjk([{ type: 'paragraph', text: '㓚' }]),
    true,
    'must detect CJK Extension A character',
  );
  assert.equal(
    sectionsContainCjk([{ type: 'paragraph', text: '㐀' }]),
    true,
    'must detect U+3400 (Extension A start boundary)',
  );
  assert.equal(
    sectionsContainCjk([{ type: 'paragraph', text: '䶿' }]),
    true,
    'must detect U+4DBF (Extension A end boundary)',
  );
});

test('sectionsContainCjk: detects CJK Compatibility Ideographs (U+F900-FAD9)', () => {
  // 豈 (U+F900) — first character of the Compatibility block.
  assert.equal(
    sectionsContainCjk([{ type: 'paragraph', text: '豈' }]),
    true,
  );
  // U+FAD9 — last ASSIGNED codepoint in the block (U+FADA-FAFF
  // are unassigned, so they wouldn't match Unicode property
  // regex anyway). Pins the upper boundary at the real edge.
  assert.equal(
    sectionsContainCjk([
      { type: 'paragraph', text: String.fromCodePoint(0xFAD9) },
    ]),
    true,
  );
});

test('sectionsContainCjk: detects Hangul Jamo (U+1100–11FF)', () => {
  // ᄀ (U+1100) — first Jamo character. Distinct from the Hangul
  // Syllables block at U+AC00 — Codex round 3's range list missed
  // it and round 4 caught the gap.
  assert.equal(
    sectionsContainCjk([{ type: 'paragraph', text: 'ᄀ' }]),
    true,
  );
  // ퟿ (U+D7FF) is Hangul Jamo Extended-B end.
  assert.equal(
    sectionsContainCjk([{ type: 'paragraph', text: 'ힰ' }]),
    true,
    'must detect Hangul Jamo Extended-B start',
  );
});

test('sectionsContainCjk: detects BMP-outside Extension B (U+20000+, surrogate pair)', () => {
  // 𠀀 (U+20000) — first Extension B character, encoded as
  // surrogate pair in UTF-16. The /u flag is what makes the regex
  // see this as ONE codepoint instead of two unpaired surrogates.
  // If a future refactor drops the /u flag this test trips.
  const bmpOutside = String.fromCodePoint(0x20000);
  assert.equal(
    sectionsContainCjk([{ type: 'paragraph', text: bmpOutside }]),
    true,
    'must detect BMP-outside CJK (Extension B+) via /u flag + Unicode property',
  );
});

test('sectionsContainCjk: detects CJK in OBJECT-form table rows (renderTable read path)', () => {
  // pdfkitGenerate.renderTable reads cells via
  //   Array.isArray(row) ? row[i] : row?.[columns[i].key]
  // The scanner has to follow the same path. Codex round 4 caught
  // the omission: object-form rows with CJK string values went
  // straight to pdfkit and rendered as tofu.
  assert.equal(
    sectionsContainCjk([
      {
        type: 'table',
        columns: [{ header: 'Name', key: 'name' }, { header: 'City', key: 'city' }],
        rows: [
          { name: 'Alice', city: 'New York' }, // ASCII
          { name: '张三', city: '北京' },        // CJK in object-form row
        ],
      },
    ]),
    true,
    'must detect CJK string values in object-form rows by columns[].key',
  );
});

test('sectionsContainCjk: object row with CJK in UNDECLARED key → NOT detected (mirrors renderTable read path)', () => {
  // Contract: sectionsContainCjk only flags content that
  // pdfkitGenerate.renderTable would actually render. If a column
  // has no `key` (or the row uses a key that isn't in columns[]),
  // renderTable doesn't render that field → no tofu → no flag.
  // This avoids false positives that would needlessly route ASCII
  // tables to Playwright. Codex review's hint was about object-
  // form ROWS in DECLARED columns, not stray fields.
  assert.equal(
    sectionsContainCjk([
      {
        type: 'table',
        columns: [{ header: 'X', key: 'x' }], // key 'x' not on the row
        rows: [{ name: '王五' }],            // 'name' not declared
      },
    ]),
    false,
    'undeclared CJK fields are not rendered → not flagged',
  );
});

// ─── CJK punctuation + fullwidth forms (Codex round 6 regression) ──────────
//
// Codex review round 6 (2026-05-02) caught that the round-4 switch
// from hand-coded ranges to `\p{Script=...}` silently dropped
// coverage for CJK Symbols & Punctuation (U+3000–303F) and
// Halfwidth/Fullwidth Forms (U+FF00–FFEF) — those characters live
// in Script=Common, not Han/Hiragana/Katakana/Hangul. pdfkit
// Helvetica still tofus them. Round 6 fix restored coverage with
// `scx` (Script_Extensions) + explicit ranges. These tests pin
// the restored behaviour so a future "more Unicode-correct"
// refactor can't regress it.

test('sectionsContainCjk: detects CJK punctuation alone (Script=Common, scx includes Hani)', () => {
  // 。 (U+3002) IDEOGRAPHIC FULL STOP — pdfkit Helvetica has no
  // glyph for this. Must trigger CJK detection even when no
  // ideographs / kana / hangul are present.
  assert.equal(
    sectionsContainCjk([{ type: 'paragraph', text: '。' }]),
    true,
  );
  assert.equal(
    sectionsContainCjk([{ type: 'paragraph', text: '，' }]),
    true,
  );
  assert.equal(
    sectionsContainCjk([{ type: 'paragraph', text: '「重要」' }]),
    true,
  );
});

test('sectionsContainCjk: detects fullwidth digits (U+FF10-FF19)', () => {
  // １２３ — pdfkit Helvetica only ships glyphs for U+0020-007E
  // (Basic Latin). Fullwidth digits are tofu in pdfkit.
  assert.equal(
    sectionsContainCjk([{ type: 'paragraph', text: '１２３ 元' }]),
    true,
  );
  assert.equal(
    sectionsContainCjk([{ type: 'paragraph', text: '１' }]),
    true,
  );
});

test('sectionsContainCjk: detects fullwidth Latin (U+FF21-FF3A, U+FF41-FF5A)', () => {
  // ＡＢＣ — fullwidth Latin letters. Script_Extensions=Latin
  // only (NOT in scx=Han/Hiragana/Katakana/Hangul), so they're
  // caught by the explicit U+FF00-FFEF block range, not by scx.
  // This test pins that the block-range layer is in place.
  assert.equal(
    sectionsContainCjk([{ type: 'paragraph', text: 'ＡＢＣ' }]),
    true,
    'fullwidth Latin must be detected (block-range layer)',
  );
  assert.equal(
    sectionsContainCjk([{ type: 'paragraph', text: 'ｈｅｌｌｏ' }]),
    true,
    'fullwidth lowercase Latin too',
  );
});

test('sectionsContainCjk: detects CJK punctuation in TABLE HEADER', () => {
  assert.equal(
    sectionsContainCjk([
      {
        type: 'table',
        columns: [{ header: '价格（元）' }, { header: 'Plain' }],
        rows: [['100', 'x']],
      },
    ]),
    true,
    'CJK punctuation in column headers must trigger detection',
  );
});

test('sectionsContainCjk: detects fullwidth chars in OBJECT-FORM rows', () => {
  // Combination of round-4 (object-form mirror) + round-6
  // (fullwidth forms coverage). Object row, column with key,
  // value contains fullwidth digits → must detect.
  assert.equal(
    sectionsContainCjk([
      {
        type: 'table',
        columns: [{ header: 'Code', key: 'code' }, { header: 'Total', key: 'total' }],
        rows: [
          { code: 'A1', total: '１，２３４ 元' }, // fullwidth digits + comma
        ],
      },
    ]),
    true,
  );
});

// ─── pickRebuildEngine routing for CJK punctuation / fullwidth ──────────────

test('pickRebuildEngine: pure CJK punctuation routes to html_playwright', () => {
  // Document that contains ONLY CJK punctuation (no Han / kana /
  // Hangul) must still route to the right engine. Common case:
  // a header line like "===== 章节 =====" with mostly punctuation.
  assert.equal(
    pickRebuildEngine({ sections: [{ type: 'paragraph', text: '。、！？' }] }),
    'html_playwright',
  );
});

test('pickRebuildEngine: pure fullwidth Latin routes to html_playwright', () => {
  // Pure ASCII would route to pdfkit; pure fullwidth Latin must
  // NOT — Helvetica can't render fullwidth glyphs. The router has
  // to send it to Playwright.
  assert.equal(
    pickRebuildEngine({ sections: [{ type: 'paragraph', text: 'ＨＥＬＬＯ' }] }),
    'html_playwright',
  );
});

test('pickRebuildEngine: explicit pdfkit override still wins for fullwidth content', () => {
  // The override contract (round-3 Q2 decision) holds even for
  // the round-6 expanded coverage: a user who explicitly picks
  // pdfkit gets pdfkit, even with content the auto-router would
  // have sent to Playwright.
  assert.equal(
    pickRebuildEngine({
      rebuildEngine: 'pdfkit',
      sections: [{ type: 'paragraph', text: '。、ＡＢＣ１２３' }],
    }),
    'pdfkit',
  );
});

test('sectionsContainCjk: handles bad input without throwing', () => {
  assert.equal(sectionsContainCjk(null), false);
  assert.equal(sectionsContainCjk(undefined), false);
  assert.equal(sectionsContainCjk('not an array'), false);
  assert.equal(sectionsContainCjk([]), false);
  assert.equal(sectionsContainCjk([null, undefined, {}]), false);
});

// ─── pickRebuildEngine content-routing ──────────────────────────────────────

test('pickRebuildEngine: ASCII content + no language → pdfkit (default)', () => {
  assert.equal(
    pickRebuildEngine({ sections: [{ type: 'paragraph', text: 'hello' }] }),
    'pdfkit',
  );
});

test('pickRebuildEngine: CJK content + NO language → html_playwright (content scan)', () => {
  // The exact scenario Codex called out: model emits Chinese
  // without setting language, previous router silently sent it to
  // pdfkit → tofu. Pin the fix so a future "simplify" doesn't
  // re-introduce the regression.
  assert.equal(
    pickRebuildEngine({ sections: [{ type: 'paragraph', text: '这是一段中文。' }] }),
    'html_playwright',
  );
});

test('pickRebuildEngine: ASCII content + zh-CN language → html_playwright (language wins)', () => {
  assert.equal(
    pickRebuildEngine({
      outputStyle: { language: 'zh-CN' },
      sections: [{ type: 'paragraph', text: 'hello' }],
    }),
    'html_playwright',
  );
});

test('pickRebuildEngine: CJK content + en-US language → html_playwright (content scan still triggers)', () => {
  // Even if the model lies about language, content-side detection
  // makes sure CJK still gets the right engine.
  assert.equal(
    pickRebuildEngine({
      outputStyle: { language: 'en-US' },
      sections: [{ type: 'paragraph', text: '中文内容' }],
    }),
    'html_playwright',
  );
});

test('pickRebuildEngine: CJK content + explicit pdfkit override → pdfkit (respects user)', () => {
  // Q2 decision (2026-05-01): explicit override wins even with CJK
  // content. Schema description warns pdfkit can't render CJK; an
  // explicit override is the user knowingly accepting tofu (e.g.
  // for debug / font-fallback testing).
  assert.equal(
    pickRebuildEngine({
      rebuildEngine: 'pdfkit',
      sections: [{ type: 'paragraph', text: '中文测试' }],
    }),
    'pdfkit',
  );
});

test('pickRebuildEngine: CJK content + explicit html_playwright → html_playwright (matches intent)', () => {
  assert.equal(
    pickRebuildEngine({
      rebuildEngine: 'html_playwright',
      sections: [{ type: 'paragraph', text: '中文测试' }],
    }),
    'html_playwright',
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
