// PDF edit-spec validator + dispatcher.
//
// User design audit (2026-04-30) called for a structured "edit plan"
// layer between Codex OAuth (the brain) and the local PDF tools (the
// workers). Instead of the model emitting a PDF directly, it emits a
// JSON spec describing what needs to change; melo locally turns the
// spec into the new PDF.
//
// User confirmed Q1+Q2 (2026-05-01):
//   • Two modes: `in_place_overlay` AND `rebuild`. Both ship in
//     batch C.
//   • `in_place_overlay` covers what pdf-lib can ACTUALLY do safely
//     on an existing PDF — overlays, metadata, form fields. The
//     stack we picked (pdf-lib + Codex OAuth + no embedded fonts)
//     CANNOT do textual replacement (find "5.5", swap to "gpt") at
//     anything close to publication quality. The user already
//     acknowledged this in their audit ("对于合同签名/扫描件/复杂
//     表单/加密 PDF, 最好只做批注/水印/追加页/重建副本"). So
//     in_place_overlay is honest about its limits.
//   • `rebuild` walks the audit's recommended path: read source →
//     model produces sections[] → local renderer (pdfkit or
//     Playwright) lays out a NEW PDF. Loses original layout, gains
//     reliable text replacement.
//
// This module is the validator + dispatcher. The actual rendering
// lives in pdfLibOps (in_place_overlay) and pdfkitGenerate /
// pdfTool's writePdf (rebuild). pdfTool wires the user-facing
// `from_spec` action onto this dispatcher.

import { isAbsolute, resolve as resolvePath } from 'node:path';

const VALID_MODES = new Set(['in_place_overlay', 'rebuild']);
const VALID_OVERLAY_TYPES = new Set(['text', 'image']);
const VALID_PAGE_SIZES = new Set(['A4', 'LETTER', 'LEGAL']);
const VALID_REBUILD_ENGINES = new Set(['auto', 'pdfkit', 'html_playwright']);

// ASCII / Latin-only check used by overlay text validation. Same
// rule as pdfLibOps watermark / page-numbers — pdf-lib's
// StandardFont (Helvetica) has no CJK glyphs, so silently accepting
// CJK text would render as ▢▢ tofu. We reject up front with a
// clear error so the model can route to `rebuild` mode instead.
const NON_LATIN_PATTERN = /[^\x00-\x7F]/;

/**
 * Validate an edit-spec object. Returns { ok: true, spec } when valid,
 * or { ok: false, error } with a human-readable error message keyed
 * to the offending field.
 *
 * Validation is intentionally STRICT — we surface schema problems
 * before pdf-lib touches disk so the model's tool result includes
 * actionable feedback ("overlay #2 missing required `y` field")
 * rather than a stack trace from deep inside pdf-lib.
 */
export function validateEditSpec(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'editSpec must be an object' };
  }
  const spec = input;
  if (!VALID_MODES.has(spec.mode)) {
    return {
      ok: false,
      error: `editSpec.mode must be one of: ${[...VALID_MODES].join(' | ')} (got ${JSON.stringify(spec.mode)})`,
    };
  }

  if (spec.mode === 'in_place_overlay') {
    return validateInPlaceOverlay(spec);
  }
  return validateRebuild(spec);
}

// ─── in_place_overlay validation ────────────────────────────────────────────

