// Codex catalog migration contract.  When melo's
// DEFAULT_MODEL_CATALOGS.codex changes (user feedback 2026-04-29:
// "5.5 旁边为什么是 4.1"), already-saved disks that exactly match
// a previously-shipped default get an in-place upgrade. Genuinely
// customised catalogs are left alone.
//
// The contract has three branches we have to keep clean:
//
//   1. fresh default          → returns the new default verbatim
//   2. obsolete persisted     → migrates to the new default
//   3. user-customised        → returns the saved catalog unchanged
//
// Codex audit 2026-04-29: a botched migration could either
//   - silently overwrite a power user's hand-curated list, or
//   - leave dogfooders stuck on the obsolete catalog forever.
// These tests pin both failure modes.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MODEL_CATALOGS,
  migrateCodexCatalog,
  normalizeModelCatalogs,
} from './config.js';

// ─── migrateCodexCatalog (the pure helper) ─────────────────────────────────

test('migrateCodexCatalog — undefined / non-array passes through (caller handles fallback)', () => {
  // A missing `modelCatalogs.codex` should NOT be migrated by this
  // helper — the falsy-fallback in normalizeModelCatalogs is what
  // hands such callers the current default. Migration only fires
  // for a CONCRETE old default sitting on disk.
  for (const bad of [undefined, null, 'string', 42, {}]) {
    assert.equal(migrateCodexCatalog(bad), bad);
  }
});

test('migrateCodexCatalog — exact match for ["gpt-5.4","gpt-4.1","gpt-4.1-mini"] → new default', () => {
  // Pre-5.5-bump default. Anyone who installed melo before the
  // 2026-04-28 gpt-5.5 sweep has this exact array on disk.
  const out = migrateCodexCatalog(['gpt-5.4', 'gpt-4.1', 'gpt-4.1-mini']);
  assert.deepEqual(out, [...DEFAULT_MODEL_CATALOGS.codex]);
  // Returned a fresh array — caller mutating it must not bleed into
  // the frozen DEFAULT_MODEL_CATALOGS reference.
  out.push('mutation');
  assert.equal(DEFAULT_MODEL_CATALOGS.codex.length, 3);
});

test('migrateCodexCatalog — exact match for ["gpt-5.5","gpt-4.1","gpt-4.1-mini"] → new default', () => {
  // Snapshot of the default between the 2026-04-28 5.5 sweep and
  // the 2026-04-29 user-feedback B-form. melo dogfooders sitting
  // here would otherwise stay on the 4.1-mini fallback forever.
  const out = migrateCodexCatalog(['gpt-5.5', 'gpt-4.1', 'gpt-4.1-mini']);
  assert.deepEqual(out, [...DEFAULT_MODEL_CATALOGS.codex]);
});

test('migrateCodexCatalog — exact match is order-sensitive', () => {
  // The fingerprint for "obsolete default" only matches when the
  // array is in the original order. A reorder is evidence of user
  // intent ("I rearranged my favourites") — leave it alone.
  const reordered = ['gpt-4.1', 'gpt-5.4', 'gpt-4.1-mini'];
  assert.deepEqual(migrateCodexCatalog(reordered), reordered);
});

test('migrateCodexCatalog — extra entry is treated as user customisation', () => {
  // User added a personal favourite to the default → that's
  // customisation; we must not strip it.
  const extra = ['gpt-5.5', 'gpt-4.1', 'gpt-4.1-mini', 'my-favourite-model'];
  assert.deepEqual(migrateCodexCatalog(extra), extra);
});

test('migrateCodexCatalog — missing entry is treated as user customisation', () => {
  // User trimmed an entry → still customisation.
  const trimmed = ['gpt-5.5', 'gpt-4.1'];
  assert.deepEqual(migrateCodexCatalog(trimmed), trimmed);
});

test('migrateCodexCatalog — different model name is customisation (no-op)', () => {
  // Same length & shape but different model id ≠ obsolete default.
  const custom = ['gpt-5.5', 'gpt-4o', 'gpt-4o-mini'];
  assert.deepEqual(migrateCodexCatalog(custom), custom);
});

test('migrateCodexCatalog — already-current B-form passes through (idempotent)', () => {
  // Running the migration twice must not produce side effects.
  const current = [...DEFAULT_MODEL_CATALOGS.codex];
  assert.deepEqual(migrateCodexCatalog(current), current);
});

// ─── normalizeModelCatalogs (boot path that wires the migration in) ─────────

test('normalizeModelCatalogs — fresh user (no codex catalog at all) returns the new default', () => {
  // Branch 1: missing/undefined entry → DEFAULT fallback.
  const out = normalizeModelCatalogs({});
  assert.deepEqual(out.codex, [...DEFAULT_MODEL_CATALOGS.codex]);
});

test('normalizeModelCatalogs — obsolete persisted catalog gets migrated to new default', () => {
  // Branch 2: dogfooder with the 5.5-first-cut shape on disk.
  const out = normalizeModelCatalogs({
    codex: ['gpt-5.5', 'gpt-4.1', 'gpt-4.1-mini'],
  });
  assert.deepEqual(out.codex, [...DEFAULT_MODEL_CATALOGS.codex]);
});

test('normalizeModelCatalogs — pre-5.5 obsolete catalog also migrates', () => {
  const out = normalizeModelCatalogs({
    codex: ['gpt-5.4', 'gpt-4.1', 'gpt-4.1-mini'],
  });
  assert.deepEqual(out.codex, [...DEFAULT_MODEL_CATALOGS.codex]);
});

test('normalizeModelCatalogs — user-customised catalog passes through verbatim', () => {
  // Branch 3: user added a personal model → must NOT be touched.
  const custom = ['gpt-5.5', 'gpt-4o', 'my-personal-model'];
  const out = normalizeModelCatalogs({ codex: custom });
  assert.deepEqual(out.codex, custom);
});

test('normalizeModelCatalogs — api-key catalog is NOT migrated (different namespace)', () => {
  // The migration only fires for codex; api-key/local stay
  // controlled by their own DEFAULT_MODEL_CATALOGS entries.
  const out = normalizeModelCatalogs({
    'api-key': ['gpt-4.1', 'gpt-4.1-mini'],
  });
  assert.deepEqual(out['api-key'], ['gpt-4.1', 'gpt-4.1-mini']);
});

test('normalizeModelCatalogs — already-current B-form persisted is preserved (idempotent)', () => {
  // Running the boot path twice on the post-migration disk must
  // not flip-flop or wipe values. catalog stays the new default.
  const out = normalizeModelCatalogs({
    codex: [...DEFAULT_MODEL_CATALOGS.codex],
  });
  assert.deepEqual(out.codex, [...DEFAULT_MODEL_CATALOGS.codex]);
});
