#!/usr/bin/env node
/**
 * scripts/memory-status.js
 *
 * Phase 1 #5 · Phase 3 · Phase 4 — read-only CLI diagnostics.
 *
 * The actual collection logic lives in src/memory/status.js and the
 * formatters live in src/memory/statusFormat.js, so the UI endpoint
 * (/api/memory/status) and this CLI share one source of truth.
 *
 * Usage:
 *   node scripts/memory-status.js                 # full human-readable
 *   node scripts/memory-status.js --json          # machine-readable
 *   node scripts/memory-status.js --live          # probe live provider (Phase 4)
 *   node scripts/memory-status.js --meta          # only _meta section
 *   node scripts/memory-status.js --dreams        # only dreams section
 *   node scripts/memory-status.js --sections=store,embedding
 *   node scripts/memory-status.js --help
 *
 * Exit codes:
 *   0  snapshot rendered ok
 *   1  store exists but failed to open (db corruption, perms, …)
 *   2  explicit drift detected (only under --live; useful in CI gates)
 */

import { collectMemoryStatus, withLiveProviderModelId } from '../src/memory/status.js';
import {
  parseStatusFlags,
  formatText,
  getHelpText,
} from '../src/memory/statusFormat.js';

/**
 * Try to read the live provider's modelId.  Never throws — if the probe
 * fails (Ollama down, network blocked, provider mis-configured) we just
 * return null and the formatter will say "(provider not available)".
 */
async function probeLiveModelId() {
  try {
    // Import lazily so the default (no --live) path stays lightweight —
    // no Ollama HTTP roundtrip, no openai SDK boot.
    const { getEmbeddingProvider } = await import(
      '../src/memory/embedProviders/createEmbeddingProvider.js'
    );
    const provider = await getEmbeddingProvider();
    if (!provider) return null;
    const id = provider.modelId;
    return typeof id === 'string' && id.trim() ? id.trim() : null;
  } catch {
    return null;
  }
}

async function main() {
  const flags = parseStatusFlags(process.argv.slice(2));

  if (flags.help) {
    process.stdout.write(`${getHelpText()}\n`);
    process.exit(0);
  }

  let snap = collectMemoryStatus();

  if (flags.live) {
    const liveModelId = await probeLiveModelId();
    snap = withLiveProviderModelId(snap, liveModelId);
  }

  if (flags.json) {
    process.stdout.write(`${JSON.stringify(snap, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatText(snap, { sections: flags.sections })}\n`);
  }

  // Exit-code contract:
  //   2 = drift (only under --live, so CI can opt into the gate)
  //   1 = store present but unreadable
  //   0 = clean
  if (flags.live && snap.embedding?.drift?.hasDrift) process.exit(2);
  if (snap.store.exists && snap.store.openError) process.exit(1);
  process.exit(0);
}

main().catch(err => {
  // Unexpected top-level failure — shouldn't happen because collectors are
  // fail-open, but belt-and-suspenders for CI log legibility.
  process.stderr.write(`memory-status: ${err?.message || err}\n`);
  process.exit(1);
});
