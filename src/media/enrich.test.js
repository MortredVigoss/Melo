import test from 'node:test';
import assert from 'node:assert/strict';
import {
  enrichMessageWithMediaContext,
  extractedMediaSearchText,
  mergeSocialPreviewWithDirectVideoExtraction,
  normalizeExtractedMedia,
  renderExtractedMediaContext,
  shouldBypassCachedExtraction,
} from './index.js';
import { extractImageContent } from './extractors/imageExtractor.js';
import { extractReadableHtml } from './extractors/linkExtractor.js';
import { extractYoutubeId, parseWebVttTranscript } from './extractors/youtubeExtractor.js';
import { modelSupportsVision } from './visionCapability.js';

test('normalizeExtractedMedia keeps only valid structured entries', () => {
  const items = normalizeExtractedMedia([
    null,
    { kind: 'transcript', text: '  hello world  ', metadata: { title: 'Audio' } },
    { kind: 'unknown', text: '' },
    { kind: 'caption', text: '[Image attachment: photo.png]', metadata: { source: 'vision-passthrough' } },
    { kind: 'caption', text: '[Image attachment: photo.png]', metadata: { source: 'inline-image-placeholder' } },
    { kind: 'mystery', text: 'fallback summary' },
  ]);

  assert.deepEqual(items, [
    {
      attachmentId: null,
      kind: 'transcript',
      text: 'hello world',
      metadata: { title: 'Audio' },
    },
    {
      attachmentId: null,
      kind: 'summary',
      text: 'fallback summary',
      metadata: {},
    },
  ]);
});

test('modelSupportsVision stays conservative', () => {
  assert.equal(modelSupportsVision('gpt-4o'), true);
  assert.equal(modelSupportsVision('gemini-1.5-pro'), true);
  assert.equal(modelSupportsVision('gpt-5.5'), true);
  assert.equal(modelSupportsVision('o3'), true);
  assert.equal(modelSupportsVision('gpt-3.5-turbo'), false);
});

test('renderExtractedMediaContext and search text include extracted content', () => {
  const media = [
    {
      kind: 'article',
      text: 'This article explains the migration plan.',
      metadata: { title: 'Migration plan', url: 'https://example.com/doc' },
    },
  ];

  assert.match(renderExtractedMediaContext(media), /Linked content/);
  assert.match(extractedMediaSearchText(media), /Migration plan/);
});

test('enrichMessageWithMediaContext no-ops when media is disabled', async () => {
  process.env.MELO_DISABLE_MEDIA = '1';
  const message = {
    attachments: [
      { id: 'image-1', kind: 'image', url: 'https://example.com/cat.png' },
    ],
  };

  await enrichMessageWithMediaContext(message, { modelSupportsVision: true });
  assert.deepEqual(message.extractedMedia, []);
  delete process.env.MELO_DISABLE_MEDIA;
});

test('shouldBypassCachedExtraction retries shallow social-link cache but keeps deep cache', () => {
  const attachment = { kind: 'link', url: 'https://v.douyin.com/1ZtdZeuq73U/' };

  assert.equal(
    shouldBypassCachedExtraction(attachment, {
      metadata: { source: 'social-link:share-preview:wechat' },
    }),
    true,
  );
  assert.equal(
    shouldBypassCachedExtraction(attachment, {
      metadata: { source: 'social-link:opengraph' },
    }),
    true,
  );
  assert.equal(
    shouldBypassCachedExtraction(attachment, {
      metadata: { source: 'social-link:browser:browser' },
    }),
    false,
  );
  assert.equal(
    shouldBypassCachedExtraction(attachment, {
      metadata: { source: 'social-link:share-preview:wechat+douyin-ssr' },
    }),
    false,
  );
  assert.equal(
    shouldBypassCachedExtraction(attachment, {
      metadata: { source: 'social-link:yt-dlp' },
    }),
    false,
  );
  assert.equal(
    shouldBypassCachedExtraction(attachment, {
      metadata: {
        source: 'social-link:share-preview:wechat+douyin-ssr',
        media: [{ src: 'https://aweme.snssdk.com/aweme/v1/playwm/?video_id=abc' }],
      },
    }),
    true,
  );
  assert.equal(
    shouldBypassCachedExtraction(attachment, {
      metadata: {
        source: 'social-link:share-preview:wechat+douyin-ssr',
        media: [{ src: 'https://aweme.snssdk.com/aweme/v1/playwm/?video_id=abc' }],
        directMediaExtractionAttempted: true,
      },
    }),
    false,
  );
  assert.equal(
    shouldBypassCachedExtraction(
      { kind: 'link', url: 'https://example.com/article' },
      { metadata: { source: 'social-link:share-preview:wechat' } },
    ),
    false,
  );
});

