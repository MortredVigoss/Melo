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

test('IMAGE_FOLLOW_UP_PATTERN matches image-edit phrasings so multi-turn edits carry forward', () => {
  const positives = [
    '再换个色',
    '把背景换掉',
    '去掉这个字',
    '改成赛博朋克风',
    '换背景',
    '抠掉logo',
    '裁切右半边',
    '调亮一点',
    '加个帽子',
    'edit the photo',
    'edit the screenshot',
    'change the color',
    'change the background',
    'change the font',
    'change the style',
    'recolor',
    'retouch this',
    'crop this',
    'make it brighter',
    'make it darker',
    'make it smaller',
  ];
  for (const text of positives) {
    assert.ok(
      IMAGE_FOLLOW_UP_PATTERN.test(text),
      `IMAGE_FOLLOW_UP_PATTERN should now match: "${text}"`,
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

test('IMAGE_FOLLOW_UP_PATTERN extension does NOT match generic non-image edit asks', () => {
  // Bare "edit the code" / "modify variables" / 修改代码 etc. should
  // NOT carry forward an image — those are code/text edits, not image
  // edits. The extension only adds image-specific phrases (edit the
  // image / change the color / 抠掉 etc.).
  const negatives = [
    'edit the code',
    'edit my essay',
    'change the variable name',
    'modify the function',
    'replace the algorithm',
  ];
  for (const text of negatives) {
    assert.equal(
      IMAGE_FOLLOW_UP_PATTERN.test(text),
      false,
      `IMAGE_FOLLOW_UP_PATTERN should NOT match generic non-image edit: "${text}"`,
    );
  }
});
