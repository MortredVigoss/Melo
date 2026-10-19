import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, fstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureFileIdentity, unlinkatChecked, unlinkOpenedLeaf, atomicOpenLeaf, C, _raw } from './dirfdOps.js';
import * as gate from './fileSafetyGate.js';
import { clearChat } from './chatScopedGrants.js';
import { fileWriteTool } from '../tools/builtins/fileWriteTool.js';
import { fileEditTool } from '../tools/builtins/fileEditTool.js';
import { fileMoveTool } from '../tools/builtins/fileMoveTool.js';
import { fileDeleteTool } from '../tools/builtins/fileDeleteTool.js';
import { fileMkdirTool } from '../tools/builtins/fileMkdirTool.js';

async function fixture(fn) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'file-identity-')));
  const home = join(root, 'home');
  const ws = join(root, 'workspace');
  mkdirSync(home); mkdirSync(ws);
  const previous = process.env.MELO_HOME;
  process.env.MELO_HOME = home;
  clearChat(); gate._clearPendingForTests();
  try { await fn({ root, ws }); }
  finally {
    gate._clearPendingForTests(); clearChat();
    if (previous === undefined) delete process.env.MELO_HOME;
    else process.env.MELO_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

const cases = [
  ['write', fileWriteTool, path => ({ path, content: 'changed' })],
  ['edit', fileEditTool, path => ({ path, old_string: 'original', new_string: 'changed' })],
  ['move', fileMoveTool, path => ({ src: path, dst: `${path}.moved` })],
  ['delete', fileDeleteTool, path => ({ paths: [path] })],
  ['mkdir', fileMkdirTool, path => ({ path })],
];
for (const [name, tool, args] of cases) {
  for (const swap of ['parent', 'entry']) {
    test(`${name}: ${swap} replaced during approval leaves the replacement intact`, async () => fixture(async ({ ws }) => {
      const parent = join(ws, 'dir'); mkdirSync(parent);
      const path = join(parent, 'item');
      if (name !== 'mkdir') writeFileSync(path, 'original');
      let changed = false;
      const result = await tool.run(args(path), {
        workspacePath: ws, chatId: 'identity',
        sseEmitter(_event, payload) {
          if (!changed) {
            changed = true;
            if (swap === 'parent') { rmSync(parent, { recursive: true }); mkdirSync(parent); }
            else rmSync(path, { force: true });
            // Identical content defeats hash-only checks. A held identity must
            // refuse even if the allocator would otherwise recycle the inode.
            writeFileSync(path, 'original');
          }
          queueMicrotask(() => gate.resolveFileSafety(payload.requestId, 'once', {
            confirmInput: payload.expectedConfirmation,
          }));
        },
      });
      assert.equal(changed, true, 'the production approval path was reached');
      assert.equal(result.ok, false);
      assert.equal(readFileSync(path, 'utf8'), 'original');
      assert.equal(existsSync(`${path}.moved`), false);
    }));
  }
}

test('checked operations reject numeric snapshots and released identities before touching disk', async () => fixture(async ({ ws }) => {
  const path = join(ws, 'file'); writeFileSync(path, 'original');
  await assert.rejects(unlinkatChecked(ws, 'file', 1, 1), { code: 'FILE_SAFETY_DENIED' });
  const identity = captureFileIdentity(path); identity.close(); identity.close();
  await assert.rejects(unlinkatChecked(ws, 'file', identity), { code: 'FILE_SAFETY_DENIED' });
  assert.equal(readFileSync(path, 'utf8'), 'original');
}));

test('restore-style O_TRUNC refuses a swapped file before truncating it', async () => fixture(async ({ ws }) => {
  const path = join(ws, 'file'); writeFileSync(path, 'original');
  const identity = captureFileIdentity(path);
  try {
    rmSync(path); writeFileSync(path, 'replacement');
    await assert.rejects(atomicOpenLeaf(ws, 'file', C.O_WRONLY | C.O_TRUNC, 0o644, identity), { code: 'FILE_SAFETY_DENIED' });
    assert.equal(readFileSync(path, 'utf8'), 'replacement');
  } finally { identity.close(); }
}));

test('failed-create cleanup leaves a replacement intact and removes its own placeholder', async () => fixture(async ({ ws }) => {
  for (const replace of [false, true]) {
    const path = join(ws, replace ? 'replacement' : 'placeholder');
    const identity = captureFileIdentity(path);
    const opened = await atomicOpenLeaf(ws, identity.leaf, C.O_RDWR | C.O_CREAT | C.O_EXCL, 0o644, identity);
    try {
      if (replace) {
        rmSync(path); writeFileSync(path, 'replacement');
        assert.throws(() => unlinkOpenedLeaf(ws, identity.leaf, opened.leafFd, identity), { code: 'FILE_SAFETY_DENIED' });
        assert.equal(readFileSync(path, 'utf8'), 'replacement');
      } else {
        unlinkOpenedLeaf(ws, identity.leaf, opened.leafFd, identity);
        assert.equal(existsSync(path), false);
      }
    } finally { opened.closeLeaf(); identity.close(); }
  }
}));

// Observe real descriptors, not merely a resource-counter implementation.
async function trackPins(fn) {
  const saved = _raw.openIdentityAt;
  const opened = new Set();
  _raw.openIdentityAt = (...args) => { const fd = saved(...args); opened.add(fd); return fd; };
  try {
    await fn();
    assert.ok(opened.size > 0);
    for (const fd of opened) assert.throws(() => fstatSync(fd), { code: 'EBADF' });
  } finally { _raw.openIdentityAt = saved; }
}

for (const outcome of ['deny', 'abort', 'timeout', 'emitter-error']) {
  test(`approval ${outcome} releases pinned descriptors`, async t => fixture(async ({ ws }) => {
    const path = join(ws, 'file'); writeFileSync(path, 'original');
    const controller = new AbortController();
    if (outcome === 'timeout') t.mock.timers.enable({ apis: ['setTimeout'] });
    await trackPins(async () => {
      await assert.rejects(gate.requestWrite({
        path, chatId: 'identity', signal: controller.signal,
        sseEmitter(_event, payload) {
          if (outcome === 'emitter-error') throw new Error('emitter failed');
          queueMicrotask(() => {
            if (outcome === 'deny') gate.resolveFileSafety(payload.requestId, 'deny');
            if (outcome === 'abort') controller.abort();
            if (outcome === 'timeout') t.mock.timers.tick(120_001);
          });
        },
      }));
    });
    assert.equal(readFileSync(path, 'utf8'), 'original');
  }));
}

test('unused approval expires and releases descriptors', async t => fixture(async ({ ws }) => {
  const path = join(ws, 'file'); writeFileSync(path, 'original');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await trackPins(async () => {
    const approval = await gate.requestWrite({ path, chatId: 'identity', sseEmitter(_event, payload) {
      queueMicrotask(() => gate.resolveFileSafety(payload.requestId, 'once'));
    } });
    t.mock.timers.tick(300_001);
    await assert.rejects(gate.commitOperation(approval.operationToken), /unknown|expired/);
  });
}));

test('cancelling an approved but unconsumed request releases its token handles', async () => fixture(async ({ ws }) => {
  const path = join(ws, 'file'); writeFileSync(path, 'original');
  const controller = new AbortController();
  await trackPins(async () => {
    const approval = await gate.requestWrite({ path, chatId: 'identity', signal: controller.signal,
      sseEmitter(_event, payload) { queueMicrotask(() => gate.resolveFileSafety(payload.requestId, 'once')); },
    });
    controller.abort();
    await assert.rejects(gate.commitOperation(approval.operationToken), /unknown/);
  });
}));

test('concurrent commits cannot consume the same approval twice', async () => fixture(async ({ ws }) => {
  const path = join(ws, 'file'); writeFileSync(path, 'original');
  await trackPins(async () => {
    const approval = await gate.requestWrite({ path, chatId: 'identity',
      sseEmitter(_event, payload) { queueMicrotask(() => gate.resolveFileSafety(payload.requestId, 'once')); },
    });
    const results = await Promise.allSettled([
      gate.commitOperation(approval.operationToken), gate.commitOperation(approval.operationToken),
    ]);
    assert.deepEqual(results.map(result => result.status), ['fulfilled', 'rejected']);
  });
}));

test('successful tool and failed commit release approval and pre-read handles', async () => fixture(async ({ ws }) => {
  const path = join(ws, 'file'); writeFileSync(path, 'original');
  await trackPins(async () => {
    const result = await fileWriteTool.run({ path, content: 'changed' }, {
      workspacePath: ws, chatId: 'identity', sseEmitter(_event, payload) {
        queueMicrotask(() => gate.resolveFileSafety(payload.requestId, 'once'));
      },
    });
    assert.equal(result.ok, true);
  });
  await trackPins(async () => {
    const approval = await gate.requestWrite({ path, chatId: 'identity', sseEmitter(_event, payload) {
      queueMicrotask(() => gate.resolveFileSafety(payload.requestId, 'once'));
    } });
    await assert.rejects(gate.commitOperation(approval.operationToken, { expectedKind: gate.OP_KIND.DELETE }), /kind mismatch/);
  });
}));
