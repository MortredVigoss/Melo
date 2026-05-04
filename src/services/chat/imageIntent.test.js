// imageIntent.test.js — Phase 4 (2026-05-04) image-intent gate.
//
// Pins the regex contract for IMAGE_GEN_INTENT_PATTERN +
// detectImageIntent that controls whether the inline image_generation
// tool gets added to the Codex /codex/responses payload. The gate
// closes the Xiaohongshu/Douyin share-link mis-routing — when the
// model had image_generation always-available it would pick it up as
// a fallback for failed fetch_url calls and fabricate an image
// instead of admitting the URL couldn't be summarized.
//
// Coverage groups:
//   1. IMAGE_GEN_INTENT_PATTERN: text-to-image asks fire (en + zh)
//   2. False-positive guards: incidental verb+noun combinations don't fire
//   3. detectImageIntent: gen always counts; edit/follow-up only with image
//   4. Real-world scenario fixtures: the bug we are fixing — link-paste
//      with thumbnail + non-image text → intent must NOT fire

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  IMAGE_GEN_INTENT_PATTERN,
  IMAGE_EDIT_INTENT_PATTERN,
  IMAGE_FOLLOW_UP_PATTERN,
  detectImageGenIntent,
  detectImageIntent,
} from './messageBuilder.js';

// ── 1. Generation intent (positive cases) ─────────────────────────────

const GEN_POSITIVES = [
  'draw a cat',
  'draw me a picture of a sunset',
  'generate an image of a robot',
  'create a poster for the event',
  'paint a portrait',
  'make me a logo',
  'design a banner for our launch',
  'render an icon set',
  'sketch a wireframe',
  'sketch the layout',
  '画一只猫',
  '画一张山水',
  '画个图',
  '生成图片',
  '生成一张海报',
  '生成插图',
  '做张海报',
  '做一个 logo',
  '帮我设计一个图标',
  '绘制一张流程图',
  '出一张图',
  '来一张图',
];

for (const text of GEN_POSITIVES) {
  test(`IMAGE_GEN_INTENT_PATTERN fires for: "${text}"`, () => {
    assert.ok(
      IMAGE_GEN_INTENT_PATTERN.test(text),
      `expected "${text}" to read as image-generation intent`,
    );
    assert.equal(detectImageGenIntent(text), true);
  });
}

// ── 2. False-positive guards (negative cases) ─────────────────────────

const GEN_NEGATIVES = [
  // The bug we are fixing: pasted a Xiaohongshu/Douyin link, asked for
  // a summary. None of these should be image intent.
  'https://www.xiaohongshu.com/explore/abc 总结一下',
  'https://www.xiaohongshu.com/explore/abc 这个讲了什么',
  'https://v.douyin.com/abc 帮我看看',
  'https://v.douyin.com/abc 视频里讲了什么',
  '看看这个链接 https://xhslink.com/abc',
  // CSS / theming / coding talk that mentions related verbs but no image noun.
  'change the background color to blue',
  'change the font',
  'make the button larger',
  'edit the file',
  'modify the function',
  'create a new branch',          // git
  'create a new file',            // file system
  'create a function',            // code
  'design the API',               // arch
  'make the request faster',
  'render the page',              // SSR — no image noun
  'generate the report',          // not an image noun
  // NOTE: "paint the room", "draw the line", "draw blood" are
  // documented Tier-A false positives — strong verb + generic noun.
  // Pattern comment in messageBuilder.js explains why we accept them
  // (cheap to recover, no forced tool call). Don't add them here.
  // Plain Q&A
  'what is rust',
  'how do I run the tests',
  '总结一下这个文档',
  '这个 bug 怎么修',
  '说一下这个函数',
  // Empty / null / non-string defensive
  '',
  '   ',
];

for (const text of GEN_NEGATIVES) {
  test(`IMAGE_GEN_INTENT_PATTERN does NOT fire for: "${text}"`, () => {
    assert.equal(
      IMAGE_GEN_INTENT_PATTERN.test(text || ''),
      false,
      `"${text}" must NOT read as image-generation intent`,
    );
  });
}

test('detectImageGenIntent: handles null / undefined / non-string', () => {
  assert.equal(detectImageGenIntent(null), false);
  assert.equal(detectImageGenIntent(undefined), false);
  assert.equal(detectImageGenIntent(42), false);
  assert.equal(detectImageGenIntent({}), false);
  assert.equal(detectImageGenIntent(''), false);
  assert.equal(detectImageGenIntent('   '), false);
});

// ── 3. detectImageIntent (composed gate) ──────────────────────────────

test('detectImageIntent: generation intent fires regardless of input image', () => {
  assert.equal(detectImageIntent('draw a cat', { hasInputImage: false }), true);
  assert.equal(detectImageIntent('draw a cat', { hasInputImage: true }), true);
  assert.equal(detectImageIntent('画一张山水', { hasInputImage: false }), true);
});

test('detectImageIntent: edit-intent text WITHOUT input image → false', () => {
  // Without an input image, edit verbs alone don't count — they
  // false-positive on CSS / theming / arbitrary "change X" copy.
  assert.equal(detectImageIntent('change the background', { hasInputImage: false }), false);
  assert.equal(detectImageIntent('改一下', { hasInputImage: false }), false);
  assert.equal(detectImageIntent('换成红色', { hasInputImage: false }), false);
});

