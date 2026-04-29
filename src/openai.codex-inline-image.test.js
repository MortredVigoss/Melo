// Inline-image generation through the Codex chat stream.
//
// Why these tests exist
// ---------------------
// readCodexSseResponse used to handle only text + reasoning deltas. When
// we wired the built-in `image_generation` tool into the chat stream
// (so a Codex OAuth user can ask "draw a cat" mid-conversation and get
// the image inlined), we added two pieces:
//
//   1. saveCodexInlineImageItem — base64 → workspace file → signed URL
//   2. readCodexSseResponse `response.output_item.done` branch that
//      decodes the result, calls the supplied onInlineImage callback
//      and appends the returned markdown snippet into the streamed text
//      (so downstream URL-→-attachment promotion picks it up as an
//       image attachment on the assistantMessage)
//
// Failure modes pinned by these tests
// -----------------------------------
//   • Image markdown silently dropped — `extractResponsesText` would
//     prefer the terminal `response.completed` payload (which doesn't
//     contain our client-side markdown) over `deltaText`. Loss of every
//     generated image. Pinned by `streams an image_generation_call …`.
//   • Sub-1KiB / non-image base64 leaking through — we'd write a corrupt
//     file and hand the user a broken image link. Pinned by `tiny buffer
//     is rejected` and `non-image bytes are rejected`.
//   • Duplicate image when both `output_item.done` and `response.completed`
//     carry the same call. Pinned by `duplicate image_generation_call …`.
//   • Save failure should not crash the chat reply; the prose still
//     streams. Pinned by `save failure leaves text reply intact`.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readCodexSseResponse,
  saveCodexInlineImageItem,
  buildCodexResponsesTools,
  messagesHaveInputImages,
  createCodexResponsesReply,
} from './openai.js';

// PNG magic so the magic-byte sniffer accepts the buffer as image/png.
function fakePngBase64(sizeBytes = 2048) {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const padding = Buffer.alloc(Math.max(0, sizeBytes - header.length), 0);
  return Buffer.concat([header, padding]).toString('base64');
}

function mockResponseFromEvents(events) {
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const event of events) {
        controller.enqueue(encoder.encode(`${event}\n\n`));
      }
      controller.close();
    },
  });
  return { body: stream };
}

function sseTextDelta(text) {
  return `event: response.output_text.delta\ndata: ${JSON.stringify({
    type: 'response.output_text.delta',
    delta: text,
  })}`;
}

function sseImageItemDone({ id = 'igc_1', result, output_format = 'png' }) {
  return `event: response.output_item.done\ndata: ${JSON.stringify({
    type: 'response.output_item.done',
    item: {
      id,
      type: 'image_generation_call',
      status: 'completed',
      result,
      output_format,
    },
  })}`;
}

function sseCompleted(response = null) {
  return `event: response.completed\ndata: ${JSON.stringify({
    type: 'response.completed',
    response,
  })}`;
}

// ─── buildCodexResponsesTools (payload gating) ──────────────────────────────
//
// These pin the rule the user explicitly endorsed on 2026-04-29: Codex
// inline image generation is enabled in EVERY chat / agent / sub-agent
// path that has a usable workspace. The single gate is `workspacePath`.
// We deliberately do NOT add an additional `allowedTools` / agent-profile
// gate here — Codex Plus's image_generation is treated as a free
// server-side capability (parallel to web_search), not a melo tool.
// If a future provider invalidates that assumption the gate moves into
// THIS helper, not into the caller chain.

test('buildCodexResponsesTools — no workspace, no web search → empty tool list', () => {
  const tools = buildCodexResponsesTools({ enableWebSearch: false, workspacePath: null });
  assert.deepEqual(tools, []);
});

test('buildCodexResponsesTools — workspacePath alone enables image_generation only', () => {
  const tools = buildCodexResponsesTools({
    enableWebSearch: false,
    workspacePath: '/tmp/some/workspace',
  });
  assert.equal(tools.length, 1);
  assert.equal(tools[0].type, 'image_generation');
});

