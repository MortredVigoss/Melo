/**
 * Scene layer — the "time × people × topic" aggregate in the Scene → Frame →
 * Content hierarchy.
 *
 * A scene represents a continuous span of activity inside a single chat.
 * Rolling window: 7 days per chat; same chat, same 7-day bucket → same scene.
 *
 * Scene payload text (80-200 chars):
 *   "Chat <title> • <YYYY-MM-DD → YYYY-MM-DD>
 *    Topics: tag1, tag2, tag3
 *    Participants: Alice, Bob
 *    Frames: N · User turns: M"
 *
 * Pure module — DB writes happen in the caller.
 */

const SCENE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// ─── Grouping ───────────────────────────────────────────────────────────────

/**
 * Group an ordered set of frames (from splitFrames → buildFrameEntry) into
 * scene windows.  A scene extends until either the inter-frame gap exceeds
 * SCENE_WINDOW_MS or the overall scene duration itself exceeds SCENE_WINDOW_MS.
 *
 * The input is expected to be the metadata output of frame entries — i.e.
 * objects with { startAt, endAt, frameId, participants, topicTags }.
 *
 * @param {Array} frameEntries entries produced by buildFrameEntry
 * @returns {Array<{ frames: Array, startAt: string, endAt: string }>}
 */
export function groupIntoScenes(frameEntries = [], { windowMs = SCENE_WINDOW_MS } = {}) {
  const sorted = frameEntries
    .filter(entry => entry?.metadata?.startAt)
    .sort((a, b) => Date.parse(a.metadata.startAt) - Date.parse(b.metadata.startAt));

  const scenes = [];
  let current = null;

  for (const entry of sorted) {
    const startTs = Date.parse(entry.metadata.startAt);
    const endTs = Date.parse(entry.metadata.endAt || entry.metadata.startAt);
    if (!Number.isFinite(startTs)) continue;

    if (!current) {
      current = { frames: [entry], startTs, endTs };
      continue;
    }

    const inWindow =
      startTs - current.endTs <= windowMs &&
      endTs - current.startTs <= windowMs;

    if (inWindow) {
      current.frames.push(entry);
      current.endTs = Math.max(current.endTs, endTs);
    } else {
      scenes.push(finalizeScene(current));
      current = { frames: [entry], startTs, endTs };
    }
  }

  if (current) scenes.push(finalizeScene(current));
  return scenes;
}

function finalizeScene(raw) {
  return {
    frames: raw.frames,
    startAt: new Date(raw.startTs).toISOString(),
    endAt: new Date(raw.endTs).toISOString(),
  };
}

// ─── Scene → memory entry ───────────────────────────────────────────────────

/**
 * Build a memory-store entry for a scene.
 *
 * @param {Object} chat
 * @param {Object} scene       one element of groupIntoScenes output
 * @returns {Object|null}      entry suitable for replaceMemories/upsertMemory
 */
export function buildSceneEntry(chat, scene) {
  if (!scene?.frames?.length) return null;

  const participants = new Set();
  const topics = new Map();
  let userTurns = 0;

  for (const frame of scene.frames) {
    for (const p of frame.metadata?.participants || []) participants.add(p);
    for (const t of frame.metadata?.topicTags || []) {
      topics.set(t, (topics.get(t) || 0) + 1);
    }
    userTurns += Number(frame.metadata?.userTurns) || 0;
  }

  const topTopics = Array.from(topics.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([tag]) => tag);

  const participantList = Array.from(participants);
  const title = chat?.title || chat?.name || `chat:${chat?.id || 'unknown'}`;
  const startDay = scene.startAt.slice(0, 10);
  const endDay = scene.endAt.slice(0, 10);
  const dayRange = startDay === endDay ? startDay : `${startDay} → ${endDay}`;

  const text = [
    `Scene • ${title} • ${dayRange}`,
    topTopics.length ? `Topics: ${topTopics.join(', ')}` : null,
    participantList.length ? `Participants: ${participantList.join(', ')}` : null,
    `Frames: ${scene.frames.length} · User turns: ${userTurns}`,
  ].filter(Boolean).join('\n');

  const sceneId = `scene:${chat?.id || 'unknown'}:${startDay}--${endDay}`;
  const now = new Date().toISOString();

  // Propagate sceneId back onto the member frames so recallMemoriesTiered
  // can narrow frame lookups.  Callers should persist these updates.
  for (const frame of scene.frames) {
    if (frame?.metadata) frame.metadata.sceneId = sceneId;
  }

  return {
    id: sceneId,
    namespace: chat?.id ? `chat:${chat.id}` : '',
    kind: 'scene',
    sourceId: null,
    text,
    searchText: text.toLowerCase(),
    tokensEstimate: Math.ceil(text.length / 4),
    createdAt: scene.startAt,
    updatedAt: scene.endAt || now,
    lastUsedAt: null,
    metadata: {
      sceneId,
      participants: participantList,
      topicTags: topTopics,
      startAt: scene.startAt,
      endAt: scene.endAt,
      frameIds: scene.frames.map(f => f.id),
      frameCount: scene.frames.length,
      userTurns,
      chatId: chat?.id || null,
    },
  };
}
