// Tests for the image-edit fast-path. Exercises both the pure
// helpers (findLatestUserImageUrl / findLatestUserText / resolveImage
// Bytes / allocateEditedImagePath) and the top-level
// tryImageEditFastPath dispatcher with all four gates.
//
// The dispatcher is tested with editFn injected (no real Codex call)
// so we can drive it from a Codex-OAuth-shaped config without standing
// up the credential file or fetch round-trip.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findLatestUserImageUrl,
  findLatestUserText,
  resolveImageBytes,
  allocateEditedImagePath,
  tryImageEditFastPath,
} from './imageEditFastPath.js';

// Buffer with PNG magic so detectImageMimeFromBytes accepts it.
function fakePng(size = 4096) {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([header, Buffer.alloc(Math.max(0, size - header.length), 0)]);
}

function dataUriPng(size = 4096) {
  return `data:image/png;base64,${fakePng(size).toString('base64')}`;
}

// ─── findLatestUserImageUrl ─────────────────────────────────────────────────

test('findLatestUserImageUrl picks the most-recent user image even when older user turns also have images', () => {
  const messages = [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'first attempt' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,FIRST' } },
      ],
    },
    { role: 'assistant', content: 'edited.' },
    {
      role: 'user',
      content: [
        { type: 'text', text: '再换个色' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,SECOND' } },
      ],
    },
  ];
  assert.equal(findLatestUserImageUrl(messages), 'data:image/png;base64,SECOND');
});

test('findLatestUserImageUrl ignores assistant-role images', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    {
      role: 'assistant',
      content: [
        { type: 'image_url', image_url: { url: 'data:image/png;base64,BOT' } },
      ],
    },
  ];
  // The assistant's previously-emitted image is not a user-supplied
  // edit reference. Function returns null so the fast-path doesn't
  // accidentally try to "edit" the bot's own output.
  assert.equal(findLatestUserImageUrl(messages), null);
});

test('findLatestUserImageUrl handles bad shapes without throwing', () => {
  for (const bad of [null, undefined, 'string', 42, {}]) {
    assert.equal(findLatestUserImageUrl(bad), null);
  }
});

test('findLatestUserImageUrl skips empty / blank URLs', () => {
  const messages = [
    {
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: '' } },
        { type: 'image_url', image_url: { url: '   ' } },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,ok' } },
      ],
    },
  ];
  assert.equal(findLatestUserImageUrl(messages), 'data:image/png;base64,ok');
});

// ─── findLatestUserText ─────────────────────────────────────────────────────

test('findLatestUserText concatenates text parts from the latest user message', () => {
  const messages = [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'hi' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,A' } },
        { type: 'text', text: 'change the background' },
      ],
    },
  ];
  assert.equal(findLatestUserText(messages), 'hi change the background');
});

test('findLatestUserText accepts plain-string content (legacy shape)', () => {
  const messages = [{ role: 'user', content: '把背景换掉' }];
  assert.equal(findLatestUserText(messages), '把背景换掉');
});

test('findLatestUserText returns empty string when no user turn has text', () => {
  assert.equal(findLatestUserText([]), '');
  assert.equal(findLatestUserText(null), '');
  assert.equal(
    findLatestUserText([
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] },
    ]),
    '',
  );
});

// ─── resolveImageBytes ──────────────────────────────────────────────────────

test('resolveImageBytes — data: URI happy path returns bytes + sniffed mime', async () => {
  const result = await resolveImageBytes(dataUriPng(4096));
  assert.ok(result);
  assert.equal(result.mime, 'image/png');
  assert.ok(Buffer.isBuffer(result.bytes));
  assert.deepEqual(
    Array.from(result.bytes.subarray(0, 4)),
    [0x89, 0x50, 0x4e, 0x47],
    'bytes must start with PNG magic',
  );
});

test('resolveImageBytes — data: URI with sub-1KiB body is rejected', async () => {
  // 64 byte buffer — under IMAGE_MIN_BYTES floor.
  const tiny = `data:image/png;base64,${fakePng(64).toString('base64')}`;
  assert.equal(await resolveImageBytes(tiny), null);
});

test('resolveImageBytes — data: URI with non-image bytes is rejected', async () => {
  // 4KB of "AAAAAA…" — large enough but no image magic.
  const big = `data:image/png;base64,${Buffer.alloc(4096, 0x41).toString('base64')}`;
  assert.equal(await resolveImageBytes(big), null);
});

test('resolveImageBytes — https URL fetched, sniffs mime from body, ignores server content-type', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    headers: new Map([['content-type', 'application/octet-stream']]),
    arrayBuffer: async () => fakePng(4096).buffer.slice(0, fakePng(4096).length),
  });
  // headers.get is the API we actually call — adapt the Map shape.
  fetchImpl.headers = { get: () => null };
  const realFetch = async (url, init) => {
    const png = fakePng(4096);
    return {
      ok: true,
      status: 200,
      headers: { get: name => (name.toLowerCase() === 'content-type' ? 'application/octet-stream' : null) },
      arrayBuffer: async () => png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength),
    };
  };
  const result = await resolveImageBytes('https://cdn.example.com/x.png', { fetchImpl: realFetch });
  assert.ok(result);
  // Mime comes from magic-byte sniff, NOT from the bogus
  // application/octet-stream header.
  assert.equal(result.mime, 'image/png');
});

