import { startBuiltinMaintenance } from './builtinMaintenance.js';
import { stopBuiltinEmbeddings } from './embedProviders/BuiltinEmbedProvider.js';
/**
 * Memory runtime — centralised boot wiring for the memory subsystem.
 *
 * This module is the single place the desktop server (or any other host)
 * calls at startup to:
 *
 *   1. Resolve the configured memory provider (sqlite-vec / chroma / lancedb /
 *      http-proxy, with optional shadow + per-namespace routes) so that any
 *      misconfigured env var fails fast.
 *   2. Resolve the bundled embedding model (or an explicit integration override)
 *      and rebuild old vectors in verified, staged batches when needed.
 *   3. Register the dreaming scheduler timers (incremental + full sweeps).
 *
 * The returned handle exposes `stop()` so the host can release timers on
 * shutdown (SIGINT / SIGTERM).  All three phases are wrapped in individual
 * try/catch blocks because a memory-subsystem failure must never take the
 * server down — the core chat path uses `store.js` directly and tolerates a
 * missing dreaming worker.
 *
 * Enable / disable flags (env):
 *   • MELO_MEMORY_RUNTIME=0        skip the whole runtime (tests, paranoid users)
 *   • MELO_DREAMING_ENABLED=0      scheduler no-ops (see dreaming/sweep.js)
 *   • MELO_MEMORY_PROVIDER=…       picks primary provider (see createProvider.js)
 *   • MELO_EMBED_PROVIDER=…        picks embedding backend
 */

import { getMemoryProvider } from './providers/createProvider.js';
import { getEmbeddingProvider } from './embedProviders/createEmbeddingProvider.js';
import { checkEmbeddingDimensions, EMBEDDING_DIMS } from './embeddings.js';
import {
  readStoredEmbeddingDims,
  readStoredEmbeddingModelId,
  requireEmbeddingRepair,
  writeStoredEmbeddingModelId,
} from './store.js';
import { startDreamingScheduler, stop as stopDreamingScheduler } from './dreaming/scheduler.js';

let _runtimeHandle = null;

/**
 * Initialise the memory runtime.  Idempotent — calling twice returns the same
 * handle.  Safe to call even when the env disables parts (each phase is
 * optional and failures are logged, not thrown).
 *
 * @param {Object}   [opts]
 * @param {Function} [opts.log]                logger; defaults to console.warn
 * @param {boolean}  [opts.skipScheduler]      true in tests that don't want timers
 * @returns {Promise<{
 *   stop: () => void,
 *   provider: any | null,
 *   embedder: any | null,
 *   schedulerStarted: boolean,
 * }>}
 */