test('detectImageIntent: edit-intent text WITH input image → true', () => {
  assert.equal(detectImageIntent('change the background', { hasInputImage: true }), true);
  assert.equal(detectImageIntent('改一下颜色', { hasInputImage: true }), true);
  assert.equal(detectImageIntent('换个背景', { hasInputImage: true }), true);
});

test('detectImageIntent: image follow-up text WITH input image → true', () => {
  assert.equal(detectImageIntent('what is in the image', { hasInputImage: true }), true);
  assert.equal(detectImageIntent('这张图里有什么', { hasInputImage: true }), true);
  assert.equal(detectImageIntent('看一下图里写了什么', { hasInputImage: true }), true);
});

test('detectImageIntent: image follow-up text WITHOUT input image → false', () => {
  assert.equal(detectImageIntent('what is in the image', { hasInputImage: false }), false);
  assert.equal(detectImageIntent('这张图里有什么', { hasInputImage: false }), false);
});

test('detectImageIntent: defensive on bad input', () => {
  assert.equal(detectImageIntent(null), false);
  assert.equal(detectImageIntent(''), false);
  assert.equal(detectImageIntent(undefined, { hasInputImage: true }), false);
  assert.equal(detectImageIntent(42, { hasInputImage: true }), false);
});

// ── 4. The bug fixture: Xiaohongshu/Douyin link-paste with thumbnail ──

test('detectImageIntent: Xiaohongshu URL + summarize text + thumbnail attachment → false', () => {
  // The exact failure mode from the user report:
  //   • share-link from Xiaohongshu/Douyin app on phone
  //   • text says "总结一下" / "看看这个" / "帮我看看视频"
  //   • the share preview includes a thumbnail (hasInputImage = true)
  //
  // Pre-Phase-4 image_generation was always in the tool list when
  // workspace was set, so the model — once fetch_url failed — would
  // pick image_generation as a fallback because (a) it was listed and
  // (b) the thumbnail satisfied the model's "looks like an image
  // task" heuristic. Result: user got a fabricated image instead of
  // a summary.
  //
  // The new gate must return false here so the tool never appears in
  // the payload — model PHYSICALLY cannot pick it.
  const cases = [
    { text: 'https://www.xiaohongshu.com/explore/abc 总结一下', hasInputImage: true },
    { text: 'https://v.douyin.com/abc 帮我看看视频', hasInputImage: true },
    { text: 'https://xhslink.com/abc 这个讲了什么', hasInputImage: true },
    { text: '看看这个 https://www.douyin.com/video/123', hasInputImage: true },
  ];
  for (const { text, hasInputImage } of cases) {
    assert.equal(
      detectImageIntent(text, { hasInputImage }),
      false,
      `link-paste with thumbnail must not read as image intent: "${text}"`,
    );
  }
});

test('detectImageIntent: Xiaohongshu URL + EXPLICIT image-gen intent → true (does not regress legitimate use)', () => {
  // If the user paste a link AND explicitly asks for an image, the
  // gate should still fire. Otherwise the fix would over-correct.
  const cases = [
    { text: 'https://example.com 画一张类似的图', hasInputImage: false },
    { text: '看了这个 https://x.com/abc 帮我画一个 logo', hasInputImage: true },
    { text: 'generate an image inspired by https://example.com', hasInputImage: false },
  ];
  for (const { text, hasInputImage } of cases) {
    assert.equal(
      detectImageIntent(text, { hasInputImage }),
      true,
      `explicit image-gen intent should still fire: "${text}"`,
    );
  }
});

// ── 5. Stale-history-image regression (Codex Phase 4 🔴 follow-up) ───
//
// The detectImageIntent helper itself is correct — it AND-gates
// edit/follow-up patterns with hasInputImage. The bug Codex flagged is
// that the CALLER (createCodexResponsesReply) was passing the broad
// `messagesHaveInputImages` (any history) instead of latest-turn-only.
// Tests here cover the helper's contract under both inputs so the
// caller-side fix has an explicit pinned semantic to align with.

test('detectImageIntent: edit copy + hasInputImage:false → false (matches latest-turn-only contract)', () => {
  // When the caller correctly passes latestUserHasImage:false, generic
  // edit verbs must NOT fire — even if older history had images.
  // CSS / theming / arbitrary "change" copy stays out of image_gen.
  assert.equal(detectImageIntent('change the background', { hasInputImage: false }), false);
  assert.equal(detectImageIntent('改一下', { hasInputImage: false }), false);
  assert.equal(detectImageIntent('换一下颜色', { hasInputImage: false }), false);
  assert.equal(detectImageIntent('modify the function', { hasInputImage: false }), false);
});

test('detectImageIntent: edit copy + hasInputImage:true → true (latest turn has image)', () => {
  // When the latest user turn carries an image AND the text reads as
  // edit intent, image_generation should be available.
  assert.equal(detectImageIntent('change the background', { hasInputImage: true }), true);
  assert.equal(detectImageIntent('改一下颜色', { hasInputImage: true }), true);
});
