import {migrateLegacyResults} from '../domain/artifact/artifactService.js';
import { serializeAgentState } from '../domain/agent/agentState.js';
import { backupAgentState } from './storageMigration.js';
import { measureStage, measureStageSync, startStage } from '../runtime/performanceTrace.js';
import { compactChatRuns } from '../persistence/turnArchive.js';
import { backupLegacyState } from './storageMigration.js';
import { createRequestContext } from '../runtime/requestContext.js';
import { currentRequestContext, runWithRequestContext } from '../runtime/requestScope.js';
import { realpathSync } from 'node:fs';
import { checkpointCacheGeneration, pruneThreadCheckpoints } from '../memory/checkpointer.js';
import { syncDerivedSnapshot } from '../memory/derivedIndex.js';
import { dispatchDerivedCommit } from './derivedDispatcher.js';
// Serialized state transactions. Business services mutate the latest state; snapshots are read-only.
import { readFile, stat } from 'node:fs/promises';
import { ownSnapshot, commitSnapshot, unchangedChats, metadataJson } from './ownedSnapshot.js';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { atomicWriteJson } from '../storage.js';
import { getMeloHome } from '../config.js';
import { parseStatePayload } from './statePayload.js';
import {
  hydrateState,
  hydrateChatThreads,
  createDefaultState,
} from './stateHydration.js';
import { mergeDiskSkillsIntoState } from './diskSkills.js';
import {
  importAgentMarkdownFiles,
  queueAgentMarkdownPrime,
} from './markdownSync.js';
import { createAgentMarkdownFileHelpers } from '../persistence/agentMarkdownFiles.js';
import {
  persistChatThreads,
  serializeChatForPersistence,
} from './chatPersistence.js';
// Phase 7d-5δ commit 8b: ensureSelectedEntities moved to its own leaf
// (stateSelections.js) in commit 8a, which finally clears the §5 carve-out
// blocker that kept `updateStateAtomically` in desktopStore.js. The
// queue itself is module-private here (`stateWriteQueue`), so the
// natural home for `updateStateAtomically` is right alongside saveState.
import { ensureSelectedEntities } from './stateSelections.js';

// Per-home markdown-sync flag. CLAUDE.md §6 fix-5: the flag is keyed by an
// explicit `home` argument (not by `getMeloHome()` at access time) so the
// readStateSnapshot capture chain can pin every read+write to a single
// home value, even across awaits.
const markdownSyncedByHome = new Map();
function isMarkdownSyncedFor(home) {
  return markdownSyncedByHome.get(home) === true;
}
function markSyncedFor(home) {
  markdownSyncedByHome.set(home, true);
}

const stateQueues = new Map();
const committedByHome = new Map();
const loadingByHome = new Map();
const MAX_RESIDENT_HOMES = 8;
const snapshotSource = Symbol('stateSnapshotSource');
const fingerprint = raw => createHash('sha256').update(raw).digest('hex');

// Build a home-bound load context. CLAUDE.md §6: every async hop inside
// readStateSnapshot uses the SAME captured home. The state.json path,
// the threads dir, the agents/ helper factory, the synced-flag key,
// and the prime scheduling all derive from this one capture — no later
// getMeloHome() reads, no lazy resolvers.
//
// fix-6 expansion: ctx now includes threadsDir + bound markdown helpers.
// Every state-machine helper that touches a home-derived path
// (hydrateChatThreads, persistChatThreads via the chain, the four
// checkpointer ops) accepts this ctx and uses its threadsDir.
function captureLoadContext(home = getMeloHome()) {
  home = resolve(home);
  try { home = realpathSync(home); } catch {}
  const stateFilePath = join(home, 'desktop', 'state.json');
  const threadsDir = join(home, 'desktop', 'threads');
  const storePath = join(home, 'desktop', 'store.sqlite');
  const { getAgentMarkdownPaths } = createAgentMarkdownFileHelpers({
    agentsDir: join(home, 'desktop', 'agents'),
  });
  return { home, stateFilePath, threadsDir, storePath, getAgentMarkdownPaths };
}

