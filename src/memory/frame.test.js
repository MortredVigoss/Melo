import test from 'node:test';
import assert from 'node:assert/strict';
import { splitFrames, buildFrameEntry, buildFrameId, topTopicTokens } from './frame.js';

function makeMsg(role, text, offsetMin = 0, extras = {}) {
  const base = Date.parse('2026-04-14T10:00:00Z');
  return {
    role,
    content: text,
    createdAt: new Date(base + offsetMin * 60_000).toISOString(),
    ...extras,
  };
}

test('splitFrames groups adjacent turns into one frame when below thresholds', () => {
  const messages = [
    makeMsg('user', 'First question', 0),
    makeMsg('assistant', 'First answer', 1),
    makeMsg('user', 'Follow-up', 2),
    makeMsg('assistant', 'Answer 2', 3),
  ];
  const frames = splitFrames(messages);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].startIndex, 0);
  assert.equal(frames[0].endIndex, 3);
});

test('splitFrames cuts on >30min gap', () => {
  const messages = [
    makeMsg('user', 'A', 0),
    makeMsg('assistant', 'B', 1),
    makeMsg('user', 'C', 45), // 45m gap after msg 1
    makeMsg('assistant', 'D', 46),
  ];
  const frames = splitFrames(messages);
  assert.equal(frames.length, 2);
  assert.equal(frames[0].endIndex, 1);
  assert.equal(frames[1].startIndex, 2);
});

test('splitFrames cuts at max user turns', () => {
  const messages = [];
  for (let i = 0; i < 14; i++) {
    messages.push(makeMsg(i % 2 === 0 ? 'user' : 'assistant', `m${i}`, i));
  }
  const frames = splitFrames(messages, { maxUserTurns: 3 });
  assert.ok(frames.length >= 2);
});

test('splitFrames cuts at token budget', () => {
  const big = 'word '.repeat(2000); // ~2500 chars ≈ 625 tokens per message
  const messages = [
    makeMsg('user', big, 0),
    makeMsg('assistant', big, 1),
    makeMsg('user', big, 2),
    makeMsg('assistant', big, 3),
    makeMsg('user', big, 4),
  ];
  const frames = splitFrames(messages, { maxTokens: 800 });
  assert.ok(frames.length >= 2, `expected split, got ${frames.length} frames`);
});

test('buildFrameEntry produces kind=frame entry with participants + topics', () => {
  const chat = {
    id: 'chat-1',
    messages: [
      makeMsg('user', 'LRU cache capacity discussion for skill matcher', 0, { senderName: 'Alice' }),
      makeMsg('assistant', 'I recommend cap = 64 based on benchmarks.', 1),
      makeMsg('user', 'Let us try 128 instead.', 2, { senderName: 'Alice' }),
    ],
  };
  const [frame] = splitFrames(chat.messages);
  const entry = buildFrameEntry(chat, frame);
  assert.ok(entry);
  assert.equal(entry.kind, 'frame');
  assert.equal(entry.namespace, 'chat:chat-1');
  assert.ok(entry.text.includes('LRU') || entry.text.includes('cache') || entry.text.includes('skill'));
  assert.deepEqual(entry.metadata.participants, ['Alice']);
  assert.ok(entry.metadata.topicTags.length > 0);
  assert.equal(entry.metadata.chatId, 'chat-1');
});

test('topTopicTokens returns the most frequent non-stopwords', () => {
  const slice = [
    { role: 'user', content: 'cache cache skill skill router' },
    { role: 'assistant', content: 'the cache and the skill matter' },
  ];
  const tokens = topTopicTokens(slice, 2);
  assert.deepEqual(tokens, ['cache', 'skill']);
});

test('buildFrameEntry returns null when all messages are empty', () => {
  const chat = {
    id: 'chat-2',
    messages: [makeMsg('user', '', 0), makeMsg('assistant', '', 1)],
  };
  const [frame] = splitFrames(chat.messages);
  // frame may be undefined if all messages are empty, which is also OK
  if (frame) {
    const entry = buildFrameEntry(chat, frame);
    assert.equal(entry, null);
  }
});

