// Tests for the attachment → bytes resolver. Covers both paths:
//   • signed-workspace-URL fast path (decode + readFile from disk)
//   • HTTP fallback with a stubbed fetchImpl
//
// We avoid network, avoid real signing (per-process secret — we only need
// the `p` param shape because decodeSignedWorkspaceUrl does NOT verify the
// HMAC; that's the documented contract), and we use tmpdir() for the
// filesystem fast path.

import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decodeSignedWorkspaceUrl,
  loadAttachmentBytes,
} from './attachmentBytes.js';

function b64urlEncode(str) {
  return Buffer.from(str, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function mintSignedLikeUrl(absPath) {
  // Shape only — HMAC verification is NOT run by decodeSignedWorkspaceUrl.
  return (
    `http://127.0.0.1:12345/api/files/signed/${encodeURIComponent(
      absPath.split('/').pop() || 'file',
    )}` +
    `?p=${b64urlEncode(absPath)}&e=${Date.now() + 600_000}&s=fakesig`
  );
}

test('decodeSignedWorkspaceUrl extracts the absolute path from the `p` param', () => {
  const url = mintSignedLikeUrl('/tmp/melo-abc/generated/img-1700000000.png');
  assert.equal(
    decodeSignedWorkspaceUrl(url),
    '/tmp/melo-abc/generated/img-1700000000.png',
  );
});

test('decodeSignedWorkspaceUrl returns null for non-signed URLs', () => {
  assert.equal(decodeSignedWorkspaceUrl('https://cdn.example/photo.png'), null);
  assert.equal(decodeSignedWorkspaceUrl('http://127.0.0.1/api/other'), null);
  assert.equal(decodeSignedWorkspaceUrl(''), null);
  assert.equal(decodeSignedWorkspaceUrl(null), null);
  assert.equal(decodeSignedWorkspaceUrl('not-a-url'), null);
});

test('decodeSignedWorkspaceUrl rejects non-absolute decoded paths', () => {
  // Someone hand-forges a URL where `p` decodes to a relative path — we
  // must not allow that to become a relative readFile downstream.
  const url =
    'http://127.0.0.1/api/files/signed/x?p=' + b64urlEncode('relative/path.png');
  assert.equal(decodeSignedWorkspaceUrl(url), null);
});

test('decodeSignedWorkspaceUrl returns null when `p` is missing', () => {
  assert.equal(
    decodeSignedWorkspaceUrl('http://127.0.0.1/api/files/signed/x?e=123&s=abc'),
    null,
  );
});

test('loadAttachmentBytes reads directly from disk when URL is a signed workspace URL', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'melo-attach-'));
  const filePath = join(dir, 'pixel.png');
  const body = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG magic
  await writeFile(filePath, body);

  try {
    const attachment = {
      kind: 'image',
      url: mintSignedLikeUrl(filePath),
      mimeType: '',
      fileName: '',
    };
    // Force fetchImpl to a throwing stub so we verify the fast path was taken
    // (no HTTP attempt at all).
    const fetchImpl = async () => {
      throw new Error('fetch should not be called on the signed-URL fast path');
    };

    const result = await loadAttachmentBytes(attachment, { fetchImpl });
    assert.ok(Buffer.isBuffer(result.buffer));
    assert.deepEqual(result.buffer, body);
    assert.equal(result.mimeType, 'image/png');
    assert.equal(result.fileName, 'pixel.png');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadAttachmentBytes falls back to HTTP when the URL is external', async () => {
  const body = Buffer.from([0xff, 0xd8, 0xff, 0xe0]); // JPEG SOI
  const fetchImpl = async url => {
    assert.equal(url, 'https://cdn.example.com/banner.jpg');
    return {
      ok: true,
      status: 200,
      headers: {
        get: key => (key.toLowerCase() === 'content-type' ? 'image/jpeg' : null),
      },
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    };
  };

  const result = await loadAttachmentBytes(
    { kind: 'image', url: 'https://cdn.example.com/banner.jpg' },
    { fetchImpl },
  );
  assert.ok(Buffer.isBuffer(result.buffer));
  assert.deepEqual(Array.from(result.buffer), Array.from(body));
  assert.equal(result.mimeType, 'image/jpeg');
  assert.equal(result.fileName, 'banner.jpg');
});

test('loadAttachmentBytes honours declared mimeType / fileName over sniffing', async () => {
  const body = Buffer.from([0, 1, 2]);
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'image/png' },
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  });

  const result = await loadAttachmentBytes(
    {
      kind: 'image',
      url: 'https://cdn.example.com/opaque',
      mimeType: 'image/webp',
      fileName: 'custom.webp',
    },
    { fetchImpl },
  );
  assert.equal(result.mimeType, 'image/webp');
  assert.equal(result.fileName, 'custom.webp');
});

test('loadAttachmentBytes returns null when the attachment has no URL', async () => {
  assert.equal(await loadAttachmentBytes({ kind: 'image', url: '' }), null);
  assert.equal(await loadAttachmentBytes({}), null);
  assert.equal(await loadAttachmentBytes(null), null);
});

test('loadAttachmentBytes throws when HTTP fetch fails', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 403,
    headers: { get: () => null },
    arrayBuffer: async () => new ArrayBuffer(0),
  });
  await assert.rejects(
    loadAttachmentBytes(
      { kind: 'image', url: 'https://cdn.example.com/forbidden.png' },
      { fetchImpl },
    ),
    /HTTP 403/,
  );
});

test('loadAttachmentBytes falls back to HTTP when the signed URL points to a missing file', async () => {
  const fallbackBody = Buffer.from([0x47, 0x49, 0x46]); // GIF header
  const url = mintSignedLikeUrl('/tmp/melo-does-not-exist-xyz/fake.png');
  const fetchImpl = async u => {
    assert.equal(u, url);
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'image/gif' },
      arrayBuffer: async () =>
        fallbackBody.buffer.slice(
          fallbackBody.byteOffset,
          fallbackBody.byteOffset + fallbackBody.byteLength,
        ),
    };
  };

  const result = await loadAttachmentBytes({ kind: 'image', url }, { fetchImpl });
  assert.equal(result.mimeType, 'image/gif');
  assert.deepEqual(Array.from(result.buffer), Array.from(fallbackBody));
});
