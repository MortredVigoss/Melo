/**
 * G-6 #2 audit (2026-05-11): cross-MELO_HOME isolation for skillRuns
 * telemetry SQLite handle.  Pre-fix `STORE_PATH` was a module-load
 * `const` (the existing skillRuns.test.js works around it by setting
 * MELO_HOME *before* dynamic import — fragile, doesn't support
 * mid-suite flipping or multi-profile runtime user-switch).
 *
 * Real-behavior assertions (lessons-learned #2):
 *   - recordSkillRun under home A lands rows in home A's db file
 *   - flip MELO_HOME to B → next recordSkillRun lands in home B's db
 *   - home A's file untouched (handle bounce ≠ delete)
 *   - getSkillRunStats after flip reads home B's index (not A's)
 *   - reset hook idempotent
 *   - source-level guard against re-introducing module-load const
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  recordSkillRun,
  getSkillRunStats,
  _resetSkillRunsForTests,
} from './skillRuns.js';

let _homeA = null;
let _homeB = null;
let _prevHome;

test.beforeEach(() => {
  _prevHome = process.env.MELO_HOME;
  _homeA = mkdtempSync(join(tmpdir(), 'melo-sr-cross-A-'));
  _homeB = mkdtempSync(join(tmpdir(), 'melo-sr-cross-B-'));
  process.env.MELO_HOME = _homeA;
  _resetSkillRunsForTests();
});

test.afterEach(() => {
  _resetSkillRunsForTests();
  try { rmSync(_homeA, { recursive: true, force: true }); } catch {}
  try { rmSync(_homeB, { recursive: true, force: true }); } catch {}
  _homeA = null;
  _homeB = null;
  if (_prevHome === undefined) delete process.env.MELO_HOME;
  else process.env.MELO_HOME = _prevHome;
});

test('recordSkillRun under home A lands in homeA/desktop/store.sqlite (not homeB)', () => {
  recordSkillRun({
    skillId: 'skill-alpha',
    startedAt: Date.now(),
    durationMs: 100,
    ok: true,
  });
  const pathA = join(_homeA, 'desktop', 'store.sqlite');
  const pathB = join(_homeB, 'desktop', 'store.sqlite');
  assert.ok(existsSync(pathA), `home A db must exist at ${pathA}`);
  assert.equal(existsSync(pathB), false, 'home B db must NOT exist before flip');

  // Sanity: stats reflect the recorded run.
  const stats = getSkillRunStats({ skillId: 'skill-alpha' });
  assert.equal(stats.skills.length, 1);
  assert.equal(stats.skills[0].runs, 1);
});

test('flip MELO_HOME to B → next recordSkillRun routes to homeB/desktop/store.sqlite (handle auto-reopens)', () => {
  // (1) Seed under A.
  recordSkillRun({ skillId: 'skill-A-only', durationMs: 100, ok: true });
  assert.ok(existsSync(join(_homeA, 'desktop', 'store.sqlite')));

  // (2) Flip MELO_HOME to B.  No reset hook called — testing getDb's
  //     auto-reopen-on-path-change branch.
  process.env.MELO_HOME = _homeB;

  recordSkillRun({ skillId: 'skill-B-only', durationMs: 200, ok: true });
  const pathB = join(_homeB, 'desktop', 'store.sqlite');
  assert.ok(existsSync(pathB), `after flip, home B db must exist at ${pathB}`);

  // (3) Home A's file untouched.
  assert.ok(existsSync(join(_homeA, 'desktop', 'store.sqlite')),
    'home A db must remain — flip swaps handle, not wipes old file');

  // (4) Stats now reflect home B's table — should see skill-B-only,
  //     not skill-A-only (cross-home isolation honored).
  const statsB = getSkillRunStats({ skillId: 'skill-B-only' });
  assert.equal(statsB.skills.length, 1, 'home B index must have skill-B-only');
  assert.equal(statsB.skills[0].runs, 1);

  const statsA = getSkillRunStats({ skillId: 'skill-A-only' });
  assert.equal(statsA.skills.length, 0,
    'home B index should NOT see home A rows — §6 regression guard');
});

test('_resetSkillRunsForTests: idempotent + safe with no open handle', () => {
  assert.doesNotThrow(() => _resetSkillRunsForTests());
  assert.doesNotThrow(() => _resetSkillRunsForTests());
});

test('source-level guard: skillRuns.js does NOT re-introduce module-load `const STORE_PATH = join(getMeloHome()…)`', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname: pd } = await import('node:path');
  const here = pd(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, 'skillRuns.js'), 'utf8');
  assert.equal(
    /const\s+STORE_PATH\s*=\s*join\(\s*getMeloHome\(\)/.test(source),
    false,
    'STORE_PATH must not be a module-load-time const (CLAUDE.md §6)',
  );
  assert.match(
    source,
    /function\s+storePath\s*\(\)\s*\{[\s\S]*?return\s+join\(\s*getMeloHome\(\)/,
    'storePath should be a call-time function',
  );
});
