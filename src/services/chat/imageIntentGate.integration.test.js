// imageIntentGate.integration.test.js — Phase 4 Codex follow-up (H plan).
//
// Pins the cross-system contract between:
//   1. messageBuilder.js  — carry-forward via IMAGE_FOLLOW_UP_PATTERN
//      (decides whether an older turn's image gets merged into the
//       latest user turn).
//   2. openai.js          — latestUserMessageHasImage gate
//      (decides whether image_generation enters the tools list).
//
// The two systems must agree on the SAME visible state of the latest
// turn after carry-forward runs. If they drift apart — e.g. carry-forward
// stays narrow but the gate widens — image_generation can either get
// silently dropped on legitimate cross-turn edits, or get re-enabled
// for bare CSS/theming follow-ups (the Xiaohongshu/Douyin failure mode).
//
// Codex review (Phase 4 follow-up 2026-05-04, C 评级 阻 push) explicitly
// requested integration tests covering "from chat history to payload".
// This file is that test.

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildModelMessagesFromChat } from '../../desktopStore.js';
import { latestUserMessageHasImage } from '../../openai.js';

function latestContent(messages) {
  return messages[messages.length - 1]?.content;
}

function latestHasImageUrlPart(messages) {
  const content = latestContent(messages);
  if (!Array.isArray(content)) return false;
  return content.some(part =>
    part?.type === 'image_url'
    && typeof part?.image_url?.url === 'string'
    && part.image_url.url.trim(),
  );
}

// ── Contract: carry-forward triggers ⇒ gate sees image ───────────────

test('carry-forward triggers ("这张图里有什么") → modelMessages latest has image_url AND gate sees it', () => {
  const modelMessages = buildModelMessagesFromChat({
    messages: [
      {
        role: 'user',
        content: '看一下这张图',
        attachments: [{ kind: 'image', url: 'data:image/png;base64,AAAA', title: 'a.png' }],
      },
      { role: 'assistant', content: '看到了。' },
      { role: 'user', content: '里面有什么', attachments: [] },
    ],
  });

  // Both must agree the latest turn carries the image.
  assert.equal(latestHasImageUrlPart(modelMessages), true,
    'carry-forward should have merged the image into latest turn');
  assert.equal(latestUserMessageHasImage(modelMessages), true,
    'gate must see the image after carry-forward');
});

test('carry-forward triggers ("换背景") with explicit image-noun verb — image carries forward', () => {
  // "换背景" is a literal alternate in IMAGE_FOLLOW_UP_PATTERN. With
  // image in prior turn this should carry forward → gate sees image.
  // (Note: "换个色" alone is NOT in IMAGE_FOLLOW_UP — only the
  //  contiguous "换色" / "换背景" / "换底色" alternates qualify. Pin
  //  the contiguous-alternate form so the contract is unambiguous.)
  const modelMessages = buildModelMessagesFromChat({
    messages: [
      {
        role: 'user',
        content: '把这个改成 gpt',
        attachments: [{ kind: 'image', url: 'data:image/png;base64,AAAA', title: 'a.png' }],
      },
      { role: 'assistant', content: 'Done.' },
      { role: 'user', content: '换背景', attachments: [] },
    ],
  });

  assert.equal(latestHasImageUrlPart(modelMessages), true);
  assert.equal(latestUserMessageHasImage(modelMessages), true);
});

// ── Contract: carry-forward does NOT trigger ⇒ gate stays off ────────

test('CSS/theming follow-up after a screenshot does NOT carry image forward and gate stays off', () => {
  // The exact false-positive scenario the messageBuilder docs call out
  // (review round 6, 2026-04-30): user shared a screenshot then asked
  // about CSS. Carry-forward must NOT trigger. Gate must stay off.
  const modelMessages = buildModelMessagesFromChat({
    messages: [
      {
        role: 'user',
        content: '帮我看一下这张截图',
        attachments: [{ kind: 'image', url: 'data:image/png;base64,AAAA', title: 'screen.png' }],
      },
      { role: 'assistant', content: '看完了。' },
      { role: 'user', content: 'change the background color to blue', attachments: [] },
    ],
  });

  assert.equal(latestHasImageUrlPart(modelMessages), false,
    'CSS follow-up text must NOT pull the screenshot into the latest turn');
  assert.equal(latestUserMessageHasImage(modelMessages), false,
    'gate must stay off so image_generation is not in the tools list');
});

