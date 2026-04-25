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
import {
  persistChatThreads,
  serializeChatForPersistence,
} from './chatPersistence.js';
import { syncMemoryStoreSnapshot } from './memorySnapshot.js';

// Path resolution is intentionally lazy. `getMeloHome()` reads
// `process.env.MELO_HOME`, which the test suite swaps between fixtures —
// desktopStore.projectsDefault.test.js cache-busts desktopStore.js with a
// query-string trick to load it fresh per test, but that trick does NOT
// cascade to dependency modules like this one. So we re-read MELO_HOME
// on every call site instead of caching it at module load. Behavior is
// byte-equivalent: a fresh value either way, just resolved later.
function statePath() {
  return join(getMeloHome(), 'desktop', 'state.json');
}

let stateWriteQueue = Promise.resolve();
let markdownSynced = false;

export async function readStateSnapshot({ persistRepair = true } = {}) {
  try {
    const raw = await readFile(statePath(), 'utf8');
    const { parsed, repaired } = parseStatePayload(raw);
    const state = hydrateState(parsed);
    const markdownImported = markdownSynced ? false : await importAgentMarkdownFiles(state);
    if (!markdownSynced) {
      markdownSynced = true;
      queueAgentMarkdownPrime(state);
    }
    const threadRepaired = await hydrateChatThreads(state);
    await mergeDiskSkillsIntoState(state);

    // Auto-prune legacy excess chats (from before the MAX_RECENT_CHATS limit was enforced).
    const excessBefore = (state.chats || []).length;
    pruneExcessChats(state);
    const prunedExcess = excessBefore > (state.chats || []).length;

    if ((repaired || markdownImported || threadRepaired || prunedExcess) && persistRepair) {
      await saveState(state);
    }

    return state;
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      const state = createDefaultState();
      await importAgentMarkdownFiles(state);
      markdownSynced = true;
      queueAgentMarkdownPrime(state);
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

export async function persistStateAtomically(state) {
  await persistChatThreads(state.chats);
  await atomicWriteJson(statePath(), {
    ...state,
    chats: state.chats.map(serializeChatForPersistence),
  });
  syncMemoryStoreSnapshot(state);
}

export async function saveState(state) {
  stateWriteQueue = stateWriteQueue
    .catch(() => {})
    .then(() => persistStateAtomically(state));
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
