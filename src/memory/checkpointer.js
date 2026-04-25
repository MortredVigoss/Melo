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

// checkpointCache was originally a flat `Map<threadId, payload>`. After
// the state machine moved to non-cache-busted modules, the same threadId
// across two MELO_HOME values would silently return the FIRST home's
// cached payload — bypassing the lazy `threadsDir()` disk fix because the
// cache hit returns before disk read. Codex review caught this and the
// user picked Q3-B + Q4-b (nested Map + allHomes invalidate option).
//
// Shape: Map<MELO_HOME, Map<threadId, payload>>. Each home gets its own
// inner Map, capped at MAX_CACHE_ENTRIES with the same LRU-by-insertion
// behavior as before. Production has one home → one inner Map → behavior
// equivalent. CLAUDE.md §5 mechanical adjustment, scope limited to the
// cross-module isolation requirement.
const checkpointCacheByHome = new Map();
function getCacheBucket() {
  const home = getMeloHome();
  let bucket = checkpointCacheByHome.get(home);
  if (!bucket) {
    bucket = new Map();
    checkpointCacheByHome.set(home, bucket);
  }
  return bucket;
}

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

  const bucket = getCacheBucket();
  if (bucket.has(threadId)) {
    bucket.delete(threadId);
  }
  bucket.set(threadId, payload);
  while (bucket.size > MAX_CACHE_ENTRIES) {
    const oldestKey = bucket.keys().next().value;
    bucket.delete(oldestKey);
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

  const bucket = getCacheBucket();
  if (bucket.has(normalizedThreadId)) {
    return clonePayload(remember(normalizedThreadId, bucket.get(normalizedThreadId)));
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

  getCacheBucket().delete(normalizedThreadId);
  await rm(checkpointPathFor(normalizedThreadId), { force: true });
}

export async function pruneThreadCheckpoints(keepThreadIds = []) {
  await mkdir(threadsDir(), { recursive: true });
  const keep = new Set(keepThreadIds.map(value => String(value || '').trim()).filter(Boolean));
  const entries = await readdir(threadsDir(), { withFileTypes: true });

  const bucket = getCacheBucket();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue;
    }

    const threadId = decodeURIComponent(entry.name.slice(0, -5));
    if (keep.has(threadId)) {
      continue;
    }

    bucket.delete(threadId);
    await rm(join(threadsDir(), entry.name), { force: true });
  }
}

/**
 * Invalidate cached thread checkpoints.
 *
 * @param {string | null} threadId — null/omitted clears the entire cache for
 *   the current home (or every home, when `allHomes` is true).
 * @param {{ allHomes?: boolean }} [options]
 *   • `allHomes: true` clears across every recorded MELO_HOME bucket — used
 *     by tests that swap homes and want a clean slate. Default scope is
 *     the current home only (Q4-b option from Phase 7d-5α-A1 followup).
 */
export function invalidateThreadCheckpointCache(threadId = null, { allHomes = false } = {}) {
  if (allHomes) {
    if (threadId == null) {
      checkpointCacheByHome.clear();
      return;
    }
    const id = String(threadId || '').trim();
    for (const bucket of checkpointCacheByHome.values()) {
      bucket.delete(id);
    }
    return;
  }

  const bucket = getCacheBucket();
  if (threadId == null) {
    bucket.clear();
    return;
  }
  bucket.delete(String(threadId || '').trim());
}
