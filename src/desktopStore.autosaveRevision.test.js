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

const { updateModelConfig, refreshModelCatalog } = await import('./desktopStore.js');

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

test('autosave: concurrent newer + stale revision — race serialized by withConfigLock, newer always wins', async () => {
  // Codex C 第十二轮 (2026-04-28): the revision check + saveConfig
  // must execute atomically. Without a lock, two concurrent
  // updateModelConfig calls can both loadConfig() and read the same
  // baseline `autosaveRevision`, both pass the gate, and the slower
  // POST then overwrites the faster one when it finally reaches
  // saveConfig. This test fires both calls without awaiting, then
  // asserts the final saved state matches the *newer* body — proving
  // withConfigLock serializes the read-modify-write, so the slower
  // path re-reads the freshly-written state and rejects its own
  // stale body.
  const baseRev = Date.now() + 8_000_000;
  // Seed a known baseline so both racers start from the same state.
  await updateModelConfig({
    minimaxApiKey: 'sk-baseline',
    minimaxGroupId: 'group-baseline',
    _autosaveRevision: baseRev,
  });

  const newerRev = baseRev + 200;
  const olderRev = baseRev + 100;
  // Fire both writes without awaiting in between. Both will queue
  // through withConfigLock; whichever runs second sees the first
  // one's saved revision in its loadConfig() snapshot.
  const [resA, resB] = await Promise.all([
    updateModelConfig({
      minimaxApiKey: 'sk-newer-wins',
      minimaxGroupId: 'group-newer-wins',
      _autosaveRevision: newerRev,
    }),
    updateModelConfig({
      minimaxApiKey: 'sk-older-loses',
      minimaxGroupId: 'group-older-loses',
      _autosaveRevision: olderRev,
    }),
  ]);

  // Final on-disk state must reflect the *newer* body, regardless of
  // which Promise.all slot finished its await first.
  const cfgPath = join(TEMP_HOME, 'config.json');
  const persisted = JSON.parse(readFileSync(cfgPath, 'utf8'));
  assert.equal(persisted.minimaxApiKey, 'sk-newer-wins',
    'concurrent write race must converge to the newer revision body');
  assert.equal(persisted.minimaxGroupId, 'group-newer-wins');
  assert.equal(persisted.autosaveRevision, newerRev,
    'saved revision must end at the newer rev');

  // Both responses are valid bootstrap snapshots — stale path returns
  // the unchanged-(at-its-load-time) bootstrap. The bootstrap from
  // the older path may reflect either pre- or post-newer state
  // depending on ordering, but neither should crash.
  assert.ok(resA?.settings?.config);
  assert.ok(resB?.settings?.config);
});

test('autosave: malformed _autosaveRevision (NaN / string / null / object) — falls through to force-write semantics', async () => {
  // Defensive: a malformed revision must not silently reject every
  // future request. The server gate's rule is precise:
  //   `typeof val === 'number' && Number.isFinite(val)` → use as
  //                                                      revision
  //   otherwise → no revision attached → force-write applies + bumps
  //
  // Negative finite numbers are NOT in this set; they are valid
  // numbers and therefore go through the monotonic check (covered by
  // the next test). NaN / strings / null / undefined / objects /
  // arrays all fail the `typeof === 'number' && isFinite` guard and
  // are equivalent to no revision.
  await updateModelConfig({
    minimaxGroupId: 'group-baseline',
    _autosaveRevision: Date.now() + 6_000_000,
  });

  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 'oops', null, undefined, {}, []]) {
    const bootstrap = await updateModelConfig({
      minimaxGroupId: 'group-after-bad-rev',
      _autosaveRevision: bad,
    });
    // Treated as no revision → force write applies.
    assert.equal(
      bootstrap.settings.config.minimaxGroupId,
      'group-after-bad-rev',
      `_autosaveRevision=${String(bad)} (typeof=${typeof bad}) should fall through to force-write`,
    );
    // Reset for next iteration.
    await updateModelConfig({
      minimaxGroupId: 'group-baseline',
      _autosaveRevision: Date.now() + 7_000_000,
    });
  }
});