function validateInPlaceOverlay(spec) {
  if (typeof spec.sourcePdf !== 'string' || !spec.sourcePdf.trim()) {
    return {
      ok: false,
      error: 'in_place_overlay requires `sourcePdf` (path to the PDF to overlay onto)',
    };
  }
  if (!spec.sourcePdf.toLowerCase().endsWith('.pdf')) {
    return { ok: false, error: 'sourcePdf must end in .pdf' };
  }

  // At least ONE of overlays/metadata/formFields must be present —
  // an empty in_place_overlay spec is a misuse (would just copy the
  // file unchanged).
  const hasOverlays = Array.isArray(spec.overlays) && spec.overlays.length > 0;
  const hasMetadata =
    spec.metadata &&
    typeof spec.metadata === 'object' &&
    Object.keys(spec.metadata).length > 0;
  const hasFormFields = Array.isArray(spec.formFields) && spec.formFields.length > 0;
  if (!hasOverlays && !hasMetadata && !hasFormFields) {
    return {
      ok: false,
      error:
        'in_place_overlay must include at least one of: `overlays` (text/image), `metadata` (title/author/subject), or `formFields`',
    };
  }

  // Validate each overlay
  if (spec.overlays !== undefined) {
    if (!Array.isArray(spec.overlays)) {
      return { ok: false, error: 'overlays must be an array' };
    }
    for (let i = 0; i < spec.overlays.length; i++) {
      const ov = spec.overlays[i];
      const err = validateOverlay(ov, i);
      if (err) return { ok: false, error: err };
    }
  }

  // Validate metadata
  if (spec.metadata !== undefined) {
    if (typeof spec.metadata !== 'object' || spec.metadata === null || Array.isArray(spec.metadata)) {
      return { ok: false, error: 'metadata must be an object' };
    }
    for (const k of Object.keys(spec.metadata)) {
      if (!['title', 'author', 'subject'].includes(k)) {
        return { ok: false, error: `metadata.${k} not supported (use title / author / subject)` };
      }
      if (typeof spec.metadata[k] !== 'string') {
        return { ok: false, error: `metadata.${k} must be a string` };
      }
    }
  }

  // Validate form fields
  if (spec.formFields !== undefined) {
    if (!Array.isArray(spec.formFields)) {
      return { ok: false, error: 'formFields must be an array' };
    }
    for (let i = 0; i < spec.formFields.length; i++) {
      const f = spec.formFields[i];
      if (!f || typeof f !== 'object') {
        return { ok: false, error: `formFields[${i}] must be an object` };
      }
      if (typeof f.name !== 'string' || !f.name.trim()) {
        return { ok: false, error: `formFields[${i}].name must be a non-empty string` };
      }
      if (typeof f.value !== 'string') {
        return { ok: false, error: `formFields[${i}].value must be a string` };
      }
    }
  }

  return { ok: true, spec };
}

function validateOverlay(ov, i) {
  if (!ov || typeof ov !== 'object') {
    return `overlays[${i}] must be an object`;
  }
  if (!VALID_OVERLAY_TYPES.has(ov.type)) {
    return `overlays[${i}].type must be one of: ${[...VALID_OVERLAY_TYPES].join(' | ')}`;
  }
  if (typeof ov.page !== 'number' || !Number.isInteger(ov.page) || ov.page < 1) {
    return `overlays[${i}].page must be a 1-indexed positive integer`;
  }
  if (typeof ov.x !== 'number' || !Number.isFinite(ov.x)) {
    return `overlays[${i}].x must be a finite number (PDF points from bottom-left origin)`;
  }
  if (typeof ov.y !== 'number' || !Number.isFinite(ov.y)) {
    return `overlays[${i}].y must be a finite number`;
  }
  if (ov.type === 'text') {
    if (typeof ov.text !== 'string' || !ov.text) {
      return `overlays[${i}].text must be a non-empty string`;
    }
    if (NON_LATIN_PATTERN.test(ov.text)) {
      return `overlays[${i}].text must be ASCII / Latin only — pdf-lib StandardFont has no CJK glyphs. Use mode='rebuild' for CJK content.`;
    }
    if (ov.fontSize !== undefined && (typeof ov.fontSize !== 'number' || ov.fontSize <= 0)) {
      return `overlays[${i}].fontSize must be a positive number`;
    }
    if (ov.color !== undefined) {
      if (
        !Array.isArray(ov.color) ||
        ov.color.length !== 3 ||
        !ov.color.every(c => typeof c === 'number' && c >= 0 && c <= 1)
      ) {
        return `overlays[${i}].color must be [r, g, b] where each value is in [0, 1]`;
      }
    }
  } else if (ov.type === 'image') {
    if (typeof ov.imagePath !== 'string' || !ov.imagePath) {
      return `overlays[${i}].imagePath must be a non-empty string`;
    }
    if (ov.width !== undefined && (typeof ov.width !== 'number' || ov.width <= 0)) {
      return `overlays[${i}].width must be a positive number`;
    }
    if (ov.height !== undefined && (typeof ov.height !== 'number' || ov.height <= 0)) {
      return `overlays[${i}].height must be a positive number`;
    }
  }
  return null;
}

// ─── rebuild validation ─────────────────────────────────────────────────────