test('buildCodexResponsesTools — web search alone enables web_search only', () => {
  const tools = buildCodexResponsesTools({
    enableWebSearch: true,
    workspacePath: null,
  });
  assert.equal(tools.length, 1);
  assert.equal(tools[0].type, 'web_search');
});

test('buildCodexResponsesTools — both flags emits both tools in stable order (web_search first)', () => {
  const tools = buildCodexResponsesTools({
    enableWebSearch: true,
    workspacePath: '/tmp/melo/chat-workspace',
  });
  assert.deepEqual(
    tools.map(t => t.type),
    ['web_search', 'image_generation'],
  );
});

test('buildCodexResponsesTools — non-absolute workspacePath does NOT enable image_generation', () => {
  // Defence in depth: a relative path would land somewhere unexpected
  // inside the running process's cwd. signWorkspaceFileUrl also rejects
  // non-absolute paths, so this is also an upstream consistency check.
  for (const bogus of ['relative/dir', '', null, undefined, 42, {}, ['/tmp/x']]) {
    const tools = buildCodexResponsesTools({
      enableWebSearch: false,
      workspacePath: bogus,
    });
    assert.deepEqual(
      tools,
      [],
      `bogus workspacePath ${JSON.stringify(bogus)} should not enable image_generation`,
    );
  }
});

test('buildCodexResponsesTools — hasInputImage + workspace flips image_generation to edit mode (input_fidelity: high)', () => {
  // User-visible feature: "edit this screenshot" only works when the
  // image_generation tool runs in high-fidelity edit mode. Without it
  // Codex re-paints from scratch and a request like "change 5.5 to gpt"
  // returns a totally different image. Pinned 2026-04-30 after the
  // user reported the desktop+Telegram failure mode.
  const tools = buildCodexResponsesTools({
    enableWebSearch: false,
    workspacePath: '/tmp/some/workspace',
    hasInputImage: true,
  });
  assert.equal(tools.length, 1);
  assert.equal(tools[0].type, 'image_generation');
  assert.equal(
    tools[0].input_fidelity,
    'high',
    'edit-mode requires input_fidelity: "high" so original details survive',
  );
});

test('buildCodexResponsesTools — pure text-to-image (no input image) keeps minimal tool config', () => {
  // Negative case: when there is NO input image we MUST NOT set
  // input_fidelity (it costs more and biases tool behaviour). The
  // round-1 minimal config stays the default for pure generation.
  const tools = buildCodexResponsesTools({
    enableWebSearch: false,
    workspacePath: '/tmp/some/workspace',
    hasInputImage: false,
  });
  assert.equal(tools.length, 1);
  assert.equal(tools[0].type, 'image_generation');
  assert.equal(
    tools[0].input_fidelity,
    undefined,
    'pure generation must NOT carry input_fidelity',
  );
});

test('buildCodexResponsesTools — hasInputImage without workspace stays empty (no inline image possible)', () => {
  // Edit mode still requires somewhere to write the result. No workspace
  // → no image_generation tool at all, regardless of input image.
  const tools = buildCodexResponsesTools({
    enableWebSearch: false,
    workspacePath: null,
    hasInputImage: true,
  });
  assert.deepEqual(tools, []);
});

test('buildCodexResponsesTools — defaults: zero-arg call yields empty tool list', () => {
  // Anyone refactoring createCodexResponsesReply could call this without
  // args to clear the tool slot — make sure that stays a no-op.
  assert.deepEqual(buildCodexResponsesTools(), []);
  assert.deepEqual(buildCodexResponsesTools({}), []);
});

// ─── createCodexResponsesReply payload integration ──────────────────────────
//
// Codex review (2026-04-30 round 4) flagged: helper-only tests can't
// catch wiring regressions in the real call site (forgetting to pass
// hasInputImage / model override / instructions append, etc). These
// tests build a minimal stub credential + fetch and assert the actual
// body posted to /codex/responses across the three scenarios the user's
// design contract cares about.

function loggedInCredentialStub() {
  return {
    loggedIn: true,
    expired: false,
    accessToken: 'oauth-tok-abc',
    accountId: 'acct-test',
    email: 'user@example.com',
    plan: 'plus',
    source: 'codex',
    authPath: '/tmp/auth.json',
    authMode: 'oauth',
    expiresAt: Date.now() + 3600_000,
  };
}

