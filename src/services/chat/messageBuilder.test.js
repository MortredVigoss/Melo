// Tests for messageBuilder. All pure — zero state, zero disk — which is
// exactly what the 7d-1 extraction buys us: the hairy model-window logic
// can now be exercised with tiny in-memory chat fixtures.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildModelMessagesFromChat,
  messageToModelContent,
  modelRichMediaAttachments,
  shouldCarryForwardRecentMedia,
  followUpPatternForSourceMessage,
  mergeRichMediaContextIntoMessage,
  stripHistoricalRichMediaFromMessage,
  summarizeAttachmentsForPrompt,
  isProviderFailureAssistantMessage,
  IMAGE_FOLLOW_UP_PATTERN,
  AUDIO_FOLLOW_UP_PATTERN,
  IMAGE_EDIT_INTENT_PATTERN,
  detectImageEditIntent,
  RICH_MEDIA_ATTACHMENT_KINDS,
} from './messageBuilder.js';

// ─── Fixtures ───────────────────────────────────────────────────────────────

let msgCounter = 0;
function msg(role, text, { attachments = [], extractedMedia = [], senderName } = {}) {
  msgCounter += 1;
  const m = {
    id: `m${msgCounter}`,
    role,
    createdAt: new Date(2026, 0, 1, 0, msgCounter).toISOString(),
    blocks: [{ kind: 'text', text }],
    attachments,
    extractedMedia,
  };
  if (senderName) m.senderName = senderName;
  return m;
}

const imageAttachment = {
  id: 'img-1',
  kind: 'image',
  url: 'https://example.com/cat.png',
  title: 'A cat',
};

const audioAttachment = {
  id: 'a-1',
  kind: 'audio',
  url: 'https://example.com/voice.ogg',
  fileName: 'voice.ogg',
};

// ═══════════════════════════════════════════════════════════════════════════
// summarizeAttachmentsForPrompt
// ═══════════════════════════════════════════════════════════════════════════

test('summarizeAttachmentsForPrompt: empty list → empty string', () => {
  assert.equal(summarizeAttachmentsForPrompt([]), '');
});

test('summarizeAttachmentsForPrompt: shows label + URL, skips URL for data: URIs', () => {
  const out = summarizeAttachmentsForPrompt([
    { kind: 'image', title: 'Cat', url: 'https://example.com/cat.png' },
    { kind: 'audio', fileName: 'voice.ogg', url: 'data:audio/ogg;base64,AAAA' },
  ]);
  assert.match(out, /- Image: Cat \(https:\/\/example\.com\/cat\.png\)/);
  assert.match(out, /- Audio: voice\.ogg/);
  // data: URIs should NOT splat their base64 body into the prompt.
  assert.doesNotMatch(out, /base64/);
});

// ═══════════════════════════════════════════════════════════════════════════
// modelRichMediaAttachments
// ═══════════════════════════════════════════════════════════════════════════

test('modelRichMediaAttachments: keeps https image, drops file:// image (unsupported scheme)', () => {
  const message = {
    attachments: [
      { kind: 'image', url: 'https://example.com/a.png' },
      { kind: 'image', url: 'file:///local/b.png' }, // unsupported scheme
    ],
  };
  const out = modelRichMediaAttachments(message);
  // file:// image gets filtered out by MODEL_IMAGE_ATTACHMENT_PATTERN.
  assert.ok(out.every(a => a.url !== 'file:///local/b.png'));
  assert.ok(out.some(a => a.url === 'https://example.com/a.png'));
});

test('modelRichMediaAttachments: data:image/ is kept, data:text/ is dropped (wrong kind)', () => {
  const out = modelRichMediaAttachments({
    attachments: [
      { kind: 'image', url: 'data:image/png;base64,AAAA' },
      { kind: 'image', url: 'data:text/plain;base64,BBBB' }, // wrong data scheme
    ],
  });
  assert.equal(out.length, 1);
});

