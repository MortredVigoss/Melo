import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectUrlKind,
  extractUrlsFromText,
  promoteTextUrlsToAttachments,
} from './urlDetector.js';

test('detectUrlKind classifies common media URLs', () => {
  assert.equal(detectUrlKind('https://example.com/pic.png'), 'image');
  assert.equal(detectUrlKind('https://example.com/file.pdf'), 'document');
  assert.equal(detectUrlKind('https://youtu.be/dQw4w9WgXcQ'), 'video-platform');
  assert.equal(detectUrlKind('https://example.com/page'), 'link');
});

test('extractUrlsFromText finds unique URLs and trims punctuation', () => {
  const items = extractUrlsFromText(
    'Look at https://example.com/test.png, then https://example.com/test.png and https://example.com/doc.',
  );

  assert.deepEqual(
    items.map(item => item.url),
    ['https://example.com/test.png', 'https://example.com/doc'],
  );
});

test('promoteTextUrlsToAttachments upgrades plain text URLs without duplicating existing ones', () => {
  const attachments = promoteTextUrlsToAttachments(
    'See https://example.com/a.pdf and https://example.com/video.mp4',
    [{ url: 'https://example.com/video.mp4' }],
  );

  assert.deepEqual(attachments, [
    {
      id: undefined,
      kind: 'link',
      url: 'https://example.com/a.pdf',
      title: 'example.com/a.pdf',
      mimeType: 'application/pdf',
      fileName: '',
    },
  ]);
});
