/**
 * Regression tests for the cross-chat session-permission leak.
 *
 * Before the fix, `sessionAlwaysAllow` / `sessionAlwaysDeny` were
 * process-global Sets. A user granting "session allow" for a tool in
 * Chat A caused Chat B, and any Telegram chats in the same process, to
 * silently skip the permission dialog for that tool. Now the sets are
 * keyed per-chatId; these tests pin that isolation in place.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function freshModule() {
  // Cache-bust so each test gets its own in-memory state.
  const mod = await import(`./permissions.js?tc=${Date.now()}-${Math.random()}`);
  return mod;
}

async function withTempMeloHome(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'melo-perm-chat-'));
  const prevHome = process.env.MELO_HOME;
  process.env.MELO_HOME = dir;
  try {
    await mkdir(dir, { recursive: true });
    // Empty config → no persistent rules, so checkPermissionRule falls to 'ask'
    await writeFile(join(dir, 'config.json'), '{}', 'utf8');
    await fn();
  } finally {
    if (prevHome === undefined) delete process.env.MELO_HOME;
    else process.env.MELO_HOME = prevHome;
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Drive requestPermission → resolvePermission in-process, without an SSE
 * round-trip. The moment requestPermission fires its sseEmitter, we
 * capture the requestId and resolve the pending promise via
 * resolvePermission().
 */
async function grantSessionPermission(mod, { toolId, chatId, granted = true }) {
  let capturedRequestId;
  const sseEmitter = (_event, payload) => {
    capturedRequestId = payload.requestId;
    // Fire resolvePermission on the next tick so requestPermission has a
    // chance to register the pending entry.
    queueMicrotask(() => {
      mod.resolvePermission(capturedRequestId, granted, 'session', toolId);
    });
  };
  // Use try/catch because a denial throws
  try {
    await mod.requestPermission(toolId, {}, sseEmitter, undefined, chatId);
    return { granted: true };
  } catch {
    return { granted: false };
  }
}

test('session grant in Chat A does NOT leak to Chat B', async () => {
  await withTempMeloHome(async () => {
    const mod = await freshModule();

    // Chat A grants session-allow for `bash`
    await grantSessionPermission(mod, { toolId: 'bash', chatId: 'chat-A' });

    // Chat A subsequently sees it allowed without asking
    assert.equal(await mod.checkPermissionRule('bash', {}, 'chat-A'), 'allow');

    // Chat B must still be asked
    assert.equal(await mod.checkPermissionRule('bash', {}, 'chat-B'), 'ask');

    // Undefined chatId (default scope) also must be asked — no global leak
    assert.equal(await mod.checkPermissionRule('bash', {}, undefined), 'ask');
  });
});

test('session deny in Chat A does NOT leak to Chat B', async () => {
  await withTempMeloHome(async () => {
    const mod = await freshModule();

    await grantSessionPermission(mod, { toolId: 'fetch_url', chatId: 'chat-A', granted: false });

    assert.equal(await mod.checkPermissionRule('fetch_url', {}, 'chat-A'), 'deny');
    assert.equal(await mod.checkPermissionRule('fetch_url', {}, 'chat-B'), 'ask');
  });
});

test('getSessionPermissions(chatId) returns only that chat\'s rules', async () => {
  await withTempMeloHome(async () => {
    const mod = await freshModule();

    await grantSessionPermission(mod, { toolId: 'bash',     chatId: 'chat-A' });
    await grantSessionPermission(mod, { toolId: 'fetch_url',chatId: 'chat-B' });
    await grantSessionPermission(mod, { toolId: 'write_file',chatId: 'chat-B', granted: false });

    const a = mod.getSessionPermissions('chat-A');
    assert.deepEqual(a, { allow: ['bash'], deny: [] });

    const b = mod.getSessionPermissions('chat-B');
    assert.deepEqual(b.allow.sort(), ['fetch_url']);
    assert.deepEqual(b.deny.sort(),  ['write_file']);

    // No-chatId call returns the union (admin view, legacy callers)
    const all = mod.getSessionPermissions();
    assert.deepEqual(all.allow.sort(), ['bash', 'fetch_url']);
    assert.deepEqual(all.deny.sort(),  ['write_file']);
  });
});

test('clearSessionPermissions(chatId) only clears that chat', async () => {
  await withTempMeloHome(async () => {
    const mod = await freshModule();

    await grantSessionPermission(mod, { toolId: 'bash',     chatId: 'chat-A' });
    await grantSessionPermission(mod, { toolId: 'fetch_url',chatId: 'chat-B' });

    mod.clearSessionPermissions('chat-A');

    // Chat A back to ask, Chat B untouched
    assert.equal(await mod.checkPermissionRule('bash', {}, 'chat-A'), 'ask');
    assert.equal(await mod.checkPermissionRule('fetch_url', {}, 'chat-B'), 'allow');
  });
});

test('clearSessionPermissions() with no arg still clears everything (admin reset)', async () => {
  await withTempMeloHome(async () => {
    const mod = await freshModule();

    await grantSessionPermission(mod, { toolId: 'bash',     chatId: 'chat-A' });
    await grantSessionPermission(mod, { toolId: 'fetch_url',chatId: 'chat-B' });

    mod.clearSessionPermissions();

    assert.equal(await mod.checkPermissionRule('bash', {}, 'chat-A'), 'ask');
    assert.equal(await mod.checkPermissionRule('fetch_url', {}, 'chat-B'), 'ask');
  });
});

test('default-scope (no chatId) requests are isolated from named chats', async () => {
  await withTempMeloHome(async () => {
    const mod = await freshModule();

    // Grant under default scope (no chatId supplied)
    await grantSessionPermission(mod, { toolId: 'bash', chatId: undefined });

    // Default scope sees the rule
    assert.equal(await mod.checkPermissionRule('bash', {}, undefined), 'allow');

    // Named chats must be asked — no cross-pollution with the default bucket
    assert.equal(await mod.checkPermissionRule('bash', {}, 'chat-X'), 'ask');
  });
});
