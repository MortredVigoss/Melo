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
} from '../services/agent/markdownFiles.js';
import { normalizeMarkdownContent } from '../shared/helpers.js';
import {
  normalizeAgentProfile,
  normalizeAgentProfiles,
  normalizeAgentOverride,
  normalizeProjectAgentOverrides,
} from './agentProfiles.js';
import { allAgentIdsFromProfiles } from '../services/agent/agentLibrary.js';

// Per-MELO_HOME debounce. Original was a single `let markdownPrimeQueued`
// boolean; once one home triggered a prime pass, every other home would
// silently skip because the flag stayed `true` until the in-flight pass
// finished. After this module became non-cache-busted (Phase 7d-5α-A1),
// the flag started leaking across test homes the same way `markdownSynced`
// did. Same fix shape: a Set keyed by current home.
const markdownPrimePendingHomes = new Set();

export async function importAgentMarkdownFiles(state) {
  let changed = false;
  state.agentProfiles = normalizeAgentProfiles(state.agentProfiles);

  for (const agentId of allAgentIdsFromProfiles(state.agentProfiles)) {
    const profile = normalizeAgentProfile(agentId, state.agentProfiles?.[agentId]);
    const paths = getAgentMarkdownPaths(agentId, { scope: 'global' });
    const identityFromDisk = normalizeMarkdownContent((await readTextIfExists(paths.identityPath)) || profile.identity);
    const soulFromDisk = normalizeMarkdownContent((await readTextIfExists(paths.soulPath)) || profile.soulMd);
    if (identityFromDisk !== profile.identity || soulFromDisk !== profile.soulMd) {
      changed = true;
    }
    state.agentProfiles[agentId] = normalizeAgentProfile(agentId, {
      ...profile,
      identity: identityFromDisk,
      soulMd: soulFromDisk,
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
      const paths = getAgentMarkdownPaths(agentId, { scope: 'project', projectId });
      const identityFromDisk = normalizeMarkdownContent((await readTextIfExists(paths.identityPath)) || profile.identity);
      const soulFromDisk = normalizeMarkdownContent((await readTextIfExists(paths.soulPath)) || profile.soulMd);
      if (identityFromDisk !== profile.identity || soulFromDisk !== profile.soulMd) {
        changed = true;
      }
      const normalizedOverride = normalizeAgentOverride(agentId, {
        ...profile,
        identity: identityFromDisk,
        soulMd: soulFromDisk,
      });
      if (normalizedOverride) {
        state.projectAgentOverrides[projectId][agentId] = normalizedOverride;
      }
    }
  }

  return changed;
}

async function primeAgentMarkdownFiles(state) {
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

export function queueAgentMarkdownPrime(state) {
  const home = getMeloHome();
  if (markdownPrimePendingHomes.has(home)) {
    return;
  }

  markdownPrimePendingHomes.add(home);
  const snapshot = {
    agentProfiles: normalizeAgentProfiles(state.agentProfiles),
    projectAgentOverrides: normalizeProjectAgentOverrides(
      state.projectAgentOverrides,
      state.agentProfiles,
    ),
  };

  Promise.resolve()
    .then(() => primeAgentMarkdownFiles(snapshot))
    .catch(error => {
      console.warn(`Failed to prime Melo agent markdown files: ${error.message}`);
    })
    .finally(() => {
      markdownPrimePendingHomes.delete(home);
    });
}

// `getAgentMarkdownPaths` is bound LAZILY here. The factory now accepts
// either a string or a `() => string` for `agentsDir` — by passing the
// getter form, every getAgentMarkdownPaths(...) call re-reads
// `getMeloHome()` at call time. This is required because tests in
// desktopStore.projectsDefault.test.js cache-bust desktopStore.js with
// per-test MELO_HOME values, but that trick does NOT cascade to
// dependency modules — markdownSync.js is loaded once. Without lazy
// resolution this module would freeze AGENTS_DIR to whichever home was
// active at first load and silently read/write the wrong agents
// directory across MELO_HOME switches. (Phase 7d-5α-A1 commit 9 follow-up,
// CLAUDE.md §5 mechanical adjustment.)
import { createAgentMarkdownFileHelpers } from '../services/agent/markdownFiles.js';
import { join } from 'node:path';
import { getMeloHome } from '../config.js';

const { getAgentMarkdownPaths } = createAgentMarkdownFileHelpers({
  agentsDir: () => join(getMeloHome(), 'desktop', 'agents'),
});