// Builds a minimal Response-shaped object whose body is an empty SSE
// stream that just terminates with response.completed. createCodex...
// will read this, see no events, and resolve to either deltaText or
// the canonical text — we don't care which because the assertions are
// on the REQUEST body, not the response.
function emptyCompletedResponse() {
  const block = `event: response.completed\ndata: ${JSON.stringify({
    type: 'response.completed',
    response: {
      output: [{ type: 'message', content: [{ text: 'ok' }] }],
    },
  })}\n\n`;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(block));
      controller.close();
    },
  });
  return { ok: true, status: 200, body: stream };
}

async function captureCodexRequestPayload(callOpts) {
  let captured = null;
  await createCodexResponsesReply({
    baseUrl: 'https://chatgpt.com/backend-api',
    model: 'gpt-4.1', // intentionally different from gpt-5.5 to test override
    systemPrompt: 'You are a helpful assistant.',
    messages: [],
    ...callOpts,
    _credentialProvider: async () => loggedInCredentialStub(),
    _fetchImpl: async (url, init) => {
      captured = { url, body: JSON.parse(init.body), headers: init.headers };
      return emptyCompletedResponse();
    },
  });
  return captured;
}

test('payload — edit-mode (workspace + input image): high fidelity tool, edit instructions, caller model preserved', async () => {
  const captured = await captureCodexRequestPayload({
    workspacePath: '/tmp/some/workspace',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: '把这张图里的 5.5 改成 gpt' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBOR' } },
        ],
      },
    ],
  });

  assert.ok(captured, 'fetch must have been invoked');
  // Tool config: image_generation present, in EDIT mode
  const imageTool = captured.body.tools?.find(t => t.type === 'image_generation');
  assert.ok(imageTool, 'tools must include image_generation');
  assert.equal(imageTool.input_fidelity, 'high', 'edit mode requires input_fidelity=high');
  // tool_choice must allow the model to invoke image_generation
  assert.equal(captured.body.tool_choice, 'auto');
  // Instructions: contain the edit-mode block
  assert.match(
    captured.body.instructions,
    /INLINE IMAGE EDITING/,
    'edit-mode instructions must be appended when input image present',
  );
  assert.match(
    captured.body.instructions,
    /DO NOT ask the user for a file path/,
    'anti-file-path clause must be appended',
  );
  // Caller's model is preserved — the round-4 force-override to gpt-5.5
  // was reverted (user 2026-04-30): too wide a hammer that swapped models
  // even for pure-text turns. Whatever the caller picked stays.
  assert.equal(
    captured.body.model,
    'gpt-4.1',
    'caller-supplied model (gpt-4.1) must NOT be silently overridden',
  );
  // input flows the user's prompt + the uploaded image as input_image
  // — the image-edit tool chain the user described in the design audit:
  //   user upload → backend reads → input_image part → input_text edit prompt
  //   → image_generation tool with input_fidelity:high → tool returns base64.
  const userTurn = captured.body.input.find(i => i.role === 'user');
  assert.ok(userTurn, 'input must contain a user-role entry');
  const partKinds = userTurn.content.map(p => p.type);
  assert.ok(
    partKinds.includes('input_text'),
    `user content must include input_text part (got ${JSON.stringify(partKinds)})`,
  );
  assert.ok(
    partKinds.includes('input_image'),
    `user content must include input_image part (got ${JSON.stringify(partKinds)})`,
  );
  // input_image must carry the actual image data, not a placeholder
  const imagePart = userTurn.content.find(p => p.type === 'input_image');
  assert.match(
    imagePart.image_url,
    /^data:image\//,
    'input_image must inline the user upload as a data: URI',
  );
});

