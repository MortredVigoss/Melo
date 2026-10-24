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
  editImageViaCodex,
  editAndSaveImageViaCodex,
  buildEditPromptText,
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
    assert.equal(body.model, 'gpt-6.1-sol');
    assert.equal(body.stream, true);
    assert.deepEqual(body.tools, [{ type: 'image_generation' }]);
    assert.ok(body.input[0].content[0].text.includes('\nUser request (verbatim):\na tabby cat\n'));
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
  assert.equal(result.model, 'gpt-6.1-sol');
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

// ─── Edit pipeline (two-stage: vision analysis → image_generation) ──────────
//
// Why these tests exist
// ---------------------
// The chat 流 + native image_generation route is fine for "draw a fresh
// cat" but produces visibly worse edits ("change 5.5 to gpt in this
// screenshot") than ChatGPT's image editor. User audit 2026-04-30 lists
// two causes within our control: huge agent system prompt drowning the
// edit instruction; and no explicit "preserve list" forcing the model
// to lock unedited regions. editImageViaCodex addresses both via a
// dedicated minimal-prompt pipeline that runs vision analysis first
// (frozen reference) and then a tightly-scoped image_generation call.

function imageHeader(mime = 'image/png') {
  // Match magic for the chosen mime so detectImageMimeFromBytes accepts
  // the result on the way back out of stage 2.
  if (mime === 'image/jpeg') return Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0, 0, 0, 0]);
  if (mime === 'image/webp') {
    return Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
  }
  if (mime === 'image/gif') return Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0]);
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
}

function fakeImageBytes(sizeBytes = 4096, mime = 'image/png') {
  const header = imageHeader(mime);
  return Buffer.concat([header, Buffer.alloc(Math.max(0, sizeBytes - header.length), 0)]);
}

// ─── buildEditPromptText (pure helper) ───────────────────────────────────────