test('resolveImageBytes — https URL with non-OK status returns null', async () => {
  const fetchImpl = async () => ({ ok: false, status: 404 });
  assert.equal(
    await resolveImageBytes('https://cdn.example.com/missing.png', { fetchImpl }),
    null,
  );
});

test('resolveImageBytes — https URL serving HTML error page (sniff fails) returns null', async () => {
  // Codex review (2026-04-30) called out the "trust the bytes" rule
  // explicitly: a 200 OK response with HTML body declared as image
  // must NOT pass. Pin this behaviour in the resolver.
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'image/png' }, // server lies
    arrayBuffer: async () => Buffer.alloc(4096, 0x41).buffer, // ASCII payload
  });
  assert.equal(
    await resolveImageBytes('https://cdn.example.com/lie.png', { fetchImpl }),
    null,
  );
});

test('resolveImageBytes — unsupported scheme returns null without throwing', async () => {
  for (const url of [
    'file:///local/x.png',
    'blob:1234',
    'ftp://x/y',
    '',
    null,
    undefined,
  ]) {
    assert.equal(await resolveImageBytes(url), null);
  }
});

// ─── allocateEditedImagePath ────────────────────────────────────────────────

test('allocateEditedImagePath creates the generated/ folder + returns a unique .png path', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'melo-fastpath-test-'));
  try {
    const a = await allocateEditedImagePath(ws);
    const b = await allocateEditedImagePath(ws);
    assert.match(a, /\/generated\/img-[a-z0-9]+-[a-f0-9]+\.png$/);
    assert.match(b, /\.png$/);
    assert.notEqual(a, b, 'sequential calls must produce distinct paths');
    // generated/ folder exists on disk after the call.
    const stats = await stat(join(ws, 'generated'));
    assert.ok(stats.isDirectory());
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

test('allocateEditedImagePath rejects non-string / relative path', async () => {
  for (const bad of [null, undefined, '', 42, 'relative/path']) {
    await assert.rejects(
      allocateEditedImagePath(bad),
      /workspace path/,
    );
  }
});

// ─── tryImageEditFastPath (top-level dispatcher) ────────────────────────────

function codexConfig(overrides = {}) {
  return { authMode: 'codex', ...overrides };
}

function buildEditMessages({ withImage = true, latestText = '把里面的 5.5 改成 gpt' } = {}) {
  const content = [{ type: 'text', text: latestText }];
  if (withImage) {
    content.push({ type: 'image_url', image_url: { url: dataUriPng(4096) } });
  }
  return [{ role: 'user', content }];
}

test('tryImageEditFastPath happy path: returns markdown URL, calls editFn with bytes + mime + workspace path', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'melo-fastpath-happy-'));
  try {
    const editCalls = [];
    const editFn = async opts => {
      editCalls.push(opts);
      // Emulate editAndSaveImageViaCodex: write the bytes to outputPath
      // and return the metadata shape it does in production.
      const { writeFile } = await import('node:fs/promises');
      await writeFile(opts.outputPath, fakePng(4096));
      return {
        path: opts.outputPath,
        bytes: 4096,
        mimeType: 'image/png',
        model: 'gpt-5.5',
        editSpec: 'Subject: x\nPreserve: y',
        sourceUrl: null,
      };
    };

    const onDeltas = [];
    const sseEvents = [];

    const reply = await tryImageEditFastPath({
      config: codexConfig(),
      messages: buildEditMessages(),
      workspace: { rootPath: ws },
      onDelta: payload => onDeltas.push(payload),
      sseEmitter: (name, payload) => sseEvents.push({ name, payload }),
      editFn,
    });

    assert.ok(reply, 'fast path should return a non-empty reply');
    assert.match(reply, /!\[edited image\]\(.+\/api\/files\/signed\/img-.+\.png\?p=.+\)/);

    // editFn was called with the user's edit prompt + the resolved
    // image bytes (sniffed as image/png from the data: URI).
    assert.equal(editCalls.length, 1);
    assert.equal(editCalls[0].prompt, '把里面的 5.5 改成 gpt');
    assert.equal(editCalls[0].sourceImageMime, 'image/png');
    assert.ok(editCalls[0].sourceImageBytes.length >= 4096);
    assert.match(editCalls[0].outputPath, /\/generated\/img-.+\.png$/);

    // UI streaming was invoked with the same reply.
    assert.equal(onDeltas.length, 1);
    assert.equal(onDeltas[0].text, reply);
    // sseEmitter saw a reply_text event so non-streaming UIs can render too.
    assert.ok(sseEvents.some(e => e.name === 'reply_text' && e.payload.text === reply));
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

test('tryImageEditFastPath gate 1: non-Codex auth → returns null without calling editFn', async () => {
  let editCalled = 0;
  const reply = await tryImageEditFastPath({
    config: { authMode: 'api-key' },
    messages: buildEditMessages(),
    workspace: { rootPath: '/tmp/x' },
    editFn: async () => {
      editCalled += 1;
      return {};
    },
  });
  assert.equal(reply, null);
  assert.equal(editCalled, 0, 'editFn must NOT fire when auth is not Codex');
});

test('tryImageEditFastPath gate 2: missing workspace.rootPath → null', async () => {
  const reply = await tryImageEditFastPath({
    config: codexConfig(),
    messages: buildEditMessages(),
    workspace: null,
    editFn: async () => ({ path: 'x' }),
  });
  assert.equal(reply, null);
});

test('tryImageEditFastPath gate 2: relative workspace.rootPath → null', async () => {
  const reply = await tryImageEditFastPath({
    config: codexConfig(),
    messages: buildEditMessages(),
    workspace: { rootPath: 'relative/dir' },
    editFn: async () => ({ path: 'x' }),
  });
  assert.equal(reply, null);
});

test('tryImageEditFastPath gate 3: no input image in conversation → null', async () => {
  let editCalled = 0;
  const reply = await tryImageEditFastPath({
    config: codexConfig(),
    messages: buildEditMessages({ withImage: false }),
    workspace: { rootPath: '/tmp/x' },
    editFn: async () => {
      editCalled += 1;
      return {};
    },
  });
  assert.equal(reply, null);
  assert.equal(editCalled, 0);
});

test('tryImageEditFastPath gate 4: no edit intent in latest user text → null', async () => {
  // Image present but user is just asking what's in it — no edit. We
  // must NOT short-circuit. The normal agent loop handles "describe
  // this image" perfectly well.
  let editCalled = 0;
  const reply = await tryImageEditFastPath({
    config: codexConfig(),
    messages: buildEditMessages({ latestText: '这张图里有什么？' }),
    workspace: { rootPath: '/tmp/x' },
    editFn: async () => {
      editCalled += 1;
      return {};
    },
  });
  assert.equal(reply, null);
  assert.equal(editCalled, 0);
});

test('tryImageEditFastPath: editFn throwing → null (caller falls through to agent loop)', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'melo-fastpath-err-'));
  try {
    const reply = await tryImageEditFastPath({
      config: codexConfig(),
      messages: buildEditMessages(),
      workspace: { rootPath: ws },
      editFn: async () => {
        throw new Error('Codex returned 500');
      },
    });
    // Failure is silent: caller decides how to surface (most likely
    // by running the agent loop, which will produce a text apology).
    assert.equal(reply, null);
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

test('tryImageEditFastPath: source bytes resolution failure (e.g. tiny image) → null', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'melo-fastpath-tiny-'));
  try {
    const tinyDataUri = `data:image/png;base64,${fakePng(64).toString('base64')}`;
    let editCalled = 0;
    const reply = await tryImageEditFastPath({
      config: codexConfig(),
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '改一下颜色' },
            { type: 'image_url', image_url: { url: tinyDataUri } },
          ],
        },
      ],
      workspace: { rootPath: ws },
      editFn: async () => {
        editCalled += 1;
        return {};
      },
    });
    assert.equal(reply, null);
    assert.equal(editCalled, 0, 'editFn must NOT fire when bytes resolution fails');
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

