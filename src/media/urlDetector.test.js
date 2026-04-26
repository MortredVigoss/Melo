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

// The composer's Link button now also routes through promoteTextUrlsToAttachments
// (desktop-ui/app.js → promptComposerLinkAttachment) so YouTube / audio / video /
// PDF / plain web pages get the same kind+mimeType+title regardless of whether
// the user pasted text or clicked Link. These cases lock that contract — if
// any of these shapes drift the composer's manual-link path silently drifts
// with them.

test('promoteTextUrlsToAttachments: video-platform URL maps to kind=video', () => {
  const [a] = promoteTextUrlsToAttachments('https://youtu.be/dQw4w9WgXcQ', []);
  assert.equal(a.kind, 'video');
  assert.equal(a.url, 'https://youtu.be/dQw4w9WgXcQ');
  assert.equal(a.title, 'youtu.be/dQw4w9WgXcQ');
  assert.equal(a.mimeType, '');
});

test('promoteTextUrlsToAttachments: image extension maps to kind=image', () => {
  const [a] = promoteTextUrlsToAttachments('https://example.com/cover.jpg', []);
  assert.equal(a.kind, 'image');
  assert.equal(a.mimeType, '');
});

test('promoteTextUrlsToAttachments: audio extension maps to kind=audio', () => {
  const [a] = promoteTextUrlsToAttachments('https://example.com/clip.mp3', []);
  assert.equal(a.kind, 'audio');
});

test('promoteTextUrlsToAttachments: PDF document gets mimeType=application/pdf, kind=link', () => {
  const [a] = promoteTextUrlsToAttachments('https://example.com/spec.pdf', []);
  assert.equal(a.kind, 'link');
  assert.equal(a.mimeType, 'application/pdf');
});

test('promoteTextUrlsToAttachments: plain web URL falls back to kind=link with empty mimeType', () => {
  const [a] = promoteTextUrlsToAttachments('https://example.com/page', []);
  assert.equal(a.kind, 'link');
  assert.equal(a.mimeType, '');
});

test('promoteTextUrlsToAttachments: bare URL passed alone (composer Link path) returns one attachment', () => {
  // Sanity: the manual-link composer path passes a bare URL string (no prose),
  // so URL_PATTERN must match it and emit exactly one promoted attachment.
  const result = promoteTextUrlsToAttachments('https://example.com/song.flac', []);
  assert.equal(result.length, 1);
  assert.equal(result[0].kind, 'audio');
});