test('payload — pure text-to-image (workspace + no input image): minimal tool, no edit instructions, caller model preserved', async () => {
  const captured = await captureCodexRequestPayload({
    workspacePath: '/tmp/some/workspace',
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: '画一只橘猫' }],
      },
    ],
  });

  const imageTool = captured.body.tools?.find(t => t.type === 'image_generation');
  assert.ok(imageTool, 'tools must include image_generation (workspace present)');
  assert.equal(
    imageTool.input_fidelity,
    undefined,
    'pure generate must NOT carry input_fidelity (cost + behaviour bias)',
  );
  // Instructions: edit block must NOT be appended for pure-generate
  assert.doesNotMatch(
    captured.body.instructions,
    /INLINE IMAGE EDITING/,
    'edit instructions must not appear when no input image',
  );
  // Caller's model is preserved — pure text-to-image still runs on
  // whatever the user picked. Codex catalog (gpt-5.5/5.4/4.1) is all
  // image-capable, so this is safe; gpt-5-codex-mini will get the
  // model's own "I can't draw" response, which is correct UX.
  assert.equal(captured.body.model, 'gpt-4.1');
});

test('payload — plain text Q&A (workspace + no image, no draw intent): caller model preserved, no edit instructions', async () => {
  // Codex review (2026-04-30 round 4) flagged this exact case: a plain
  // "今天天气如何" type message under Codex+workspace MUST NOT have its
  // model silently swapped or its instructions polluted with image
  // edit guidance. The previous force-override broke this contract;
  // the revert restores it. Pinned so a future "smart" gate can't
  // re-introduce the silent swap.
  const captured = await captureCodexRequestPayload({
    workspacePath: '/tmp/some/workspace',
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: '今天天气怎么样？' }],
      },
    ],
  });

  assert.equal(
    captured.body.model,
    'gpt-4.1',
    'plain text turn must keep the caller-chosen model verbatim',
  );
  assert.doesNotMatch(
    captured.body.instructions,
    /INLINE IMAGE EDITING/,
    'plain text turn must not carry image-edit instructions',
  );
});

test('payload — no workspace + input image: no image_generation tool, no edit instructions, caller model preserved', async () => {
  // Edge case: a chat without a workspace (e.g. background polling
  // without bound chat workspace) cannot host inline image generation
  // even if the user uploaded a reference. The whole image path must
  // disable, AND the caller's model selection must be preserved (we
  // don't override gpt-5.5 here because we wouldn't actually generate
  // images anyway).
  const captured = await captureCodexRequestPayload({
    workspacePath: null,
    model: 'gpt-4.1',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: '看一下这张图' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBOR' } },
        ],
      },
    ],
  });

  const imageTool = captured.body.tools?.find(t => t.type === 'image_generation');
  assert.equal(imageTool, undefined, 'no workspace → no image_generation tool');
  assert.doesNotMatch(captured.body.instructions, /INLINE IMAGE EDITING/);
  assert.equal(
    captured.body.model,
    'gpt-4.1',
    'model override only applies when inline image is actually enabled',
  );
});

test('payload — historical image (older user turn) + new edit ask: edit-mode still triggers (cross-turn reuse)', async () => {
  // User design decision A (2026-04-30): allow cross-turn reuse of
  // earlier uploaded images. So a conversation where the image was
  // uploaded two turns ago + the latest user turn says "再换个色"
  // must still get edit-mode tool config + edit instructions —
  // otherwise the model would re-paint from scratch and the user's
  // continuation editing UX breaks.
  const captured = await captureCodexRequestPayload({
    workspacePath: '/tmp/some/workspace',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: '把这个改成 gpt' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBOR' } },
        ],
      },
      { role: 'assistant', content: 'Done. Here you go.' },
      { role: 'user', content: [{ type: 'text', text: '再换个色' }] },
    ],
  });

  const imageTool = captured.body.tools?.find(t => t.type === 'image_generation');
  assert.equal(
    imageTool.input_fidelity,
    'high',
    'cross-turn reuse: edit mode must persist as long as the conversation has any uploaded image',
  );
  assert.match(captured.body.instructions, /INLINE IMAGE EDITING/);
  // Instructions must also contain the EXCEPTIONS clause so model can
  // peel back to text-to-image when user actually says "draw something
  // new". Asserts the explicit pass-through is wired in.
  assert.match(
    captured.body.instructions,
    /EXCEPTIONS/,
    'edit-mode instructions must include the explicit exceptions clause',
  );
});

