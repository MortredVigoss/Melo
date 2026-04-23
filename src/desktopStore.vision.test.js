import test from 'node:test';
import assert from 'node:assert/strict';
import { buildModelMessagesFromChat } from './desktopStore.js';

function latestContentParts(messages) {
  return messages[messages.length - 1]?.content;
}

test('buildModelMessagesFromChat carries the most recent image into a contextual follow-up turn', () => {
  const modelMessages = buildModelMessagesFromChat({
    messages: [
      {
        role: 'user',
        content: '这张图里写了什么？',
        attachments: [
          {
            kind: 'image',
            url: 'data:image/png;base64,AAAA',
            title: '截图.png',
          },
        ],
      },
      {
        role: 'assistant',
        content: '我先看看这张图。',
      },
      {
        role: 'user',
        content: '里面有什么',
        attachments: [],
      },
    ],
  });

  const latestParts = latestContentParts(modelMessages);
  assert.ok(Array.isArray(latestParts));
  assert.ok(latestParts.some(part => part?.type === 'image_url'));
});

test('buildModelMessagesFromChat does not carry old images into unrelated new questions', () => {
  const modelMessages = buildModelMessagesFromChat({
    messages: [
      {
        role: 'user',
        content: '这张图里写了什么？',
        attachments: [
          {
            kind: 'image',
            url: 'data:image/png;base64,AAAA',
            title: '截图.png',
          },
        ],
      },
      {
        role: 'assistant',
        content: '我先看看这张图。',
      },
      {
        role: 'user',
        content: '顺便帮我写个 Python 函数',
        attachments: [],
      },
    ],
  });

  const latestParts = latestContentParts(modelMessages);
  if (Array.isArray(latestParts)) {
    assert.equal(latestParts.some(part => part?.type === 'image_url'), false);
  } else {
    assert.match(String(latestParts || ''), /Python 函数/);
  }
});

test('buildModelMessagesFromChat does not over-match generic Chinese words like 内容', () => {
  const modelMessages = buildModelMessagesFromChat({
    messages: [
      {
        role: 'user',
        content: '这张图里写了什么？',
        attachments: [
          {
            kind: 'image',
            url: 'data:image/png;base64,AAAA',
            title: '截图.png',
          },
        ],
      },
      {
        role: 'assistant',
        content: '我先看看。',
      },
      {
        role: 'user',
        content: '帮我整理一下这次对话的内容',
        attachments: [],
      },
    ],
  });

  const latestParts = latestContentParts(modelMessages);
  if (Array.isArray(latestParts)) {
    assert.equal(latestParts.some(part => part?.type === 'image_url'), false);
  } else {
    assert.match(String(latestParts || ''), /这次对话的内容/);
  }
});

test('buildModelMessagesFromChat strips historical rich-media attachments from earlier user turns', () => {
  const modelMessages = buildModelMessagesFromChat({
    messages: [
      {
        role: 'user',
        content: '先看这张旧图',
        attachments: [
          {
            kind: 'image',
            url: 'data:image/png;base64,AAAA',
            title: 'old.png',
          },
        ],
      },
      {
        role: 'assistant',
        content: '我看到了。',
      },
      {
        role: 'user',
        content: '现在看这张新图',
        attachments: [
          {
            kind: 'image',
            url: 'data:image/png;base64,BBBB',
            title: 'new.png',
          },
        ],
      },
    ],
  });

  const firstUserContent = modelMessages[0]?.content;
  const latestUserContent = latestContentParts(modelMessages);

  if (Array.isArray(firstUserContent)) {
    assert.equal(firstUserContent.some(part => part?.type === 'image_url'), false);
  } else {
    assert.match(String(firstUserContent || ''), /先看这张旧图/);
  }

  assert.ok(Array.isArray(latestUserContent));
  assert.equal(latestUserContent.some(part => part?.type === 'image_url'), true);
});

// The window is now token-budget bounded (see buildRecentWindow in
// src/memory/contextCompact.js). Short chats are sent in full; only long
// chats get trimmed at the token boundary.

test('buildModelMessagesFromChat keeps the full short history when it fits the token budget', () => {
  const messages = Array.from({ length: 20 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `message-${index}`,
    attachments: [],
  }));

  const modelMessages = buildModelMessagesFromChat({ messages });

  // 20 tiny messages easily fit under CONTEXT_WINDOW_TOKENS, so nothing is
  // dropped. The newest message must always survive and sit at the tail.
  assert.equal(modelMessages.length, 20);
  assert.match(String(modelMessages[0]?.content || ''), /message-0/);
  assert.match(String(modelMessages[modelMessages.length - 1]?.content || ''), /message-19/);
});

