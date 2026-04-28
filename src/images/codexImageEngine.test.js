// Tests for the Codex-OAuth image engine. We don't touch the real Codex
// endpoint in unit tests — every test injects:
//   • a `credentialProvider` stub, so the real getCodexCredential doesn't
//     read ~/.codex/auth.json;
//   • a `fetchImpl` stub that returns a minimal Response-like object whose
//     `body` is a ReadableStream emitting a canned SSE transcript.
//
// The PNG magic (89 50 4E 47 0D 0A 1A 0A) is prepended to each payload so
// the magic-byte sniffer accepts the decoded bytes as `image/png` without
// us having to ship a real image in the test fixture.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateImageViaCodex,
  generateAndSaveImageViaCodex,
  parseSseEventBlock,
} from './codexImageEngine.js';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function fakePngBase64(sizeBytes = 2048) {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const padding = Buffer.alloc(Math.max(0, sizeBytes - header.length), 0);
  return Buffer.concat([header, padding]).toString('base64');
}

function loggedInCredential(overrides = {}) {
  return {
    loggedIn: true,
    expired: false,
    accessToken: 'oauth-tok-xyz',
    accountId: 'acct-123',
    email: 'user@example.com',
    plan: 'plus',
    source: 'codex',
    authPath: '/tmp/auth.json',
    authMode: 'oauth',
    expiresAt: Date.now() + 3600_000,
    ...overrides,
  };
}

// Build a mock Response object that streams the given array of SSE event
// strings. Each string is one complete event BLOCK (no trailing \n\n —
// we add the separator ourselves).
function mockResponseFromEvents(events, { ok = true, status = 200 } = {}) {
  const encoder = new TextEncoder();
  const chunks = events.map(ev => encoder.encode(ev + '\n\n'));
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    body: stream,
    text: async () => events.join('\n\n'),
  };
}

function sseEvent(obj) {
  return `data: ${JSON.stringify(obj)}`;
}

// ─── parseSseEventBlock (exported helper) ────────────────────────────────────

test('parseSseEventBlock joins multi-line data: and ignores comments', () => {
  const block = [
    ': keep-alive',
    'data: {"type":"response.output_item.done",',
    'data:  "item":{"type":"image_generation_call","result":"AAA"}}',
  ].join('\n');
  const parsed = parseSseEventBlock(block);
  assert.equal(parsed.type, 'response.output_item.done');
  assert.equal(parsed.item.result, 'AAA');
});

test('parseSseEventBlock returns null for [DONE] and empty payloads', () => {
  assert.equal(parseSseEventBlock('data: [DONE]'), null);
  assert.equal(parseSseEventBlock(''), null);
  assert.equal(parseSseEventBlock(': just a comment'), null);
});

test('parseSseEventBlock returns null for malformed JSON', () => {
  assert.equal(parseSseEventBlock('data: {not json'), null);
});

// ─── Happy path ──────────────────────────────────────────────────────────────

test('generateImageViaCodex returns decoded bytes when output_item.done carries the image', async () => {
  const base64 = fakePngBase64(4096);
  const fetchImpl = async (url, init) => {
    assert.equal(url, 'https://chatgpt.com/backend-api/codex/responses');
    assert.equal(init.method, 'POST');
    // Verify the tool + model shape in the body.
    const body = JSON.parse(init.body);
    assert.equal(body.model, 'gpt-5.5');
    assert.equal(body.stream, true);
    assert.deepEqual(body.tools, [{ type: 'image_generation' }]);
    assert.equal(body.input[0].content[0].text, 'a tabby cat');
    // Header sanity.
    assert.equal(init.headers.authorization, 'Bearer oauth-tok-xyz');
    assert.equal(init.headers['chatgpt-account-id'], 'acct-123');
    assert.equal(init.headers['openai-beta'], 'responses=experimental');

    return mockResponseFromEvents([
      sseEvent({ type: 'response.created', response: { id: 'r1' } }),
      sseEvent({
        type: 'response.output_item.done',
        item: {
          type: 'image_generation_call',
          id: 'ig1',
          result: base64,
          status: 'completed',
          output_format: 'png',
        },
      }),
      sseEvent({ type: 'response.completed', response: { id: 'r1' } }),
    ]);
  };

  const result = await generateImageViaCodex({
    prompt: 'a tabby cat',
    fetchImpl,
    credentialProvider: async () => loggedInCredential(),
  });
  assert.ok(Buffer.isBuffer(result.buffer));
  assert.equal(result.mimeType, 'image/png');
  assert.equal(result.model, 'gpt-5.5');
  assert.ok(result.buffer.length >= 4096);
});

