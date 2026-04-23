/**
 * Tests for Phase 3.3.4 — skill run telemetry.
 *
 * Uses a temporary MELO_HOME so the real user store is never touched.
 * Covers:
 *   - record → readback via stats
 *   - success / failure counting
 *   - P50 computation
 *   - recent errors list
 *   - prune drops old rows
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Point MELO_HOME at a throwaway dir before the module loads.
let tempHome;
before(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'melo-skillruns-'));
  process.env.MELO_HOME = tempHome;
});

after(() => {
  try { rmSync(tempHome, { recursive: true, force: true }); } catch {}
});

// Dynamic import so MELO_HOME is read after it's set.
let recordSkillRun, getSkillRunStats, pruneSkillRuns, getSkillLastRunMap;
before(async () => {
  const mod = await import('./skillRuns.js');
  recordSkillRun = mod.recordSkillRun;
  getSkillRunStats = mod.getSkillRunStats;
  pruneSkillRuns = mod.pruneSkillRuns;
  getSkillLastRunMap = mod.getSkillLastRunMap;
});

test('record → stats roundtrip', () => {
  recordSkillRun({ skillId: 'alpha', durationMs: 100, ok: true });
  recordSkillRun({ skillId: 'alpha', durationMs: 200, ok: true });
  recordSkillRun({ skillId: 'alpha', durationMs: 300, ok: false, errorType: 'BOOM', errorMessage: 'kaboom' });

  const stats = getSkillRunStats();
  const alpha = stats.skills.find(s => s.skillId === 'alpha');
  assert.ok(alpha, 'alpha entry exists');
  assert.equal(alpha.runs, 3);
  assert.equal(alpha.successes, 2);
  assert.equal(alpha.failures, 1);
  assert.ok(Math.abs(alpha.successRate - 2 / 3) < 1e-9);
  assert.equal(alpha.p50DurationMs, 200);
  assert.equal(alpha.recentErrors.length, 1);
  assert.equal(alpha.recentErrors[0].errorType, 'BOOM');
});

test('missing skillId is ignored', () => {
  const before = getSkillRunStats().skills.length;
  recordSkillRun({ skillId: '', ok: true });
  const after = getSkillRunStats().skills.length;
  assert.equal(after, before);
});

test('getSkillLastRunMap returns { skillId → lastRunAt }', () => {
  // Uses the alpha rows inserted by the earlier roundtrip test.
  const map = getSkillLastRunMap({ windowDays: 30 });
  assert.ok(map instanceof Map);
  const alphaLast = map.get('alpha');
  assert.ok(Number.isFinite(alphaLast), 'alpha has a numeric lastRunAt');
  // Should be recent — within the last minute.
  assert.ok(Date.now() - alphaLast < 60 * 1000);
});

test('prune drops rows older than keepDays', () => {
  // Insert a row with an ancient started_at.
  recordSkillRun({
    skillId: 'old-skill',
    startedAt: Date.now() - 400 * 24 * 60 * 60 * 1000,
    durationMs: 50,
    ok: true,
  });
  const before = getSkillRunStats({ windowDays: 500 }).skills.find(s => s.skillId === 'old-skill');
  assert.ok(before, 'old-skill row present before prune');
  const removed = pruneSkillRuns({ keepDays: 180 });
  assert.ok(removed >= 1);
  const after = getSkillRunStats({ windowDays: 500 }).skills.find(s => s.skillId === 'old-skill');
  assert.equal(after, undefined, 'old-skill row removed after prune');
});
