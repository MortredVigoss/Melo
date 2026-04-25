import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { getMeloHome } from '../config.js';
import { atomicWriteJson } from '../storage.js';

// THREADS_DIR was originally a module-load-time const. Phase 7d-5α-A1
// commit 9 follow-up audit caught that this captures MELO_HOME at first
// import — the same bug class that hit STATE_PATH and AGENTS_DIR after
// the state-machine moved to its own module. Fix: lazy resolution every
// time the path is needed. CLAUDE.md §5 mechanical adjustment.
function threadsDir() {
  return join(getMeloHome(), 'desktop', 'threads');
}
const THREAD_CHECKPOINT_VERSION = 1;
const MAX_CACHE_ENTRIES = 48;
const checkpointCache = new Map();

function checkpointPathFor(threadId) {
  return join(threadsDir(), `${encodeURIComponent(String(threadId || '').trim())}.json`);
}

function clonePayload(payload) {
  return payload ? structuredClone(payload) : null;
}

function remember(threadId, payload) {
  if (!threadId || !payload) {
    return payload;
  }

  if (checkpointCache.has(threadId)) {
    checkpointCache.delete(threadId);
  }
  checkpointCache.set(threadId, payload);
  while (checkpointCache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = checkpointCache.keys().next().value;
    checkpointCache.delete(oldestKey);
  }
  return payload;
}

function normalizeCheckpoint(payload = {}) {
  return {
    version: Number(payload?.version) || THREAD_CHECKPOINT_VERSION,
    threadId: String(payload?.threadId || '').trim(),
    createdAt: typeof payload?.createdAt === 'string' ? payload.createdAt : null,
    updatedAt: typeof payload?.updatedAt === 'string' ? payload.updatedAt : null,
    messages: Array.isArray(payload?.messages) ? payload.messages : [],
    derived:
      payload?.derived && typeof payload.derived === 'object'
        ? payload.derived
        : {},
  };
}

export async function loadThreadCheckpoint(threadId) {
  const normalizedThreadId = String(threadId || '').trim();
  if (!normalizedThreadId) {
    return null;
  }

  if (checkpointCache.has(normalizedThreadId)) {
    return clonePayload(remember(normalizedThreadId, checkpointCache.get(normalizedThreadId)));
  }

  try {
    const raw = await readFile(checkpointPathFor(normalizedThreadId), 'utf8');
    const parsed = normalizeCheckpoint(JSON.parse(raw));
    remember(normalizedThreadId, parsed);
    return clonePayload(parsed);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return null;
    }

    throw new Error(`Failed to read thread checkpoint for ${normalizedThreadId}: ${error.message}`);
  }
}

export async function saveThreadCheckpoint(threadId, payload = {}) {
  const normalizedThreadId = String(threadId || '').trim();
  if (!normalizedThreadId) {
    throw new Error('Thread checkpoint requires a thread id.');
  }

  await mkdir(threadsDir(), { recursive: true });
  const normalized = normalizeCheckpoint({
    ...payload,
    threadId: normalizedThreadId,
  });
  await atomicWriteJson(checkpointPathFor(normalizedThreadId), normalized);
  remember(normalizedThreadId, normalized);
  return clonePayload(normalized);
}

export async function deleteThreadCheckpoint(threadId) {
  const normalizedThreadId = String(threadId || '').trim();
  if (!normalizedThreadId) {
    return;
  }

  checkpointCache.delete(normalizedThreadId);
  await rm(checkpointPathFor(normalizedThreadId), { force: true });
}

export async function pruneThreadCheckpoints(keepThreadIds = []) {
  await mkdir(threadsDir(), { recursive: true });
  const keep = new Set(keepThreadIds.map(value => String(value || '').trim()).filter(Boolean));
  const entries = await readdir(threadsDir(), { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue;
    }

    const threadId = decodeURIComponent(entry.name.slice(0, -5));
    if (keep.has(threadId)) {
      continue;
    }

    checkpointCache.delete(threadId);
    await rm(join(threadsDir(), entry.name), { force: true });
  }
}

export function invalidateThreadCheckpointCache(threadId = null) {
  if (threadId == null) {
    checkpointCache.clear();
    return;
  }

  checkpointCache.delete(String(threadId || '').trim());
}
