import { mergeAgentInstructions } from '../domain/agent/agentDocument.js';
// Agent markdown-file sync — Phase 7d-5α-A1 (commit 8/9).
//
// On state load (readStateSnapshot, now in stateStore.js), Melo:
//   1. Reads any IDENTITY.md / SOUL.md files the user has authored on
//      disk and folds them into state.agentProfiles. Disk wins where
//      it differs from the persisted JSON copy. → importAgentMarkdownFiles
//   2. After the first state read, kicks off a background "prime" pass
//      that creates the `.md` files for any agent profile that doesn't
//      have them yet, so the user can edit them without first triggering
//      an explicit "save". → queueAgentMarkdownPrime + primeAgentMarkdownFiles
//
// The `markdownPrimeQueued` boolean is the debounce: once a prime pass
// is queued, further calls during that pass become no-ops. The flag is
// cleared in the .finally() handler so a state load → save → load cycle
// gets a fresh prime opportunity.
//
// What stays in desktopStore: `syncAgentMarkdownFiles` (used only by
// createCustomAgent). It uses `effectiveAgentProfile` which has 8
// callers and isn't safe to move in this phase. Two near-identical
// helpers split across two files is awkward but unavoidable given the
// dependency graph today.
//
// Per CLAUDE.md §5 (byte-for-byte rule), every body below is verbatim
// from desktopStore.js — only the `export` keyword + this file header
// were added.

import {
  readTextIfExists,
  ensureMarkdownFile,
} from '../persistence/agentMarkdownFiles.js';
import { normalizeMarkdownContent } from '../shared/helpers.js';
import {
  normalizeAgentProfile,
  normalizeAgentProfiles,
  normalizeAgentOverride,
  normalizeProjectAgentOverrides,
} from './agentProfiles.js';
import { allAgentIdsFromProfiles } from '../domain/agent/agentLibrary.js';

// Per-MELO_HOME debounce. Original was a single `let markdownPrimeQueued`
// boolean; once one home triggered a prime pass, every other home would
// silently skip because the flag stayed `true` until the in-flight pass
// finished. After this module became non-cache-busted (Phase 7d-5α-A1),
// the flag started leaking across test homes the same way `markdownSynced`
// did. Same fix shape: a Set keyed by current home.
const markdownPrimePendingHomes = new Map();

/**
 * Import agent IDENTITY.md / SOUL.md from disk into state.agentProfiles.
 *
 * @param {object} state — state object to mutate (and optionally normalize).
 * @param {Function} [providedGetAgentMarkdownPaths] — caller's home-bound
 *   path resolver. CLAUDE.md §6: when readStateSnapshot calls this from
 *   inside a single load-chain, it passes the helper captured at the top
 *   of the chain so every disk path here resolves under the SAME home,
 *   even across the multiple awaits inside this function. When omitted,
 *   the function captures its own helper at entry — preserves legacy
 *   call shape for any sync caller that doesn't span an env-flip risk.
 */
export async function importAgentMarkdownFiles(state, providedGetAgentMarkdownPaths) {
  const getPathsForCapturedHome = providedGetAgentMarkdownPaths
    || createAgentMarkdownFileHelpers({
      agentsDir: join(getMeloHome(), 'desktop', 'agents'),
    }).getAgentMarkdownPaths;

  let changed = false;
  state.agentProfiles = normalizeAgentProfiles(state.agentProfiles);

  for (const agentId of allAgentIdsFromProfiles(state.agentProfiles)) {
    const profile = normalizeAgentProfile(agentId, state.agentProfiles?.[agentId]);
    const paths = getPathsForCapturedHome(agentId, { scope: 'global' });
    const identityFromDisk = normalizeMarkdownContent((await readTextIfExists(paths.identityPath)) || profile.identity);
    const soulFromDisk = normalizeMarkdownContent((await readTextIfExists(paths.soulPath)) || profile.soulMd);
    if (identityFromDisk !== profile.identity || soulFromDisk !== profile.soulMd) {
      changed = true;
    }
    state.agentProfiles[agentId] = normalizeAgentProfile(agentId, {
      ...profile,
      identity: identityFromDisk,
      soulMd: soulFromDisk,
      instructions: mergeAgentInstructions(profile, {identity:identityFromDisk,soulMd:soulFromDisk}),
    });
  }

  state.projectAgentOverrides = normalizeProjectAgentOverrides(
    state.projectAgentOverrides,
    state.agentProfiles,
  );
  for (const [projectId, overrides] of Object.entries(state.projectAgentOverrides)) {
    for (const agentId of allAgentIdsFromProfiles(state.agentProfiles)) {
      const override = overrides?.[agentId];
      if (!override) {
        continue;
      }

      const profile = normalizeAgentProfile(agentId, override);
      const paths = getPathsForCapturedHome(agentId, { scope: 'project', projectId });
      const identityFromDisk = normalizeMarkdownContent((await readTextIfExists(paths.identityPath)) || profile.identity);
      const soulFromDisk = normalizeMarkdownContent((await readTextIfExists(paths.soulPath)) || profile.soulMd);
      if (identityFromDisk !== profile.identity || soulFromDisk !== profile.soulMd) {
        changed = true;
      }
      const normalizedOverride = normalizeAgentOverride(agentId, {
        ...profile,
        identity: identityFromDisk,
        soulMd: soulFromDisk,
        instructions: mergeAgentInstructions(profile, {identity:identityFromDisk,soulMd:soulFromDisk}),
      });
      if (normalizedOverride) {
        state.projectAgentOverrides[projectId][agentId] = normalizedOverride;
      }
    }
  }

  return changed;
}