async function readSnapshot({ persistRepair = false, maintenance = false, previousChats = [], home: requestedHome } = {}) {
  // Capture once at entry. Any later getMeloHome() reads inside this
  // function (or any function it awaits into) would be a §6 violation
  // and would re-introduce the cross-home leak Codex caught at fix-4.
  const ctx = captureLoadContext(requestedHome);
  const { home, stateFilePath, threadsDir, getAgentMarkdownPaths } = ctx;

  let manifestFound = false;
  try {
    const raw = await measureStage('state.manifest.read', () => readFile(stateFilePath, 'utf8'));
    manifestFound = true;
    const { parsed, repaired } = parseStatePayload(raw);
    if (Number(parsed._storageFormat) > 3) throw Object.assign(new Error('This state was written by a newer Melo storage version.'), { code: 'STATE_VERSION_UNSUPPORTED' });
    const state = measureStageSync('state.normalize', () => hydrateState(parsed));
    const alreadySyncedThisHome = isMarkdownSyncedFor(home);
    const markdownImported = Number(parsed._storageFormat) >= 3 || alreadySyncedThisHome
      ? false
      : await importAgentMarkdownFiles(state, getAgentMarkdownPaths);
    if (!alreadySyncedThisHome) {
      if (maintenance) {
        markSyncedFor(home);
        await queueAgentMarkdownPrime(state, home, getAgentMarkdownPaths);
      }
    }
    const threadRepaired = await measureStage('state.threads.hydrate', () => hydrateChatThreads(state, { threadsDir, previousChats }));
    // Legacy manifests store messages in checkpoints. Classify generated
    // snippets only after their source replies have actually been hydrated.
    if(Array.isArray(parsed.artifacts))state.artifacts=migrateLegacyResults(parsed.artifacts,state.chats);
    const resultsMigrated=Array.isArray(parsed.artifacts)&&parsed.artifacts.some((a,i)=>a.kind!==state.artifacts[i]?.kind);
    await measureStage('state.skills.scan', () => mergeDiskSkillsIntoState(state));

    if ((repaired || markdownImported || threadRepaired || resultsMigrated) && persistRepair) {
      // Pass the entire captured ctx so the repair save also writes
      // state.json + thread checkpoints to the home we read from,
      // regardless of any env flip during this load chain.
      await persistStateAtomically(state, { ctx });
    }

    state[snapshotSource] ||= { home, fingerprint: fingerprint(raw), requiresRepair: repaired || markdownImported || threadRepaired || resultsMigrated, committedRuns: structuredClone(state.chatRuns || []) };
    return state;
  } catch (error) {
    if (!manifestFound && error && typeof error === 'object' && error.code === 'ENOENT') {
      const state = createDefaultState();
      await importAgentMarkdownFiles(state, getAgentMarkdownPaths);
      if (maintenance) {
        markSyncedFor(home);
        await queueAgentMarkdownPrime(state, home, getAgentMarkdownPaths);
      }
      await measureStage('state.threads.hydrate', () => hydrateChatThreads(state, { threadsDir }));
      await mergeDiskSkillsIntoState(state);
      return state;
    }

    throw Object.assign(new Error(`Failed to read desktop state: ${error.message}`, { cause: error }), { code: error.code });
  }
}

async function manifestStamp(ctx) {
  try {
    const value = await stat(ctx.stateFilePath, { bigint: true });
    return `${value.dev}:${value.ino}:${value.size}:${value.mtimeNs}:${value.ctimeNs}`;
  } catch (error) { if (error.code === 'ENOENT') return 'missing'; throw error; }
}

function publishCommitted(ctx, state, stamp, unchanged = new Set(), { refreshed = false } = {}) {
  const previous = committedByHome.get(ctx.home)?.state;
  // Preserve read-time normalization of imported entities without traversing
  // every transcript during a commit.
  const normalized = { ...hydrateState({ ...state, chats: [] }), chats: state.chats };
  const committed = commitSnapshot(normalized, previous, unchanged);
  const entry = { state: committed, source: { ...state[snapshotSource], base: committed }, stamp,
    generation: checkpointCacheGeneration(ctx.threadsDir), loadedAt: refreshed ? Date.now() : (committedByHome.get(ctx.home)?.loadedAt || Date.now()) };
  committedByHome.delete(ctx.home);
  committedByHome.set(ctx.home, entry);
  while (committedByHome.size > MAX_RESIDENT_HOMES) committedByHome.delete(committedByHome.keys().next().value);
  return entry;
}

