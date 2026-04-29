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
