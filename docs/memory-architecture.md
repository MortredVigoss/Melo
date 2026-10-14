<!-- Current contract, 2026-10-11; older phase notes below are historical. -->

Memory facts now carry source message/sender, scope, validity and user overrides.
Automatic facts are chat-scoped; explicit local sharing supports project, agent or personal scope. Remote audiences never inherit local shared facts. Corrections replace only matching subjects; legacy invalidation is reconciled into canonical SQLite records. User edits and forgotten tombstones survive checkpoint replay and index rebuild. Original chats remain intact.

Melo bundles quantized multilingual-e5-small and runs ONNX inference on a Node worker. Model assets are checksum-pinned at build time; inference disables networking. No Ollama, separate service or API key is needed. Native 384-dimensional normalized vectors are zero-extended to 1024 for the existing schema without changing cosine distances. The distinct model ID prevents mixing with old bge-m3 vectors. A staged, verified rebuild switches models atomically while keyword recall remains usable. Keyword and semantic candidates are fused for both flat and hierarchical retrieval.

Knowledge → Memory supports viewing facts and source statements, editing, scope selection, reversible forgetting, and records of memory context supplied to new answers. These records do not claim final citation or internal reasoning. Existing source-less facts are labelled accordingly. Tests: `npm run test:memory` (included in the main gate).

---

# Melo Memory Architecture

Historical phase notes: 2026-04-18. The current contract above supersedes old provider defaults and fact-scope behavior described below.

This document describes the memory stack after the Phase A–E rewrite and the
subsequent Dreaming / Pluggable-Backends pass.  It complements
`Memory-Redesign-Proposal.md` (the design) — this file is the **as-built**
reference for engineers working on the stack.

## 1 · Tiers at a glance

```
                    macro (attic)          micro (scene/frame/content)
                 ┌──────────────────┐     ┌────────────────────────────┐
prompt input ──> │ Hot attic (~800) │ ──> │ L0 identity                │
                 │ Warm on-demand   │     │ L1 compact summary         │
                 │ Cold (ANN only)  │     │ L2 session memory          │
                 └──────────────────┘     │ L3 scene recall            │
                                          │ L4 frame recall            │
                                          │ L5 content recall (prompt) │
                                          └────────────────────────────┘
```

### Attic — importance dial

| Tier | Budget | Injection | Entry rule | Exit rule |
|------|--------|-----------|------------|-----------|
| Hot  | ≤ 800 tok | Every turn | pinned / `correction` / `decision` / `useCount ≥ 5 & ≤14d` | idle 14d → Warm |
| Warm | ≤ 1600 tok | On relevant query | `useCount ≥ 1 & ≤30d` | idle 90d → Cold |
| Cold | — | Only if ANN recall hits it | Default | promoted back when use picks up |

### Scene / Frame / Content — structural granularity

| Layer   | `kind` | Window | Purpose |
|---------|--------|--------|---------|
| Scene   | `scene`   | 7d per chat | "When/with whom/about what" anchor |
| Frame   | `frame`   | 3–5 turns   | One picture: discussion slice |
| Content | `prompt` / `fact` | single turn | Verbatim content |

## 2 · Key modules