test('generateImageViaCodex falls back to response.completed.output when streaming .done was missed', async () => {
  const base64 = fakePngBase64(2048);
  const fetchImpl = async () =>
    mockResponseFromEvents([
      sseEvent({
        type: 'response.completed',
        response: {
          output: [
            { type: 'reasoning', content: [] },
            {
              type: 'image_generation_call',
              result: base64,
              status: 'completed',
              output_format: 'png',
            },
          ],
        },
      }),
    ]);

  const result = await generateImageViaCodex({
    prompt: 'fallback path',
    fetchImpl,
    credentialProvider: async () => loggedInCredential(),
  });
  assert.equal(result.mimeType, 'image/png');
  assert.ok(result.buffer.length >= 2048);
});

// Regression for the HTTP 400 `{"detail":"Instructions are required"}` that
// the live /codex/responses endpoint returns for requests missing the
// `instructions` field. The instruction also serves as a guardrail against
// the model bailing to "here's an SVG, save it yourself" behavior.
test('generateImageViaCodex sends a non-empty instructions field that forbids SVG/text fallbacks', async () => {
  let capturedBody = null;
  const fetchImpl = async (_url, init) => {
    capturedBody = JSON.parse(init.body);
    return mockResponseFromEvents([
      sseEvent({
        type: 'response.output_item.done',
        item: { type: 'image_generation_call', result: fakePngBase64(2048), output_format: 'png' },
      }),
    ]);
  };
  await generateImageViaCodex({
    prompt: 'anything',
    fetchImpl,
    credentialProvider: async () => loggedInCredential(),
  });
  assert.equal(typeof capturedBody.instructions, 'string');
  assert.ok(capturedBody.instructions.length > 0, 'instructions must be non-empty');
  // Guardrails we rely on — tighten if the text is ever rewritten.
  assert.match(capturedBody.instructions, /image_generation/);
  assert.match(capturedBody.instructions, /svg/i);
});

test('generateImageViaCodex forwards background/input_fidelity into tool config', async () => {
  let capturedBody = null;
  const fetchImpl = async (_url, init) => {
    capturedBody = JSON.parse(init.body);
    return mockResponseFromEvents([
      sseEvent({
        type: 'response.output_item.done',
        item: { type: 'image_generation_call', result: fakePngBase64(2048), output_format: 'png' },
      }),
    ]);
  };
  await generateImageViaCodex({
    prompt: 'transparent logo',
    background: 'transparent',
    inputFidelity: 'high',
    model: 'gpt-5-codex',
    fetchImpl,
    credentialProvider: async () => loggedInCredential(),
  });
  assert.equal(capturedBody.model, 'gpt-5-codex');
  assert.deepEqual(capturedBody.tools, [
    { type: 'image_generation', background: 'transparent', input_fidelity: 'high' },
  ]);
});

// ─── Credential-gating ───────────────────────────────────────────────────────

test('generateImageViaCodex throws NOT_CONFIGURED when not logged in', async () => {
  const fetchImpl = async () => {
    throw new Error('fetch should not be called');
  };
  await assert.rejects(
    generateImageViaCodex({
      prompt: 'x',
      fetchImpl,
      credentialProvider: async () => ({ loggedIn: false, expired: false }),
    }),
    err => err.code === 'NOT_CONFIGURED' && /not available/i.test(err.message),
  );
});

test('generateImageViaCodex throws NOT_CONFIGURED when credential is expired', async () => {
  await assert.rejects(
    generateImageViaCodex({
      prompt: 'x',
      fetchImpl: async () => { throw new Error('fetch should not be called'); },
      credentialProvider: async () => ({ loggedIn: false, expired: true }),
    }),
    err => err.code === 'NOT_CONFIGURED' && /expired/i.test(err.message),
  );
});

test('generateImageViaCodex throws NOT_CONFIGURED when accountId is missing', async () => {
  await assert.rejects(
    generateImageViaCodex({
      prompt: 'x',
      fetchImpl: async () => { throw new Error('fetch should not be called'); },
      credentialProvider: async () => loggedInCredential({ accountId: null }),
    }),
    err => err.code === 'NOT_CONFIGURED' && /account id/i.test(err.message),
  );
});

// ─── Error paths ─────────────────────────────────────────────────────────────

test('generateImageViaCodex surfaces HTTP errors with status codes', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 401,
    statusText: 'Unauthorized',
    body: null,
    text: async () => JSON.stringify({ error: { message: 'bad token' } }),
  });
  await assert.rejects(
    generateImageViaCodex({
      prompt: 'x',
      fetchImpl,
      credentialProvider: async () => loggedInCredential(),
    }),
    err => err.code === 'NOT_CONFIGURED' && /bad token/i.test(err.message),
  );
});

test('generateImageViaCodex maps HTTP 429/500 to GENERATE_FAILED (auto fallback)', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 429,
    statusText: 'Too Many Requests',
    body: null,
    text: async () => 'rate limited',
  });
  await assert.rejects(
    generateImageViaCodex({
      prompt: 'x',
      fetchImpl,
      credentialProvider: async () => loggedInCredential(),
    }),
    err => err.code === 'GENERATE_FAILED',
  );
});