function ownCommitted(entry) {
  const snapshot = measureStageSync('state.snapshot.copy', () => ownSnapshot(entry.state));
  snapshot[snapshotSource] = entry.source;
  return snapshot;
}

async function readCommitted(ctx) {
  const stamp = await manifestStamp(ctx);
  const cached = committedByHome.get(ctx.home);
  if (cached && cached.stamp === stamp && cached.generation === checkpointCacheGeneration(ctx.threadsDir)
      && Date.now() - cached.loadedAt < 30_000) return cached;
  // Only cold/externally changed loads coalesce. Reads never join the write
  // queue and can observe the previous committed revision during a slow write.
  if (loadingByHome.has(ctx.home)) return loadingByHome.get(ctx.home);
  const current = currentRequestContext();
  const context = current?.home === ctx.home ? current : createRequestContext({ ...current, home: ctx.home });
  const promise = runWithRequestContext(context, async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = await manifestStamp(ctx);
      let state;
      try { state = await readSnapshot({ home: ctx.home, previousChats: cached?.generation === checkpointCacheGeneration(ctx.threadsDir) ? cached.state.chats : [] }); }
      catch (error) {
        if (before !== await manifestStamp(ctx)) continue;
        throw error;
      }
      const after = await manifestStamp(ctx);
      if (before !== after) continue;
      return publishCommitted(ctx, state, after, new Set(state.chats.filter(chat => cached?.state.chats.includes(chat)).map(chat => chat.id)), { refreshed: true });
    }
    throw Object.assign(new Error('State is changing; retry the read.'), { code: 'STATE_CONFLICT', statusCode: 409 });
  });
  loadingByHome.set(ctx.home, promise);
  try { return await promise; }
  finally { if (loadingByHome.get(ctx.home) === promise) loadingByHome.delete(ctx.home); }
}

export async function readStateSnapshot({ persistRepair = true, home = getMeloHome() } = {}) {
  const ctx = captureLoadContext(home);
  if (persistRepair) return updateStateAtomically(() => {}, { home: ctx.home });
  return ownCommitted(await readCommitted(ctx));
}

export function loadState({ home = getMeloHome() } = {}) {
  return readStateSnapshot({ persistRepair: false, home });
}

/**
 * Persist state to disk.
 *
 * @param {object} state — desktop state to persist.
 * @param {object} [options]
 *   • ctx — full captured load context `{ home, stateFilePath,
 *     threadsDir, getAgentMarkdownPaths }`. CLAUDE.md §6: lets callers
 *     like readStateSnapshot's repair-save tunnel the home captured at
 *     the top of the load chain through the entire async write path
 *     (state.json AND thread checkpoints), even if env flips during
 *     the await. Falls back to lazy resolution for callers without a
 *     ctx of their own (e.g. desktopStore's updateStateAtomically).
 *   • capturedStatePath — DEPRECATED in favor of `ctx`; kept for any
 *     caller still using the older shape from fix-5.
 */
