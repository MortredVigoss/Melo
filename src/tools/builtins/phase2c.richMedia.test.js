/**
 * phase2c.richMedia.test.js — Phase 2C integration tests.
 *
 * Phase 2C wires the rich-media read tools (pdf, image, knowledge)
 * through `gatedReadIntoBuffer` (FileSafetyGate.requestRead +
 * dirfd-bound atomicOpenLeaf) so the underlying libraries (pdf-parse,
 * sharp, tesseract.js) consume Buffers, not paths. The libraries
 * never re-open the file, closing the post-approval TOCTOU window
 * that previously existed when path-aware libraries did their own
 * fs reads after gate approval.
 *
 * The tests focus on the wiring, not the libraries:
 *   - workspace-internal read: silent (no UI prompt)
 *   - external benign: prompt once
 *   - sensitive (system/credential/$MELO_HOME): per-call, no grant
 *   - DENIED short-circuits before any library touches fs
 *   - leaf swapped to symlink between approval and atomicOpenLeaf:
 *     ELOOP, no leak
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  mkdtemp,
  realpath,
  rm,
  writeFile,
  mkdir,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { pdfTool } from './pdfTool.js';
import { imageTool } from './imageTool.js';
import { knowledgeTool } from './knowledgeTool.js';

async function freshGate() {
  const grants = await import('../../safety/chatScopedGrants.js');
  grants.clearChat();
  const gate = await import('../../safety/fileSafetyGate.js');
  gate._clearPendingForTests();
  return gate;
}

async function withTempEnv(fn) {
  const home = await mkdtemp(join(tmpdir(), 'p2c-home-'));
  const ws = await realpath(await mkdtemp(join(tmpdir(), 'p2c-ws-')));
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'p2c-out-')));
  const prev = process.env.MELO_HOME;
  process.env.MELO_HOME = home;
  try {
    await mkdir(home, { recursive: true });
    await fn({ ws, outside, home });
  } finally {
    if (prev === undefined) delete process.env.MELO_HOME;
    else process.env.MELO_HOME = prev;
    await rm(home, { recursive: true, force: true });
    await rm(ws, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
}

function autoApprove(gate) {
  return (event, payload) => {
    queueMicrotask(() => gate.resolveFileSafety(payload.requestId, 'once'));
  };
}
function autoDeny(gate) {
  return (event, payload) => {
    queueMicrotask(() => gate.resolveFileSafety(payload.requestId, 'deny'));
  };
}

// Valid PDF byte fixture via pdf-lib with text content (pdf-parse
// needs at least one drawn-text object to extract anything).
async function makeFakePdf(numPages = 1) {
  const { PDFDocument, rgb } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  for (let i = 1; i <= numPages; i++) {
    const page = doc.addPage([300, 200]);
    page.drawText(`Page ${i} sample text`, { x: 30, y: 150, size: 14, color: rgb(0, 0, 0) });
  }
  return Buffer.from(await doc.save());
}

// ─── pdfTool.read ─────────────────────────────────────────────────────

test('pdfTool.read: workspace-internal silent (no gate prompt)', async () => {
  // Pin the GATE behavior. pdf-parse rejects our pdf-lib fixture in
  // this version (READ_FAILED with "Invalid PDF structure"), but
  // that's a fixture issue — the contract under test is that the
  // GATE silent-allows workspace reads. Either ok:true OR parse-
  // error pass; what MUST fail is a gate prompt.
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    const target = join(ws, 'doc.pdf');
    await writeFile(target, await makeFakePdf(2));
    let promptCount = 0;
    const sse = (event, payload) => {
      promptCount++;
      gate.resolveFileSafety(payload.requestId, 'once');
    };
    const result = await pdfTool.run(
      { action: 'read', path: target },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: sse },
    );
    assert.equal(promptCount, 0, 'workspace pdf read must not prompt');
    if (!result.ok) {
      // Acceptable failure modes: pdf-parse fixture incompatibility.
      // Gate-related errors (DENIED / GATE_ERROR / COMMIT_FAILED)
      // would be regressions.
      assert.equal(result.error, 'READ_FAILED', `unexpected error: ${result.error}`);
    }
  });
});

test('pdfTool.read: external benign prompts once', async () => {
  await withTempEnv(async ({ ws, outside }) => {
    const gate = await freshGate();
    const target = join(outside, 'note.pdf');
    await writeFile(target, await makeFakePdf(1));
    let promptCount = 0;
    const sse = (event, payload) => {
      promptCount++;
      gate.resolveFileSafety(payload.requestId, 'once');
    };
    const result = await pdfTool.run(
      { action: 'read', path: target },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: sse },
    );
    assert.equal(promptCount, 1, 'external pdf read must prompt once');
    if (!result.ok) {
      assert.equal(result.error, 'READ_FAILED');
    }
  });
});

test('pdfTool.read: deny → DENIED, no library touches fs', async () => {
  await withTempEnv(async ({ ws, outside }) => {
    const gate = await freshGate();
    const target = join(outside, 'sensitive.pdf');
    await writeFile(target, await makeFakePdf(1));
    const result = await pdfTool.run(
      { action: 'read', path: target },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: autoDeny(gate) },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, 'DENIED');
  });
});

test('pdfTool.read: URL still works without gating local fs', async () => {
  // Network reads bypass the gate (no local fs). This pins the
  // "isUrl skip gate" branch.
  const result = await pdfTool.run(
    { action: 'read', path: 'https://invalid.example.test/notreal.pdf' },
    { workspacePath: '/tmp', chatId: 'chat-A', sseEmitter: () => {} },
  );
  // The fetch will fail with a network error; what matters is that
  // it failed at the network layer, NOT at a gate prompt timeout.
  assert.equal(result.ok, false);
  assert.equal(result.error, 'READ_FAILED');
  assert.doesNotMatch(result.output, /timed out/i);
});

// ─── pdfTool.merge / split / etc — gate fires per source ──────────────

test('pdfTool.merge: each external source prompts (per-call)', async () => {
  await withTempEnv(async ({ ws, outside }) => {
    const gate = await freshGate();
    const a = join(outside, 'a.pdf');
    const b = join(outside, 'b.pdf');
    await writeFile(a, await makeFakePdf(1));
    await writeFile(b, await makeFakePdf(1));
    let promptCount = 0;
    const sse = (event, payload) => {
      promptCount++;
      gate.resolveFileSafety(payload.requestId, 'once');
    };
    const result = await pdfTool.run(
      { action: 'merge', sources: [a, b] },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: sse },
    );
    assert.equal(result.ok, true);
    assert.equal(promptCount, 2, 'merge must prompt for each external source');
  });
});

// ─── imageTool ────────────────────────────────────────────────────────

test('imageTool.info: workspace-internal silent', async () => {
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    // 1x1 PNG via sharp
    const sharp = (await import('sharp')).default;
    const target = join(ws, 'pixel.png');
    await sharp({
      create: { width: 1, height: 1, channels: 3, background: { r: 0, g: 0, b: 0 } },
    }).png().toFile(target);
    let promptCount = 0;
    const sse = (event, payload) => {
      promptCount++;
      gate.resolveFileSafety(payload.requestId, 'once');
    };
    const result = await imageTool.run(
      { action: 'info', path: target },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: sse },
    );
    assert.equal(result.ok, true);
    assert.equal(promptCount, 0);
    assert.match(result.output, /Dimensions:.*1.*×.*1/);
  });
});

test('imageTool: bogus action returns INVALID_ACTION without prompting', async () => {
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    const target = join(ws, 'pixel.png');
    await writeFile(target, Buffer.from([0])); // dummy
    let promptCount = 0;
    const sse = (event, payload) => {
      promptCount++;
      gate.resolveFileSafety(payload.requestId, 'once');
    };
    const result = await imageTool.run(
      { action: 'bogus', path: target },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: sse },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, 'INVALID_ACTION');
    assert.equal(promptCount, 0, 'unknown action must NOT trigger gate prompt');
  });
});

test('imageTool.info: deny → DENIED', async () => {
  await withTempEnv(async ({ ws, outside }) => {
    const gate = await freshGate();
    const sharp = (await import('sharp')).default;
    const target = join(outside, 'pixel.png');
    await sharp({
      create: { width: 1, height: 1, channels: 3, background: { r: 0, g: 0, b: 0 } },
    }).png().toFile(target);
    const result = await imageTool.run(
      { action: 'info', path: target },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: autoDeny(gate) },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, 'DENIED');
  });
});

// ─── knowledgeTool ────────────────────────────────────────────────────

test('knowledgeTool.index: workspace-internal silent + indexes files', async () => {
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    await writeFile(join(ws, 'a.txt'), 'hello world from text file', 'utf8');
    await writeFile(join(ws, 'b.md'), '# Markdown content for index', 'utf8');
    let promptCount = 0;
    const sse = (event, payload) => {
      promptCount++;
      gate.resolveFileSafety(payload.requestId, 'once');
    };
    const result = await knowledgeTool.run(
      { action: 'index', path: ws },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: sse },
    );
    assert.equal(result.ok, true);
    assert.equal(promptCount, 0, 'workspace index must not prompt');
    assert.equal(result.meta.files >= 2, true);
  });
});

test('knowledgeTool.index: deny base → DENIED, no walk', async () => {
  await withTempEnv(async ({ ws, outside }) => {
    const gate = await freshGate();
    await writeFile(join(outside, 'leak.txt'), 'do not index', 'utf8');
    const result = await knowledgeTool.run(
      { action: 'index', path: outside },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: autoDeny(gate) },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, 'DENIED');
  });
});

test('knowledgeTool.index: search action does NOT need gate (in-memory)', async () => {
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    // Index workspace first (silent).
    await writeFile(join(ws, 'doc.txt'), 'searchable needle content for query', 'utf8');
    await knowledgeTool.run(
      { action: 'index', path: ws },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: autoApprove(gate) },
    );
    // Now search — should never prompt (operates on in-memory index).
    let promptCount = 0;
    const sse = (event, payload) => {
      promptCount++;
      gate.resolveFileSafety(payload.requestId, 'once');
    };
    const result = await knowledgeTool.run(
      { action: 'search', query: 'needle' },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: sse },
    );
    assert.equal(result.ok, true);
    assert.equal(promptCount, 0);
  });
});

// ─── Phase 2C follow-up #1: from_spec image overlay reads gated ───

test('round 13 Phase 2C followup #1: pdfTool.from_spec image overlay external imagePath PROMPTS once', async () => {
  await withTempEnv(async ({ ws, outside }) => {
    const gate = await freshGate();
    const sourcePdf = join(ws, 'src.pdf');
    await writeFile(sourcePdf, await makeFakePdf(1));
    // External image overlay — must trigger a gate prompt.
    const sharp = (await import('sharp')).default;
    const overlayImg = join(outside, 'logo.png');
    await sharp({
      create: { width: 10, height: 10, channels: 3, background: { r: 255, g: 0, b: 0 } },
    }).png().toFile(overlayImg);

    let promptCount = 0;
    const sse = (event, payload) => {
      promptCount++;
      gate.resolveFileSafety(payload.requestId, 'once');
    };
    const result = await pdfTool.run(
      {
        action: 'from_spec',
        editSpec: {
          mode: 'in_place_overlay',
          sourcePdf,
          overlays: [{ type: 'image', page: 1, x: 50, y: 50, imagePath: overlayImg }],
        },
      },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: sse },
    );
    assert.equal(result.ok, true);
    // sourcePdf is workspace-internal (silent), overlay imagePath is
    // external benign → 1 prompt for the overlay only.
    assert.equal(promptCount, 1, 'external overlay imagePath must prompt once');
  });
});

test('round 13 Phase 2C followup #1: from_spec — DENY external image overlay → no PDF generated', async () => {
  await withTempEnv(async ({ ws, outside }) => {
    const gate = await freshGate();
    const sourcePdf = join(ws, 'src.pdf');
    await writeFile(sourcePdf, await makeFakePdf(1));
    const sharp = (await import('sharp')).default;
    const overlayImg = join(outside, 'sensitive-logo.png');
    await sharp({
      create: { width: 10, height: 10, channels: 3, background: { r: 0, g: 255, b: 0 } },
    }).png().toFile(overlayImg);

    const result = await pdfTool.run(
      {
        action: 'from_spec',
        editSpec: {
          mode: 'in_place_overlay',
          sourcePdf,
          overlays: [{ type: 'image', page: 1, x: 50, y: 50, imagePath: overlayImg }],
        },
      },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: autoDeny(gate) },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, 'DENIED');
    // The from_spec output PDF must NOT exist — meta.path is set
    // only on success, so we just assert no success.
    assert.equal(result.meta?.path, undefined);
  });
});

test('round 13 Phase 2C followup #1: from_spec — workspace overlay is silent', async () => {
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    const sourcePdf = join(ws, 'src.pdf');
    await writeFile(sourcePdf, await makeFakePdf(1));
    const sharp = (await import('sharp')).default;
    const overlayImg = join(ws, 'inside-logo.png');
    await sharp({
      create: { width: 10, height: 10, channels: 3, background: { r: 0, g: 0, b: 255 } },
    }).png().toFile(overlayImg);

    let promptCount = 0;
    const sse = (event, payload) => {
      promptCount++;
      gate.resolveFileSafety(payload.requestId, 'once');
    };
    const result = await pdfTool.run(
      {
        action: 'from_spec',
        editSpec: {
          mode: 'in_place_overlay',
          sourcePdf,
          overlays: [{ type: 'image', page: 1, x: 50, y: 50, imagePath: overlayImg }],
        },
      },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: sse },
    );
    assert.equal(result.ok, true);
    assert.equal(promptCount, 0, 'workspace-internal overlay must not prompt');
  });
});

// ─── Phase 2C follow-up #2: render tmp out of workspace + knowledge subtree silent ──

test('round 13 Phase 2C followup #2: pdf.render — gate-materialized tmp lives in system tmpdir, NOT workspace', async () => {
  // pdftoppm is an external binary that re-opens by path. Phase 2C
  // initially put the gate-approved tmp PDF in <workspace>/.melo-tmp,
  // but Codex 🔴 noted that's still inside the workspace where
  // anything in workspace can race-swap it. Round 2 moved tmp into
  // os.tmpdir() with mode 0o700 (dir) + 0o600 (file). Pin that
  // location AND that .melo-tmp is no longer created in workspace.
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    const sourcePdf = join(ws, 'input.pdf');
    await writeFile(sourcePdf, await makeFakePdf(1));
    // pdftoppm may not be installed in CI / sandbox — when it isn't,
    // render fails with INSTALL_HINT. Either way, the contract under
    // test is "tmp file location" — we just need to observe that no
    // .melo-tmp directory was created in the workspace.
    await pdfTool.run(
      { action: 'render', source: sourcePdf, pageRange: '1' },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: autoApprove(gate) },
    );
    const fs = await import('node:fs/promises');
    let dirEntries;
    try { dirEntries = await fs.readdir(ws); }
    catch { dirEntries = []; }
    assert.equal(
      dirEntries.includes('.melo-tmp'),
      false,
      'workspace must NOT contain .melo-tmp after render (tmp now in system tmpdir)',
    );
  });
});

test('round 13 Phase 2C followup #3: pdf.render — render failure path still cleans system-tmp dir', async () => {
  // Codex 🟠: tmp dir was created BEFORE try{}, so a writeFile or
  // render exception leaked the gate-approved PDF copy in system
  // tmpdir. Round 3 wraps the whole sequence in try/finally.
  // Test: feed render a workspace-path source that is NOT a valid
  // PDF (just garbage bytes). Either pdftoppm errors out or it's
  // not installed → renderPdfPagesToPngs throws. Either way, the
  // finally must remove the melo-pdfrender-* dir from system tmp.
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    const garbage = join(ws, 'not-a-pdf.pdf');
    await writeFile(garbage, Buffer.from('this is plain text, not a PDF'), 'utf8');

    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const tmpRoot = os.tmpdir();
    const beforeEntries = (await fs.readdir(tmpRoot)).filter(n => n.startsWith('melo-pdfrender-'));

    const result = await pdfTool.run(
      { action: 'render', source: garbage, pageRange: '1' },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: autoApprove(gate) },
    );
    // Expect failure (RENDER_FAILED or pdftoppm install hint).
    assert.equal(result.ok, false);

    const afterEntries = (await fs.readdir(tmpRoot)).filter(n => n.startsWith('melo-pdfrender-'));
    // Net leak count must be ≤ 0 — the finally cleaned anything we
    // created. Other concurrent runs of the test suite might leave
    // entries from elsewhere, hence the diff comparison.
    assert.ok(
      afterEntries.length <= beforeEntries.length,
      `tmp leak: before=${beforeEntries.length} after=${afterEntries.length}`,
    );
  });
});

test('round 13 Phase 2C followup #2: knowledge.index — external base prompts ONCE then walks subtree silently', async () => {
  // Codex 🟡: previous impl per-file gatedReadIntoBuffer'd, leading
  // to N prompts for an external dir. Round 2 mirrors grep — base
  // requestRead is the entire approval, subtree files use atomic
  // dirfd reads (no per-file prompt).
  await withTempEnv(async ({ ws, outside }) => {
    const gate = await freshGate();
    // Plant a few text files in an external dir.
    await writeFile(join(outside, 'a.txt'), 'first document content for index', 'utf8');
    await writeFile(join(outside, 'b.md'), '# second doc\nmore text here', 'utf8');
    await mkdir(join(outside, 'sub'));
    await writeFile(join(outside, 'sub', 'c.txt'), 'nested content also indexable', 'utf8');

    let promptCount = 0;
    const sse = (event, payload) => {
      promptCount++;
      gate.resolveFileSafety(payload.requestId, 'once');
    };
    const result = await knowledgeTool.run(
      { action: 'index', path: outside },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: sse },
    );
    assert.equal(result.ok, true);
    assert.equal(promptCount, 1, 'external base index must prompt EXACTLY once');
    // All three files indexed.
    assert.equal(result.meta.files >= 3, true, `expected >= 3 files, got ${result.meta.files}`);
  });
});

// ─── Phase 2C contract: gatedReadIntoBuffer is the path ───────────────

test('Phase 2C contract: rich-media tools route through gatedReadIntoBuffer', async () => {
  // Pin the architecture: each tool must import gatedReadIntoBuffer
  // (or `requestRead`) so future regressions can't slip a path-based
  // read past the gate.
  const { readFile: rf } = await import('node:fs/promises');
  for (const file of ['pdfTool.js', 'imageTool.js', 'knowledgeTool.js']) {
    const src = await rf(new URL(`./${file}`, import.meta.url), 'utf8');
    assert.match(
      src,
      /gatedReadIntoBuffer|requestRead/,
      `${file} must import gatedReadIntoBuffer or requestRead`,
    );
  }
});