test('bare edit verb without image word + historical image → carry-forward stays off, gate stays off', () => {
  // Codex review (2026-05-04 C 评级) flagged this scenario explicitly:
  // "再改一下头发" / "换一下颜色" do NOT match IMAGE_FOLLOW_UP_PATTERN
  // (no image-noun), so they don't trigger carry-forward. The
  // image-intent gate consults the SAME post-carry-forward state, so
  // image_generation correctly stays out of tools. User wanting cross-
  // turn edit must say "再改一下这张图的头发" (or similar) to re-anchor.
  // Pin the alignment so future expansions on either side don't
  // create a one-sided drift.
  const fixtures = [
    '再改一下头发',
    '换一下颜色',
    '调一下亮度',
    '再修改',
  ];

  for (const text of fixtures) {
    const modelMessages = buildModelMessagesFromChat({
      messages: [
        {
          role: 'user',
          content: '这是我的图',
          attachments: [{ kind: 'image', url: 'data:image/png;base64,AAAA', title: 'pic.png' }],
        },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: text, attachments: [] },
      ],
    });

    assert.equal(
      latestHasImageUrlPart(modelMessages),
      false,
      `bare-edit "${text}" must NOT carry image forward`,
    );
    assert.equal(
      latestUserMessageHasImage(modelMessages),
      false,
      `gate must agree with carry-forward: no image in latest turn for "${text}"`,
    );
  }
});

test('latest user turn has its OWN image → both systems agree image is there', () => {
  // Sanity: when the user uploads an image directly in the latest
  // turn (no carry-forward needed) the gate must obviously see it.
  const modelMessages = buildModelMessagesFromChat({
    messages: [
      {
        role: 'user',
        content: 'change the background',
        attachments: [{ kind: 'image', url: 'data:image/png;base64,AAAA', title: 'a.png' }],
      },
    ],
  });

  assert.equal(latestHasImageUrlPart(modelMessages), true);
  assert.equal(latestUserMessageHasImage(modelMessages), true);
});

// ── End-to-end: chat history → Codex payload tools ───────────────────
//
// Codex review (Phase 4 H plan ⚪ P2 closure 2026-05-04): the half-pin
// above (helper sees image after carry-forward) is not enough — a wiring
// regression in createCodexResponsesReply could still drop
// image_generation from the payload while the helper-level test stays
// green. These cases drive the FULL pipeline:
//   chat → buildModelMessagesFromChat → createCodexResponsesReply →
//   captured request body → assertions on tools/instructions.

import { createCodexResponsesReply } from '../../openai.js';

const CODEX_CRED_STUB = {
  loggedIn: true,
  expired: false,
  accountId: 'acct-test',
  accessToken: 'token-test',
};

// Mirrors emptyCompletedResponse in src/openai.codex-inline-image.test.js —
// produces a Response-shaped object whose SSE stream terminates with a
// well-formed response.completed so createCodexResponsesReply resolves
// without throwing. We only care about the captured REQUEST body.
function emptyCompletedSseResponse() {
  const block = `event: response.completed\ndata: ${JSON.stringify({
    type: 'response.completed',
    response: { output: [{ type: 'message', content: [{ text: 'ok' }] }] },
  })}\n\n`;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(block));
      controller.close();
    },
  });
  return { ok: true, status: 200, body: stream };
}

async function captureCodexPayloadFromChat(chat, { workspacePath = '/tmp/test-ws' } = {}) {
  const modelMessages = buildModelMessagesFromChat(chat);
  let captured = null;
  await createCodexResponsesReply({
    baseUrl: 'https://chatgpt.com/backend-api',
    model: 'gpt-5.5',
    systemPrompt: 'You are Melo.',
    messages: modelMessages,
    workspacePath,
    _credentialProvider: async () => CODEX_CRED_STUB,
    _fetchImpl: async (url, init) => {
      captured = { url, body: JSON.parse(init.body) };
      return emptyCompletedSseResponse();
    },
  });
  return captured;
}