// ─── messagesHaveInputImages (edit-mode trigger) ────────────────────────────
//
// This is the one knob that flips inline image from "redraw from
// scratch" to "edit in place". A miss here means the user sees the
// failure mode reported on 2026-04-30 — model says "I need a file
// path" because no signal told it to use the conversation's input_image.

test('messagesHaveInputImages — detects an image_url part in a user message', () => {
  const messages = [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'change 5.5 to gpt' },
        {
          type: 'image_url',
          image_url: { url: 'data:image/png;base64,iVBORw0KGgo' },
        },
      ],
    },
  ];
  assert.equal(messagesHaveInputImages(messages), true);
});

test('messagesHaveInputImages — detects remote https image url', () => {
  const messages = [
    {
      role: 'user',
      content: [
        {
          type: 'image_url',
          image_url: { url: 'https://cdn.example.com/screenshot.png' },
        },
      ],
    },
  ];
  assert.equal(messagesHaveInputImages(messages), true);
});

test('messagesHaveInputImages — pure-text user message returns false', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    { role: 'user', content: 'plain string content' },
  ];
  assert.equal(messagesHaveInputImages(messages), false);
});

test('messagesHaveInputImages — image attached only to assistant role does NOT count', () => {
  // Edit mode is about the user uploading a reference for the next
  // turn. An image embedded in a previous assistant reply is NOT a
  // user-supplied edit reference. Pin: assistant-only image returns false.
  const messages = [
    {
      role: 'assistant',
      content: [
        {
          type: 'image_url',
          image_url: { url: 'data:image/png;base64,QQAA' },
        },
      ],
    },
  ];
  assert.equal(messagesHaveInputImages(messages), false);
});

test('messagesHaveInputImages — empty / blank url skipped', () => {
  const messages = [
    {
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: '' } },
        { type: 'image_url', image_url: { url: '   ' } },
        { type: 'image_url', image_url: {} },
      ],
    },
  ];
  assert.equal(messagesHaveInputImages(messages), false);
});

test('messagesHaveInputImages — defensive: bad shapes never throw', () => {
  for (const bad of [null, undefined, 'string', 42, {}, []]) {
    assert.equal(
      messagesHaveInputImages(bad),
      false,
      `bad input ${JSON.stringify(bad)} should return false, not throw`,
    );
  }
});

// ─── saveCodexInlineImageItem ───────────────────────────────────────────────

