/**
 * Server-side regression for the connector autosave revision gate
 * (Codex C 第十一轮 audit, 2026-04-28).
 *
 * Background: connector form's 3-second idle autosave can race itself.
 * An older inflight POST can still be processing on the server when
 * a newer pending body gets beaconed at unload. sendBeacon doesn't
 * guarantee delivery order, so without a server-side ordering check
 * the older body could land last and silently overwrite the user's
 * latest typing. The fix: every autosave/flush attaches a monotonic
 * `_autosaveRevision` (Date.now() on the client). updateModelConfig
 * rejects a patch whose revision is <= the saved revision.
 *
 * Explicit Save (handleSaveConnectorConfig) deliberately omits the
 * revision field — it's a force-write that bumps the saved revision
 * to max(current, Date.now()), invalidating every autosave revision
 * older than that.
 *
 * Same MELO_HOME-isolated pattern as desktopStore.minimaxVoiceConfig.test.js.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEMP_HOME = mkdtempSync(join(tmpdir(), 'melo-autosave-rev-test-'));
process.env.MELO_HOME = TEMP_HOME;

const { updateModelConfig } = await import('./desktopStore.js');

test('autosave: a body with no _autosaveRevision (explicit Save) writes and bumps current', async () => {
  // Brand-new config: autosaveRevision starts at 0. An explicit Save
  // (no _autosaveRevision metadata) must apply AND bump the saved
  // revision past Date.now() so that any older in-flight autosave
  // landing afterwards is automatically rejected.
  const before = Date.now();
  const bootstrap = await updateModelConfig({
    minimaxApiKey: 'sk-explicit-save',
    minimaxGroupId: 'group-from-explicit',
  });
  // Saved value should land.
  assert.equal(bootstrap.settings.config.hasMinimaxKey, true);
  assert.equal(bootstrap.settings.config.minimaxGroupId, 'group-from-explicit');

  // Inspect the on-disk config: autosaveRevision should now be
  // >= the wall-clock at the start of this test, proving the bump.
  const cfgPath = join(TEMP_HOME, 'config.json');
  const persisted = JSON.parse(readFileSync(cfgPath, 'utf8'));
  assert.ok(
    typeof persisted.autosaveRevision === 'number' && persisted.autosaveRevision >= before,
    `autosaveRevision must be bumped to >= ${before}, got ${persisted.autosaveRevision}`,
  );
});

test('autosave: newer revision applies and bumps saved revision to that value', async () => {
  const t1 = Date.now() + 1_000_000;
  const bootstrap1 = await updateModelConfig({
    minimaxApiKey: 'sk-rev-1',
    _autosaveRevision: t1,
  });
  assert.equal(bootstrap1.settings.config.hasMinimaxKey, true);

  const cfgPath = join(TEMP_HOME, 'config.json');
  let persisted = JSON.parse(readFileSync(cfgPath, 'utf8'));
  assert.equal(persisted.autosaveRevision, t1, 'first autosave bumps to its own revision');
  // _autosaveRevision is metadata, never persisted as a config field.
  assert.equal(
    '_autosaveRevision' in persisted,
    false,
    '_autosaveRevision must be stripped before persisting; it is metadata not config',
  );

  // A later, larger revision lands and bumps further.
  const t2 = t1 + 5_000;
  await updateModelConfig({ minimaxGroupId: 'group-rev-2', _autosaveRevision: t2 });
  persisted = JSON.parse(readFileSync(cfgPath, 'utf8'));
  assert.equal(persisted.autosaveRevision, t2);
  assert.equal(persisted.minimaxGroupId, 'group-rev-2');
});

test('autosave: STALE revision (<= current) is rejected — older inflight cannot overwrite newer pending', async () => {
  // Seed with a known high revision.
  const newer = Date.now() + 2_000_000;
  await updateModelConfig({
    minimaxApiKey: 'sk-newer-pending',
    minimaxGroupId: 'group-newer',
    _autosaveRevision: newer,
  });

  // Now simulate an older inflight body landing: same payload shape,
  // but smaller revision. Server must refuse to apply.
  const older = newer - 1000;
  const bootstrap = await updateModelConfig({
    minimaxApiKey: 'sk-older-stale-DO-NOT-WRITE',
    minimaxGroupId: 'group-older-stale-DO-NOT-WRITE',
    _autosaveRevision: older,
  });
  // Returned bootstrap reflects the unchanged saved state — same
  // 'newer' values, NOT the stale older ones.
  assert.equal(bootstrap.settings.config.minimaxGroupId, 'group-newer',
    'older inflight body must NOT overwrite newer saved state');

  const cfgPath = join(TEMP_HOME, 'config.json');
  const persisted = JSON.parse(readFileSync(cfgPath, 'utf8'));
  // mask reads from minimaxApiKey field — verify directly.
  assert.equal(persisted.minimaxApiKey, 'sk-newer-pending', 'saved key must stay newer');
  assert.equal(persisted.autosaveRevision, newer, 'saved revision must stay at the newer value');
});

test('autosave: equal revision is also rejected (defensive against duplicate beacons)', async () => {
  const r = Date.now() + 3_000_000;
  await updateModelConfig({ minimaxGroupId: 'group-equal-base', _autosaveRevision: r });

  // Replay the same revision with a different body — must NOT apply.
  await updateModelConfig({ minimaxGroupId: 'group-equal-replay', _autosaveRevision: r });

  const cfgPath = join(TEMP_HOME, 'config.json');
  const persisted = JSON.parse(readFileSync(cfgPath, 'utf8'));
  assert.equal(persisted.minimaxGroupId, 'group-equal-base',
    'equal revision must be treated as stale — replay attacks / accidental duplicate beacons cannot resurrect old data');
});

test('autosave: explicit Save (no revision) AFTER a high autosave revision still wins and bumps further', async () => {
  // Seed with a high autosave revision.
  const high = Date.now() + 4_000_000;
  await updateModelConfig({
    minimaxApiKey: 'sk-from-autosave',
    _autosaveRevision: high,
  });

  // Explicit Save: no _autosaveRevision. Must apply (force-write)
  // AND bump revision to max(high, Date.now()) — Date.now() in
  // real usage is ALWAYS smaller than `high` here because we
  // contrived `high = Date.now() + 4_000_000`, so the bump is to
  // `high` (max preserves it). What matters: the explicit save
  // body lands.
  const bootstrap = await updateModelConfig({ minimaxApiKey: 'sk-explicit-overrides' });
  assert.equal(bootstrap.settings.config.hasMinimaxKey, true);

  const cfgPath = join(TEMP_HOME, 'config.json');
  const persisted = JSON.parse(readFileSync(cfgPath, 'utf8'));
  assert.equal(persisted.minimaxApiKey, 'sk-explicit-overrides');
  assert.ok(
    persisted.autosaveRevision >= high,
    `explicit Save must bump revision to >= ${high}, got ${persisted.autosaveRevision}`,
  );
});

test('autosave: stale revision rejection returns full bootstrap so client applyBootstrap reads newer state', async () => {
  // The contract: even when we reject the patch, return the current
  // bootstrap so a confused client (e.g. one that just unload-flushed
  // a stale beacon) can rehydrate to the truth.
  const r = Date.now() + 5_000_000;
  await updateModelConfig({
    minimaxApiKey: 'sk-truth',
    minimaxGroupId: 'group-truth',
    _autosaveRevision: r,
  });

  const stale = await updateModelConfig({
    minimaxApiKey: 'sk-junk',
    minimaxGroupId: 'group-junk',
    _autosaveRevision: r - 1,
  });
  assert.equal(stale.settings.config.minimaxGroupId, 'group-truth');
  assert.equal(stale.settings.config.hasMinimaxKey, true);
});

test('autosave: invalid _autosaveRevision (NaN / string / negative-but-finite) — falls through to force-write semantics', async () => {
  // Defensive: a malformed revision must not silently reject every
  // future request. Client mistakes / replay attacks are bounded by
  // the rule "non-finite number means no revision attached".
  await updateModelConfig({
    minimaxGroupId: 'group-baseline',
    _autosaveRevision: Date.now() + 6_000_000,
  });

  for (const bad of [Number.NaN, 'oops', null, undefined, {}, []]) {
    const bootstrap = await updateModelConfig({
      minimaxGroupId: 'group-after-bad-rev',
      _autosaveRevision: bad,
    });
    // Treated as no revision → force write applies.
    assert.equal(bootstrap.settings.config.minimaxGroupId, 'group-after-bad-rev');
    // Reset for next iteration.
    await updateModelConfig({
      minimaxGroupId: 'group-baseline',
      _autosaveRevision: Date.now() + 7_000_000,
    });
  }
});

// Cleanup
process.on('exit', () => {
  try { rmSync(TEMP_HOME, { recursive: true, force: true }); } catch {}
});