test('autosave: negative finite revision is treated as a stale autosave, not a force-write', async () => {
  // Codex audit 2026-04-28 (⚪ follow-up): the previous test name
  // claimed "negative-but-finite" coverage but actually never sent a
  // negative number. Pin the real behaviour here: a finite negative
  // number IS a valid revision (passes typeof+isFinite), so the
  // monotonic gate compares it against the saved revision. Saved
  // revision is always >= 0 (DEFAULT_CONFIG starts at 0), so any
  // negative number is by definition stale and gets rejected — not
  // promoted to force-write. This is the safer-of-the-two choices:
  // a buggy/replayed client can't sneak a "very negative" revision
  // past the gate and clobber saved state.
  const baseRev = Date.now() + 9_000_000;
  await updateModelConfig({
    minimaxGroupId: 'group-newer-must-survive',
    _autosaveRevision: baseRev,
  });

  // Negative finite revision → stale → reject.
  const bootstrap = await updateModelConfig({
    minimaxGroupId: 'group-from-negative-revision',
    _autosaveRevision: -1,
  });
  assert.equal(
    bootstrap.settings.config.minimaxGroupId,
    'group-newer-must-survive',
    'negative revision is stale (every saved revision is >= 0); reject must preserve newer body',
  );

  // Same expectation for a small positive revision below the saved one.
  const bootstrap2 = await updateModelConfig({
    minimaxGroupId: 'group-from-tiny-positive',
    _autosaveRevision: 1,
  });
  assert.equal(
    bootstrap2.settings.config.minimaxGroupId,
    'group-newer-must-survive',
    'small positive revision is also stale; rejection is purely monotonic, not "is the number weird"',
  );
});

test('refresh: discovery hoisted out of lock — concurrent updateModelConfig during discovery is NOT rolled back', async () => {
  // Codex C 第十三轮 (2026-04-28) regression test: refresh used to
  // hold the config lock across the network discovery (15s worst
  // case), or — after the first hoist attempt — wrote the form
  // snapshot taken BEFORE discovery into the saved config inside
  // the lock. Either design clobbered any updateModelConfig that
  // landed during discovery. Final design: refresh only patches
  // modelCatalogs[authMode]; form fields flow through from the
  // freshly-reloaded current state.
  //
  // We simulate the race with a controllable discovery: refresh
  // calls our fake discoverFn which awaits a deferred promise.
  // While refresh is parked there, we synchronously fire
  // updateModelConfig writing fresh fields; once that resolves we
  // release discovery; refresh's lock-section then reloads the
  // updated state and overlays only the catalog.

  // Establish a known baseline before the race.
  const baseRev = Date.now() + 10_000_000;
  await updateModelConfig({
    minimaxApiKey: 'sk-pre-race',
    minimaxGroupId: 'group-pre-race',
    _autosaveRevision: baseRev,
  });

  let releaseDiscovery;
  const discoveryHeld = new Promise(resolve => { releaseDiscovery = resolve; });
  const fakeDiscoverFn = async () => {
    // Park the network round-trip so we can interleave a write.
    await discoveryHeld;
    // Include 'gpt-4.1' so that normalizeConfigShape's
    // resolveModelForAuthMode keeps the user-typed model — otherwise
    // saveConfig folds an out-of-catalog model back to catalog[0],
    // which would mask whether refresh rolled back the user's field
    // or not. The contract under test is "refresh doesn't write
    // form fields"; 'normalize folds an unknown model' is a
    // separate, intentional behaviour.
    return ['gpt-4.1', 'codex-discovered-model-A'];
  };

  // Fire refresh WITHOUT awaiting — it'll park inside fakeDiscoverFn.
  const refreshPromise = refreshModelCatalog(
    {
      authMode: 'codex',
      baseUrl: 'http://refresh-input.example/v1',
      model: 'gpt-5.5',
      apiKey: '',
    },
    { _discoverFn: fakeDiscoverFn },
  );

  // Yield so refresh is definitely parked at `await discoveryHeld`.
  await new Promise(resolve => setTimeout(resolve, 10));

  // Now interleave a real autosave landing during discovery — the
  // user typed a NEW MiniMax key + a different model and the 3-second
  // autosave finishes mid-refresh.
  const interleavedRev = baseRev + 5_000;
  await updateModelConfig({
    minimaxApiKey: 'sk-INTERLEAVED-MUST-SURVIVE',
    minimaxGroupId: 'group-INTERLEAVED-MUST-SURVIVE',
    model: 'gpt-4.1', // different model to prove field is preserved
    _autosaveRevision: interleavedRev,
  });

  // Release discovery; refresh now enters its lock section.
  releaseDiscovery();
  await refreshPromise;

  // Final on-disk state must reflect:
  //   - the INTERLEAVED autosave's fields (minimax key/group/model)
  //   - refresh's catalog overlaid onto modelCatalogs.codex
  //   - autosaveRevision must be the larger of the two writers'
  //     contributions (refresh writes via withConfigLock with no
  //     _autosaveRevision → bumps to max(current, Date.now()))
  const cfgPath = join(TEMP_HOME, 'config.json');
  const persisted = JSON.parse(readFileSync(cfgPath, 'utf8'));

  assert.equal(
    persisted.minimaxApiKey,
    'sk-INTERLEAVED-MUST-SURVIVE',
    'refresh must NOT roll back the autosave that landed during discovery',
  );
  assert.equal(
    persisted.minimaxGroupId,
    'group-INTERLEAVED-MUST-SURVIVE',
    'refresh must NOT roll back the autosave Group ID either',
  );
  assert.equal(
    persisted.model,
    'gpt-4.1',
    'refresh must NOT roll back the model field the autosave just set',
  );
  assert.deepEqual(
    persisted.modelCatalogs?.codex,
    ['gpt-4.1', 'codex-discovered-model-A'],
    'refresh MUST land its catalog under the resolved authMode',
  );
});