test('saveCodexInlineImageItem writes the file and returns a signed URL', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'melo-inline-img-'));
  try {
    const result = await saveCodexInlineImageItem(
      { result: fakePngBase64(2048), output_format: 'png' },
      workspace,
    );
    assert.ok(result, 'expected save result');
    assert.match(result.path, /\/generated\/img-[a-z0-9]+-[a-f0-9]+\.png$/);
    assert.equal(result.mimeType, 'image/png');
    assert.ok(result.bytes >= 1024);
    assert.match(result.url, /^https?:\/\/.+\/api\/files\/signed\/img-.+\.png\?p=.+&e=\d+&s=.+$/);

    const stats = await stat(result.path);
    assert.equal(stats.size, result.bytes);
    const head = await readFile(result.path);
    assert.deepEqual(
      Array.from(head.subarray(0, 4)),
      [0x89, 0x50, 0x4e, 0x47],
      'file should start with PNG magic bytes',
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('saveCodexInlineImageItem rejects sub-1KiB buffer (probable partial)', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'melo-inline-img-'));
  try {
    // 64 bytes — way under the 1024-byte floor.
    const tiny = Buffer.alloc(64, 0x89).toString('base64');
    const result = await saveCodexInlineImageItem({ result: tiny }, workspace);
    assert.equal(result, null, 'tiny buffer should be rejected');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('saveCodexInlineImageItem rejects non-image bytes that pass the size check', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'melo-inline-img-'));
  try {
    // 4KiB of text — large enough to clear the size floor, but no magic.
    const big = Buffer.alloc(4096, 0x41).toString('base64');
    const result = await saveCodexInlineImageItem({ result: big }, workspace);
    assert.equal(result, null, 'non-image bytes should be rejected');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('saveCodexInlineImageItem rejects non-image bytes EVEN WHEN output_format claims png', async () => {
  // Codex review round 2 (2026-04-29) caught a bypass: previously
  // codexInlineImageMime fell back to `output_format` when magic-byte
  // sniff failed, so a payload like
  //   { result: <non-png bytes>, output_format: 'png' }
  // would be saved with `.png` extension and passed to the UI as a
  // valid image. Codex has shipped 200-OK error pages with declared
  // image content-types in the past — same risk class as imageGen's
  // "trust the bytes, not the server's story" rule.
  // Contract: bytes must self-identify; output_format is purely
  // advisory and cannot rescue corrupt content.
  const workspace = await mkdtemp(join(tmpdir(), 'melo-inline-img-'));
  try {
    // 4KiB of pure ASCII (e.g. an HTML error page) — no PNG magic.
    const errorPage = Buffer.alloc(4096, 0x41).toString('base64');
    for (const fmt of ['png', 'jpeg', 'jpg', 'webp', 'gif']) {
      const result = await saveCodexInlineImageItem(
        { result: errorPage, output_format: fmt },
        workspace,
      );
      assert.equal(
        result,
        null,
        `output_format=${fmt} must NOT rescue non-image bytes`,
      );
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('saveCodexInlineImageItem strips data: URI prefix if upstream emits one', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'melo-inline-img-'));
  try {
    const dataUri = `data:image/png;base64,${fakePngBase64(2048)}`;
    const result = await saveCodexInlineImageItem({ result: dataUri }, workspace);
    assert.ok(result);
    assert.equal(result.mimeType, 'image/png');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

// ─── readCodexSseResponse + onInlineImage ───────────────────────────────────

test('streams an image_generation_call.done into the deltaText (markdown URL preserved)', async () => {
  const onDeltas = [];
  const inlineCalls = [];
  const response = mockResponseFromEvents([
    sseTextDelta('Here is a cat: '),
    sseImageItemDone({ id: 'igc_1', result: fakePngBase64(2048) }),
    // Note: no `output_text` in completed → forces fallback path that
    // would normally drop image markdown if we returned completedText.
    sseCompleted({ output: [] }),
  ]);

  const reply = await readCodexSseResponse(response, {
    onDelta: payload => {
      onDeltas.push(payload.delta);
    },
    onInlineImage: async item => {
      inlineCalls.push(item.id);
      return `\n\n![generated image](https://test/file.png?s=abc)\n\n`;
    },
  });

  assert.equal(inlineCalls.length, 1, 'onInlineImage should fire once');
  assert.equal(inlineCalls[0], 'igc_1');
  assert.match(reply, /Here is a cat: /);
  assert.match(reply, /!\[generated image\]\(https:\/\/test\/file\.png\?s=abc\)/);
  // The delta callback should have streamed the markdown so the UI can
  // render the image inline before the response finalises.
  assert.ok(onDeltas.some(d => d.includes('![generated image]')));
});

test('completedText path is preferred for pure-text replies (no inline images)', async () => {
  // Without any image events, prefer the canonical completed response text
  // so trailing-whitespace / encoding glitches in deltaText don't bleed
  // through. This is the historical behaviour.
  const response = mockResponseFromEvents([
    sseTextDelta('hi'),
    sseCompleted({
      output: [
        {
          type: 'message',
          content: [{ text: 'hi (canonical)' }],
        },
      ],
    }),
  ]);
  const reply = await readCodexSseResponse(response, {});
  assert.equal(reply, 'hi (canonical)');
});

test('duplicate image_generation_call across output_item.done + completed is emitted exactly once', async () => {
  const inlineCalls = [];
  const item = {
    id: 'igc_dupe',
    type: 'image_generation_call',
    status: 'completed',
    result: fakePngBase64(2048),
    output_format: 'png',
  };
  const response = mockResponseFromEvents([
    sseImageItemDone({ id: 'igc_dupe', result: item.result }),
    sseCompleted({ output: [item] }),
  ]);

  await readCodexSseResponse(response, {
    onInlineImage: async it => {
      inlineCalls.push(it.id);
      return `\n\n![generated image](https://test/x.png)\n\n`;
    },
  });

  assert.equal(inlineCalls.length, 1, 'should not re-emit the same image id');
});

test('output_item.done image found ONLY in completed response is still emitted', async () => {
  // Under heavy load, the streaming output_item.done event sometimes
  // never arrives — only the terminal response.completed payload carries
  // the image_generation_call. The reader has to walk completedResponse.output
  // for any unseen images so the user still gets their image.
  const inlineCalls = [];
  const item = {
    id: 'igc_late',
    type: 'image_generation_call',
    status: 'completed',
    result: fakePngBase64(2048),
    output_format: 'png',
  };
  const response = mockResponseFromEvents([
    sseTextDelta('done.'),
    sseCompleted({ output: [item] }),
  ]);

  const reply = await readCodexSseResponse(response, {
    onInlineImage: async it => {
      inlineCalls.push(it.id);
      return `\n\n![generated image](https://test/late.png)\n\n`;
    },
  });

  assert.equal(inlineCalls.length, 1);
  assert.match(reply, /!\[generated image\]\(https:\/\/test\/late\.png\)/);
});

test('save failure leaves text reply intact (no crash, no markdown injected)', async () => {
  const onDeltas = [];
  const response = mockResponseFromEvents([
    sseTextDelta('text only.'),
    sseImageItemDone({ id: 'igc_fail', result: fakePngBase64(2048) }),
    sseCompleted({ output: [] }),
  ]);

  const reply = await readCodexSseResponse(response, {
    onDelta: payload => onDeltas.push(payload.delta),
    onInlineImage: async () => {
      // Simulating a workspace-write or sign failure surfaced as either
      // null or thrown error. Both should be tolerated.
      throw new Error('disk full');
    },
  });

  assert.equal(reply, 'text only.');
  assert.equal(
    onDeltas.filter(d => d.includes('![generated image]')).length,
    0,
    'no image markdown should leak when the save callback throws',
  );
});

test('save failure with non-empty completed output still returns canonical completedText', async () => {
  // Codex review (2026-04-29 round 1) caught: the first cut tracked
  // attempted-and-emitted ids in the same Set, so a save crash would
  // leave the failed id "marked" → the final-text branch saw
  // emittedImageIds.size > 0 and returned deltaText (which is missing
  // the image we couldn't write), corrupting the canonical completedText
  // contract.
  //
  // Contract pinned here: when the save callback fails AND the response
  // payload provides a usable `output_text`, the reader returns the
  // canonical text (NOT a partial deltaText). Failure of an inline image
  // never degrades the prose return path.
  const inlineCalls = [];
  const response = mockResponseFromEvents([
    sseTextDelta('streaming chunk one. '),
    sseImageItemDone({ id: 'igc_failpath', result: fakePngBase64(2048) }),
    sseTextDelta('streaming chunk two.'),
    sseCompleted({
      output: [
        {
          type: 'message',
          content: [{ text: 'streaming chunk one. streaming chunk two.' }],
        },
      ],
    }),
  ]);

  const reply = await readCodexSseResponse(response, {
    onInlineImage: async item => {
      inlineCalls.push(item.id);
      throw new Error('simulated workspace write failure');
    },
  });

  assert.equal(inlineCalls.length, 1, 'save callback must still fire (we tried)');
  assert.equal(
    reply,
    'streaming chunk one. streaming chunk two.',
    'save failure must NOT switch the return path to deltaText',
  );
  assert.doesNotMatch(
    reply,
    /!\[generated image\]/,
    'no markdown URL should survive when the save callback failed',
  );
});

test('completed-only payload (no text deltas) + canonical text + image keeps both', async () => {
  // Codex review round 2 (2026-04-29) caught the dual of the
  // save-failure bug: when `response.completed` carries BOTH a
  // canonical `output_text` AND an image_generation_call, but the
  // intermediate `response.output_text.delta` events were missing
  // (heavy-load completed-only path), the previous logic returned
  // deltaText (= just the image markdown) and silently dropped the
  // canonical prose. Pin the contract explicitly: final reply must
  // contain (a) every word of completedText, (b) every injected
  // image markdown URL.
  const item = {
    id: 'igc_completed_only',
    type: 'image_generation_call',
    status: 'completed',
    result: fakePngBase64(2048),
    output_format: 'png',
  };
  const response = mockResponseFromEvents([
    // No text deltas. The model's prose only arrives in the terminal
    // payload's output_text.
    sseCompleted({
      output: [
        {
          type: 'message',
          content: [{ text: 'Here is the cat you asked for.' }],
        },
        item,
      ],
    }),
  ]);

  const reply = await readCodexSseResponse(response, {
    onInlineImage: async () => `\n\n![generated image](https://test/cat.png)\n\n`,
  });

  assert.match(reply, /Here is the cat you asked for\./, 'canonical prose must survive');
  assert.match(
    reply,
    /!\[generated image\]\(https:\/\/test\/cat\.png\)/,
    'injected image markdown must survive',
  );
  // Order: prose first, image after — sensible default when stream
  // didn't tell us where to splice. Pinned so a future refactor can't
  // silently flip the order.
  const proseIndex = reply.indexOf('Here is the cat');
  const imageIndex = reply.indexOf('![generated image]');
  assert.ok(
    proseIndex >= 0 && imageIndex > proseIndex,
    `expected prose before image (got prose=${proseIndex} image=${imageIndex})`,
  );
});

test('streamed text includes every word of completedText AND image → return deltaText', async () => {
  // Inverse of the previous case: when streaming caught both the
  // canonical text and we appended images, deltaText is a complete
  // representation of the user's view. Returning it preserves
  // streaming order verbatim. Re-appending completedText would
  // double-quote the prose.
  const reply = await readCodexSseResponse(
    mockResponseFromEvents([
      sseTextDelta('hello world.'),
      sseImageItemDone({ id: 'igc_x', result: fakePngBase64(2048) }),
      sseCompleted({
        output: [
          { type: 'message', content: [{ text: 'hello world.' }] },
        ],
      }),
    ]),
    {
      onInlineImage: async () => '\n\n![generated image](https://test/x.png)\n\n',
    },
  );
  // Single occurrence of "hello world." — no double quote.
  assert.equal(reply.match(/hello world\./g)?.length, 1);
  assert.match(reply, /!\[generated image\]\(https:\/\/test\/x\.png\)/);
});

test('save callback returning null (silent failure) does NOT corrupt completedText path', async () => {
  // `null` is the documented in-band signal for "save failed, skip this
  // image" (used by saveCodexInlineImageItem when the buffer is too
  // small / fails magic-byte sniff). Same contract as the throw branch:
  // attemptedImageIds gets the id (we don't retry), emittedImageIds
  // does NOT (we didn't actually inject markdown), final-text return
  // stays on the canonical completedText.
  const response = mockResponseFromEvents([
    sseTextDelta('a'),
    sseImageItemDone({ id: 'igc_null', result: fakePngBase64(2048) }),
    sseCompleted({
      output: [{ type: 'message', content: [{ text: 'canonical' }] }],
    }),
  ]);

  const reply = await readCodexSseResponse(response, {
    onInlineImage: async () => null,
  });

  assert.equal(reply, 'canonical');
});

test('omits image_generation_call without a result field (e.g. status=in_progress)', async () => {
  const inlineCalls = [];
  const response = mockResponseFromEvents([
    `event: response.output_item.done\ndata: ${JSON.stringify({
      type: 'response.output_item.done',
      item: {
        id: 'igc_noresult',
        type: 'image_generation_call',
        status: 'in_progress',
        // result intentionally absent
      },
    })}`,
    sseCompleted({ output: [] }),
    sseTextDelta('text fallback'),
  ]);

  await readCodexSseResponse(response, {
    onInlineImage: async it => {
      inlineCalls.push(it.id);
      return '\n\n![x](https://test/x.png)\n\n';
    },
  });

  assert.equal(inlineCalls.length, 0);
});
