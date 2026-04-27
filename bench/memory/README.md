# Memory Retrieval Bench

A reproducible recall@k benchmark for `recallMemoriesTiered`. The
`Memory-Redesign-Proposal.md` Phase C verification claims top-5 ≥ 85% on
Telegram long-DM data; this directory turns that claim into a script anyone
can run after a memory-stack change.

## Files

| Path | Role |
|------|------|
| `golden.example.json` | Schema + 2 illustrative entries. Copy to `golden.json` to start. |
| `golden.json` | **gitignored** — the real query set. Holds private conversation snippets. |
| `results-YYYY-MM-DD.md` | One report per run. Default output of `npm run bench:memory`. |

`golden.json` and `results-*.md` are gitignored so private conversation
fragments never enter version control. Commit `golden.example.json` to
document the schema only.

## Schema

```json
{
  "version": 1,
  "queries": [
    {
      "id": "q-001",
      "namespaces": ["chat:abc", "speaker:alice"],
      "query": "Alice 对 LRU capacity 的看法",
      "expectedIds": ["mem_0001"],
      "expectedSubstrings": ["LRU 的默认 capacity 应该是 64"],
      "expectedKinds": ["frame", "content"],
      "tags": ["technical-detail"],
      "notes": "free-form context for the human reviewer"
    }
  ]
}
```

A row is counted as a hit when **either**:

- `expectedIds` contains a recalled `memory.id`, **or**
- any string in `expectedSubstrings` is a (case-insensitive) substring of the
  recalled `search_text` / `text`.

`expectedKinds` is informational; per-kind hit rates are reported separately
so you can see whether the win came from scene / frame / content layer.

## Running

```bash
# uses bench/memory/golden.json by default
npm run bench:memory

# point at a different file
npm run bench:memory -- --golden bench/memory/my-set.json

# skip embeddings (force keyword fallback path)
npm run bench:memory -- --no-embed

# CI gate: exit 2 if Recall@5 < 0.85
npm run bench:memory -- --threshold-recall5 0.85

# emit machine-readable JSON instead of the markdown report
npm run bench:memory -- --json
```

## Building a real golden set

The example file ships with two synthetic rows. Replace them with real
queries using the workflow below. Aim for **30–50 queries** spread across
chat namespaces; that's enough to make recall@5 stable to ~3 percentage
points.

1. Skim recent chats. Pick moments where you remember a fact, decision, or
   correction that should be recoverable later.
2. Write the query the way you'd actually ask it months later (with typos,
   shortened names, mixed languages — match real usage, not idealised
   keywords).
3. Find one or two phrases from the original message that uniquely identify
   it; put them in `expectedSubstrings`.
4. Tag it: `correction`, `decision`, `technical-detail`, `user-preference`,
   `project-context` (the same five categories `sessionMemory.js` extracts).
5. Run the bench. Misses tell you where the stack is weak — usually a
   missing scene boundary, a dead embedding, or a too-aggressive attic
   demotion.

## Reading the report

Each run produces a markdown summary plus per-query detail:

```
Recall@1  : 13/30 (43.3%)
Recall@5  : 23/30 (76.7%)
Recall@10 : 27/30 (90.0%)

Per-kind hit rate (top-k of that kind):
  scene  (top-3) : 5/30  (16.7%)
  frame  (top-8) : 18/30 (60.0%)
  content(top-12): 25/30 (83.3%)

Mean recall latency: 12.4 ms
```

Read top-5 as the headline number — that's what
`Memory-Redesign-Proposal.md` Phase C committed to. The per-kind table tells
you which tier is doing the work; if `content` carries everything and
`scene` / `frame` are flat, the dreaming pipeline isn't promoting useful
mid-tier rows.

## What this bench does NOT measure

- **Quality of the retrieved context.** Whether a frame summary is faithful
  to its underlying turns is covered by `summaryQuality.js` (F-2C), not
  here.
- **Re-ranking quality of the validator.** Stage-4 validation is bypassed
  by default (`validate=false`) so misses are attributable to the recall
  layer, not to conflict pruning. Re-enable with `--validate` if you want
  the full pipeline.
- **Real production embedding model availability.** The bench respects
  `MELO_OFFLINE_ONLY` / `MELO_EMBED_PROVIDER`. If no provider is
  configured, recall falls back to keyword scoring and that fact is noted
  in the report header.
