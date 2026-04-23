import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { appendDreamRecord, diaryPathFor } from './diary.js';

test('diaryPathFor generates YYYY-MM-DD file name', () => {
  const iso = '2026-04-18T10:00:00.000Z';
  const path = diaryPathFor(iso);
  assert.ok(path.endsWith('2026-04-18.md'));
});

test('appendDreamRecord writes a fresh file with header + counts', () => {
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

test('appendDreamRecord is append-only across runs', () => {
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
