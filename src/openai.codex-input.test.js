import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCodexResponsesInput } from './openai.js';

test('buildCodexResponsesInput preserves image parts for codex responses', async () => {
  const input = await buildCodexResponsesInput([
    {
      role: 'user',
      content: [
        { type: 'text', text: '这张图里是什么？' },
        {
          type: 'image_url',
          image_url: {
            url: 'data:image/png;base64,AAAA',
          },
        },
      ],
    },
  ]);

  assert.deepEqual(input, [
    {
      role: 'user',
      content: [
        { type: 'input_text', text: '这张图里是什么？' },
        { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
      ],
    },
  ]);
});

test('buildCodexResponsesInput inlines remote image urls for codex responses', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    headers: new Headers({
      'content-type': 'image/jpeg',
    }),
    arrayBuffer: async () => Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]).buffer,
  });

  try {
    const input = await buildCodexResponsesInput([
      {
        role: 'user',
        content: [
          { type: 'text', text: '看这张 Telegram 图片' },
          {
            type: 'image_url',
            image_url: {
              url: 'https://api.telegram.org/file/botTOKEN/photos/file_1.jpg',
            },
          },
        ],
      },
    ]);

    assert.equal(input.length, 1);
    assert.equal(input[0].role, 'user');
    assert.equal(input[0].content[1]?.type, 'input_image');
    assert.match(
      input[0].content[1]?.image_url || '',
      /^data:image\/jpeg;base64,/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('buildCodexResponsesInput ignores raw audio attachments for codex responses', async () => {
  const input = await buildCodexResponsesInput([
    {
      role: 'user',
      content: [
        { type: 'text', text: '帮我听一下这段语音' },
        {
          type: 'audio_attachment',
          audio_attachment: {
            url: 'data:audio/mpeg;base64,QUJD',
            mimeType: 'audio/mpeg',
            fileName: 'clip.mp3',
          },
        },
      ],
    },
  ]);

  assert.equal(input.length, 1);
  assert.equal(input[0].role, 'user');
  assert.deepEqual(input[0].content, [
    { type: 'input_text', text: '帮我听一下这段语音' },
  ]);
});

test('buildCodexResponsesInput ignores raw video attachments for codex responses', async () => {
  const input = await buildCodexResponsesInput([
    {
      role: 'user',
      content: [
        { type: 'text', text: '帮我看看这个视频在讲什么' },
        {
          type: 'video_attachment',
          video_attachment: {
            url: 'data:video/mp4;base64,QUJD',
            mimeType: 'video/mp4',
            fileName: 'clip.mp4',
          },
        },
      ],
    },
  ]);

  assert.equal(input.length, 1);
  assert.equal(input[0].role, 'user');
  assert.deepEqual(input[0].content, [
    { type: 'input_text', text: '帮我看看这个视频在讲什么' },
  ]);
});