| File | Responsibility |
|------|----------------|
| `src/memory/store.js` | sqlite-vec + FTS5 persistence; `recallMemories`, `recallMemoriesTiered`, `memoryStats`, attic-level persistence |
| `src/memory/embeddings.js` | Ollama bge-m3 primary, OpenAI text-embedding-3-large fallback; `MELO_OFFLINE_ONLY` gate |
| `src/memory/contextCompact.js` | L1 compactor; falls back to `offline/compact.js` on cloud-LLM failure or offline mode |
| `src/memory/sessionMemory.js` | L2 fact extractor with `validFrom/validTo` + LLM + rule-based union |
| `src/memory/speakerProfile.js` | L4 speaker facts, identity line, compaction |
| `src/memory/frame.js` | Pure `splitFrames` + `buildFrameEntry` |
| `src/memory/scene.js` | Pure `groupIntoScenes` + `buildSceneEntry` |
| `src/memory/attic.js` | `evaluateAtticLevel`, `reassessAttic`, `injectHotAttic` |
| `src/memory/offline/compact.js` | Offline L1: local OAI-compatible LLM + TextRank rule fallback |
| `src/memory/offline/extractor.js` | Offline L2: regex-based fact extractor for all 5 categories |
| `src/memory/dreaming/gates.js` | Pure promotion-gate scoring (recall × diversity × outcome) |
| `src/memory/dreaming/merge.js` | Pure duplicate-merge planner (cosine ≥ `MELO_MERGE_COSINE`) |
| `src/memory/dreaming/backfill.js` | Pure temporal-backfill planner (version regex + age + optional LLM classifier) |
| `src/memory/dreaming/diary.js` | Append-only Markdown audit diary in `~/.melo/desktop/dreams/YYYY-MM-DD.md` |
| `src/memory/dreaming/sweep.js` | Orchestrator: attic reassess → gate filter → merge → backfill → hit prune → diary |
| `src/memory/dreaming/scheduler.js` | `startDreamingScheduler` (incremental + full) and `triggerDreamingNow` |
| `src/memory/providers/MemoryProvider.js` | Abstract backend interface + `ensureProviderShape` validator |
| `src/memory/providers/SqliteVecProvider.js` | Default adapter — forwards to `store.js` (zero-regression path) |
| `src/memory/providers/ChromaProvider.js` | REST adapter for a local/remote Chroma collection |
| `src/memory/providers/LanceDbProvider.js` | Soft-dep adapter using `@lancedb/lancedb` when present |
| `src/memory/providers/HttpProxyProvider.js` | Minimal REST adapter for a user-hosted proxy |
| `src/memory/providers/createProvider.js` | Factory registry + `RouterProvider` (shadow-write + prefix routing) + `buildProviderFromEnv` |
| `src/memory/embedProviders/EmbeddingProvider.js` | Abstract embedding interface + `l2Normalize` / `toDims` helpers |
| `src/memory/embedProviders/OllamaEmbedProvider.js` | Default local embedder (bge-m3 via `/api/embed`) |
| `src/memory/embedProviders/OpenAIEmbedProvider.js` | Cloud fallback (`text-embedding-3-large`), disabled under `MELO_OFFLINE_ONLY` |
| `src/memory/embedProviders/CustomHttpEmbedProvider.js` | User-hosted embedding endpoint |
| `src/memory/embedProviders/createEmbeddingProvider.js` | Registry + LRU cache wrapper + `getEmbeddingProvider` singleton |

## 3 · Environment switches