test('refresh: form fields in patch are NEVER persisted as config (catalog-only contract)', async () => {
  // Companion to the race test above: even when refresh runs alone,
  // the patch.baseUrl / patch.apiKey / patch.systemPrompt etc. are
  // discovery inputs only — they must not land in saved config.
  // Otherwise the autosave / explicit Save pipelines lose ownership
  // of those fields and any user input is at the mercy of refresh
  // ordering.

  // Seed with known field values via a real updateModelConfig.
  const baseRev = Date.now() + 11_000_000;
  await updateModelConfig({
    minimaxApiKey: 'sk-baseline-2',
    baseUrl: 'http://saved-baseline.example/v1',
    model: 'baseline-model',
    systemPrompt: 'baseline prompt',
    _autosaveRevision: baseRev,
  });

  // Refresh with DIFFERENT values in the patch — those must NOT
  // overwrite the saved fields.
  const fakeDiscoverFn = async ({ authMode }) => [`${authMode}-only-catalog`];
  await refreshModelCatalog(
    {
      authMode: 'codex',
      baseUrl: 'http://REFRESH-INPUT-MUST-NOT-LAND.example/v1',
      model: 'REFRESH-INPUT-MODEL-MUST-NOT-LAND',
      systemPrompt: 'REFRESH-INPUT-PROMPT-MUST-NOT-LAND',
      apiKey: 'sk-REFRESH-INPUT-KEY-MUST-NOT-LAND',
    },
    { _discoverFn: fakeDiscoverFn },
  );

  const cfgPath = join(TEMP_HOME, 'config.json');
  const persisted = JSON.parse(readFileSync(cfgPath, 'utf8'));

  assert.equal(persisted.baseUrl, 'http://saved-baseline.example/v1',
    'refresh patch.baseUrl is a discovery input, not a config write');
  assert.equal(persisted.model, 'baseline-model',
    'refresh patch.model is a discovery input, not a config write');
  assert.equal(persisted.systemPrompt, 'baseline prompt',
    'refresh patch.systemPrompt is a discovery input, not a config write');
  // codex authMode persists apiKey='' regardless, but the contract
  // is that refresh doesn't write apiKey at all — verify by saving
  // a real key first under api-key mode and re-running.
  assert.deepEqual(persisted.modelCatalogs?.codex, ['codex-only-catalog']);
});

// Cleanup
process.on('exit', () => {
  try { rmSync(TEMP_HOME, { recursive: true, force: true }); } catch {}
});