test('buildModelMessagesFromChat trims the window when history exceeds the token budget', () => {
  // Each message is ~20k chars ≈ 5k tokens. With CONTEXT_WINDOW_TOKENS=60k
  // (raw budget ~45k after the 3/4 conversion in buildRecentWindow), only a
  // tail of these fits. The exact count depends on the budget; the test
  // asserts the semantically important invariants rather than a magic number.
  const chunk = 'x'.repeat(20_000);
  const messages = Array.from({ length: 20 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `message-${index}-${chunk}`,
    attachments: [],
  }));

  const modelMessages = buildModelMessagesFromChat({ messages });

  // 1. Trimming actually happened (otherwise this test is vacuous).
  assert.ok(
    modelMessages.length < messages.length,
    `expected trimming, got ${modelMessages.length}/${messages.length}`,
  );
  // 2. The minimum guaranteed tail is always preserved.
  assert.ok(modelMessages.length >= 6, 'at least COMPACT_KEEP_RECENT_MIN kept');
  // 3. Trimming drops from the head, not the tail — newest survives.
  assert.match(String(modelMessages[modelMessages.length - 1]?.content || ''), /message-19/);
  // 4. The first kept message is contiguous with the tail — indices form a
  //    suffix of the original array.
  const firstKeptIndex = 20 - modelMessages.length;
  assert.match(
    String(modelMessages[0]?.content || ''),
    new RegExp(`message-${firstKeptIndex}-`),
  );
});

test('buildModelMessagesFromChat carries recent audio into a contextual follow-up turn', () => {
  const modelMessages = buildModelMessagesFromChat({
    messages: [
      {
        role: 'user',
        content: '听一下这段语音',
        attachments: [
          {
            kind: 'audio',
            url: 'data:audio/mpeg;base64,QUJD',
            title: 'voice.mp3',
            mimeType: 'audio/mpeg',
            fileName: 'voice.mp3',
          },
        ],
      },
      {
        role: 'assistant',
        content: '我先听一下。',
      },
      {
        role: 'user',
        content: '他说了什么',
        attachments: [],
      },
    ],
  });

  const latestParts = latestContentParts(modelMessages);
  assert.ok(Array.isArray(latestParts));
  assert.equal(latestParts.some(part => part?.type === 'audio_attachment'), true);
});

test('buildModelMessagesFromChat carries recent link context into a contextual follow-up turn', () => {
  const modelMessages = buildModelMessagesFromChat({
    messages: [
      {
        role: 'user',
        content: '看看这个链接',
        attachments: [
          {
            kind: 'link',
            url: 'https://example.com/article',
            title: 'example.com/article',
          },
        ],
        extractedMedia: [
          {
            kind: 'article',
            text: 'This article is about migration planning.',
            metadata: {
              title: 'Migration planning',
              url: 'https://example.com/article',
            },
          },
        ],
      },
      {
        role: 'assistant',
        content: '我先看一下。',
      },
      {
        role: 'user',
        content: '这个链接讲了什么',
        attachments: [],
      },
    ],
  });

  const latestParts = latestContentParts(modelMessages);
  assert.ok(Array.isArray(latestParts));
  const textParts = latestParts.filter(part => part?.type === 'text').map(part => String(part.text || ''));
  assert.equal(textParts.some(part => part.includes('This article is about migration planning.')), true);
});

test('buildModelMessagesFromChat strips historical extracted media from earlier turns', () => {
  const modelMessages = buildModelMessagesFromChat({
    messages: [
      {
        role: 'user',
        content: '看看这个链接',
        attachments: [
          {
            kind: 'link',
            url: 'https://example.com/article',
            title: 'example.com/article',
          },
        ],
        extractedMedia: [
          {
            kind: 'article',
            text: 'Historical article body should not be replayed forever.',
            metadata: {
              title: 'Old article',
            },
          },
        ],
      },
      {
        role: 'assistant',
        content: '我先看一下。',
      },
      {
        role: 'user',
        content: '换个话题',
        attachments: [],
      },
    ],
  });

  const firstUserContent = modelMessages[0]?.content;
  if (Array.isArray(firstUserContent)) {
    const textParts = firstUserContent
      .filter(part => part?.type === 'text')
      .map(part => String(part.text || ''));
    assert.equal(textParts.some(part => part.includes('Historical article body should not be replayed forever.')), false);
  } else {
    assert.doesNotMatch(String(firstUserContent || ''), /Historical article body should not be replayed forever/);
  }
});
