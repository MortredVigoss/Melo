import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyMemoryContinuity,
  decorateMemoryEntry,
} from './lifecycle.js';

function entry(id, text, {
  namespace = 'chat:lifecycle',
  kind = 'prompt',
  createdAt = '2026-05-01T00:00:00.000Z',
  updatedAt = createdAt,
  metadata = {},
} = {}) {
  return {
    id,
    namespace,
    kind,
    sourceId: id,
    text,
    searchText: text,
    createdAt,
    updatedAt,
    metadata,
  };
}

test('decorateMemoryEntry classifies morning alarm as dependent routine', () => {
  const row = decorateMemoryEntry(entry(
    'alarm',
    '我早晨八点二十闹钟，然后开车去 Doncaster 上班。',
  ));

  assert.equal(row.metadata.memoryType, 'routine');
  assert.equal(row.metadata.factKey, 'morning_alarm');
  assert.equal(row.metadata.status, 'current');
  assert.ok(row.metadata.dependsOn.includes('home_location'));
  assert.ok(row.metadata.dependsOn.includes('work_location'));
  assert.ok(row.metadata.dependsOn.includes('commute_duration'));
});

test('applyMemoryContinuity marks routines stale when home location changes', () => {
  const rows = applyMemoryContinuity([
    entry(
      'alarm-old',
      '我早晨八点二十闹钟，然后开车四十分钟去 Doncaster 上班。',
      { updatedAt: '2026-05-01T08:00:00.000Z' },
    ),
    entry(
      'move-new',
      '我搬家到 Carlton 了。',
      { updatedAt: '2026-05-10T08:00:00.000Z' },
    ),
  ]);

  const alarm = rows.find(row => row.id === 'alarm-old');
  const move = rows.find(row => row.id === 'move-new');

  assert.equal(move.metadata.factKey, 'home_location');
  assert.equal(move.metadata.changeSignal, true);
  assert.equal(alarm.metadata.status, 'needs_confirmation');
  assert.equal(alarm.metadata.staleBecause.changedFactKey, 'home_location');
  assert.equal(alarm.metadata.staleBecause.anchorId, 'move-new');
});

test('applyMemoryContinuity keeps older anchor facts as historical, not deleted', () => {
  const rows = applyMemoryContinuity([
    entry(
      'home-old',
      '我住在 Doncaster。',
      { updatedAt: '2026-05-01T08:00:00.000Z' },
    ),
    entry(
      'home-new',
      '我现在住在 Carlton。',
      { updatedAt: '2026-05-10T08:00:00.000Z' },
    ),
  ]);

  const oldHome = rows.find(row => row.id === 'home-old');
  const newHome = rows.find(row => row.id === 'home-new');

  assert.equal(newHome.metadata.status, 'current');
  assert.equal(oldHome.metadata.status, 'historical');
  assert.equal(oldHome.metadata.supersededBy, 'home-new');
  assert.equal(oldHome.metadata.validTo, '2026-05-10T08:00:00.000Z');
});

test('applyMemoryContinuity is scoped by namespace', () => {
  const rows = applyMemoryContinuity([
    entry(
      'alarm-chat-a',
      '我早晨八点二十闹钟。',
      { namespace: 'chat:a', updatedAt: '2026-05-01T08:00:00.000Z' },
    ),
    entry(
      'move-chat-b',
      '我搬家到 Carlton 了。',
      { namespace: 'chat:b', updatedAt: '2026-05-10T08:00:00.000Z' },
    ),
  ]);

  assert.equal(rows.find(row => row.id === 'alarm-chat-a').metadata.status, 'current');
});
