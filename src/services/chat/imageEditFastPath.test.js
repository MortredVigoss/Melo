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

test('resolveImageBytes — http(s) URLs are unconditionally rejected (SSRF guard)', async () => {
  // Codex review round 4 (2026-04-30) flagged the SSRF risk: melo
  // runs Telegram / Discord pollers, so a remote user could send a
  // chat message containing a URL that looks like an image but
  // points at the host's loopback / private / link-local network or
  // cloud metadata endpoints. Even an http(s) URL with a perfectly
  // valid PNG body is a SSRF vector — it lets a remote user check
  // whether arbitrary URLs are reachable from the server, and if
  // any happen to return image-magic-byte-resembling bytes, those
  // get forwarded to Codex.
  //
  // Hardening: resolveImageBytes accepts data: URIs ONLY. Any
  // http(s) URL → null, end of story. Pinned with explicit cases
  // covering the worst attacker primitives so a future "let's add
  // an allowlist" refactor doesn't accidentally re-open the hole.
  const httpUrls = [
    // Loopback (host-local services)
    'http://127.0.0.1:8080/x.png',
    'http://127.0.0.1/admin.png',
    'http://localhost:3000/internal.png',
    'http://[::1]:8080/x.png',
    // Private RFC 1918 / link-local
    'http://10.0.0.1/foo.png',
    'http://192.168.1.1/router.png',
    'http://172.16.0.1/intranet.png',
    'http://169.254.169.254/latest/meta-data/iam/security-credentials/.png',
    // Public CDN (still rejected — fast-path is data: only)
    'https://cdn.example.com/legitimate.png',
    'https://api.telegram.org/file/bot123/photo.jpg',
    // Edge cases that historically tripped allowlists
    'http://0.0.0.0/x.png',
    'http://2130706433/x.png',  // 127.0.0.1 as decimal
    'http://[fe80::1]/x.png',   // IPv6 link-local
  ];
  for (const url of httpUrls) {
    assert.equal(
      await resolveImageBytes(url),
      null,
      `resolveImageBytes MUST reject ${url} unconditionally`,
    );
  }
});

