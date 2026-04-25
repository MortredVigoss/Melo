import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { getMeloHome } from '../config.js';
import { atomicWriteJson } from '../storage.js';

// `threadsDir` resolution evolved across multiple Phase 7d-5α-A1 fix
// rounds:
//   • fix-2 (lazy): replaced a module-load-time const with a function
//     so MELO_HOME swaps at test time picked up the right path.
//   • fix-6 (current — CLAUDE.md §6): lazy reads alone aren't enough
//     across async boundaries inside readStateSnapshot's load chain.
//     Every public op now accepts an optional explicit `threadsDir`
//     argument; when provided, the caller has captured the home up
//     front and the op operates entirely under that captured path.
//     Default-undefined preserves the legacy lazy behavior for
//     callers that aren't part of a multi-step orchestration (UI
//     handlers, single-shot writes from the chat path, etc.).
function defaultThreadsDir() {
  return join(getMeloHome(), 'desktop', 'threads');
}
function resolveThreadsDir(explicit) {
  return explicit || defaultThreadsDir();
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
// fix-3 keyed buckets by `getMeloHome()`. fix-6: key by the resolved
// threadsDir instead so the bucket key is always 1:1 with the actual
// disk path being read/written. When the caller supplies an explicit
// threadsDir for a captured load chain, both the path and the cache
// bucket trace back to the same source — eliminating the last cache-
// vs-disk consistency hazard.
const checkpointCacheByDir = new Map();
function getCacheBucket(explicitThreadsDir) {
  const dir = resolveThreadsDir(explicitThreadsDir);
  let bucket = checkpointCacheByDir.get(dir);
  if (!bucket) {
    bucket = new Map();
    checkpointCacheByDir.set(dir, bucket);
  }
  return bucket;
}

function checkpointPathFor(threadId, explicitThreadsDir) {
  return join(
    resolveThreadsDir(explicitThreadsDir),
    `${encodeURIComponent(String(threadId || '').trim())}.json`,
  );
}

function clonePayload(payload) {
  return payload ? structuredClone(payload) : null;
}

function remember(threadId, payload, explicitThreadsDir) {
  if (!threadId || !payload) {
    return payload;
  }

  const bucket = getCacheBucket(explicitThreadsDir);
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

/**
 * Load a thread checkpoint by id.
 *
 * @param {string} threadId
 * @param {{ threadsDir?: string }} [options]
 *   • `threadsDir` — explicit directory to read from. CLAUDE.md §6:
 *     callers inside a multi-await orchestration (e.g. readStateSnapshot's
 *     hydrateChatThreads pass) should supply the threadsDir captured at
 *     the top of the chain so reads under that orchestration cannot
 *     leak across MELO_HOME flips. When omitted, falls back to lazy
 *     resolution from current `getMeloHome()`.
 */
export async function loadThreadCheckpoint(threadId, { threadsDir } = {}) {
  const normalizedThreadId = String(threadId || '').trim();
  if (!normalizedThreadId) {
    return null;
  }

  const bucket = getCacheBucket(threadsDir);
  if (bucket.has(normalizedThreadId)) {
    return clonePayload(remember(normalizedThreadId, bucket.get(normalizedThreadId), threadsDir));
  }

  try {
    const raw = await readFile(checkpointPathFor(normalizedThreadId, threadsDir), 'utf8');
    const parsed = normalizeCheckpoint(JSON.parse(raw));
    remember(normalizedThreadId, parsed, threadsDir);
    return clonePayload(parsed);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return null;
    }

    throw new Error(`Failed to read thread checkpoint for ${normalizedThreadId}: ${error.message}`);
  }
}

/**
 * Save a thread checkpoint to disk.
 *
 * @param {string} threadId
 * @param {object} [payload]
 * @param {{ threadsDir?: string }} [options]
 *   • `threadsDir` — explicit directory to write to. Same semantics as
 *     loadThreadCheckpoint above.
 */
export async function saveThreadCheckpoint(threadId, payload = {}, { threadsDir } = {}) {
  const normalizedThreadId = String(threadId || '').trim();
  if (!normalizedThreadId) {
    throw new Error('Thread checkpoint requires a thread id.');
  }

  const dir = resolveThreadsDir(threadsDir);
  await mkdir(dir, { recursive: true });
  const normalized = normalizeCheckpoint({
    ...payload,
    threadId: normalizedThreadId,
  });
  await atomicWriteJson(checkpointPathFor(normalizedThreadId, threadsDir), normalized);
  remember(normalizedThreadId, normalized, threadsDir);
  return clonePayload(normalized);
}

export async function deleteThreadCheckpoint(threadId, { threadsDir } = {}) {
  const normalizedThreadId = String(threadId || '').trim();
  if (!normalizedThreadId) {
    return;
  }

  getCacheBucket(threadsDir).delete(normalizedThreadId);
  await rm(checkpointPathFor(normalizedThreadId, threadsDir), { force: true });
}

/**
 * Remove on-disk thread checkpoints whose ids are NOT in `keepThreadIds`,
 * and drop their cached entries.
 *
 * @param {string[]} [keepThreadIds]
 * @param {{ threadsDir?: string }} [options]
 */
export async function pruneThreadCheckpoints(keepThreadIds = [], { threadsDir } = {}) {
  const dir = resolveThreadsDir(threadsDir);
  await mkdir(dir, { recursive: true });
  const keep = new Set(keepThreadIds.map(value => String(value || '').trim()).filter(Boolean));
  const entries = await readdir(dir, { withFileTypes: true });

  const bucket = getCacheBucket(threadsDir);
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue;
    }

    const threadId = decodeURIComponent(entry.name.slice(0, -5));
    if (keep.has(threadId)) {
      continue;
    }

    bucket.delete(threadId);
    await rm(join(dir, entry.name), { force: true });
  }
}

/**
 * Invalidate cached thread checkpoints.
 *
 * @param {string | null} threadId — null/omitted clears the entire cache for
 *   the targeted directory (or every directory, when `allHomes` is true).
 * @param {{ allHomes?: boolean, threadsDir?: string }} [options]
 *   • `allHomes: true` clears across every recorded threadsDir bucket —
 *     used by tests that swap homes and want a clean slate.
 *   • `threadsDir` — explicit directory to scope to (matches the
 *     bucketing key in fix-6's by-dir cache). Default scope is the
 *     directory derived from current `getMeloHome()`.
 */
export function invalidateThreadCheckpointCache(threadId = null, { allHomes = false, threadsDir } = {}) {
  if (allHomes) {
    if (threadId == null) {
      checkpointCacheByDir.clear();
      return;
    }
    const id = String(threadId || '').trim();
    for (const bucket of checkpointCacheByDir.values()) {
      bucket.delete(id);
    }
    return;
  }

  const bucket = getCacheBucket(threadsDir);
  if (threadId == null) {
    bucket.clear();
    return;
  }
  bucket.delete(String(threadId || '').trim());
}