function validateRebuild(spec) {
  // sourcePdf is OPTIONAL for rebuild — the spec may describe a
  // from-scratch document. The model is expected to have already
  // read the source (if any) and synthesised the new sections[].
  if (spec.sourcePdf !== undefined) {
    if (typeof spec.sourcePdf !== 'string') {
      return { ok: false, error: 'sourcePdf must be a string (path to the original PDF)' };
    }
  }

  if (!Array.isArray(spec.sections) || spec.sections.length === 0) {
    return {
      ok: false,
      error: 'rebuild requires `sections` (non-empty array of section objects). Each section needs a `type` field — see pdfTool action="structured" for the supported shapes.',
    };
  }

  // Light validation only — the deep section schema lives in
  // pdfkitGenerate.normalizeSpec, which is the canonical authority
  // when sections actually get rendered.
  for (let i = 0; i < spec.sections.length; i++) {
    const s = spec.sections[i];
    if (!s || typeof s !== 'object') {
      return { ok: false, error: `sections[${i}] must be an object` };
    }
    if (typeof s.type !== 'string' || !s.type) {
      return { ok: false, error: `sections[${i}].type must be a non-empty string (heading / paragraph / list / table / image / code / rule / spacer / pageBreak)` };
    }
  }

  // Validate outputStyle if present
  if (spec.outputStyle !== undefined) {
    if (typeof spec.outputStyle !== 'object' || spec.outputStyle === null || Array.isArray(spec.outputStyle)) {
      return { ok: false, error: 'outputStyle must be an object' };
    }
    const os = spec.outputStyle;
    if (os.language !== undefined && typeof os.language !== 'string') {
      return { ok: false, error: 'outputStyle.language must be a string (e.g. "zh-CN", "en-US")' };
    }
    if (os.fontFamily !== undefined && typeof os.fontFamily !== 'string') {
      return { ok: false, error: 'outputStyle.fontFamily must be a CSS font-family string' };
    }
    if (os.pageSize !== undefined && !VALID_PAGE_SIZES.has(os.pageSize)) {
      return {
        ok: false,
        error: `outputStyle.pageSize must be one of: ${[...VALID_PAGE_SIZES].join(' | ')}`,
      };
    }
    if (os.margins !== undefined) {
      if (typeof os.margins === 'string' || typeof os.margins === 'number') {
        // CSS-style shorthand or points — accept as opaque.
      } else if (typeof os.margins === 'object' && os.margins !== null && !Array.isArray(os.margins)) {
        // {top,right,bottom,left} — values opaque (CSS string or number)
      } else {
        return { ok: false, error: 'outputStyle.margins must be a string, number, or {top,right,bottom,left} object' };
      }
    }
  }

  // Validate rebuildEngine if present
  if (spec.rebuildEngine !== undefined && !VALID_REBUILD_ENGINES.has(spec.rebuildEngine)) {
    return {
      ok: false,
      error: `rebuildEngine must be one of: ${[...VALID_REBUILD_ENGINES].join(' | ')}`,
    };
  }

  return { ok: true, spec };
}

// ─── engine-routing helper ──────────────────────────────────────────────────

// CJK detection. The contract: return true for any character that
// would render as ▢▢ tofu under pdfkit StandardFonts. Since
// `pdfkit-StandardFont-can-render-this-char` isn't a single Unicode
// property, the pattern is the union of two layers:
//
//   1. Script_Extensions (`scx`) ∈ {Han, Hiragana, Katakana, Hangul}
//      — covers all Han (including Extension A/B/C/D/E/F via /u-flag
//      surrogate-pair handling), Hiragana, Katakana, Hangul Syllables
//      + Jamo + Jamo Extended. Uses `scx` instead of `Script` so a
//      char like 。 (U+3002, Script=Common but Script_Extensions
//      includes Hani) gets caught here too.
//
//   2. Two explicit Unicode blocks `[　-〿＀-￯]`
//      — CJK Symbols & Punctuation + Halfwidth and Fullwidth Forms.
//      Most chars in these blocks have scx=Han, but fullwidth Latin
//      letters (Ａ U+FF21, Script_Extensions=Latin only) do NOT — yet
//      pdfkit Helvetica still tofus them because they're in the
//      Halfwidth/Fullwidth block and Helvetica only ships glyphs
//      for Basic Latin (U+0020-007E). The explicit range catches
//      everything in the block regardless of Script_Extensions.
//
// Codex review round 6 (2026-05-02) caught the round-4 regression:
// switching to `\p{Script=...}` had silently dropped CJK punctuation
// (U+3000-303F) and fullwidth forms (U+FF00-FFEF) coverage that
// round 3's hand-coded list had. Restored with belt-and-suspenders.
//
// Latin-extended (é/ñ/ü), Cyrillic, Arabic, Hebrew etc. are
// intentionally NOT detected — pdfkit Helvetica renders them
// adequately (imperfectly but not as tofu). The two-layer approach
// means future Unicode revisions auto-extend the Han / Hiragana /
// Katakana / Hangul coverage; the explicit blocks stay frozen.
const CJK_TEXT_PATTERN =
  /\p{scx=Han}|\p{scx=Hiragana}|\p{scx=Katakana}|\p{scx=Hangul}|[　-〿＀-￯]/u;

