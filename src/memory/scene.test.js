import test from 'node:test';
import assert from 'node:assert/strict';
import { groupIntoScenes, buildSceneEntry } from './scene.js';

function makeFrameEntry(id, startIso, endIso, { participants = [], topicTags = [], userTurns = 2 } = {}) {
  return {
    id,
    kind: 'frame',
    namespace: 'chat:c1',
    text: `frame ${id}`,
    metadata: {
      frameId: id,
      startAt: startIso,
      endAt: endIso,
      participants,
      topicTags,
      userTurns,
    },
  };
}

test('groupIntoScenes bundles frames within the 7-day window', () => {
  const frames = [
    makeFrameEntry('f1', '2026-04-14T10:00:00Z', '2026-04-14T10:20:00Z', { topicTags: ['cache'] }),
    makeFrameEntry('f2', '2026-04-16T09:00:00Z', '2026-04-16T09:15:00Z', { topicTags: ['cache'] }),
    makeFrameEntry('f3', '2026-04-30T10:00:00Z', '2026-04-30T10:20:00Z', { topicTags: ['router'] }),
  ];
  const scenes = groupIntoScenes(frames);
  assert.equal(scenes.length, 2);
  assert.equal(scenes[0].frames.length, 2);
  assert.equal(scenes[1].frames.length, 1);
});

test('buildSceneEntry aggregates topics, participants and user turns', () => {
  const frames = [
    makeFrameEntry('f1', '2026-04-14T10:00:00Z', '2026-04-14T10:20:00Z', {
      participants: ['Alice'],
      topicTags: ['cache', 'router'],
      userTurns: 3,
    }),
    makeFrameEntry('f2', '2026-04-15T09:00:00Z', '2026-04-15T09:15:00Z', {
      participants: ['Bob'],
      topicTags: ['cache'],
      userTurns: 2,
    }),
  ];
  const [scene] = groupIntoScenes(frames);
  const entry = buildSceneEntry({ id: 'c1', title: 'Test chat' }, scene);

  assert.ok(entry);
  assert.equal(entry.kind, 'scene');
  assert.equal(entry.namespace, 'chat:c1');
  assert.equal(entry.metadata.frameCount, 2);
  assert.equal(entry.metadata.userTurns, 5);
  assert.ok(entry.metadata.topicTags.includes('cache'));
  assert.deepEqual(entry.metadata.participants.sort(), ['Alice', 'Bob']);
  assert.deepEqual(entry.metadata.frameIds.sort(), ['f1', 'f2']);
});

test('buildSceneEntry propagates sceneId back onto the member frames', () => {
  const frames = [
    makeFrameEntry('f1', '2026-04-14T10:00:00Z', '2026-04-14T10:20:00Z'),
    makeFrameEntry('f2', '2026-04-14T11:00:00Z', '2026-04-14T11:10:00Z'),
  ];
  const [scene] = groupIntoScenes(frames);
  const entry = buildSceneEntry({ id: 'c1' }, scene);

  assert.ok(entry);
  assert.ok(entry.id.startsWith('scene:c1:'));
  assert.equal(frames[0].metadata.sceneId, entry.id);
  assert.equal(frames[1].metadata.sceneId, entry.id);
});

test('buildSceneEntry returns null when the scene has no frames', () => {
  const entry = buildSceneEntry({ id: 'c1' }, { frames: [], startAt: '2026-04-14T10:00:00Z', endAt: '2026-04-14T10:00:00Z' });
  assert.equal(entry, null);
});
