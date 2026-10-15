// Regression coverage for the async-timing C-grade Codex caught against
// commit a104f23.
//
// Bug: queueAgentMarkdownPrime captured `home` at call time for the
// pending-Set debounce, BUT the prime body (executed as a microtask)
// still resolved file paths via the lazy `() => getMeloHome()` factory
// binding. If MELO_HOME flipped between queue and microtask execution,
// the prime would write to whichever home was current at execution
// time, not the one originally queued. CLAUDE.md §6 codifies the
// general rule: "schedule-time capture, async body must not re-read env".
//
// Fix shape (per Codex's Q5-B): bind a home-specific factory at queue
// time using a literal `agentsDir` string, pass the bound
// getAgentMarkdownPaths into primeAgentMarkdownFiles. Same pattern in
// importAgentMarkdownFiles, which spans multiple awaits inside.

import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  importAgentMarkdownFiles,
  queueAgentMarkdownPrime,
} from './markdownSync.js';
import { normalizeAgentProfiles } from './agentProfiles.js';

function freshHome() {
  const home = mkdtempSync(join(tmpdir(), 'melo-async-iso-'));
  mkdirSync(join(home, 'desktop'), { recursive: true });
  return home;
}

function cleanup(home) {
  try { rmSync(home, { recursive: true, force: true }); } catch {}
}

// Minimal state shape that markdownSync needs.
function fakeState() {
  return {
    agentProfiles: normalizeAgentProfiles(),
    projectAgentOverrides: {},
  };
}

// Wait for the in-flight prime microtask + its multiple awaits to settle.
async function waitForPrimeFlush() {
  // The prime body is `Promise.resolve().then(...)` and itself contains
  // ~4 awaits over disk I/O. Two macrotask ticks + a few microtask flushes
  // should be enough on any host that lets local writeFile resolve quickly.
  for (let i = 0; i < 20; i += 1) {
    await new Promise(r => setImmediate(r));
  }
}

test('queueAgentMarkdownPrime: prime body writes to the home captured at queue time, even after env flip', async () => {
  const homeA = freshHome();
  const homeB = freshHome();
  try {
    // Schedule a prime under home A.
    process.env.MELO_HOME = homeA;
    queueAgentMarkdownPrime(fakeState());

    // IMMEDIATELY flip env to home B before the microtask runs.
    process.env.MELO_HOME = homeB;

    // Let the in-flight prime body complete.
    await waitForPrimeFlush();

    // Assert: home A got the markdown files. The buggy code would write
    // to home B because the prime body's lazy resolver would read
    // MELO_HOME at execution time.
    assert.ok(
      existsSync(join(homeA, 'desktop', 'agents', 'global', 'main', 'IDENTITY.md')),
      'home A (the home captured at queue time) must receive the prime writes',
    );
    assert.equal(
      existsSync(join(homeB, 'desktop', 'agents')),
      false,
      'home B (the home active at execution time) must NOT see prime writes',
    );
  } finally {
    cleanup(homeA);
    cleanup(homeB);
  }
});

test('importAgentMarkdownFiles: paths captured at function entry, not re-read across awaits (non-first agent)', async () => {
  const homeA = freshHome();
  const homeB = freshHome();
  try {
    // Plant IDENTITY.md for `research` — the SECOND built-in agent.
    // Codex review of fix-4 caught that asserting the first agent
    // (`main`) doesn't actually exercise the post-await code path: the
    // path for `main` is resolved BEFORE the first await inside
    // importAgentMarkdownFiles, so even a buggy lazy resolver would
    // appear correct for `main`. By asserting `research` (resolved
    // after at least one disk-read await), the test fails under any
    // implementation that re-reads getMeloHome() during async
    // execution.
    const aResearchDir = join(homeA, 'desktop', 'agents', 'global', 'research');
    mkdirSync(aResearchDir, { recursive: true });
    writeFileSync(join(aResearchDir, 'IDENTITY.md'), 'I am home A research agent.');

    const bResearchDir = join(homeB, 'desktop', 'agents', 'global', 'research');
    mkdirSync(bResearchDir, { recursive: true });
    writeFileSync(join(bResearchDir, 'IDENTITY.md'), 'I am home B research agent.');

    const state = fakeState();
    process.env.MELO_HOME = homeA;
    const importPromise = importAgentMarkdownFiles(state);

    // Flip immediately — happens before any awaits inside the import
    // resolve. With the §6-compliant fix, the home captured at function
    // entry is used for every iteration; with a buggy lazy resolver the
    // `research` iteration (post-first-await) would read homeB.
    process.env.MELO_HOME = homeB;

    await importPromise;

    const research = state.agentProfiles.research;
    assert.match(
      research?.identity || research?.identify || '',
      /home A research agent/,
      'research (post-first-await) must still read from the home captured at function entry',
    );
  } finally {
    cleanup(homeA);
    cleanup(homeB);
  }
});

test('readStateSnapshot wraps the entire load chain in a single home capture', async () => {
  // Codex caught (fix-5) that even after fix-4, readStateSnapshot called
  // multiple env-reading helpers in sequence — alreadySynced check,
  // markCurrentHomeMarkdownSynced, queueAgentMarkdownPrime, and the
  // repair-save through saveState all read getMeloHome() independently.
  // This test verifies the unified-capture refactor: schedule a
  // readStateSnapshot under home A, flip to home B, and assert the
  // repair save lands in home A; persona files are now post-save exports only.
  const { readStateSnapshot } = await import('./stateStore.js');
  const homeA = freshHome();
  const homeB = freshHome();
  try {
    // Plant a state.json that will trigger a repair (markdown imported
    // → repair flag → save). Empty state with no agent files works.
    writeFileSync(
      join(homeA, 'desktop', 'state.json'),
      JSON.stringify({ projects: [], chats: [] }),
    );

    process.env.MELO_HOME = homeA;
    const loadPromise = readStateSnapshot({ persistRepair: true });

    // Flip env mid-load. The captured home should still drive everything.
    process.env.MELO_HOME = homeB;

    await loadPromise;

    // Wait for any queued markdown prime to flush.
    for (let i = 0; i < 20; i += 1) {
      await new Promise(r => setImmediate(r));
    }

    // Loading/migrating state must not write persona exports before a save.
    assert.equal(existsSync(join(homeA, 'desktop', 'agents')), false);
    assert.equal(JSON.parse(readFileSync(join(homeA,'desktop','state.json'),'utf8'))._storageFormat,3);
    // Home B: nothing should have leaked here.
    assert.equal(
      existsSync(join(homeB, 'desktop', 'agents')),
      false,
      'home B (the env at flush time) must NOT see any writes from this load',
    );
  } finally {
    cleanup(homeA);
    cleanup(homeB);
  }
});
