/**
 * memoryPromotion.js
 *
 * Promotes per-chat sessionMemory facts into the cross-session long-term
 * memories table so they persist after the chat is compacted or deleted.
 *
 * Also provides the background embedding fill-in job that generates
 * embeddings for all memory entries that still lack them.
 *
 * Flow:
 *   After maybeExtractSessionMemory() fires, the caller invokes:
 *     promoteAndPersistFacts(chat, agentId, config)  — fire and forget
 *
 *   This function:
 *     1. Reads session facts from chat.sessionMemory
 *     2. Deduplicates against already-promoted facts (text + optionally semantic)
 *     3. Writes new facts into memories table via upsertMemory
 *     4. Triggers embedding generation for new facts
 *
 * Promoted facts live in namespace `agent:<agentId>` with kind `session-fact`,
 * so they are automatically included in every recallMemories() call.
 */

import { randomUUID } from 'node:crypto';
import {
  upsertMemory,
  recallMemories,
  getMemoriesWithoutEmbeddings,
  saveMemoryEmbedding,
} from './store.js';
import { getEmbedding as _defaultGetEmbedding, cosineSimilarity } from './embeddings.js';

// ─── Dependency injection hook (test-only) ────────────────────────────────────
//
// Production code uses the real `getEmbedding` from ./embeddings.js.  Tests can
// swap it out via `_setGetEmbeddingForTests()` to simulate provider flaps (the
// outer getEmbedding returning null) without having to disable Ollama on the
// host.  This is a Bug C regression lever: we need to prove the promoter
// doesn't retry a just-failed call, which only manifests when getEmbedding is
// genuinely null.
let _getEmbedding = _defaultGetEmbedding;
/** @internal test-only */
export function _setGetEmbeddingForTests(fn) {
  _getEmbedding = typeof fn === 'function' ? fn : _defaultGetEmbedding;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Cosine similarity threshold above which two facts are considered duplicates. */
const DEDUP_THRESHOLD = 0.88;

/** Maximum promoted facts kept per agent. Oldest are pruned beyond this. */
const MAX_PROMOTED_FACTS = 200;

/** Kind identifier used for promoted session memory facts. */
export const PROMOTED_KIND = 'session-fact';

// ─── Deduplication ───────────────────────────────────────────────────────────

function isTextDuplicate(fact, existingTexts) {
  const normalized = fact.toLowerCase().trim();
  for (const existing of existingTexts) {
    const e = existing.toLowerCase().trim();
    if (e === normalized) return true;
    if (e.includes(normalized) || normalized.includes(e)) return true;
  }
  return false;
}

function isSemanticDuplicate(candidateEmb, existingEmbs) {
  for (const emb of existingEmbs) {
    if (cosineSimilarity(candidateEmb, emb) > DEDUP_THRESHOLD) return true;
  }
  return false;
}

// ─── Main promotion function ──────────────────────────────────────────────────

/**
 * Promote new session memory facts from a chat to the long-term memory store.
 * Safe to call fire-and-forget — all errors are swallowed.
 *
 * @param {object} chat      chat record with populated sessionMemory array
 * @param {string} agentId   effective agent id (e.g. 'main')
 * @param {object} config    resolved Melo config (for embedding backend)
 * @returns {Promise<number>} count of newly promoted facts
 */
export async function promoteAndPersistFacts(chat, agentId, config) {
  try {
    const facts = Array.isArray(chat?.sessionMemory) ? chat.sessionMemory : [];
    if (!facts.length) return 0;

    const effectiveAgentId = agentId || 'main';
    const namespace = `agent:${effectiveAgentId}`;
    const now = new Date().toISOString();

    // Load already-promoted facts for this agent to deduplicate against.
    // We explicitly ask for the embedding blob so the semantic-dedup branch
    // below actually has something to compare against (Bug E: without this
    // flag, recallMemories returns embedding=undefined and the whole
    // semantic branch is dead code — every candidate slips through).
    const existingPromoted = recallMemories({
      namespaces: [namespace],
      kinds: [PROMOTED_KIND],
      limit: MAX_PROMOTED_FACTS,
      includeEmbedding: true,
    });

    const existingTexts = existingPromoted.map(r => r.text || '');
    const existingEmbeddings = existingPromoted.map(r => {
      if (!r.embedding) return null;
      try { return new Float32Array(r.embedding.buffer ?? r.embedding); } catch { return null; }
    });
    const hasEmbeddings = existingEmbeddings.some(Boolean);

    let promoted = 0;

    for (const factObj of facts) {
      const factText = String(factObj?.fact || '').trim();
      if (!factText) continue;

      // Fast text dedup
      if (isTextDuplicate(factText, existingTexts)) continue;

      // Semantic dedup (only if we have existing embeddings to compare against).
      // Bug C: track whether we've already called getEmbedding for this fact so we
      // don't retry a just-failed call below. If the provider is flapping, one
      // miss is one miss — the background fill-in job will pick it up later.
      let factEmbedding = null;
      let embedAttempted = false;
      if (hasEmbeddings) {
        factEmbedding = await _getEmbedding(factText, config).catch(() => null);
        embedAttempted = true;
        if (factEmbedding && isSemanticDuplicate(factEmbedding, existingEmbeddings.filter(Boolean))) {
          continue;
        }
      }

      // Build and write the new memory entry
      const entryId = `promoted:${effectiveAgentId}:${randomUUID()}`;
      upsertMemory({
        id: entryId,
        namespace,
        kind: PROMOTED_KIND,
        sourceId: chat?.id || null,
        text: factText,
        searchText: factText.toLowerCase().replace(/\s+/g, ' ').trim(),
        createdAt: factObj?.extractedAt || now,
        updatedAt: now,
        metadata: {
          category: factObj?.category || 'general',
          chatId: chat?.id || null,
          chatTitle: chat?.title || null,
        },
      });

      // Store embedding if available; otherwise schedule fill-in.
      // If we already attempted and got null, do NOT retry — same provider, same
      // call, same odds.  Leave it to scheduleEmbeddingFillIn() to try again.
      let emb = factEmbedding;
      if (!emb && !embedAttempted) {
        emb = await _getEmbedding(factText, config).catch(() => null);
      }
      if (emb) {
        saveMemoryEmbedding(entryId, factText.toLowerCase().replace(/\s+/g, ' ').trim(), emb);
        existingEmbeddings.push(emb);
      }

      existingTexts.push(factText);
      promoted++;
    }

    return promoted;
  } catch {
    return 0;
  }
}

// ─── Background embedding fill-in ────────────────────────────────────────────

let _fillInRunning = false;

/**
 * Generate embeddings for all memory entries that still lack one.
 * Runs in the background — only one instance at a time.
 * Safe to call fire-and-forget.
 *
 * @param {object} config  resolved Melo config
 */
export async function scheduleEmbeddingFillIn(config) {
  if (_fillInRunning) return;
  _fillInRunning = true;
  try {
    const pending = getMemoriesWithoutEmbeddings();
    if (!pending.length) return;

    for (const { id, searchText } of pending) {
      const embedding = await _getEmbedding(searchText, config).catch(() => null);
      if (embedding) {
        saveMemoryEmbedding(id, searchText, embedding);
      }
      // Yield to event loop between each embedding
      await new Promise(resolve => setImmediate(resolve));
    }
  } catch {
    // best-effort
  } finally {
    _fillInRunning = false;
  }
}