test('tryImageEditFastPath: cross-turn reuse — image two turns back, edit ask in latest user turn → fires', async () => {
  // Validates the user-design decision: historical images should be
  // reusable across turns. The message-builder upstream lifts the
  // historical image into the latest message via carry-forward, so
  // by the time fast-path sees the messages the latest user turn
  // has both image + edit text. Pinned because losing this would
  // regress the multi-turn edit UX user explicitly endorsed.
  const ws = await mkdtemp(join(tmpdir(), 'melo-fastpath-multi-'));
  try {
    let editCalled = 0;
    const editFn = async opts => {
      editCalled += 1;
      const { writeFile } = await import('node:fs/promises');
      await writeFile(opts.outputPath, fakePng(4096));
      return { path: opts.outputPath, bytes: 4096, mimeType: 'image/png', model: 'gpt-5.5' };
    };
    const reply = await tryImageEditFastPath({
      config: codexConfig(),
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '改成蓝色' },
            // Image preserved on the latest user turn courtesy of
            // messageBuilder.carry-forward (which itself triggered on
            // the IMAGE_FOLLOW_UP_PATTERN extension).
            { type: 'image_url', image_url: { url: dataUriPng(4096) } },
          ],
        },
      ],
      workspace: { rootPath: ws },
      editFn,
    });
    assert.ok(reply);
    assert.equal(editCalled, 1);
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});