| Variable | Effect | Default |
|----------|--------|---------|
| `MELO_OFFLINE_ONLY=1` | Disable cloud backends for both embeddings and compact | unset |
| `MELO_OFFLINE_DISABLE_LLM=1` | Even local LLMs are skipped; only rule-based paths run | unset |
| `MELO_MEMORY_TIERS` | Comma-separated subset of `scene,frame,content` | all three |
| `MELO_ATTIC_ENABLED=0` | Skip the Hot attic injection | unset (enabled) |
| `MELO_LOCAL_COMPACT_MODEL` | Local LLM model name for offline compact | `qwen2.5:3b` |
| `MELO_DREAMING_ENABLED` | `0` disables the entire dreaming pipeline (scheduler + `triggerDreamingNow`) | `1` |
| `MELO_DREAMING_INCREMENTAL_MS` | Incremental sweep interval | `21_600_000` (6h) |
| `MELO_DREAMING_FULL_MS` | Full sweep interval | `86_400_000` (24h) |
| `MELO_GATE_W_RECALL` | Promotion-gate weight for log-scaled hit count | `0.4` |
| `MELO_GATE_W_DIVERSITY` | Promotion-gate weight for distinct-query count (saturates at 3) | `0.35` |
| `MELO_GATE_W_OUTCOME` | Promotion-gate weight for good/hit ratio | `0.25` |
| `MELO_GATE_THRESHOLD` | Minimum combined score to promote into `hot` | `0.6` |
| `MELO_MERGE_COSINE` | Cosine threshold for duplicate merger | `0.92` |
| `MELO_STALE_AGE_DAYS` | Minimum age (days) before a row is eligible for temporal backfill | `90` |
| `MELO_STALE_FORCE_DAYS` | Age (days) at which a version-string match auto-expires | `180` |
| `MELO_MEMORY_PROVIDER` | Primary memory backend name (see §10) | `sqlite-vec` |
| `MELO_MEMORY_SHADOW` | Secondary backend name; writes are mirrored (read path untouched) | unset |
| `MELO_MEMORY_ROUTING` | Per-namespace overrides, e.g. `chat:*=sqlite-vec;skill:*=chroma` | unset |
| `MELO_CHROMA_URL` | Base URL of the Chroma server | `http://localhost:8000` |
| `MELO_CHROMA_COLLECTION` | Chroma collection name | `melo_memory` |
| `MELO_LANCE_DIR` | Directory for the LanceDB database | `~/.melo/desktop/lance` |
| `MELO_LANCE_TABLE` | LanceDB table name | `memory` |
| `MELO_MEMORY_HTTP_URL` | Base URL of a user-hosted memory proxy | unset (provider errors if selected) |
| `MELO_MEMORY_HTTP_TOKEN` | Optional bearer token for the proxy | unset |
| `MELO_EMBED_PROVIDER` | Embedding backend name override | auto (ollama → openai → http) |
| `MELO_OLLAMA_URL` | Ollama base URL | `http://localhost:11434` |
| `MELO_OLLAMA_EMBED_MODEL` | Ollama embedding model | `bge-m3` |
| `MELO_EMBED_MODEL` | OpenAI embedding model | `text-embedding-3-large` |
| `MELO_EMBED_DIMS` | Target dimensionality for pad/trim (`toDims`) | provider-native |
| `MELO_EMBED_HTTP_URL` | Base URL for the custom HTTP embedder | unset |
| `MELO_EMBED_HTTP_TOKEN` | Optional bearer token for the custom HTTP embedder | unset |

## 4 · Write path

`buildMemoryStoreEntries` (in `desktopStore.js`) produces rows for every
`kind`.  The order is:

1. `prompt`  — user messages + assistant messages, per chat/project namespace
2. `fact`    — speaker facts (per-speaker namespace)
3. `session-fact`, `approval`, `task`, `identity` — unchanged
4. `frame`   — NEW, via `splitFrames` + `buildFrameEntry`
5. `scene`   — NEW, via `groupIntoScenes` + `buildSceneEntry`

`replaceMemories` rebuilds the table from this list, then
`scheduleEmbeddingFillIn` backfills missing embeddings asynchronously.

## 5 · Read path

`buildAgentMemoryNodeContext` (desktopStore.js ~7025) assembles blocks in
this order:

1. **Hot attic** (atticEnabled only)
2. Speaker identity line
3. Condensed speaker profile **or** bulleted fact list
4. Speaker message recall
5. Other-participant facts (group chats)
6. Past self-corrections
7. Prompt history recall
8. Related approvals / tasks

Callers that want the full 3-tier view use `recallMemoriesTiered`:

```js
const { scenes, frames, contents } = recallMemoriesTiered({
  namespaces: [`chat:${chatId}`],
  query,
  queryEmbedding,
  limits: { scenes: 3, frames: 8, contents: 12 },
  atticLevels: ['warm', 'hot'], // optional
});
```

## 6 · Temporal validity

Every `session-fact` row now carries `validFrom` / `validTo`. Landing a new
`correction` fact stamps `validTo` on all prior active corrections.  Store-
level helpers (`isEntryInvalidated`) enforce this across both keyword and
vector recall paths.