export async function persistStateAtomically(state, { ctx = null, capturedStatePath = null, _writeState = atomicWriteJson } = {}) {
  ctx = ctx || captureLoadContext(capturedStatePath ? dirname(dirname(capturedStatePath)) : getMeloHome());
  if (Array.isArray(state.chatRuns)) {
    const chatIds = new Set(state.chats.map(chat => chat.id));
    state.chatRuns = state.chatRuns.filter(run => chatIds.has(run.chatId));
  }
  compactChatRuns(state, state[snapshotSource]?.committedRuns, ctx.home);
  if (!(Number(state._storageFormat) >= 2)) await backupLegacyState(ctx);
  if (state._storageFormat !== 3) await backupAgentState(ctx);
  const unchanged = Number(state._storageFormat) >= 2 && !state[snapshotSource]?.requiresRepair
    ? unchangedChats(state, state[snapshotSource]?.base) : new Set();
  const { keepThreadIds } = await measureStage('state.threads.persist', () => persistChatThreads(state.chats, { threadsDir: ctx.threadsDir, unchanged }));
  const next = { ...state, ...serializeAgentState(state), _storageFormat: 3, _revision: (Number(state._revision) || 0) + 1,
    chats: state.chats.map(serializeChatForPersistence) };
  // The manifest is the commit point: a failed write cannot publish staged
  // message files, and the previous committed checkpoints still exist.
  await measureStage('state.manifest.commit', () => _writeState(ctx.stateFilePath, next));
  state._storageFormat = next._storageFormat;
  state._revision = next._revision;
  state[snapshotSource] = { home: ctx.home, fingerprint: fingerprint(`${JSON.stringify(next, null, 2)}\n`), requiresRepair: false, committedRuns: structuredClone(state.chatRuns || []) };
  // Publish the same Agent representation that reached disk, while retaining
  // full runtime transcripts (the manifest contains checkpoint references only).
  const published = publishCommitted(ctx, {
    ...next, chats: state.chats, [snapshotSource]: state[snapshotSource],
  }, await manifestStamp(ctx), unchanged);
  state[snapshotSource] = published.source;
  try {
    if (!dispatchDerivedCommit(ctx.home, next._revision)) measureStageSync('memory.index', () => syncDerivedSnapshot(published.state, ctx));
  } catch (error) {
    console.warn(`Derived snapshot deferred: ${error.message}`);
  }
  try {
    await pruneThreadCheckpoints(keepThreadIds, { threadsDir: ctx.threadsDir });
  } catch (error) {
    console.warn(`Checkpoint cleanup deferred: ${error.message}`);
  }
}

// Legacy initialization/import API. Never silently accept a stale loaded snapshot.
// Production business mutations use updateStateAtomically; see architecture boundary tests.
export async function saveState(state, { ctx = null, capturedStatePath = null } = {}) {
  const source = state[snapshotSource];
  const home = ctx?.home || (capturedStatePath ? dirname(dirname(capturedStatePath)) : source?.home || getMeloHome());
  const captured = ctx || captureLoadContext(home);
  return enqueueStateWrite(async () => {
    if (source) {
      const current = await readFile(captured.stateFilePath, 'utf8').catch(error => {
        if (error.code === 'ENOENT') return '';
        throw error;
      });
      if (source.home !== home || fingerprint(current) !== source.fingerprint) {
        const error = new Error('State changed since this snapshot was read. Use updateStateAtomically.');
        error.code = 'STATE_CONFLICT';
        error.statusCode = 409;
        throw error;
      }
    }
    await persistStateAtomically(state, { ctx: captured, capturedStatePath });
    state[snapshotSource] = committedByHome.get(captured.home)?.source || state[snapshotSource];
    return state;
  }, { home });
}

export function enqueueStateWrite(work, { home = getMeloHome() } = {}) {
  let key = resolve(home);
  try { key = realpathSync(key); } catch {}
  const current = currentRequestContext();
  const context = current?.home === home ? current : createRequestContext({ ...current, home });
  const queued = startStage('state.queue.wait');
  const result = (stateQueues.get(key) || Promise.resolve()).catch(() => {}).then(() => { queued(); return runWithRequestContext(context, work); });
  stateQueues.set(key, result);
  const cleanup = () => { if (stateQueues.get(key) === result) stateQueues.delete(key); };
  result.then(cleanup, cleanup);
  return result;
}

export async function updateStateAtomically(mutator, { home = getMeloHome() } = {}) {
  const ctx = captureLoadContext(home);
  return enqueueStateWrite(async () => {
    const latestState = ensureSelectedEntities(
      ownCommitted(await readCommitted(ctx)),
    );
    if (!isMarkdownSyncedFor(ctx.home)) markSyncedFor(ctx.home);
    const before = measureStageSync('state.compare.before', () => metadataJson(latestState));
    const candidateState = await mutator(latestState);
    const nextState = ensureSelectedEntities(candidateState || latestState);
    // No-op commands (retries, empty cleanup, identical settings) do not
    // rewrite the manifest or rebuild derived indexes.
    if (nextState._storageFormat !== 3 || latestState[snapshotSource]?.requiresRepair || measureStageSync('state.compare.after', () => metadataJson(nextState)) !== before || unchangedChats(nextState, latestState[snapshotSource]?.base).size !== nextState.chats.length) {
      await persistStateAtomically(nextState, { ctx });
    }
    return nextState;
  }, { home: ctx.home });
}
