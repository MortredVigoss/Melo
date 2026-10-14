/**
 * Regressions for MiniMax image-download validation:
 *   - magic-byte sniffer recognizes PNG / JPEG / WebP / GIF
 *   - sniffer rejects HTML, JSON, empty, random noise
 *   - generateImageViaMinimax throws on too-small bodies
 *   - generateImageViaMinimax throws on non-image bodies
 *   - sniffed mime overrides incorrect content-type header
 *
 * We stub `globalThis.fetch` so no real network is hit.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { detectImageMimeFromBytes, generateImageViaMinimax } from './imageGen.js';

test('oversized MiniMax requests are rejected without silently dropping requirements or spending quota', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('must not send'); };
  try {
    await assert.rejects(
      generateImageViaMinimax({ prompt: 'x'.repeat(1501), apiKey: 'test-key' }),
      { code: 'IMAGE_PROMPT_TOO_LONG' },
    );
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── Magic-byte sniffer ─────────────────────────────────────────────────────

function makePngBuffer(payloadSize = 2048) {
  // Valid PNG signature + padding to hit size threshold.
  const header = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  return Buffer.concat([header, Buffer.alloc(payloadSize - header.length, 0)]);
}

function makeJpegBuffer(payloadSize = 2048) {
  const header = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]);
  return Buffer.concat([header, Buffer.alloc(payloadSize - header.length, 0)]);
}

function makeWebpBuffer(payloadSize = 2048) {
  // "RIFF" + 4-byte size + "WEBP"
  const header = Buffer.from([
    0x52, 0x49, 0x46, 0x46, // RIFF
    0x00, 0x00, 0x00, 0x00, // size placeholder
    0x57, 0x45, 0x42, 0x50, // WEBP
  ]);
  return Buffer.concat([header, Buffer.alloc(payloadSize - header.length, 0)]);
}

function makeGifBuffer(payloadSize = 2048) {
  const header = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]); // GIF89a
  return Buffer.concat([header, Buffer.alloc(payloadSize - header.length, 0)]);
}

test('detects PNG', () => {
  assert.equal(detectImageMimeFromBytes(makePngBuffer()), 'image/png');
});

test('detects JPEG', () => {
  assert.equal(detectImageMimeFromBytes(makeJpegBuffer()), 'image/jpeg');
});

test('detects WebP', () => {
  assert.equal(detectImageMimeFromBytes(makeWebpBuffer()), 'image/webp');
});

test('detects GIF', () => {
  assert.equal(detectImageMimeFromBytes(makeGifBuffer()), 'image/gif');
});

test('rejects buffers too short for magic check', () => {
  assert.equal(detectImageMimeFromBytes(Buffer.alloc(4)), null);
  assert.equal(detectImageMimeFromBytes(Buffer.alloc(0)), null);
  assert.equal(detectImageMimeFromBytes(null), null);
});

test('rejects HTML error pages', () => {
  const html = Buffer.from('<!DOCTYPE html><html><body>Error 429</body></html>');
  assert.equal(detectImageMimeFromBytes(html), null);
});

test('rejects JSON error bodies', () => {
  const json = Buffer.from('{"error":"rate limit exceeded","code":429}                ');
  assert.equal(detectImageMimeFromBytes(json), null);
});

test('rejects random noise', () => {
  const noise = Buffer.from('not-an-image-at-all-0123456789abcdef');
  assert.equal(detectImageMimeFromBytes(noise), null);
});

// ─── generateImageViaMinimax validation path ───────────────────────────────

function stubFetch({ apiBody, downloadBody, downloadContentType = 'image/jpeg', downloadOk = true }) {
  return async (url) => {
    if (typeof url === 'string' && url.includes('api.minimaxi.chat')) {
      return {
        ok: true,
        status: 200,
        json: async () => apiBody,
      };
    }
    // The download URL
    return {
      ok: downloadOk,
      status: downloadOk ? 200 : 500,
      headers: {
        get: (k) => (k.toLowerCase() === 'content-type' ? downloadContentType : null),
      },
      arrayBuffer: async () => downloadBody,
    };
  };
}

test('throws when downloaded body is too small', async () => {
  const originalFetch = globalThis.fetch;
  // Use Uint8Array.buffer — it's a dedicated ArrayBuffer, not a Node pool
  // slice, so the resulting Buffer length equals the raw byte count.
  const tinyAB = new Uint8Array([116, 105, 110, 121]).buffer; // "tiny", 4 bytes
  globalThis.fetch = stubFetch({
    apiBody: { data: { image_urls: ['https://cdn.example/tiny.jpg'] }, base_resp: { status_code: 0 } },
    downloadBody: tinyAB,
  });
  try {
    await assert.rejects(
      generateImageViaMinimax({ prompt: 'hi', apiKey: 'test-key' }),
      /too small|Generated image/i,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('throws when downloaded body has wrong magic (HTML)', async () => {
  const originalFetch = globalThis.fetch;
  // Large enough HTML to pass the size check — must still fail magic
  const html = Buffer.from('<!DOCTYPE html><html><body>' + 'x'.repeat(2000) + '</body></html>');
  globalThis.fetch = stubFetch({
    apiBody: { data: { image_urls: ['https://cdn.example/fake.jpg'] }, base_resp: { status_code: 0 } },
    downloadBody: html.buffer.slice(html.byteOffset, html.byteOffset + html.byteLength),
    downloadContentType: 'image/jpeg', // server lies
  });
  try {
    await assert.rejects(
      generateImageViaMinimax({ prompt: 'hi', apiKey: 'test-key' }),
      /magic-byte|image header/i,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('returns buffer with sniffed mime when body is a valid PNG', async () => {
  const originalFetch = globalThis.fetch;
  const pngBuf = makePngBuffer(4096);
  globalThis.fetch = stubFetch({
    apiBody: { data: { image_urls: ['https://cdn.example/ok.png'] }, base_resp: { status_code: 0 } },
    downloadBody: pngBuf.buffer.slice(pngBuf.byteOffset, pngBuf.byteOffset + pngBuf.byteLength),
    downloadContentType: 'application/octet-stream', // server returns wrong ct
  });
  try {
    const result = await generateImageViaMinimax({ prompt: 'hi', apiKey: 'test-key' });
    // Sniffed mime overrides the incorrect header
    assert.equal(result.mimeType, 'image/png');
    assert.ok(result.buffer.length === pngBuf.length);
    assert.equal(result.sourceUrl, 'https://cdn.example/ok.png');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('throws when MiniMax returns status_code != 0', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stubFetch({
    apiBody: { base_resp: { status_code: 1008, status_msg: 'insufficient balance' } },
    downloadBody: Buffer.alloc(0).buffer,
  });
  try {
    await assert.rejects(
      generateImageViaMinimax({ prompt: 'hi', apiKey: 'test-key' }),
      /insufficient balance|status_code/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('throws when MiniMax response has no image_urls', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stubFetch({
    apiBody: { data: {}, base_resp: { status_code: 0 } },
    downloadBody: Buffer.alloc(0).buffer,
  });
  try {
    await assert.rejects(
      generateImageViaMinimax({ prompt: 'hi', apiKey: 'test-key' }),
      /no image_urls/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
