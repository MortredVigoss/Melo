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
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
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

test('importAgentMarkdownFiles: paths captured at function entry, not re-read across awaits', async () => {
  const homeA = freshHome();
  const homeB = freshHome();
  try {
    // Plant a distinct IDENTITY.md under home A's main agent.
    const aMainDir = join(homeA, 'desktop', 'agents', 'global', 'main');
    mkdirSync(aMainDir, { recursive: true });
    const homeAIdentity = 'I am home A main agent.';
    writeFileSync(join(aMainDir, 'IDENTITY.md'), homeAIdentity);

    // Plant a different one under home B.
    const bMainDir = join(homeB, 'desktop', 'agents', 'global', 'main');
    mkdirSync(bMainDir, { recursive: true });
    writeFileSync(join(bMainDir, 'IDENTITY.md'), 'I am home B main agent.');

    // Start an import under home A; the function will await disk reads
    // for every agent. Test scenario: env flips mid-flight. Real
    // env-flip happens between commits in tests but timing here is
    // arranged manually.
    const state = fakeState();
    process.env.MELO_HOME = homeA;
    const importPromise = importAgentMarkdownFiles(state);

    // Immediately flip — this happens in the time before the first
    // await inside importAgentMarkdownFiles resolves.
    process.env.MELO_HOME = homeB;

    await importPromise;

    // Assert: home A's identity made it into state, not home B's.
    const profile = state.agentProfiles.main;
    assert.match(
      profile?.identity || profile?.identify || '',
      /home A main agent/,
      'importAgentMarkdownFiles must read from the home captured at function entry',
    );
  } finally {
    cleanup(homeA);
    cleanup(homeB);
  }
});
