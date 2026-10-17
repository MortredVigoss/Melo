import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withWorkspaceWriter, trackWorkspaceWork, workspaceBlockState, clearWorkspaceBlock } from './workspaceScheduling.js';

// agent-loop-audit #3 (2026-10-16): a stuck underlying write after
// cancellation must not hold the workspace forever, and writers waiting
// for the lease must be released by their own abort signal.
test('a queued writer is released by its own abort while a predecessor holds the lease', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'melo-ws-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let releaseFirst;
  const first = withWorkspaceWriter(dir, null, () => new Promise(resolve => { releaseFirst = resolve; }));
  await new Promise(resolve => setTimeout(resolve, 10));
  const controller = new AbortController();
  const second = withWorkspaceWriter(dir, controller.signal, async () => 'second ran');
  setTimeout(() => controller.abort(new Error('user stopped')), 20);
  await assert.rejects(second, error => error.code === 'ABORTED');
  releaseFirst('done');
  assert.equal(await first, 'done');
});

test('stuck cancelled work blocks the workspace with a reason, then unblocks when it settles', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'melo-ws-'));
  t.after(async () => { await clearWorkspaceBlock(dir); await rm(dir, { recursive: true, force: true }); });
  let settleStuck;
  const stuck = new Promise(resolve => { settleStuck = resolve; });
  const controller = new AbortController();
  const member = withWorkspaceWriter(dir, controller.signal, async () => {
    trackWorkspaceWork(stuck); // a tool that ignores cancellation
    controller.abort(new Error('user stopped'));
    return 'member returned early';
  }, { drainGraceMs: 30 });
  assert.equal(await member, 'member returned early');
  const state = await workspaceBlockState(dir);
  assert.ok(state, 'workspace is marked blocked after the grace period');
  assert.equal(state.pending, 1);
  await assert.rejects(withWorkspaceWriter(dir, null, async () => 'must not run'), error => error.code === 'WORKSPACE_BLOCKED' && /still running/.test(error.message));
  settleStuck();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(await workspaceBlockState(dir), null, 'block clears itself once the stuck work settles');
  assert.equal(await withWorkspaceWriter(dir, null, async () => 'runs again'), 'runs again');
});

test('normal completion still drains pending side effects before releasing the lease', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'melo-ws-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const order = [];
  await withWorkspaceWriter(dir, null, async () => {
    trackWorkspaceWork(new Promise(resolve => setTimeout(() => { order.push('side effect'); resolve(); }, 30)));
    order.push('work returned');
  });
  await withWorkspaceWriter(dir, null, async () => { order.push('next writer'); });
  assert.deepEqual(order, ['work returned', 'side effect', 'next writer']);
  assert.equal(await workspaceBlockState(dir), null);
});