test('modelRichMediaAttachments: covers audio/video/link URL patterns', () => {
  const out = modelRichMediaAttachments({
    attachments: [
      { kind: 'audio', url: 'https://example.com/a.ogg' },
      { kind: 'video', url: 'data:video/mp4;base64,AAAA' },
      { kind: 'link', url: 'https://example.com/page' },
    ],
  });
  assert.equal(out.length, 3);
});

// ═══════════════════════════════════════════════════════════════════════════
// followUpPatternForSourceMessage
// ═══════════════════════════════════════════════════════════════════════════

test('followUpPatternForSourceMessage: picks pattern based on source media kind', () => {
  const imgSrc = { attachments: [{ kind: 'image', url: 'https://x/y.png' }] };
  assert.equal(followUpPatternForSourceMessage(imgSrc), IMAGE_FOLLOW_UP_PATTERN);

  const audioSrc = { attachments: [{ kind: 'audio', url: 'https://x/y.ogg' }] };
  assert.equal(followUpPatternForSourceMessage(audioSrc), AUDIO_FOLLOW_UP_PATTERN);

  assert.equal(followUpPatternForSourceMessage({ attachments: [] }), null);
});

// Regression (Phase 7d-1 Codex review): the \b word-boundary wrappers on
// the English branches are load-bearing. Without them, `photo` inside the
// group matches `photography`, `photographic`, etc. as substrings,
// spuriously triggering carry-forward. `\b` only protects against
// prefix/suffix extensions of a keyword — standalone uses of "image" /
// "screenshot" in otherwise-unrelated sentences are still a match, which
// is fine because the carry-forward is further guarded by the 4-turn
// distance cap + the requirement that the latest turn carries no media of
// its own.
test('IMAGE_FOLLOW_UP_PATTERN does not false-match keyword prefixes/suffixes', () => {
  const negativeCases = [
    'photography question',     // photo + graphy → \b after photo fails
    'the photographic style',   // photo + graphic
    'photosynthesis',           // photo + synthesis
    'imagery in the abstract',  // image + ry
    'imagination runs wild',    // image + ination
  ];
  for (const text of negativeCases) {
    assert.equal(
      IMAGE_FOLLOW_UP_PATTERN.test(text),
      false,
      `IMAGE_FOLLOW_UP_PATTERN should NOT match: "${text}"`,
    );
  }
});