test('mergeSocialPreviewWithDirectVideoExtraction appends transcript and preserves keyframes', () => {
  const out = mergeSocialPreviewWithDirectVideoExtraction(
    {
      kind: 'article',
      text: 'Douyin preview body',
      metadata: {
        title: 'Douyin title',
        media: [{ src: 'https://aweme.snssdk.com/aweme/v1/playwm/?video_id=abc' }],
      },
    },
    {
      kind: 'transcript',
      text: 'spoken words from the video',
      metadata: {
        source: 'video-audio-transcript',
        keyframes: ['data:image/jpeg;base64,/9j/4AAQ'],
      },
    },
    { directUrl: 'https://aweme.snssdk.com/aweme/v1/playwm/?video_id=abc' },
  );

  assert.match(out.text, /Douyin preview body/);
  assert.match(out.text, /Direct video transcript/);
  assert.match(out.text, /spoken words from the video/);
  assert.equal(out.metadata.directMediaExtractionAttempted, true);
  assert.equal(out.metadata.directMediaExtractionSucceeded, true);
  assert.deepEqual(out.metadata.keyframes, ['data:image/jpeg;base64,/9j/4AAQ']);
});

test('extractImageContent does not create placeholder text for vision models', async () => {
  const extracted = await extractImageContent({
    url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
    title: 'Inline smoke image',
  }, {
    modelSupportsVision: true,
  });

  assert.equal(extracted, null);
});

test('extractImageContent skips tiny inline images instead of creating placeholders', async () => {
  const extracted = await extractImageContent({
    url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
    title: 'Inline smoke image',
  }, {
    modelSupportsVision: false,
  });

  assert.equal(extracted, null);
});

test('renderExtractedMediaContext ignores legacy placeholder media sources', () => {
  const text = renderExtractedMediaContext([
    {
      kind: 'caption',
      text: '[Image attachment: old.png]',
      metadata: { source: 'ocr-fallback-placeholder' },
    },
    {
      kind: 'article',
      text: 'Useful extracted content.',
      metadata: { title: 'Real article' },
    },
  ]);

  assert.doesNotMatch(text, /Image attachment: old\.png/);
  assert.match(text, /Useful extracted content\./);
});

test('extractReadableHtml strips scripts and preserves article text', () => {
  const extracted = extractReadableHtml(`
    <html>
      <head>
        <title>Example Title</title>
        <meta name="description" content="Example excerpt" />
        <script>ignored()</script>
      </head>
      <body>
        <article><h1>Hello</h1><p>World body</p></article>
      </body>
    </html>
  `, 'https://example.com');

  assert.equal(extracted?.metadata?.title, 'Example Title');
  assert.equal(extracted?.metadata?.excerpt, 'Example excerpt');
  assert.match(extracted?.text || '', /Hello/);
  assert.match(extracted?.text || '', /World body/);
  assert.doesNotMatch(extracted?.text || '', /ignored/);
});

test('YouTube helpers parse ids and clean VTT subtitles', () => {
  assert.equal(
    extractYoutubeId('https://youtu.be/dQw4w9WgXcQ'),
    'dQw4w9WgXcQ',
  );
  assert.match(
    parseWebVttTranscript(`WEBVTT

00:00:00.000 --> 00:00:01.000
Hello <i>world</i>

00:00:01.000 --> 00:00:02.000
Again`),
    /Hello world[\s\S]*Again/,
  );
});