test('buildEditPromptText carries the user prompt and explicit preserve scaffold', () => {
  const text = buildEditPromptText({ userPrompt: '把里面的 5.5 改成 gpt' });
  // The scaffold is the same every time — that is the point of having
  // a frozen template instead of a free-form prompt.
  assert.match(text, /^Edit the uploaded image\./);
  assert.match(text, /Preserve all other attributes/);
  assert.match(text, /把里面的 5\.5 改成 gpt/);
  assert.match(text, /Use the uploaded image as the primary reference\.$/);
  // Without an editSpec, the "Reference" block is omitted entirely so
  // the prompt stays terse.
  assert.doesNotMatch(text, /Reference \(from analysis/);
});

test('buildEditPromptText embeds the editSpec when stage 1 produced one', () => {
  const editSpec = [
    'Subject: orange tabby cat closeup',
    'Composition: top-down, centered',
    'Style: photo',
    'Preserve: fur color, eye highlights, paw position',
  ].join('\n');
  const text = buildEditPromptText({
    userPrompt: 'add sunglasses',
    editSpec,
  });
  assert.match(text, /Reference \(from analysis/);
  assert.match(text, /Subject: orange tabby cat closeup/);
  assert.match(text, /Preserve: fur color, eye highlights, paw position/);
  assert.match(text, /add sunglasses/);
});

test('buildEditPromptText rejects missing requirements instead of generating an empty edit', () => {
  assert.throws(() => buildEditPromptText(), /具体要求/);
});

// ─── editImageViaCodex (two-stage live request shape) ───────────────────────

test('editImageViaCodex sends stage 1 (no tools) THEN stage 2 (image_generation tool) with same input_image', async () => {
  // Captures every fetch call so we can assert the request matrix:
  //   call 1: vision analysis — instructions mention "extract a short
  //           structured reference"; NO `tools` key (pure text); input
  //           contains the user's edit prompt embedded for context AND
  //           the same input_image as call 2.
  //   call 2: image edit — instructions explicitly forbid file paths;
  //           tools = [{type:'image_generation'}]; tool_choice='auto';
  //           input has buildEditPromptText output as input_text AND
  //           the same input_image (so model has the bytes to edit).
  const calls = [];

  const stage1Reply = mockResponseFromEvents([
    sseEvent({ type: 'response.output_text.delta', delta: 'Subject: cat' }),
    sseEvent({ type: 'response.output_text.delta', delta: '\nComposition: closeup' }),
    sseEvent({
      type: 'response.completed',
      response: {
        output: [
          {
            type: 'message',
            content: [
              {
                text: 'Subject: cat\nComposition: closeup\nStyle: photo\nPreserve: fur color, eye color',
              },
            ],
          },
        ],
      },
    }),
  ]);

  const stage2Bytes = fakeImageBytes(4096);
  const stage2Base64 = stage2Bytes.toString('base64');
  const stage2Reply = mockResponseFromEvents([
    sseEvent({
      type: 'response.output_item.done',
      item: { type: 'image_generation_call', status: 'completed', result: stage2Base64 },
    }),
  ]);

  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return calls.length === 1 ? stage1Reply : stage2Reply;
  };

  const sourceBytes = fakeImageBytes(2048);
  const result = await editImageViaCodex({
    prompt: '把里面的 5.5 改成 gpt',
    sourceImageBytes: sourceBytes,
    sourceImageMime: 'image/png',
    fetchImpl,
    credentialProvider: async () => loggedInCredential(),
  });

  // Two HTTP calls — one per stage.
  assert.equal(calls.length, 2, 'two-stage pipeline must POST exactly twice');

  // Stage 1: vision analysis. No tools, instructions ask for the
  // structured reference, image is attached so model can see it.
  const stage1 = calls[0].body;
  assert.equal(
    stage1.tools,
    undefined,
    'stage 1 must NOT carry tools (vision-only, pure text reply)',
  );
  assert.match(stage1.instructions, /structured reference/);
  const stage1User = stage1.input.find(i => i.role === 'user');
  const stage1Kinds = stage1User.content.map(p => p.type);
  assert.ok(
    stage1Kinds.includes('input_image'),
    'stage 1 must include the source image (vision analysis needs to see it)',
  );
  assert.ok(stage1Kinds.includes('input_text'));

  // Stage 2: image edit. Tools = [image_generation], tool_choice=auto.
  const stage2 = calls[1].body;
  assert.deepEqual(
    stage2.tools,
    [{ type: 'image_generation' }],
    'stage 2 must use the bare image_generation tool — Codex rejects every variant we tried',
  );
  assert.equal(stage2.tool_choice, 'auto');
  assert.match(stage2.instructions, /image editor/);
  assert.match(stage2.instructions, /Do not redraw unrelated parts|do not redraw|preserve/i);
  assert.match(stage2.instructions, /DO NOT ask for a file path/i);

  // Stage 2 input must contain the buildEditPromptText scaffold (with
  // stage 1's spec embedded) AND the same input_image as stage 1.
  const stage2User = stage2.input.find(i => i.role === 'user');
  const stage2InputText = stage2User.content.find(p => p.type === 'input_text')?.text;
  assert.match(stage2InputText, /Edit the uploaded image\./);
  assert.match(stage2InputText, /Reference \(from analysis/);
  assert.match(stage2InputText, /Preserve: fur color, eye color/);
  assert.match(stage2InputText, /把里面的 5\.5 改成 gpt/);
  const stage2Image = stage2User.content.find(p => p.type === 'input_image');
  assert.ok(stage2Image, 'stage 2 must re-attach the source image as input_image');
  assert.match(stage2Image.image_url, /^data:image\/png;base64,/);

  // Both stages share the same session_id (set by the credential header
  // builder via a per-call sessionId — assert via the data URI matching).
  const stage1Image = stage1User.content.find(p => p.type === 'input_image');
  assert.equal(
    stage1Image.image_url,
    stage2Image.image_url,
    'both stages must reference the SAME source image (else stage 1 spec is for a different image than stage 2 edits)',
  );

  // Result returns bytes + the spec stage 1 produced.
  assert.equal(result.buffer.length, stage2Bytes.length);
  assert.equal(result.mimeType, 'image/png');
  assert.match(result.editSpec, /Subject: cat/);
});

test('editImageViaCodex skipVisionAnalysis=true skips stage 1 and goes straight to image edit', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const stage2Reply = mockResponseFromEvents([
      sseEvent({
        type: 'response.output_item.done',
        item: {
          type: 'image_generation_call',
          status: 'completed',
          result: fakeImageBytes(4096).toString('base64'),
        },
      }),
    ]);
    return stage2Reply;
  };

  const result = await editImageViaCodex({
    prompt: 'add a hat',
    sourceImageBytes: fakeImageBytes(2048),
    sourceImageMime: 'image/png',
    skipVisionAnalysis: true,
    fetchImpl,
    credentialProvider: async () => loggedInCredential(),
  });

  assert.equal(calls.length, 1, 'skipVisionAnalysis must drop stage 1 entirely');
  // Stage 2 still has the user prompt; just no Reference block.
  assert.deepEqual(calls[0].body.tools, [{ type: 'image_generation' }]);
  const userText = calls[0].body.input[0].content.find(p => p.type === 'input_text').text;
  assert.match(userText, /Edit the uploaded image\./);
  assert.doesNotMatch(userText, /Reference \(from analysis/);
  assert.match(userText, /add a hat/);
  assert.equal(result.editSpec, null, 'editSpec must be null when stage 1 is skipped');
});

test('editImageViaCodex falls through stage-1 failure WITHOUT failing the whole edit', async () => {
  // Stage 1 hitting HTTP 500 / network error / timeout must not block
  // stage 2 — we still try to do the edit (with a less-precise prompt
  // since we have no Reference block). Vision analysis is best-effort,
  // not a hard prerequisite. Pinned because the alternative (fail the
  // whole edit on stage 1 hiccup) would degrade reliability for free.
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    if (calls.length === 1) {
      // Stage 1 fails outright.
      return mockResponseFromEvents([], { ok: false, status: 500 });
    }
    // Stage 2 succeeds.
    return mockResponseFromEvents([
      sseEvent({
        type: 'response.output_item.done',
        item: {
          type: 'image_generation_call',
          status: 'completed',
          result: fakeImageBytes(4096).toString('base64'),
        },
      }),
    ]);
  };

  const result = await editImageViaCodex({
    prompt: 'change the colors',
    sourceImageBytes: fakeImageBytes(2048),
    sourceImageMime: 'image/png',
    fetchImpl,
    credentialProvider: async () => loggedInCredential(),
  });

  assert.equal(calls.length, 2, 'stage 1 failure must not skip stage 2');
  assert.ok(result.buffer.length > 0);
  assert.equal(
    result.editSpec,
    null,
    'editSpec must be null when stage 1 failed (we fell through)',
  );
  // Stage 2 prompt has no Reference block since stage 1 produced none.
  const stage2Text = calls[1].body.input[0].content.find(p => p.type === 'input_text').text;
  assert.doesNotMatch(stage2Text, /Reference \(from analysis/);
  assert.match(stage2Text, /change the colors/);
});

test('editImageViaCodex rejects missing / undersized inputs', async () => {
  const fetchImpl = async () => {
    throw new Error('should not reach fetch on bad input');
  };

  // No prompt
  await assert.rejects(
    editImageViaCodex({
      prompt: '',
      sourceImageBytes: fakeImageBytes(2048),
      sourceImageMime: 'image/png',
      fetchImpl,
      credentialProvider: async () => loggedInCredential(),
    }),
    /prompt is required/,
  );

  // No image bytes
  await assert.rejects(
    editImageViaCodex({
      prompt: 'edit',
      sourceImageBytes: null,
      sourceImageMime: 'image/png',
      fetchImpl,
      credentialProvider: async () => loggedInCredential(),
    }),
    /sourceImageBytes/,
  );

  // Image bytes too small (< IMAGE_MIN_BYTES)
  await assert.rejects(
    editImageViaCodex({
      prompt: 'edit',
      sourceImageBytes: Buffer.alloc(64, 0x89),
      sourceImageMime: 'image/png',
      fetchImpl,
      credentialProvider: async () => loggedInCredential(),
    }),
    /sourceImageBytes/,
  );

  // Missing mime
  await assert.rejects(
    editImageViaCodex({
      prompt: 'edit',
      sourceImageBytes: fakeImageBytes(2048),
      sourceImageMime: '',
      fetchImpl,
      credentialProvider: async () => loggedInCredential(),
    }),
    /sourceImageMime is required/,
  );
});

test('editAndSaveImageViaCodex writes the edited image to disk', async () => {
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    const isStage1 = !body.tools;
    if (isStage1) {
      return mockResponseFromEvents([
        sseEvent({
          type: 'response.completed',
          response: {
            output: [
              { type: 'message', content: [{ text: 'Subject: x\nPreserve: a' }] },
            ],
          },
        }),
      ]);
    }
    return mockResponseFromEvents([
      sseEvent({
        type: 'response.output_item.done',
        item: {
          type: 'image_generation_call',
          status: 'completed',
          result: fakeImageBytes(4096).toString('base64'),
        },
      }),
    ]);
  };

  const dir = await mkdtemp(join(tmpdir(), 'melo-edit-test-'));
  try {
    const outputPath = join(dir, 'edited.png');
    const meta = await editAndSaveImageViaCodex({
      outputPath,
      prompt: 'tweak it',
      sourceImageBytes: fakeImageBytes(2048),
      sourceImageMime: 'image/png',
      fetchImpl,
      credentialProvider: async () => loggedInCredential(),
    });
    assert.equal(meta.path, outputPath);
    assert.ok(meta.bytes > 0);
    assert.equal(meta.mimeType, 'image/png');
    assert.match(meta.editSpec, /Subject: x/);

    const onDisk = await readFile(outputPath);
    assert.equal(onDisk.length, meta.bytes);
    assert.deepEqual(
      Array.from(onDisk.subarray(0, 4)),
      [0x89, 0x50, 0x4e, 0x47],
      'on-disk file must start with PNG magic bytes',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('image engine keeps requested language model separate from provider-reported model', async () => {
  const frames=[];
  const result=await generateImageViaCodex({prompt:'one image',model:'gpt-6.1-sol',credentialProvider:async()=>loggedInCredential(),onPreview:(data,index)=>frames.push(index),fetchImpl:async()=>mockResponseFromEvents([
    sseEvent({type:'response.created',response:{model:'gpt-reported'}}),
    sseEvent({type:'response.image_generation_call.partial_image',partial_image_b64:fakePngBase64(2048),partial_image_index:0}),
    sseEvent({type:'response.output_item.done',item:{type:'image_generation_call',result:fakePngBase64(2048),output_format:'png'}}),
  ])});
  assert.equal(result.requestedModel,'gpt-6.1-sol');assert.equal(result.reportedModel,'gpt-reported');assert.deepEqual(frames,[0]);
});

test('generation preserves requirements after 4000 characters and rejects oversized input before a paid request', async () => {
  const tail='EXACT FINAL COPY: Melo 2026 · Do not add a logo';
  const prompt='A detailed visual requirement. '.repeat(200)+tail;
  let sent;let calls=0;
  await generateImageViaCodex({prompt,credentialProvider:async()=>loggedInCredential(),fetchImpl:async(_url,init)=>{
    calls++;sent=JSON.parse(init.body);
    return mockResponseFromEvents([sseEvent({type:'response.output_item.done',item:{type:'image_generation_call',result:fakePngBase64(2048),output_format:'png'}})]);
  }});
  assert.ok(sent.input[0].content[0].text.includes(tail));
  await assert.rejects(generateImageViaCodex({prompt:'x'.repeat(40000),credentialProvider:async()=>loggedInCredential(),fetchImpl:async()=>{calls++;throw new Error('must not send');}}),{code:'IMAGE_PROMPT_TOO_LONG'});
  assert.equal(calls,1);
});

test('editing template lets explicit user changes override preserved reference attributes',()=>{
  const text=buildEditPromptText({userPrompt:'Change the palette to gold and use a wide composition.',editSpec:'Preserve: purple colors, square layout'});
  assert.match(text,/explicit.*(?:override|take precedence)/i);
  assert.doesNotMatch(text,/^Preserve composition, subject identity, face, logo, text layout, colors, camera angle, and proportions\.$/m);
});

test('both edit stages retain late requirements and reference generation does not freeze layout', async()=>{
  const prompt='Detailed requirements. '.repeat(240)+'CHANGE THE COMPOSITION TO A WIDE POSTER';
  const bodies=[];
  const result=await editImageViaCodex({prompt,action:'generate',referenceRoles:['style','subject'],sourceImageBytes:fakeImageBytes(2048),sourceImageMime:'image/png',referenceImages:[{buffer:fakeImageBytes(2048),mimeType:'image/png'}],credentialProvider:async()=>loggedInCredential(),fetchImpl:async(_url,init)=>{
    bodies.push(JSON.parse(init.body));
    return bodies.length===1 ? mockResponseFromEvents([sseEvent({type:'response.completed',response:{output:[{type:'message',content:[{text:'Style: purple. Preserve: square layout'}]}]}})]) : mockResponseFromEvents([sseEvent({type:'response.output_item.done',item:{type:'image_generation_call',result:fakePngBase64(2048),output_format:'png'}})]);
  }});
  assert.equal(bodies.length,2);assert.ok(result.buffer.length>1024);
  for(const body of bodies){const parts=body.input[0].content;assert.ok(parts[0].text.includes(prompt));assert.equal(parts.filter(p=>p.type==='input_image').length,2);assert.match(parts[0].text,/Image 1: visual style/);assert.match(parts[0].text,/Image 2: subject identity/);}
  assert.match(bodies[1].instructions,/create a new image/);
  assert.doesNotMatch(bodies[1].instructions,/Preserve composition/);
});

test('explicit high image quality reaches Codex generation and edit requests', async () => {
  const bodies = [];
  const options = {
    prompt: 'A simple gold circle', quality: 'high',
    credentialProvider: async () => loggedInCredential(),
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return mockResponseFromEvents([sseEvent({type:'response.output_item.done',item:{type:'image_generation_call',result:fakePngBase64(4096),output_format:'png',quality:'high'}})]);
    },
  };
  const generated = await generateImageViaCodex(options);
  const edited = await editImageViaCodex({...options,sourceImageBytes:Buffer.from(fakePngBase64(4096),'base64'),sourceImageMime:'image/png',skipVisionAnalysis:true});
  assert.equal(bodies.length, 2);
  for (const body of bodies) assert.deepEqual(body.tools, [{type:'image_generation',quality:'high'}]);
  assert.equal(generated.reportedQuality, 'high');
  assert.equal(edited.reportedQuality, 'high');
});

test('saving an image preserves lower service quality without upgrading or regenerating it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'melo-image-quality-'));
  let calls = 0;
  const options = {
    prompt: 'A circle', quality: 'high', credentialProvider: async () => loggedInCredential(),
    fetchImpl: async () => { calls++; return mockResponseFromEvents([sseEvent({type:'response.output_item.done',item:{type:'image_generation_call',result:fakePngBase64(4096),output_format:'png',quality:'low'}})]); },
  };
  try {
    const generated = await generateAndSaveImageViaCodex({...options, outputPath:join(dir,'generated.png')});
    const edited = await editAndSaveImageViaCodex({...options, outputPath:join(dir,'edited.png'), sourceImageBytes:Buffer.from(fakePngBase64(4096),'base64'), sourceImageMime:'image/png', skipVisionAnalysis:true});
    for (const result of [generated,edited]) {
      assert.equal(result.requestedQuality,'high'); assert.equal(result.reportedQuality,'low');
      assert.equal((await readFile(result.path)).length,4096);
    }
    assert.equal(calls,2);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('a chosen size is requested; if the service rejects it, one retry at the default size is reported', async () => {
  const base64 = fakePngBase64(4096);
  const sizes = [];
  const success = () => mockResponseFromEvents([
    sseEvent({ type: 'response.output_item.done', item: { type: 'image_generation_call', result: base64, status: 'completed', output_format: 'png' } }),
    sseEvent({ type: 'response.completed', response: { id: 'r' } }),
  ]);
  const accepted = await generateImageViaCodex({ prompt: 'a cat', size: '2560x1440', credentialProvider: async () => loggedInCredential(),
    fetchImpl: async (_url, init) => { sizes.push(JSON.parse(init.body).tools[0].size); return success(); } });
  assert.deepEqual(sizes, ['2560x1440']);
  assert.notEqual(accepted.sizeFallback, true);
  sizes.length = 0;
  const fallback = await generateImageViaCodex({ prompt: 'a cat', size: '3824x2144', credentialProvider: async () => loggedInCredential(),
    fetchImpl: async (_url, init) => {
      const size = JSON.parse(init.body).tools[0].size; sizes.push(size);
      return size ? mockResponseFromEvents([JSON.stringify({ error: { message: 'Invalid size' } })], { ok: false, status: 400 }) : success();
    } });
  assert.deepEqual(sizes, ['3824x2144', undefined], 'exactly one retry, without size');
  assert.equal(fallback.sizeFallback, true);
  // Other failures are not retried.
  let calls = 0;
  await assert.rejects(generateImageViaCodex({ prompt: 'a cat', size: '2560x1440', credentialProvider: async () => loggedInCredential(),
    fetchImpl: async () => { calls++; return mockResponseFromEvents(['{}'], { ok: false, status: 429 }); } }));
  assert.equal(calls, 1);
});