## 7 · Importance feedback

`touchRows` increments `metadata.useCount` on every hit.  `useCountBoost`
adds `log2(n+1) * 20` (capped at 60) to the scoring function, with `/600`
scaling applied on the vector path so it harmonises with cosine-similarity
ranges.

## 8 · Offline readiness

- Embeddings: `ollama pull bge-m3` is the only prereq.  With
  `MELO_OFFLINE_ONLY=1`, cloud paths are skipped entirely.
- Compact: tries Ollama → LM Studio → llama.cpp → rule-based TextRank.  The
  rule summariser never needs the network.
- Session memory: rule extractor covers all 5 fact categories.  When the
  LLM is available its output is unioned with the rule output.

## 9 · Dreaming pipeline

"Dreaming" is the idle-time consolidation pass that keeps the store healthy
without blocking the hot path.  It is driven by two timers in
`src/memory/dreaming/scheduler.js` (incremental every 6h, full every 24h)
plus an idle-watch hook that can trigger a sweep when the user has been
inactive for 10 minutes.  The entire pipeline short-circuits when
`MELO_DREAMING_ENABLED=0`.

A single call to `runDreamingSweep()` executes these phases in order:

1. **Attic reassess + promotion gate.**  Rows flagged by
   `listMemoriesForAtticReassess` are scored against `memory_hits` via
   `getHitStats` and passed to `scoreGate()`.  A row is promoted to `hot`
   only when

   ```
   score = w_recall · log2(hits+1)/log2(11)
         + w_diversity · min(distinctQueries, 3)/3
         + w_outcome · goodOutcomes/hits
   ```

   clears `MELO_GATE_THRESHOLD` (default `0.6`).  `correction`, `decision`,
   `identity` and any row with `metadata.pinned=true` bypass the gate (they
   keep the existing importance-by-category rule).

2. **Duplicate merger.**  `listMergeCandidates` pulls rows grouped by
   `(namespace, kind)`; `planDuplicateMerges` runs pairwise cosine on
   embeddings and emits `[{keepId, dropId, useCountBonus}]` pairs for every
   match at or above `MELO_MERGE_COSINE`.  `mergeMemoryInto` is
   transactional: the survivor inherits `useCount + bonus`, appends the
   loser's id to `metadata.mergedFrom[]`, and the loser is demoted to
   `cold` with `metadata.mergedInto` set so future recalls can still link
   back.

3. **Temporal backfill.**  Rows older than `MELO_STALE_AGE_DAYS` with no
   `validTo` and zero `useCount` are run through `planTemporalBackfill`.
   Two rules fire:  a version-string regex combined with age ≥
   `MELO_STALE_FORCE_DAYS` is enough on its own, and an optional async
   `llmClassifier(row)` can catch ambiguous preferences.  Any exception
   from the classifier is swallowed so the sweep never fails because of a
   bad LLM response.  Matches get `validTo = now` via `setValidTo`.

4. **Hit pruning.**  `pruneHits({maxDays: 60})` drops `memory_hits` rows
   older than 60 days so the table stays bounded.

5. **Audit diary.**  `appendDreamRecord(summary)` writes an append-only
   Markdown entry to `~/.melo/desktop/dreams/YYYY-MM-DD.md` with per-run
   counts and id-level detail for promoted / merged / expired rows.

The sweep is idempotent: running it twice in a row produces a second diary
entry with all-zero counts.  Every pure planner (gates / merge / backfill /
diary) is unit-tested; the orchestrator is covered by
`scheduler.test.js` and an integration smoke-test.

## 10 · Provider / Embedding abstraction

The memory store is now backend-agnostic behind `MemoryProvider`.  The
abstract interface is:

```
upsert(entry) · replaceAll(entries) · search(opts) · searchTiered(opts)
stats() · listForReassess(opts) · setAtticLevels(ids, level)
recordHit({memoryId, queryHash, rank, outcome}) · close()
```

