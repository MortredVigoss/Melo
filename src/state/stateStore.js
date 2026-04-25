// State machine — Phase 7d-5α-A1 final commit (commit 8+9 bundle).
//
// This is the bridge module the entire 7d-5α-A1 series has been building
// toward. It owns:
//
//   • The on-disk state.json path (statePath())
//   • The single shared write-queue (stateWriteQueue) — guarantees
//     persist-atomically and save-state writes never overlap.
//   • The "have we synced agent markdown files yet" boot flag
//     (markdownSynced).
//   • The four canonical state-machine entry points the rest of the
//     codebase uses to load / persist desktop state:
//
//       loadState(), saveState(state), persistStateAtomically(state),
//       readStateSnapshot({ persistRepair })
//
//     plus enqueueStateWrite — see the §5 carve-out note below.
//
// Notably NOT here: updateStateAtomically. It stays in desktopStore for
// now because its body uses ensureSelectedEntities, which has 57 callers
// across desktopStore and is not safe to move in this phase. To still
// share the queue with saveState, this module exports an
// `enqueueStateWrite(work)` helper that schedules `work` on the same
// queue. desktopStore's updateStateAtomically uses that helper instead
// of mutating the queue directly.
//
// CLAUDE.md §5 carve-out:
//   • saveState and persistStateAtomically: BYTE-IDENTICAL bodies to the
//     desktopStore originals. They use the local `stateWriteQueue` let
//     directly, exactly as before.
//   • updateStateAtomically (still in desktopStore) is now adapted to
//     call enqueueStateWrite(work) instead of mutating the queue
//     directly. This is the only practical way to keep the queue
//     module-private to stateStore without forcing ensureSelectedEntities
//     into this commit. Documented as a §5 mechanical adjustment, same
//     class as the APP_ROOT dirname adjustment in commit 7.
//
// Sub-phase ledger: this commit closes 7d-5α-A1. After this lands, the
// full state-machine (read + write + queue) lives in src/state/, and
// the chatGraphRunner could in principle be moved to a service module
// without an import cycle on the state-machine quartet. Other elephant
// dependencies (effectiveAgentProfile, prompt builders, etc.) still
// live in desktopStore and would need their own subsequent phases
// (7d-5β / 7d-5γ) before runner extraction can happen.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteJson } from '../storage.js';
import { getMeloHome } from '../config.js';
import { parseStatePayload } from './statePayload.js';
import {
  hydrateState,
  hydrateChatThreads,
  createDefaultState,
} from './stateHydration.js';
import { pruneExcessChats } from './chatPruning.js';
import { mergeDiskSkillsIntoState } from './diskSkills.js';
import {
  importAgentMarkdownFiles,
  queueAgentMarkdownPrime,
} from './markdownSync.js';
import { createAgentMarkdownFileHelpers } from '../services/agent/markdownFiles.js';
import {
  persistChatThreads,
  serializeChatForPersistence,
} from './chatPersistence.js';
import { syncMemoryStoreSnapshot } from './memorySnapshot.js';

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

let stateWriteQueue = Promise.resolve();

// Build a home-bound load context. CLAUDE.md §6: every async hop inside
// readStateSnapshot uses the SAME captured home. The state.json path,
// the agents/ helper factory, the synced-flag key, and the prime
// scheduling all derive from this one capture — no later getMeloHome()
// reads, no lazy resolvers.
function captureLoadContext() {
  const home = getMeloHome();
  const stateFilePath = join(home, 'desktop', 'state.json');
  const { getAgentMarkdownPaths } = createAgentMarkdownFileHelpers({
    agentsDir: join(home, 'desktop', 'agents'),
  });
  return { home, stateFilePath, getAgentMarkdownPaths };
}

export async function readStateSnapshot({ persistRepair = true } = {}) {
  // Capture once at entry. Any later getMeloHome() reads inside this
  // function (or any function it awaits into) would be a §6 violation
  // and would re-introduce the cross-home leak Codex caught at fix-4.
  const { home, stateFilePath, getAgentMarkdownPaths } = captureLoadContext();

  try {
    const raw = await readFile(stateFilePath, 'utf8');
    const { parsed, repaired } = parseStatePayload(raw);
    const state = hydrateState(parsed);
    const alreadySyncedThisHome = isMarkdownSyncedFor(home);
    const markdownImported = alreadySyncedThisHome
      ? false
      : await importAgentMarkdownFiles(state, getAgentMarkdownPaths);
    if (!alreadySyncedThisHome) {
      markSyncedFor(home);
      queueAgentMarkdownPrime(state, home, getAgentMarkdownPaths);
    }
    const threadRepaired = await hydrateChatThreads(state);
    await mergeDiskSkillsIntoState(state);

    // Auto-prune legacy excess chats (from before the MAX_RECENT_CHATS limit was enforced).
    const excessBefore = (state.chats || []).length;
    pruneExcessChats(state);
    const prunedExcess = excessBefore > (state.chats || []).length;

    if ((repaired || markdownImported || threadRepaired || prunedExcess) && persistRepair) {
      // Pass the captured stateFilePath through so the repair save also
      // writes to the home we read from, regardless of any env flip
      // during this load chain.
      await saveState(state, { capturedStatePath: stateFilePath });
    }

    return state;
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      const state = createDefaultState();
      await importAgentMarkdownFiles(state, getAgentMarkdownPaths);
      markSyncedFor(home);
      queueAgentMarkdownPrime(state, home, getAgentMarkdownPaths);
      await hydrateChatThreads(state);
      await mergeDiskSkillsIntoState(state);
      return state;
    }

    throw new Error(`Failed to read desktop state: ${error.message}`);
  }
}

export async function loadState() {
  return readStateSnapshot({ persistRepair: true });
}

/**
 * Persist state to disk.
 *
 * @param {object} state — desktop state to persist.
 * @param {object} [options]
 *   • capturedStatePath — when provided, write to this exact path instead
 *     of resolving from current MELO_HOME. CLAUDE.md §6: lets callers like
 *     readStateSnapshot's repair-save tunnel the home captured at the top
 *     of the load chain through the async write path, even if env flips.
 *     Falls back to lazy `getMeloHome()` resolution for callers (like
 *     desktopStore's updateStateAtomically) that don't have a captured
 *     path of their own.
 */
export async function persistStateAtomically(state, { capturedStatePath = null } = {}) {
  await persistChatThreads(state.chats);
  const targetPath = capturedStatePath || join(getMeloHome(), 'desktop', 'state.json');
  await atomicWriteJson(targetPath, {
    ...state,
    chats: state.chats.map(serializeChatForPersistence),
  });
  syncMemoryStoreSnapshot(state);
}

export async function saveState(state, { capturedStatePath = null } = {}) {
  stateWriteQueue = stateWriteQueue
    .catch(() => {})
    .then(() => persistStateAtomically(state, { capturedStatePath }));
  await stateWriteQueue;
  return state;
}

// CLAUDE.md §5 carve-out: this helper exists so updateStateAtomically (still
// in desktopStore for ensureSelectedEntities-dependency reasons) can share
// the same write queue as saveState above. It's a 5-line wrapper that
// preserves the queue's serialization contract without exposing the let
// binding (named imports of `let` are read-only across modules).
export async function enqueueStateWrite(work) {
  stateWriteQueue = stateWriteQueue.catch(() => {}).then(work);
  return stateWriteQueue;
}