// ─── P2-10: frame id stability ─────────────────────────────────────────────
//
// Prior scheme `frame:${chatId}:${startIndex}-${endIndex}` broke on re-index:
// inserting/pruning a message anywhere earlier in the chat shifted indices
// and minted a fresh id for the same semantic window, discarding attic
// level, useCount, mergedFrom lineage and hit history.
// New scheme hashes (chatId|startAt|endAt) — the time-window identity of
// the frame.  Same slice of time => same id, regardless of where it lives
// in the messages array.

test('P2-10: buildFrameId is stable across re-indexing for the same time window', () => {
  const chatA = {
    id: 'chat-p210',
    messages: [
      makeMsg('user', 'hello', 0),
      makeMsg('assistant', 'hi there', 1),
      makeMsg('user', 'follow-up', 2),
      makeMsg('assistant', 'answer', 3),
    ],
  };
  const [frameA] = splitFrames(chatA.messages);
  const idA = buildFrameId(chatA, frameA);

  // Simulate "older turns were pruned" — same time-window, different indices.
  const chatB = {
    id: 'chat-p210',
    messages: [
      makeMsg('assistant', 'preamble from earlier session', -90),
      makeMsg('user', 'earlier question', -89),
      ...chatA.messages, // same four turns, now starting at index 2
    ],
  };
  const frames = splitFrames(chatB.messages);
  // Find the frame whose window matches chatA's single frame.
  const frameB = frames.find(
    f => f.startAt === frameA.startAt && f.endAt === frameA.endAt,
  );
  assert.ok(frameB, 'same time-window frame must exist in re-indexed chat');
  const idB = buildFrameId(chatB, frameB);

  assert.equal(idA, idB, 'frame id must be identical across re-index');
  assert.notEqual(frameA.startIndex, frameB.startIndex, 'indices did shift');
});

test('P2-10: buildFrameId differs when endAt (window boundary) changes', () => {
  const chat = { id: 'chat-p210-boundary' };
  const frame1 = {
    startIndex: 0,
    endIndex: 3,
    startAt: '2026-04-14T10:00:00.000Z',
    endAt: '2026-04-14T10:03:00.000Z',
  };
  const frame2 = {
    ...frame1,
    endAt: '2026-04-14T10:05:00.000Z',
  };
  assert.notEqual(buildFrameId(chat, frame1), buildFrameId(chat, frame2));
});

test('P2-10: buildFrameId differs across chat ids even for identical window', () => {
  const frame = {
    startIndex: 0,
    endIndex: 3,
    startAt: '2026-04-14T10:00:00.000Z',
    endAt: '2026-04-14T10:03:00.000Z',
  };
  const idX = buildFrameId({ id: 'chat-x' }, frame);
  const idY = buildFrameId({ id: 'chat-y' }, frame);
  assert.notEqual(idX, idY);
});

test('P2-10: buildFrameId falls back to position scheme without timestamps', () => {
  const chat = { id: 'chat-p210-notime' };
  const frame = { startIndex: 2, endIndex: 5 };
  const id = buildFrameId(chat, frame);
  assert.equal(id, 'frame:chat-p210-notime:2-5');
});

test('P2-10: buildFrameEntry emits the hash-based id on its entry + metadata', () => {
  const chat = {
    id: 'chat-p210-entry',
    messages: [
      makeMsg('user', 'what is the weather', 0),
      makeMsg('assistant', 'sunny', 1),
      makeMsg('user', 'thanks', 2),
    ],
  };
  const [frame] = splitFrames(chat.messages);
  const entry = buildFrameEntry(chat, frame);
  const expected = buildFrameId(chat, frame);
  assert.equal(entry.id, expected);
  assert.equal(entry.metadata.frameId, expected);
  assert.match(entry.id, /^frame:chat-p210-entry:[0-9a-f]{16}$/);
});

test('frames split from messages sharing the same timestamp retain distinct stable identities', () => {
  const chat = { id: 'same-ms-import', messages: Array.from({ length: 40 }, (_, i) =>
    makeMsg(i % 2 ? 'assistant' : 'user', `Unique imported content ${i}`, 0, { id: `message-${i}` })) };
  const frames = splitFrames(chat.messages);
  assert.ok(frames.length > 1);
  const ids = frames.map(frame => buildFrameId(chat, frame));
  assert.equal(new Set(ids).size, frames.length);
});
