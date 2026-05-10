import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendDreamRecord, diaryPathFor } from './diary.js';

// Phase E follow-up (2026-05-08): isolate MELO_HOME so appendDreamRecord
// does NOT write into the developer's real ~/.melo/desktop/dreams/.  Before
// this fix, every `node --test` run polluted the production diary with
// fixture rows ("Examined: 12 / Promoted: 2 / Demoted: 1 / Hit pruned: 5"
// — see ~/.melo/desktop/dreams/2026-04-22..05-07.md), making it impossible
// to read real consolidation activity from the diary.  Pairs with the
// diary.js fix that switched DREAMS_DIR from module-load to call-time
// resolution, so a per-test MELO_HOME actually takes effect.
function isolateHome(t) {
  const before = process.env.MELO_HOME;
  const home = mkdtempSync(join(tmpdir(), 'melo-diary-test-'));
  process.env.MELO_HOME = home;
  t.after(() => {
    try { rmSync(home, { recursive: true, force: true }); } catch {}
    if (before === undefined) delete process.env.MELO_HOME;
    else process.env.MELO_HOME = before;
  });
  return home;
}

test('diaryPathFor generates YYYY-MM-DD file name', (t) => {
  isolateHome(t);
  const iso = '2026-04-18T10:00:00.000Z';
  const path = diaryPathFor(iso);
  assert.ok(path.endsWith('2026-04-18.md'));
});

test('appendDreamRecord writes a fresh file with header + counts', (t) => {
  isolateHome(t);
  const iso = new Date().toISOString();
  const record = {
    startedAt: iso,
    finishedAt: iso,
    examined: 12,
    promoted: 2,
    demoted: 1,
    merged: 0,
    expired: 0,
    hitsPruned: 5,
    promotedRows: [{ id: 'x', level: 'hot', score: 0.72 }],
    mergeRows: [],
    expiredRows: [],
  };
  const path = appendDreamRecord(record);
  assert.ok(existsSync(path));
  const content = readFileSync(path, 'utf8');
  assert.ok(content.includes('# Melo Dream Diary'));
  assert.ok(content.includes('Examined'));
  assert.ok(content.includes('x'));
  assert.ok(content.includes('hot'));
});

test('appendDreamRecord is append-only across runs', (t) => {
  isolateHome(t);
  const iso = new Date().toISOString();
  const record = {
    startedAt: iso,
    finishedAt: iso,
    examined: 1,
    promoted: 0,
    demoted: 0,
    merged: 0,
    expired: 0,
    hitsPruned: 0,
  };
  appendDreamRecord(record);
  const path = appendDreamRecord(record);
  const content = readFileSync(path, 'utf8');
  const headerOccurrences = (content.match(/^## Run /gm) || []).length;
  assert.ok(headerOccurrences >= 2);
});
