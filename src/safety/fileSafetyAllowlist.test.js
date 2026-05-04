// fileSafetyAllowlist.test.js — Phase 3b persistent allow rules.
// Verifies:
//   - addRule round-trips through saveConfig and is observable via list/find
//   - findMatchingRule honours operation, scope (file vs dir), and the
//     write-rule-covers-edit semantics
//   - removeRule is idempotent on unknown ids and persists removals
//   - deduping on (operation, scope, realPath) prevents proliferation
//   - the gate's read/write/edit silent-allow path actually consults the
//     allowlist (i.e. an exact-file rule suppresses the prompt)

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Two separate temp dirs:
//   - homeDir is set as MELO_HOME (config persistence target). Anything
//     written under it classifies as melo_internal and is hard-blocked
//     by the gate, so file-op targets MUST live outside.
//   - workDir is a sibling tree we use for read/write/edit targets.
async function withTempEnv(fn) {
  const homeDir = await mkdtemp(join(tmpdir(), 'melo-fsa-home-'));
  const workDirRaw = await mkdtemp(join(tmpdir(), 'melo-fsa-work-'));
  // macOS resolves /var/folders/... → /private/var/folders/... — the gate's
  // allowlist lookup uses the resolved real path, so the tests must add
  // rules under that same canonicalized form. Without this, every gate
  // integration test would miss-match the rule and time out waiting on
  // the prompt that the test setup never resolves.
  const workDir = await realpath(workDirRaw);
  const prev = process.env.MELO_HOME;
  process.env.MELO_HOME = homeDir;
  try {
    await mkdir(homeDir, { recursive: true });
    await mkdir(workDir, { recursive: true });
    await fn({ homeDir, workDir });
  } finally {
    if (prev === undefined) delete process.env.MELO_HOME;
    else process.env.MELO_HOME = prev;
    await rm(homeDir, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  }
}

async function freshAllowlist() {
  const mod = await import('./fileSafetyAllowlist.js');
  mod._resetCacheForTesting();
  return mod;
}

async function freshGate() {
  const grantsMod = await import('./chatScopedGrants.js');
  grantsMod.clearChat();
  const gateMod = await import('./fileSafetyGate.js');
  gateMod._clearPendingForTests();
  const allowlistMod = await import('./fileSafetyAllowlist.js');
  allowlistMod._resetCacheForTesting();
  return { gate: gateMod, grants: grantsMod, allowlist: allowlistMod };
}

test('addFileSafetyRule persists then findMatchingFileSafetyRule reads it back', async () => {
  await withTempEnv(async ({ workDir }) => {
    const allowlist = await freshAllowlist();
    const target = join(workDir, 'project', 'src', 'main.js');
    await mkdir(join(workDir, 'project', 'src'), { recursive: true });
    await writeFile(target, 'export default 1;');

    const rule = await allowlist.addFileSafetyRule({
      operation: 'read',
      scope: 'file',
      realPath: target,
    });
    assert.ok(rule.id);
    assert.equal(rule.operation, 'read');

    const hit = await allowlist.findMatchingFileSafetyRule('read', target);
    assert.ok(hit, 'exact-file read rule should match the same realPath');
    assert.equal(hit.id, rule.id);

    const miss = await allowlist.findMatchingFileSafetyRule('read', join(workDir, 'project', 'other.js'));
    assert.equal(miss, null, 'exact-file rule must not match a sibling path');
  });
});

test('dir-scope rule matches the dir itself and any descendant', async () => {
  await withTempEnv(async ({ workDir }) => {
    const allowlist = await freshAllowlist();
    const trustedDir = join(workDir, 'workspace');
    await mkdir(trustedDir, { recursive: true });

    await allowlist.addFileSafetyRule({
      operation: 'read',
      scope: 'dir',
      realPath: trustedDir,
    });

    assert.ok(await allowlist.findMatchingFileSafetyRule('read', trustedDir));
    assert.ok(await allowlist.findMatchingFileSafetyRule('read', join(trustedDir, 'a.js')));
    assert.ok(await allowlist.findMatchingFileSafetyRule('read', join(trustedDir, 'sub', 'b.txt')));

    // Sibling outside the dir must NOT match — no prefix-without-separator
    // false positives (e.g. /tmp/workspace shouldn't match /tmp/workspace2).
    const sibling = trustedDir + '2';
    await mkdir(sibling, { recursive: true });
    const miss = await allowlist.findMatchingFileSafetyRule('read', join(sibling, 'a.js'));
    assert.equal(miss, null);
  });
});

test('write rule covers edit at lookup time', async () => {
  await withTempEnv(async ({ workDir }) => {
    const allowlist = await freshAllowlist();
    const target = join(workDir, 'doc.md');
    await writeFile(target, '# hi');

    await allowlist.addFileSafetyRule({
      operation: 'write',
      scope: 'file',
      realPath: target,
    });

    assert.ok(await allowlist.findMatchingFileSafetyRule('write', target));
    assert.ok(await allowlist.findMatchingFileSafetyRule('edit', target),
      'a write rule must satisfy an edit lookup (narrower op, same blast radius)');
    // But a read lookup must NOT silently inherit a write rule — read intent
    // is its own decision.
    assert.equal(await allowlist.findMatchingFileSafetyRule('read', target), null);
  });
});

test('addFileSafetyRule is idempotent on (operation, scope, realPath)', async () => {
  await withTempEnv(async ({ workDir }) => {
    const allowlist = await freshAllowlist();
    const target = join(workDir, 'a.js');
    await writeFile(target, 'x');

    const a = await allowlist.addFileSafetyRule({ operation: 'read', scope: 'file', realPath: target });
    const b = await allowlist.addFileSafetyRule({ operation: 'read', scope: 'file', realPath: target });
    assert.equal(a.id, b.id, 'duplicate insert must reuse the existing rule id');

    const list = await allowlist.listFileSafetyRules();
    assert.equal(list.length, 1, 'allowlist must not contain duplicate rules');
  });
});

test('removeFileSafetyRule deletes by id and is no-op for unknown ids', async () => {
  await withTempEnv(async ({ workDir }) => {
    const allowlist = await freshAllowlist();
    const target = join(workDir, 'a.js');
    await writeFile(target, 'x');

    const rule = await allowlist.addFileSafetyRule({
      operation: 'edit',
      scope: 'file',
      realPath: target,
    });

    assert.equal(await allowlist.removeFileSafetyRule('not-a-real-id'), false);
    assert.equal(await allowlist.removeFileSafetyRule(rule.id), true);

    const list = await allowlist.listFileSafetyRules();
    assert.equal(list.length, 0);
    assert.equal(await allowlist.findMatchingFileSafetyRule('edit', target), null);
  });
});

test('addFileSafetyRule rejects invalid operation / scope', async () => {
  await withTempEnv(async () => {
    const allowlist = await freshAllowlist();
    await assert.rejects(
      allowlist.addFileSafetyRule({ operation: 'delete', scope: 'file', realPath: '/tmp/x' }),
      /Invalid file-safety rule/,
    );
    await assert.rejects(
      allowlist.addFileSafetyRule({ operation: 'read', scope: 'tree', realPath: '/tmp/x' }),
      /Invalid file-safety rule/,
    );
    await assert.rejects(
      allowlist.addFileSafetyRule({ operation: 'read', scope: 'file', realPath: '' }),
      /Invalid file-safety rule/,
    );
  });
});

// ── Gate integration ──────────────────────────────────────────────────

test('requestRead with a matching exact-file rule skips the prompt', async () => {
  await withTempEnv(async ({ workDir }) => {
    const { gate, allowlist } = await freshGate();
    const target = join(workDir, 'allowed.txt');
    await writeFile(target, 'ok');
    await allowlist.addFileSafetyRule({ operation: 'read', scope: 'file', realPath: target });

    const events = [];
    const sse = (e, p) => events.push({ e, p });
    const result = await gate.requestRead({
      path: target,
      chatId: 'chat-Z',
      sseEmitter: sse,
      // No workspacePath — so without a matching rule this would prompt.
    });
    assert.equal(events.length, 0, 'allowlist hit must suppress the prompt');
    assert.equal(result.resolvedTarget, target);
  });
});

test('requestWrite with a matching exact-file rule skips the prompt', async () => {
  await withTempEnv(async ({ workDir }) => {
    const { gate, allowlist } = await freshGate();
    const target = join(workDir, 'note.md');
    await writeFile(target, 'old');
    await allowlist.addFileSafetyRule({ operation: 'write', scope: 'file', realPath: target });

    const events = [];
    const sse = (e, p) => events.push({ e, p });
    const result = await gate.requestWrite({
      path: target,
      chatId: 'chat-Z',
      sseEmitter: sse,
    });
    assert.equal(events.length, 0);
    assert.equal(result.resolvedTarget, target);
    assert.ok(result.operationToken);
  });
});

test('requestEdit honours a write-scope rule (write covers edit)', async () => {
  await withTempEnv(async ({ workDir }) => {
    const { gate, allowlist } = await freshGate();
    const target = join(workDir, 'thing.js');
    await writeFile(target, 'one');
    await allowlist.addFileSafetyRule({ operation: 'write', scope: 'file', realPath: target });

    const events = [];
    const sse = (e, p) => events.push({ e, p });
    const result = await gate.requestEdit({
      path: target,
      chatId: 'chat-Z',
      sseEmitter: sse,
    });
    assert.equal(events.length, 0);
    assert.equal(result.resolvedTarget, target);
  });
});

test('persistent flag from resolveFileSafety writes a rule on top of the per-chat grant', async () => {
  await withTempEnv(async ({ workDir }) => {
    const { gate, allowlist } = await freshGate();
    const target = join(workDir, 'doc.txt');
    await writeFile(target, 'hi');

    let captured = null;
    const sse = (event, payload) => {
      captured = payload;
      queueMicrotask(() => {
        gate.resolveFileSafety(payload.requestId, 'file', { persistent: true });
      });
    };

    const result = await gate.requestWrite({
      path: target,
      chatId: 'chat-Z',
      sseEmitter: sse,
    });
    assert.ok(captured, 'prompt should fire when no rule exists yet');
    assert.equal(result.resolvedTarget, target);

    const list = await allowlist.listFileSafetyRules();
    assert.equal(list.length, 1, 'persistent flag must produce exactly one rule');
    assert.equal(list[0].operation, 'write');
    assert.equal(list[0].scope, 'file');
    assert.equal(list[0].realPath, target);

    // Subsequent write to same path should be silent.
    const events2 = [];
    const sse2 = (e, p) => events2.push({ e, p });
    await gate.requestWrite({
      path: target,
      chatId: 'chat-Z',
      sseEmitter: sse2,
    });
    assert.equal(events2.length, 0, 'rule written by previous prompt must suppress the next one');
  });
});