// `primeAgentMarkdownFiles` and `importAgentMarkdownFiles` both run
// across multiple awaits, AND `queueAgentMarkdownPrime` schedules its
// prime body as a microtask. In all three cases, reading
// `getMeloHome()` lazily (the global lazy-getter trick used elsewhere)
// is wrong: between the call site and the actual disk I/O,
// `process.env.MELO_HOME` can change. Codex review of a104f23 caught
// this — exactly the "background task must capture home at schedule
// time" rule now codified in CLAUDE.md §6.
//
// Fix: each function takes an explicit `helpers` (`getAgentMarkdownPaths`
// bound to a specific agentsDir). queueAgentMarkdownPrime captures the
// helpers ONCE at queue time and passes them through to the prime body.
// importAgentMarkdownFiles captures helpers at function entry. Neither
// reads getMeloHome() during async execution.
async function primeAgentMarkdownFiles(state, getAgentMarkdownPaths) {
  for (const agentId of allAgentIdsFromProfiles(state.agentProfiles)) {
    const profile = normalizeAgentProfile(agentId, state.agentProfiles?.[agentId]);
    const paths = getAgentMarkdownPaths(agentId, { scope: 'global' });
    await ensureMarkdownFile(paths.identityPath, profile.identity);
    await ensureMarkdownFile(paths.soulPath, profile.soulMd);
  }

  for (const [projectId, overrides] of Object.entries(
    normalizeProjectAgentOverrides(state.projectAgentOverrides, state.agentProfiles),
  )) {
    for (const [agentId, override] of Object.entries(overrides || {})) {
      const profile = normalizeAgentProfile(agentId, override);
      const paths = getAgentMarkdownPaths(agentId, { scope: 'project', projectId });
      await ensureMarkdownFile(paths.identityPath, profile.identity);
      await ensureMarkdownFile(paths.soulPath, profile.soulMd);
    }
  }
}

/**
 * Schedule a background "prime" pass that creates IDENTITY.md / SOUL.md
 * files for any agent profile that doesn't have them yet. Debounced
 * per-home so concurrent state loads don't fan out.
 *
 * @param {object} state — agent profiles to prime.
 * @param {string} [providedHome] — home captured at the call site. When
 *   provided, this is used both to key the pending-Set and to bind the
 *   factory used by the async prime body. When omitted, falls back to
 *   reading the env at call time — only safe if the caller is fully
 *   synchronous (no awaits between this call and any MELO_HOME mutation).
 *   CLAUDE.md §6.
 * @param {Function} [providedGetAgentMarkdownPaths] — pre-bound path
 *   resolver matching providedHome. When both are provided the prime
 *   body sees zero env reads end-to-end.
 */
export function queueAgentMarkdownPrime(state, providedHome, providedGetAgentMarkdownPaths) {
  const home = providedHome || getMeloHome();
  if (markdownPrimePendingHomes.has(home)) {
    return markdownPrimePendingHomes.get(home);
  }

  const getPathsForCapturedHome = providedGetAgentMarkdownPaths
    || createAgentMarkdownFileHelpers({
      agentsDir: join(home, 'desktop', 'agents'),
    }).getAgentMarkdownPaths;
  const snapshot = {
    agentProfiles: normalizeAgentProfiles(state.agentProfiles),
    projectAgentOverrides: normalizeProjectAgentOverrides(
      state.projectAgentOverrides,
      state.agentProfiles,
    ),
  };

  const work = Promise.resolve()
    .then(() => primeAgentMarkdownFiles(snapshot, getPathsForCapturedHome))
    .catch(error => {
      console.warn(`Failed to prime Melo agent markdown files: ${error.message}`);
    })
    .finally(() => {
      markdownPrimePendingHomes.delete(home);
    });
  markdownPrimePendingHomes.set(home, work);
  return work;
}

// Each export above (importAgentMarkdownFiles + queueAgentMarkdownPrime)
// constructs its own home-bound factory at the point where the home is
// known to be stable (function entry / queue time). The earlier lazy-getter
// form `agentsDir: () => join(getMeloHome(), 'desktop', 'agents')` from
// Q2b is no longer in use here — it was the right fix for sync call sites
// but doesn't survive an async microtask boundary. The factory itself
// still accepts the lazy-getter form for any other consumer that wants it
// (e.g. desktopStore's syncAgentMarkdownFiles, which is fully sync).
import { createAgentMarkdownFileHelpers } from '../persistence/agentMarkdownFiles.js';
import { join } from 'node:path';
import { getMeloHome } from '../config.js';