test('end-to-end: chat with image + IMAGE_FOLLOW_UP follow-up → Codex payload includes image_generation', async () => {
  const captured = await captureCodexPayloadFromChat({
    messages: [
      {
        role: 'user',
        content: '看一下这张图',
        attachments: [{ kind: 'image', url: 'data:image/png;base64,AAAA', title: 'a.png' }],
      },
      { role: 'assistant', content: '看到了。' },
      { role: 'user', content: '换背景', attachments: [] },
    ],
  });
  const tools = captured?.body?.tools || [];
  assert.ok(
    tools.some(t => t?.type === 'image_generation'),
    'IMAGE_FOLLOW_UP-eligible cross-turn edit must enable image_generation in payload',
  );
});

test('end-to-end: chat with image + CSS follow-up → Codex payload omits image_generation', async () => {
  const captured = await captureCodexPayloadFromChat({
    messages: [
      {
        role: 'user',
        content: '帮我看一下这张截图',
        attachments: [{ kind: 'image', url: 'data:image/png;base64,AAAA', title: 'screen.png' }],
      },
      { role: 'assistant', content: '看完了。' },
      { role: 'user', content: 'change the background color to blue', attachments: [] },
    ],
  });
  const tools = captured?.body?.tools || [];
  assert.equal(
    tools.some(t => t?.type === 'image_generation'),
    false,
    'CSS follow-up after a screenshot must NOT enable image_generation in payload',
  );
});

test('end-to-end: chat with link paste + summarize text + thumbnail attachment → no image_generation', async () => {
  // The actual Xiaohongshu/Douyin mis-routing scenario the user
  // reported. Earlier turn or current turn carries a thumbnail image
  // (share-link preview), text reads as "summarize this" (LINK
  // follow-up, not IMAGE). Image_generation must NOT be in tools.
  const captured = await captureCodexPayloadFromChat({
    messages: [
      {
        role: 'user',
        content: '看看这个 https://www.xiaohongshu.com/explore/abc',
        attachments: [
          // Share-link preview thumbnail in current turn.
          { kind: 'image', url: 'data:image/png;base64,AAAA', title: 'preview.png' },
          { kind: 'link', url: 'https://www.xiaohongshu.com/explore/abc', title: 'Xiaohongshu post' },
        ],
      },
    ],
  });
  const tools = captured?.body?.tools || [];
  // Image attachment + non-image text → image_generation MUST stay out.
  // This is the entire point of the Phase 4 fix.
  assert.equal(
    tools.some(t => t?.type === 'image_generation'),
    false,
    'link-paste with thumbnail + summarize text must NOT enable image_generation',
  );
});

test('end-to-end: explicit image-gen text → image_generation IS in payload (no over-correction)', async () => {
  const captured = await captureCodexPayloadFromChat({
    messages: [
      { role: 'user', content: '画一只橘色的猫', attachments: [] },
    ],
  });
  const tools = captured?.body?.tools || [];
  assert.ok(
    tools.some(t => t?.type === 'image_generation'),
    'explicit "画" intent must keep image_generation available',
  );
});

test('cross-turn distance cap: image more than 4 turns back does NOT carry forward', () => {
  // shouldCarryForwardRecentMedia caps at 4 turns. Pin this so the
  // gate doesn't accidentally re-enable image_generation for stale
  // images across long conversations.
  const messages = [];
  messages.push({
    role: 'user',
    content: '这是图',
    attachments: [{ kind: 'image', url: 'data:image/png;base64,AAAA', title: 'a.png' }],
  });
  // 5 alternating turns of plain text — pushes the image >4 turns back.
  for (let i = 0; i < 5; i++) {
    messages.push({ role: 'assistant', content: `reply ${i}` });
    messages.push({ role: 'user', content: `unrelated ${i}`, attachments: [] });
  }
  // Final follow-up that WOULD have matched IMAGE_FOLLOW_UP if not for
  // distance cap.
  messages.push({ role: 'user', content: '看一下图里有什么', attachments: [] });

  const modelMessages = buildModelMessagesFromChat({ messages });
  assert.equal(latestHasImageUrlPart(modelMessages), false,
    'image >4 turns away must not carry forward');
  assert.equal(latestUserMessageHasImage(modelMessages), false,
    'gate must agree — distance cap is part of the contract');
});