export async function startMemoryRuntime({
  log = (msg) => { try { console.warn(msg); } catch {} },
  skipScheduler = false,
} = {}) {
  if (_runtimeHandle) return _runtimeHandle;

  if (process.env.MELO_MEMORY_RUNTIME === '0') {
    _runtimeHandle = {
      stop: () => {},
      provider: null,
      embedder: null,
      schedulerStarted: false,
    };
    return _runtimeHandle;
  }

  // Phase 1 — memory provider singleton (router + shadow + routes).
  let provider = null;
  try {
    provider = await getMemoryProvider();
  } catch (err) {
    log(`[memory.runtime] provider init failed: ${err?.message || err}`);
  }

  // Phase 2 — embedding provider singleton.  Null is OK — the recall path has
  // a keyword fallback when no embedder is configured.
  let embedder = null;
  try {
    embedder = await getEmbeddingProvider();
  } catch (err) {
    log(`[memory.runtime] embedder init failed: ${err?.message || err}`);
  }

  // Phase 2.5 — P2-13: detect embedding dim mismatch between the active
  // provider and either the canonical constant or what's already stored on
  // disk.  Either kind of mismatch means stored vectors can't be compared
  // against new embeddings meaningfully (they're from different spaces).
  //
  // Preserve the old index until a staged replacement has been verified.
  // Keyword recall remains available while incompatible vectors are excluded.
  try {
    const check = await checkEmbeddingDimensions(embedder);
    const storedDims = readStoredEmbeddingDims();
    if (check.ok) {
      // Canonical alignment is fine.  Now compare against the dims that
      // were last written — if the user swapped providers between runs,
      // old vectors may be in a 1024-dim space that's still the right
      // magnitude but from an incompatible model.  The vec_memories
      // table-schema check in store.js handles dims-don't-fit-rebuild;
      // here we only warn if the stored dims record disagrees.
      if (storedDims && storedDims !== check.dims) {
        log(`[memory.runtime] P2-13: stored embedding_dims=${storedDims} but provider reports ${check.dims} — preserving vectors until a verified repair completes`);
        requireEmbeddingRepair();
        log(`[memory.runtime] P2-13: preserved vectors; repair required`);
      }
    } else if (check.reason === 'provider-canonical-mismatch') {
      log(`[memory.runtime] P2-13: embedding provider dims=${check.providerDims} ≠ canonical EMBEDDING_DIMS=${EMBEDDING_DIMS}. ` +
          `Vectors will be padded/truncated in getEmbedding, but old stored vectors may be from a different space.`);
      if (storedDims && storedDims !== EMBEDDING_DIMS) {
        requireEmbeddingRepair();
        log(`[memory.runtime] P2-13: preserved vectors; repair required`);
      }
    } else if (check.reason === 'provider-no-dims') {
      log(`[memory.runtime] P2-13: embedding provider did not declare dims — skipping alignment check`);
    }

    // Phase 2 #2 — modelId drift detection.  Dims can match across two
    // completely unrelated vector spaces (OpenAI 1024 ↔ Voyage 1024), so
    // we also record the *model id* that produced the current on-disk
    // vectors.  If the next boot's provider reports a different modelId,
    // surface a loud WARN but do NOT auto-wipe — the two spaces *might*
    // actually be aliases (e.g. a custom gateway exposing ada-002 under a
    // different name), and wiping is destructive.  The operator can clear
    // vectors explicitly via wipeEmbeddingsForDimChange() or a UI action.
    try {
      const providerModel = embedder?.modelId ? String(embedder.modelId).trim() : '';
      const storedModel = readStoredEmbeddingModelId();
      if (providerModel) {
        if (!storedModel) {
          // First successful boot with this provider — just tag it.
          writeStoredEmbeddingModelId(providerModel);
        } else if (storedModel !== providerModel) {
          requireEmbeddingRepair();
          log(`[memory.runtime] Phase-2: embedding model drift detected — ` +
              `stored="${storedModel}" but provider reports "${providerModel}". ` +
              `Dims still align, but the two vector spaces may be incompatible. ` +
              `Keyword recall remains available while a verified staged rebuild completes.`);
          // NOT updating _meta on drift — the stored modelId stays pointing
          // at the space that actually wrote the on-disk vectors so the
          // warning persists across reboots until the user resolves it.
        }
      }
    } catch (err) {
      log(`[memory.runtime] Phase-2 model-drift check failed: ${err?.message || err}`);
    }
  } catch (err) {
    log(`[memory.runtime] P2-13 dim-check failed: ${err?.message || err}`);
  }

  // Phase 3 — dreaming scheduler.
  let schedulerStarted = false;
  if (!skipScheduler) {
    try {
      const handle = startDreamingScheduler();
      // `startDreamingScheduler` returns { stop } even when disabled; we track
      // actual registration by checking whether dreaming is enabled.
      schedulerStarted = process.env.MELO_DREAMING_ENABLED !== '0' && !!handle;
    } catch (err) {
      log(`[memory.runtime] scheduler start failed: ${err?.message || err}`);
    }
  }

  const maintenance = !skipScheduler ? startBuiltinMaintenance(embedder,{log}) : null;
  _runtimeHandle = {
    provider,
    embedder,
    schedulerStarted,
    stop() {
      maintenance?.stop();
      stopBuiltinEmbeddings().catch(()=>{});
      try { stopDreamingScheduler(); } catch {}
      _runtimeHandle = null;
    },
  };
  return _runtimeHandle;
}

/** Test-only: reset the singleton so a fresh call to startMemoryRuntime re-runs. */
export function _resetMemoryRuntimeForTests() {
  try { _runtimeHandle?.stop?.(); } catch {}
  _runtimeHandle = null;
}

/** Returns the current handle without starting a new runtime. */
export function getMemoryRuntime() {
  return _runtimeHandle;
}
