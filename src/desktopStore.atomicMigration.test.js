/**
 * 2026-05-23 架构 audit #3 闭环: no-lost-update concurrency tests for the
 * desktopStore functions migrated from read-modify-write → updateStateAtomically.
 *
 * Real-invariant tests (per feedback_test_must_validate_real_invariant): each
 * fires N concurrent mutations that DON'T conflict on the same field, then
 * asserts ALL of them survive.  Under the old RMW pattern (loadState at the
 * top, saveState at the bottom, both outside the write queue), the concurrent
 * calls all load the same baseline and the last saveState clobbers the rest —
 * so most updates would be lost.  With updateStateAtomically each call
 * re-reads the freshest state inside the serialized write queue, so every
 * non-conflicting update lands.
 *
 * These would FAIL against the pre-migration code — they exercise the actual
 * lost-update window, not just serial correctness.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEMP_HOME = mkdtempSync(join(tmpdir(), 'melo-atomic-migration-test-'));
process.env.MELO_HOME = TEMP_HOME;

const {
  toggleConnector,
  updateDesktopSettings,
  createChat,
} = await import('./desktopStore.js');
// loadState is imported (not re-exported) by desktopStore — read it from
// the store module directly for post-barrage assertions.
const { loadState } = await import('./state/stateStore.js');

test('concurrent toggleConnector (different connectors) — none lost', async () => {
  // Fire 12 concurrent toggles, each enabling a DIFFERENT connector id.
  // Atomic: all 12 end up enabled.  Old RMW: each reads the same baseline
  // set, adds its own id, last save wins → only ~1 connector enabled.
  const ids = Array.from({ length: 12 }, (_, i) => `connector-${i}`);
  await Promise.all(ids.map(id => toggleConnector(id)));

  const state = await loadState();
  const enabled = new Set(state.settings.enabledConnectorIds || []);
  const missing = ids.filter(id => !enabled.has(id));
  assert.equal(missing.length, 0,
    `every concurrently-toggled connector must be enabled; missing: ${missing.join(', ')}`);
});

test('concurrent updateDesktopSettings (different keys) — none lost', async () => {
  // Each call writes a DIFFERENT free-form settings key.  Atomic: all keys
  // present.  Old RMW: interleaved load/save loses all but the last.
  // Use keys that pass through the settings spread untouched (not
  // normalized/whitelisted ones like promptHistory).
  const keys = Array.from({ length: 12 }, (_, i) => `__atomicTestKey_${i}`);
  await Promise.all(keys.map((k, i) => updateDesktopSettings({ [k]: `val-${i}` })));

  const state = await loadState();
  const missing = keys.filter((k, i) => state.settings[k] !== `val-${i}`);
  assert.equal(missing.length, 0,
    `every concurrently-written settings key must persist; missing/wrong: ${missing.join(', ')}`);
});

test('concurrent createChat — every chat survives (no clobbered unshift)', async () => {
  // 5 concurrent creates, comfortably under MAX_RECENT_CHATS (10) so the
  // auto-prune doesn't confound the count.  Atomic: chat count grows by 5.
  // Old RMW: all 5 unshift onto the same baseline, last save wins → +1.
  const before = (await loadState()).chats.length;
  await Promise.all(Array.from({ length: 5 }, () => createChat({ mode: 'chat' })));
  const after = (await loadState()).chats.length;
  assert.equal(after - before, 5,
    `all 5 concurrent createChat must persist (no lost unshift); grew by ${after - before}`);
});

test.after(() => {
  try { rmSync(TEMP_HOME, { recursive: true, force: true }); } catch {}
});