test('IMAGE_FOLLOW_UP_PATTERN still matches legitimate English follow-ups', () => {
  const positiveCases = [
    'what is in the image?',
    'look at the photo',
    'this screenshot',
    'zoom in please',
    '放大看一下',
    '图里写了什么',
  ];
  for (const text of positiveCases) {
    assert.equal(
      IMAGE_FOLLOW_UP_PATTERN.test(text),
      true,
      `IMAGE_FOLLOW_UP_PATTERN SHOULD match: "${text}"`,
    );
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// shouldCarryForwardRecentMedia
// ═══════════════════════════════════════════════════════════════════════════

test('shouldCarryForwardRecentMedia: short "zoom in" follow-up after image → true', () => {
  const messages = [
    msg('user', 'Look at this', { attachments: [imageAttachment] }),
    msg('assistant', 'A cat.'),
    msg('user', '放大看一下'), // image follow-up in ZH
  ];
  assert.equal(shouldCarryForwardRecentMedia(messages, 2, 0), true);
});

test('shouldCarryForwardRecentMedia: distance > 4 turns → false (safety cap)', () => {
  const messages = [
    msg('user', 'Look at this', { attachments: [imageAttachment] }),
    msg('assistant', 'A cat.'),
    msg('user', 'ok'),
    msg('assistant', 'ok'),
    msg('user', 'ok'),
    msg('assistant', 'ok'),
    msg('user', '放大看一下'),
  ];
  assert.equal(shouldCarryForwardRecentMedia(messages, 6, 0), false);
});

test('shouldCarryForwardRecentMedia: empty latest text → false', () => {
  const messages = [
    msg('user', 'Look at this', { attachments: [imageAttachment] }),
    msg('user', ''),
  ];
  assert.equal(shouldCarryForwardRecentMedia(messages, 1, 0), false);
});

test('shouldCarryForwardRecentMedia: pattern does not match the latest text → false', () => {
  const messages = [
    msg('user', 'Look at this', { attachments: [imageAttachment] }),
    msg('assistant', 'A cat.'),
    msg('user', 'unrelated question about weather'),
  ];
  assert.equal(shouldCarryForwardRecentMedia(messages, 2, 0), false);
});

// ═══════════════════════════════════════════════════════════════════════════
// mergeRichMediaContextIntoMessage / stripHistoricalRichMediaFromMessage
// ═══════════════════════════════════════════════════════════════════════════

test('mergeRichMediaContextIntoMessage: dedupes by URL', () => {
  const target = { attachments: [imageAttachment], extractedMedia: [] };
  const source = { attachments: [imageAttachment, audioAttachment], extractedMedia: [] };
  const merged = mergeRichMediaContextIntoMessage(target, source);
  assert.equal(merged.attachments.length, 2); // target image + audio from source
  assert.ok(merged.attachments.some(a => a.kind === 'audio'));
  // No duplicate image:
  assert.equal(merged.attachments.filter(a => a.kind === 'image').length, 1);
});

test('mergeRichMediaContextIntoMessage: no new media → returns same reference', () => {
  const target = { attachments: [imageAttachment], extractedMedia: [] };
  const source = { attachments: [imageAttachment], extractedMedia: [] };
  const merged = mergeRichMediaContextIntoMessage(target, source);
  // When nothing new to merge, the fn returns the target unchanged (no clone).
  assert.equal(merged, target);
});

test('stripHistoricalRichMediaFromMessage: drops rich kinds + clears extractedMedia', () => {
  // NB: normalizeMessageAttachments coerces unknown kinds to 'link' (which
  // IS a rich kind), so there's no easy "non-rich survivor" we can plant.
  // Asserting the core contract — all rich kinds gone, extractedMedia
  // cleared — is what matters.
  const message = {
    attachments: [imageAttachment, audioAttachment],
    extractedMedia: [{ kind: 'image', text: 'alt' }],
  };
  const stripped = stripHistoricalRichMediaFromMessage(message);
  assert.ok(
    stripped.attachments.every(a => !RICH_MEDIA_ATTACHMENT_KINDS.has(a.kind)),
    'no rich-media attachments should survive',
  );
  assert.deepEqual(stripped.extractedMedia, []);
});

test('stripHistoricalRichMediaFromMessage: message with no attachments or media → returns same reference', () => {
  // Truly empty attachments is the only input shape that reliably skips the
  // clone — unknown kinds get normalized to 'link' (rich) and trigger it.
  const message = { attachments: [], extractedMedia: [] };
  assert.equal(stripHistoricalRichMediaFromMessage(message), message);
});

// ═══════════════════════════════════════════════════════════════════════════
// messageToModelContent
// ═══════════════════════════════════════════════════════════════════════════

test('messageToModelContent: text-only returns a string', () => {
  const out = messageToModelContent(msg('user', 'hello'));
  assert.equal(out, 'hello');
});

test('messageToModelContent: user + image → structured parts with text + image_url', () => {
  const out = messageToModelContent(msg('user', 'Look at this', { attachments: [imageAttachment] }));
  assert.ok(Array.isArray(out));
  assert.equal(out[0].type, 'text');
  assert.equal(out[0].text, 'Look at this');
  assert.ok(out.some(p => p.type === 'image_url' && p.image_url.url === imageAttachment.url));
});

test('messageToModelContent: group chat includeSenderPrefix prepends [name]: to user text', () => {
  const out = messageToModelContent(
    msg('user', 'hello', { senderName: 'Alice' }),
    { includeSenderPrefix: true },
  );
  assert.equal(out, '[Alice]: hello');
});

// Phase 2: video keyframes ride along on extractedMedia.metadata.keyframes.
// messageToModelContent must promote each frame to a real image_url part so
// the vision model actually sees the picture, not just hear the transcript.
test('messageToModelContent: video attachment + keyframes → image_url parts emitted', () => {
  const videoAttachment = {
    id: 'vid-1',
    kind: 'video',
    url: 'https://example.com/clip.mp4',
    fileName: 'clip.mp4',
    mimeType: 'video/mp4',
  };
  const dataUrl1 = 'data:image/jpeg;base64,/9j/4AAQAAAA';
  const dataUrl2 = 'data:image/jpeg;base64,/9j/4BBQBBBB';
  const out = messageToModelContent(
    msg('user', 'What is in this clip?', {
      attachments: [videoAttachment],
      extractedMedia: [{
        attachmentId: 'vid-1',
        kind: 'transcript',
        text: 'spoken: hello world',
        metadata: { keyframes: [dataUrl1, dataUrl2], source: 'video-audio-transcript' },
      }],
    }),
  );
  assert.ok(Array.isArray(out));
  const imageUrls = out.filter(p => p.type === 'image_url').map(p => p.image_url.url);
  assert.deepEqual(imageUrls, [dataUrl1, dataUrl2]);
  // Image_url parts must precede the video_attachment shell so the model
  // sees them before the (eventually-dropped) video stub.
  const firstImageIdx = out.findIndex(p => p.type === 'image_url');
  const videoIdx = out.findIndex(p => p.type === 'video_attachment');
  assert.ok(firstImageIdx >= 0 && videoIdx > firstImageIdx, 'image_url before video_attachment');
});

test('messageToModelContent: link-extracted social video keyframes → image_url parts emitted', () => {
  const out = messageToModelContent(
    msg('user', '分析这个抖音链接', {
      attachments: [
        { id: 'link-1', kind: 'link', url: 'https://v.douyin.com/abc/' },
      ],
      extractedMedia: [{
        attachmentId: 'link-1',
        kind: 'article',
        text: 'Douyin preview with transcript',
        metadata: {
          source: 'social-link:share-preview:wechat+douyin-ssr',
          keyframes: ['data:image/jpeg;base64,/9j/4AAQ'],
        },
      }],
    }),
  );

  assert.ok(Array.isArray(out));
  assert.ok(out.some(p => p.type === 'image_url'));
  assert.ok(out.some(p => p.type === 'text' && /Douyin preview/.test(p.text)));
});

test('messageToModelContent: video attachment without keyframes still works (graceful fallback)', () => {
  const videoAttachment = {
    id: 'vid-2',
    kind: 'video',
    url: 'https://example.com/silent.mp4',
    fileName: 'silent.mp4',
    mimeType: 'video/mp4',
  };
  const out = messageToModelContent(
    msg('user', 'transcribe this', {
      attachments: [videoAttachment],
      extractedMedia: [{
        attachmentId: 'vid-2',
        kind: 'transcript',
        text: 'just the transcript',
        metadata: { source: 'video-audio-transcript' },  // no keyframes
      }],
    }),
  );
  assert.ok(Array.isArray(out));
  assert.ok(!out.some(p => p.type === 'image_url'), 'no image_url when keyframes absent');
  assert.ok(out.some(p => p.type === 'video_attachment'));
});

test('messageToModelContent: attachments only (no recognised kind) falls back to text', () => {
  const out = messageToModelContent({
    role: 'user',
    blocks: [{ kind: 'text', text: 'hi' }],
    attachments: [{ kind: 'other', url: 'file:///tmp/x' }],
  });
  // Note: non-image attachments DO become a text entry in the structured
  // array (via summarizeAttachmentsForPrompt). So the content is either the
  // bare string (pure text) or a single text part. Either way, no image_url
  // / audio_attachment entries for unrecognised kinds.
  if (Array.isArray(out)) {
    assert.ok(!out.some(p => p.type === 'image_url' || p.type === 'audio_attachment'));
  } else {
    assert.equal(typeof out, 'string');
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// buildModelMessagesFromChat (integration of the pieces above)
// ═══════════════════════════════════════════════════════════════════════════

test('buildModelMessagesFromChat: empty chat → empty array', () => {
  assert.deepEqual(buildModelMessagesFromChat({}), []);
});

test('buildModelMessagesFromChat: compactBoundaryMessageId drops history before the boundary', () => {
  const m1 = msg('user', 'old 1');
  const m2 = msg('assistant', 'old 2');
  const m3 = msg('user', 'new 1');
  const m4 = msg('assistant', 'new 2');
  const chat = {
    messages: [m1, m2, m3, m4],
    compactBoundaryMessageId: m2.id,
  };
  const out = buildModelMessagesFromChat(chat);
  // After m2 → only m3 and m4 survive.
  assert.equal(out.length, 2);
  assert.equal(out[0].content, 'new 1');
  assert.equal(out[1].content, 'new 2');
});

test('buildModelMessagesFromChat: historical image is stripped, latest image is kept', () => {
  const chat = {
    messages: [
      msg('user', 'look at this', { attachments: [imageAttachment] }),
      msg('assistant', 'ok'),
      msg('user', 'another image', { attachments: [imageAttachment] }),
    ],
  };
  const out = buildModelMessagesFromChat(chat);
  // Turn 0 (historical user image) should have been stripped.
  const turn0 = out[0].content;
  // If attachments were stripped, content becomes bare string (or an array
  // with no image_url). Either way no image_url:
  const turn0HasImage = Array.isArray(turn0)
    ? turn0.some(p => p.type === 'image_url')
    : false;
  assert.equal(turn0HasImage, false);
  // Latest user turn must keep the image.
  const turn2 = out[2].content;
  assert.ok(Array.isArray(turn2) && turn2.some(p => p.type === 'image_url'));
});

test('buildModelMessagesFromChat: carry-forward splices recent media into a follow-up turn', () => {
  const chat = {
    messages: [
      msg('user', 'Look at this', { attachments: [imageAttachment] }),
      msg('assistant', 'A cat.'),
      msg('user', '放大看一下'),
    ],
  };
  const out = buildModelMessagesFromChat(chat);
  const latest = out[out.length - 1].content;
  // The follow-up turn started with zero attachments; carry-forward should
  // have spliced the image in.
  assert.ok(Array.isArray(latest));
  assert.ok(latest.some(p => p.type === 'image_url'));
});

test('buildModelMessagesFromChat: provider failure replies are not sent back to the model', () => {
  const failure = msg(
    'assistant',
    'Melo could not complete the model request right now. Details: Codex OAuth request failed.',
  );
  const chat = {
    messages: [
      msg('user', 'Read this link'),
      failure,
      msg('user', 'Try again'),
    ],
  };

  assert.equal(isProviderFailureAssistantMessage(failure), true);

  const out = buildModelMessagesFromChat(chat);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map(message => message.role), ['user', 'user']);
  assert.equal(out.some(message => String(message.content).includes('Codex OAuth request failed')), false);
});

// ═══════════════════════════════════════════════════════════════════════════
// RICH_MEDIA_ATTACHMENT_KINDS sanity
// ═══════════════════════════════════════════════════════════════════════════

test('RICH_MEDIA_ATTACHMENT_KINDS covers the four carry-forward kinds', () => {
  for (const k of ['image', 'audio', 'video', 'link']) {
    assert.ok(RICH_MEDIA_ATTACHMENT_KINDS.has(k), `missing kind ${k}`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// IMAGE_EDIT_INTENT_PATTERN + detectImageEditIntent
// ═══════════════════════════════════════════════════════════════════════════
//
// These pin the intent detector used by chat fast-path routing
// (Codex + has input image + edit intent + workspace → bypass agent
// loop, go straight to editImageViaCodex). Permissive pattern: the
// AND with hasInputImage upstream protects against false positives,
// so generic edit verbs are fair game.

test('detectImageEditIntent matches the user-reported edit phrasings (CJK)', () => {
  const positives = [
    '把这张图里的 5.5 改成 gpt',
    '再换个色',
    '把背景换掉',
    '去掉这个字',
    '改成赛博朋克风',
    '让它更可爱一点',  // tricky: "让...更" is colloquial
    '把头发调亮一点',
    '换个背景',
    '抠掉文字',
    '加上一个帽子',
    '裁切右半边',
    '把 5.5 改掉',
    '换掉左上角的图标',
    '调一下颜色',
    '修改这张图的字',
    '编辑图片',
    '变成卡通风',
    '弄成黑白',
  ];
  const misses = [];
  for (const text of positives) {
    if (!detectImageEditIntent(text)) misses.push(text);
  }
  // Allow a small false-negative budget since regex can't beat NLU,
  // but most everyday phrasings should hit. Make the failure
  // message explicit so the gap is visible at a glance.
  assert.ok(
    misses.length <= 1,
    `detectImageEditIntent missed too many real edit phrasings: ${JSON.stringify(misses)}`,
  );
});

test('detectImageEditIntent matches common English edit phrasings', () => {
  const positives = [
    'edit the image',
    'change to a darker palette',
    'modify the layout',
    'replace the background',
    'swap the colors',
    'recolor it',
    'retouch this',
    'crop the bottom',
    'redraw it',
    'remove the text',
    'add a hat',
    'put a hat on him',
    'make it brighter',
    'turn it into a pencil sketch',
    'paint over the logo',
  ];
  for (const text of positives) {
    assert.ok(
      detectImageEditIntent(text),
      `detectImageEditIntent SHOULD match: "${text}"`,
    );
  }
});

test('detectImageEditIntent falls through gracefully on bad input', () => {
  for (const bad of [null, undefined, '', '   ', 42, {}, []]) {
    assert.equal(
      detectImageEditIntent(bad),
      false,
      `detectImageEditIntent must return false on bad input ${JSON.stringify(bad)}`,
    );
  }
});

test('detectImageEditIntent does NOT trigger on pure conversational chatter', () => {
  // Bounded false-positive concern: the fast-path guard upstream is
  // (intent AND hasInputImage), so an "edit" word with NO image won't
  // trigger anything bad. But we still want this regex to lean against
  // the most obviously non-edit chatter so tests document the contract.
  const negatives = [
    'hello',
    '你好',
    '今天天气怎么样',  // weather
    'tell me about your day',
    '帮我写代码',  // code request
    '什么是机器学习',  // explainer
  ];
  for (const text of negatives) {
    assert.equal(
      detectImageEditIntent(text),
      false,
      `detectImageEditIntent must not match: "${text}"`,
    );
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// IMAGE_FOLLOW_UP_PATTERN extension (edit-verb additions)
// ═══════════════════════════════════════════════════════════════════════════
//
// These confirm the carry-forward extension lets multi-turn edit flows
// keep their image context, while still rejecting the negative cases
// the existing tests already pinned (photography, etc.).

test('IMAGE_FOLLOW_UP_PATTERN matches image-OBJECT-bound phrasings only (carry-forward stays strict)', () => {
  // Tightened 2026-04-30 (Codex review rounds 5 + 6):
  //
  //   round 5 — bare CJK edit verbs 改成 / 换成 / 去掉 / 换掉 /
  //     加上 / 再改 must NOT match (false-positive on code/text
  //     follow-ups: "把这个函数改成 async" would otherwise drag a
  //     screenshot into a code question).
  //   round 6 — bare English edit verbs 'change the (color|
  //     background|font|style)' / 'make it (smaller|larger)' must
  //     NOT match either (false-positive on CSS/UI/layout follow-
  //     ups: "change the background color in the CSS" / "make it
  //     smaller in viewport").
  //
  // Only phrasings that unambiguously mention an IMAGE OBJECT belong
  // here. Image-only verbs (recolor / retouch / crop) and image-
  // leaning brightness adjectives (make it brighter|darker) stay
  // because they aren't used in code/CSS contexts.
  const positives = [
    // CJK image-only verbs
    '换背景',
    '抠掉logo',
    '裁切右半边',
    '调亮一点',
    // CJK explicit object
    '这张图改一下',
    '那张图换个角度',
    // English explicit object
    'edit the photo',
    'edit the screenshot',
    'edit the image',
    // English image-only verbs
    'recolor',
    'retouch this',
    'crop this',
    // English image-leaning brightness adjectives
    'make it brighter',
    'make it darker',
  ];
  for (const text of positives) {
    assert.ok(
      IMAGE_FOLLOW_UP_PATTERN.test(text),
      `IMAGE_FOLLOW_UP_PATTERN should match: "${text}"`,
    );
  }
});

test('IMAGE_FOLLOW_UP_PATTERN extension does NOT regress prefix/suffix false positives', () => {
  // The original test pinned that 'photography', 'imagination', etc.
  // are NOT matches. The extension must keep that guarantee — the
  // \b-bounded English additions can't sneak through "imageediting"
  // or similar.
  const negatives = [
    'photography question',
    'the photographic style',
    'photosynthesis',
    'imagery in the abstract',
    'imagination runs wild',
  ];
  for (const text of negatives) {
    assert.equal(
      IMAGE_FOLLOW_UP_PATTERN.test(text),
      false,
      `IMAGE_FOLLOW_UP_PATTERN must NOT match: "${text}"`,
    );
  }
});

test('IMAGE_FOLLOW_UP_PATTERN does NOT carry forward on generic non-image edit asks (CJK + EN)', () => {
  // Codex review round 5 (2026-04-30) caught CJK regression: an
  // earlier image got dragged into a code-edit follow-up because
  // the pattern naively matched bare 改成 / 修改 / 编辑.
  //
  // Codex review round 6 (2026-04-30) caught the symmetric English
  // regression: 'change the color/background/font/style' and 'make
  // it smaller/larger' are equally common in CSS / UI / layout
  // questions. Same misroute, English flavor.
  //
  // Both negative sets are pinned together so a future "let's add
  // X back" refactor on either side can't quietly re-introduce
  // the misroute.
  const negatives = [
    // English code/text edits — historically pinned
    'edit the code',
    'edit my essay',
    'change the variable name',
    'modify the function',
    'replace the algorithm',
    // English UI/CSS/layout edits — newly pinned in round 6
    'change the color in the CSS',
    'change the background color in main.css',
    'change the font in Button.jsx',
    'change the style of the form',
    'change the color scheme',
    'make it smaller in the viewport',
    'make it larger in layout',
    'make it more responsive',
    'make it less verbose',
    'update the color',
    'update the background',
    'update the font',
    // CJK code/text edits — pinned in round 5
    '把这个函数改成 async',
    '修改函数',
    '修改代码',
    '编辑这段文字',
    '改一下文档',
    '去掉这段日志',
    '加上单元测试',
    '换一下变量名',
    '换掉这段逻辑',
    '再改一下',         // bare "再改" — no object, must NOT carry forward
    '让它更快',          // bare "让X更" — code/perf, not an image
    '让代码更简洁',
  ];
  for (const text of negatives) {
    assert.equal(
      IMAGE_FOLLOW_UP_PATTERN.test(text),
      false,
      `IMAGE_FOLLOW_UP_PATTERN should NOT match generic non-image edit: "${text}"`,
    );
  }
});