`SqliteVecProvider` is the default and just forwards to `store.js`, so
turning the abstraction on with no env vars is a no-op.  The other
built-in adapters are:

| Provider | When to use | Notes |
|----------|-------------|-------|
| `sqlite-vec` | Single-user desktop (default) | Full tiered recall, FTS5 keyword path, local only |
| `chroma` | You already run Chroma | REST to `MELO_CHROMA_URL`; `searchTiered` approximated as three kind-filtered queries |
| `lancedb` | You want an embedded columnar store | Soft dep via dynamic import — provider is `null` if `@lancedb/lancedb` is missing |
| `http-proxy` | You want a team-shared server | Minimal REST (`/upsert`, `/search`, `/search_tiered`, `/stats`, `/attic_update`, `/reassess`) |

`RouterProvider` wraps any primary with two extra behaviours:

- **Shadow-write.**  Every `upsert` / `replaceAll` is mirrored to the
  provider named in `MELO_MEMORY_SHADOW`.  Reads never hit the shadow.
  Use this to validate a new backend against production traffic before
  flipping the primary.
- **Namespace routing.**  `MELO_MEMORY_ROUTING=chat:*=sqlite-vec;skill:*=chroma`
  parses into `[{prefix, provider}]`; any entry whose `namespace` starts
  with a prefix is redirected to that provider instead of the primary.
  The matching is longest-prefix-wins in declaration order.

Embeddings follow the same pattern in `embedProviders/`.
`getEmbeddingProvider()` returns a singleton that tries
`MELO_EMBED_PROVIDER` first, otherwise falls back in order
`ollama → openai → custom-http`.  Every provider is wrapped in an LRU
cache (`withEmbeddingCache`, 512 entries) so repeated `embed(text)` calls
inside the same process are free.  `l2Normalize` + `toDims` make it safe
to mix providers with different native dimensionality — set
`MELO_EMBED_DIMS` to force a common width.

## 11 · Operational notes

- Frame / scene entries are rebuilt by `replaceMemories` on every snapshot —
  this means stale entries never leak; the trade-off is a ~O(N²) recompute
  inside each chat.  Large stores should call the incremental code path
  (`upsertMemory`) for individual updates.
- The daily attic reassess (`reassessAttic({ sinceIso })`) is meant to be
  scheduled through `src/tasks/scheduler.js`; it's idempotent and cheap.
  The dreaming scheduler (`startDreamingScheduler`) sits on top of this
  and additionally handles promotion/merge/backfill.
- `memoryStats()` returns the base shape; `memoryStatsExtended()` adds
  `totalHits`, `mergedCount` and `expiredCount` for dashboards.
- Every recall automatically batches a row into `memory_hits`
  (`memoryId`, `hit_at`, `queryHash`, `rank`, `outcome`).  This feeds the
  promotion gate; the table is capped by the 60-day pruner.

## 12 · Rollback

Any phase can be disabled via env var without redeploying:

```
MELO_MEMORY_TIERS=          # disable scene + frame writes
MELO_ATTIC_ENABLED=0        # skip Hot attic injection
MELO_OFFLINE_ONLY=           # re-enable cloud fallback
MELO_DREAMING_ENABLED=0     # freeze dreaming (scheduler + triggerDreamingNow no-op)
MELO_MEMORY_PROVIDER=sqlite-vec  # force default backend
MELO_MEMORY_SHADOW=         # drop shadow mirror
MELO_MEMORY_ROUTING=        # clear per-namespace overrides
MELO_EMBED_PROVIDER=        # fall back to auto-detect (ollama → openai → http)
```

The original `recallMemories` path is preserved so desktopStore code that
doesn't know about tiered recall keeps working unchanged.  Likewise, not
setting any provider env var leaves the stack on `SqliteVecProvider`, which
is bit-for-bit the pre-refactor behaviour.