test('resolveImageBytes — unsupported scheme returns null without throwing', async () => {
  for (const url of [
    'file:///local/x.png',
    'blob:1234',
    'ftp://x/y',
    'gopher://x',
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

function buildEditMessages({
  withImage = true,
  // Default uses an image-object phrase ('这张图') so it passes both
  // the intent gate AND the image-follow-up gate after the round-5
  // narrowing. Tests for the *negative* case (intent without image
  // object → fall through) pass a different `latestText` explicitly.
  latestText = '把这张图里的 5.5 改成 gpt',
} = {}) {
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
    assert.equal(editCalls[0].prompt, '把这张图里的 5.5 改成 gpt');
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

test('tryImageEditFastPath: https image URL → fast-path does NOT fire even with all other gates passing (SSRF guard)', async () => {
  // Layered defense: even if a remote user gets an https URL onto the
  // image_url part of a user message, the fast-path must NOT fetch
  // it. The four gates pass (Codex auth + workspace + image_url
  // present + edit intent), but resolveImageBytes returns null for
  // anything non-data:, which trips the dispatcher's null check
  // BEFORE editFn fires. Pinned because it's the canonical SSRF
  // failure shape Codex round-4 review described.
  let editCalled = 0;
  const reply = await tryImageEditFastPath({
    config: codexConfig(),
    messages: [
      {
        role: 'user',
        content: [
          // Use an image-object phrase so all four prompt-level gates
          // pass — the SSRF guard sits at resolveImageBytes BELOW the
          // gates. We're testing that even with a green prompt path
          // the URL refusal still kicks in.
          { type: 'text', text: '把这张图换个色' },
          // The exact attacker primitive: a URL that visually looks
          // like a legitimate image but points at an internal host.
          // resolveImageBytes refuses to fetch ANY http(s) URL, so
          // editFn never sees these bytes.
          { type: 'image_url', image_url: { url: 'http://127.0.0.1:8080/internal.png' } },
        ],
      },
    ],
    workspace: { rootPath: '/tmp' },
    editFn: async () => {
      editCalled += 1;
      return {};
    },
  });
  assert.equal(reply, null);
  assert.equal(editCalled, 0, 'editFn must NOT fire for any http(s) image URL');
});

test('tryImageEditFastPath: cross-turn reuse — image carried-forward + image-object edit ask → fires', async () => {
  // Validates the user-design decision: historical images should be
  // reusable across turns. The message-builder upstream lifts the
  // historical image into the latest message via carry-forward, so
  // by the time fast-path sees the messages the latest user turn
  // has both image + edit text. Pinned because losing this would
  // regress the multi-turn edit UX user explicitly endorsed.
  //
  // After Codex review round 5 narrowing: the latest user text MUST
  // contain an image-object phrase ('这张图', '换背景', 'recolor', …)
  // — bare verbs like '改成蓝色' alone now fall through to the agent
  // loop. Negative case below pins this on purpose.
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
            // Image-object phrase '换背景' satisfies both gates.
            { type: 'text', text: '换背景' },
            // Image preserved on the latest user turn via
            // messageBuilder carry-forward (which still fires on the
            // image-specific phrase '换背景').
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

test('tryImageEditFastPath: image_url present but latest text is a CODE/UI edit (no image-object phrase) → null', async () => {
  // The exact misroute Codex review caught across two rounds:
  //
  //   Round 5 (CJK) — earlier image got carried forward into a CJK
  //     code-edit follow-up because pre-narrowing
  //     IMAGE_FOLLOW_UP_PATTERN matched bare 改成.
  //   Round 6 (EN)  — same pattern, English flavor: "change the
  //     background color in CSS" / "change the font in Button.jsx"
  //     dragged a screenshot into a CSS / component question and
  //     fast-path tried to re-paint it as an image edit.
  //
  // After narrowing both sides + dispatcher Gate 5, even when
  // image_url is on the message AND detectImageEditIntent matches
  // ('change' / '改成' both match the permissive intent regex),
  // the dispatcher's second gate (IMAGE_FOLLOW_UP_PATTERN) only
  // accepts image-object phrasings. Code/UI/CSS asks fall through
  // to the chat agent loop, which is what they want anyway.
  const ws = await mkdtemp(join(tmpdir(), 'melo-fastpath-misroute-'));
  try {
    let editCalled = 0;
    const codeEditCases = [
      // CJK code/text edits (round 5 misroute shape)
      '把这个函数改成 async',
      '修改函数',
      '修改代码',
      '编辑这段文字',
      '改一下文档',
      '去掉这段日志',
      '加上单元测试',
      '换一下变量名',
      '换掉这段逻辑',
      '再改一下',
      '让它更快',
      // English UI/CSS/layout edits (round 6 misroute shape)
      'change the background color in the CSS',
      'change the background color in main.css',
      'change the font in Button.jsx',
      'change the style of the form',
      'change the color scheme',
      'make it smaller in the viewport',
      'make it larger in layout',
      'make it more responsive',
      'make it less verbose',
      'update the color',
      'update the background',
      'update the font',
      // English code edits — historically pinned
      'modify the function',
      'replace the algorithm',
      'edit my essay',
    ];
    for (const codeEditText of codeEditCases) {
      const reply = await tryImageEditFastPath({
        config: codexConfig(),
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: codeEditText },
              // Image is in the message (e.g. carry-forward from an
              // earlier turn) — but the latest text is a code edit.
              { type: 'image_url', image_url: { url: dataUriPng(4096) } },
            ],
          },
        ],
        workspace: { rootPath: ws },
        editFn: async () => {
          editCalled += 1;
          return {};
        },
      });
      assert.equal(
        reply,
        null,
        `code/UI text "${codeEditText}" must NOT trigger image fast-path even with carry-forward image present`,
      );
    }
    assert.equal(
      editCalled,
      0,
      'editFn must NOT fire for any code/UI phrasing, even with image_url in message',
    );
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

test('tryImageEditFastPath: image_url present + image-only verb (recolor/crop/retouch) → fires WITHOUT explicit image word', async () => {
  // Codex review round 6 design Q1: "english 多轮编辑是否要求每轮
  // 显式说 image/photo/screenshot, 还是允许 recolor/crop/retouch?"
  // User answered: allow image-only verbs to fire WITHOUT an explicit
  // image word — these verbs are not used in code/CSS contexts so
  // the false-positive risk is bounded. Pin that decision so a
  // future "tighten further" refactor can't quietly invert it.
  const ws = await mkdtemp(join(tmpdir(), 'melo-fastpath-image-only-verbs-'));
  try {
    let editCalled = 0;
    const editFn = async opts => {
      editCalled += 1;
      const { writeFile } = await import('node:fs/promises');
      await writeFile(opts.outputPath, fakePng(4096));
      return { path: opts.outputPath, bytes: 4096, mimeType: 'image/png', model: 'gpt-5.5' };
    };
    const imageOnlyVerbCases = [
      'recolor it',
      'crop the bottom',
      'retouch this',
      'make it brighter',
      'make it darker',
    ];
    for (const text of imageOnlyVerbCases) {
      const reply = await tryImageEditFastPath({
        config: codexConfig(),
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text },
              { type: 'image_url', image_url: { url: dataUriPng(4096) } },
            ],
          },
        ],
        workspace: { rootPath: ws },
        editFn,
      });
      assert.ok(
        reply,
        `image-only verb "${text}" should still fire fast-path without explicit image word`,
      );
    }
    assert.equal(
      editCalled,
      imageOnlyVerbCases.length,
      'editFn must fire once per image-only-verb case',
    );
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});