/**
 * Returns true when ANY string field inside the rebuild spec's
 * sections[] contains a CJK character. Walks the same shapes that
 * pdfkitGenerate's renderSection actually reads from:
 *   heading.text       paragraph.text     code.text
 *   list.items[]       table.columns[].header   table.rows[][]
 * Other section shapes (rule / spacer / pageBreak / image-by-path)
 * carry no inline text and are skipped.
 *
 * Exported so the routing decision is testable without round-
 * tripping through pickRebuildEngine.
 */
export function sectionsContainCjk(sections) {
  if (!Array.isArray(sections)) return false;
  for (const s of sections) {
    if (!s || typeof s !== 'object') continue;
    if (typeof s.text === 'string' && CJK_TEXT_PATTERN.test(s.text)) return true;
    if (Array.isArray(s.items)) {
      for (const item of s.items) {
        if (typeof item === 'string' && CJK_TEXT_PATTERN.test(item)) return true;
      }
    }
    if (Array.isArray(s.columns)) {
      for (const col of s.columns) {
        if (col && typeof col.header === 'string' && CJK_TEXT_PATTERN.test(col.header)) {
          return true;
        }
      }
    }
    if (Array.isArray(s.rows)) {
      // pdfkitGenerate.renderTable reads cells via:
      //   Array.isArray(row) ? row[i] : row?.[columns[i].key]
      // The scan mirrors EXACTLY the same read paths so it sees
      // every cell that would actually render — no more, no less.
      // Codex review round 4 (2026-05-02) flagged the array-only
      // scan that missed object-form rows (CJK in
      // `{ name: '张三' }` was silently misrouted to pdfkit).
      // The mirror also avoids false positives: a row with CJK in
      // an UNDECLARED column wouldn't be rendered by renderTable,
      // so we don't flag it either — pdfkit would just emit an
      // empty cell, no tofu.
      const cols = Array.isArray(s.columns) ? s.columns : [];
      for (const row of s.rows) {
        if (Array.isArray(row)) {
          for (const cell of row) {
            if (typeof cell === 'string' && CJK_TEXT_PATTERN.test(cell)) return true;
          }
          continue;
        }
        if (row && typeof row === 'object') {
          for (const col of cols) {
            if (col && typeof col.key === 'string') {
              const cell = row[col.key];
              if (typeof cell === 'string' && CJK_TEXT_PATTERN.test(cell)) return true;
            }
          }
        }
      }
    }
  }
  return false;
}

/**
 * Pick a rendering engine for a rebuild spec. Decision order:
 *   1. Explicit `rebuildEngine: 'pdfkit' | 'html_playwright'` wins.
 *      User decision (2026-05-01): we honour explicit pdfkit even
 *      when content is CJK — schema description warns pdfkit can't
 *      render CJK, so an explicit override is the user accepting
 *      that limitation (e.g. for debug / font-fallback testing).
 *   2. `outputStyle.language` hint matches CJK pattern (zh-* /
 *      ja-* / ko-*) → html_playwright.
 *   3. sections[] CONTENT contains CJK characters → html_playwright.
 *      (Codex review Batch C round 3 caught this gap: models often
 *      emit Chinese/Japanese/Korean text without setting `language`,
 *      and the previous router put them on pdfkit → tofu output.)
 *   4. Otherwise → pdfkit (no browser dependency, smaller footprint).
 *
 * Exported so tests + callers can pin the routing without round-
 * tripping through the actual renderer.
 */
export function pickRebuildEngine(spec) {
  const explicit = spec?.rebuildEngine;
  if (explicit === 'pdfkit' || explicit === 'html_playwright') {
    return explicit;
  }
  // 'auto' or undefined → first by language hint, then by content.
  const lang = String(spec?.outputStyle?.language || '').trim().toLowerCase();
  if (/^(zh|ja|ko)(?:[-_].*)?$/.test(lang)) {
    return 'html_playwright';
  }
  if (sectionsContainCjk(spec?.sections)) {
    return 'html_playwright';
  }
  return 'pdfkit';
}

// ─── input-path resolution ──────────────────────────────────────────────────

/**
 * Resolve an input path inside the spec (sourcePdf, overlay
 * imagePath) against the chat workspace. Mirrors pdfTool's
 * resolveInputPdfPath rule introduced in the Codex C-round path
 * fix: relative paths resolve to <workspace>/, absolute use as-is.
 *
 * Exported for the dispatcher to use — keeping the resolution
 * uniform between the tool boundary (pdfTool) and the spec layer
 * means a model that passes "doc.pdf" gets the same workspace-
 * relative read in both places.
 */
export function resolveSpecInputPath(p, workspacePath) {
  if (typeof p !== 'string' || !p.trim()) return null;
  if (isAbsolute(p)) return p;
  if (workspacePath && typeof workspacePath === 'string' && workspacePath.startsWith('/')) {
    return resolvePath(workspacePath, p);
  }
  return null;
}