test('generateImageViaCodex throws on response.failed SSE event', async () => {
  const fetchImpl = async () =>
    mockResponseFromEvents([
      sseEvent({
        type: 'response.failed',
        response: { error: { message: 'content moderation blocked prompt' } },
      }),
    ]);
  await assert.rejects(
    generateImageViaCodex({
      prompt: 'x',
      fetchImpl,
      credentialProvider: async () => loggedInCredential(),
    }),
    err => err.code === 'GENERATE_FAILED' && /moderation/.test(err.message),
  );
});

test('generateImageViaCodex rejects when buffer is below the plausibility floor', async () => {
  // 8 byte PNG magic + nothing else → below 1024-byte floor.
  const tinyBase64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64');
  const fetchImpl = async () =>
    mockResponseFromEvents([
      sseEvent({
        type: 'response.output_item.done',
        item: { type: 'image_generation_call', result: tinyBase64, output_format: 'png' },
      }),
    ]);
  await assert.rejects(
    generateImageViaCodex({
      prompt: 'x',
      fetchImpl,
      credentialProvider: async () => loggedInCredential(),
    }),
    /suspiciously small/,
  );
});

test('generateImageViaCodex rejects when decoded bytes fail magic-byte check', async () => {
  const nonImage = Buffer.alloc(2048, 0x42).toString('base64'); // 2KB of 'B' — not any known header
  const fetchImpl = async () =>
    mockResponseFromEvents([
      sseEvent({
        type: 'response.output_item.done',
        item: { type: 'image_generation_call', result: nonImage, output_format: 'xyz' },
      }),
    ]);
  await assert.rejects(
    generateImageViaCodex({
      prompt: 'x',
      fetchImpl,
      credentialProvider: async () => loggedInCredential(),
    }),
    /magic-byte check/,
  );
});

test('generateImageViaCodex rejects when the stream ends without an image item', async () => {
  const fetchImpl = async () =>
    mockResponseFromEvents([
      sseEvent({ type: 'response.created', response: {} }),
      sseEvent({ type: 'response.completed', response: { output: [] } }),
    ]);
  await assert.rejects(
    generateImageViaCodex({
      prompt: 'x',
      fetchImpl,
      credentialProvider: async () => loggedInCredential(),
    }),
    /without an image_generation_call result/,
  );
});

test('generateImageViaCodex strips data: URI prefix if present', async () => {
  const base64 = fakePngBase64(2048);
  const fetchImpl = async () =>
    mockResponseFromEvents([
      sseEvent({
        type: 'response.output_item.done',
        item: {
          type: 'image_generation_call',
          result: `data:image/png;base64,${base64}`,
          output_format: 'png',
        },
      }),
    ]);
  const result = await generateImageViaCodex({
    prompt: 'x',
    fetchImpl,
    credentialProvider: async () => loggedInCredential(),
  });
  assert.equal(result.mimeType, 'image/png');
});

// ─── generateAndSaveImageViaCodex (disk-write convenience) ───────────────────

test('generateAndSaveImageViaCodex writes the buffer to disk and returns the path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'melo-codex-img-'));
  const outputPath = join(dir, 'out.png');

  try {
    const base64 = fakePngBase64(4096);
    const fetchImpl = async () =>
      mockResponseFromEvents([
        sseEvent({
          type: 'response.output_item.done',
          item: { type: 'image_generation_call', result: base64, output_format: 'png' },
        }),
      ]);

    const result = await generateAndSaveImageViaCodex({
      prompt: 'save to disk',
      outputPath,
      fetchImpl,
      credentialProvider: async () => loggedInCredential(),
    });

    assert.equal(result.path, outputPath);
    assert.equal(result.mimeType, 'image/png');
    assert.ok(result.bytes >= 4096);

    const onDisk = await readFile(outputPath);
    assert.equal(onDisk.length, result.bytes);
    // PNG header intact after decode + write.
    assert.deepEqual(
      Array.from(onDisk.slice(0, 8)),
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('generateAndSaveImageViaCodex requires an outputPath', async () => {
  await assert.rejects(
    generateAndSaveImageViaCodex({
      prompt: 'x',
      credentialProvider: async () => loggedInCredential(),
      fetchImpl: async () => { throw new Error('should not fetch'); },
    }),
    /outputPath required/,
  );
});

// ─── Input validation ───────────────────────────────────────────────────────

test('generateImageViaCodex requires a non-empty prompt', async () => {
  await assert.rejects(
    generateImageViaCodex({
      prompt: '',
      credentialProvider: async () => loggedInCredential(),
      fetchImpl: async () => { throw new Error('should not fetch'); },
    }),
    /prompt is required/,
  );
  await assert.rejects(
    generateImageViaCodex({
      prompt: '   ',
      credentialProvider: async () => loggedInCredential(),
      fetchImpl: async () => { throw new Error('should not fetch'); },
    }),
    /prompt is required/,
  );
});
