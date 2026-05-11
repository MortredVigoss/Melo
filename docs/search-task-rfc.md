# SearchTask Contract — RFC (Phase G-2)

> Status: **RFC draft, not yet implemented**. Started 2026-05-11 after G-1c
> closed.  This doc proposes a unified `SearchTask` contract that fetchUrlTool
> / socialLinkTool / webSearchTool will eventually conform to, but does NOT
> mandate any code change yet — implementation waits on real evidenceTrail
> data from Phase 2 (1-2 day production trail collection).
>
> See `docs/search-system-roadmap.md` §#2 for context + Lessons learned
> §3 ("Codex C 出来时做 systematic 检查同类") which this RFC tries to
> internalize from day one.

---

## 1. Problem statement (grep evidence)

`grep` of return shapes across the 3 tools shows the current sprawl:

| Tool | API surface | Success shape | Fail shape | abort marker |
|---|---|---|---|---|
| `fetchUrlTool` | tool API | `{ok:true, output, meta:{url,method,length,via,canonicalUrl}, evidenceTrail}` | `{ok:false, output, error:'INVALID_URL'\|'NO_CONTENT'\|..., evidenceTrail}` | **no** explicit abort flag |
| `socialLinkTool.readSocialLink` | internal helper (consumed by fetchUrlTool + media/index.js) | `{body, via, canonicalUrl, evidenceTrail, preview?, meta?, originalUrl?}` | miss: `{body:'', via:'none', evidenceTrail, missed:true}` | `{body:'', via:'aborted', evidenceTrail, aborted:true}` |
| `webSearchTool` | tool API | `{ok:true, output, meta:{query,provider,resultCount,contentFetched,results,timings,spanId,intent,rerank,synonymRetry}, evidenceTrail}` | `{ok:false, output, error:'SEARCH_FAILED'\|..., meta?, evidenceTrail, aborted?}` | `aborted:true` flag |

### Concrete consistency gaps

1. **Output channel naming**: `output` (fetchUrl, webSearch) vs `body`
   (socialLink). Agent prompt builders have to switch on caller.
2. **Metadata bag naming**: `meta` (fetchUrl, webSearch) vs scattered
   top-level fields (`canonicalUrl`, `preview`) on socialLink. Same
   structural data, different containers.
3. **Error code vocabulary**: `INVALID_URL` / `NO_CONTENT` /
   `SOCIAL_LINK_BLOCKED` / `SOCIAL_LINK_FAILED` / `SEARCH_FAILED` —
   no shared taxonomy.  Agent retry logic has to special-case each.
4. **Abort indication**: fetchUrlTool *has no* `aborted` flag (caller
   infers from `evidenceTrail`); socialLinkTool + webSearchTool do.
   Inconsistent observability.
5. **`evidenceTrail` already aligned** ✅ (Phase G-1 win — same schema
   across all three).

### What this costs the agent

- `chatExecutionRunner` and `agentMemoryContext` need to know each
  tool's idiosyncratic shape to pull out title / URL / snippet / failure
  reason.  Adding a 4th source (RSS, papers, internal docs…) means
  another shape switch.
- Future SearchTask routing (one decision in agent, dispatch to N tools)
  is blocked: the agent can't dispatch on a uniform shape it doesn't
  have.
- Codex C-roundsto fix abort flag would have been caught earlier if the
  contract was uniform.

---

## 2. Proposed `SearchTask` contract

```js
/**
 * @typedef {Object} SearchTaskInput     — what the agent constructs
 * @property {string}   query             — required.  Original user/agent intent.
 * @property {string}   [url]             — when the task is "read this URL".
 * @property {'web-search'|'url-fetch'|'social-link'|'memory-recall'|'file-grep'} source
 *                                       — picked by the upstream router (G-3+).
 * @property {'lookup'|'verify'|'summarize'|'deep-research'} intent
 *                                       — agent's intent label; influences
 *                                          fallbackPolicy + recall depth.
 * @property {'text'|'json'|'media-extract'} expectedOutput
 * @property {Object}   [fallbackPolicy]
 * @property {string[]} [fallbackPolicy.tiers]      — allowed tier list
 * @property {number}   [fallbackPolicy.maxLatencyMs]
 * @property {boolean}  [fallbackPolicy.acceptPartial]
 * @property {string[]} [fallbackPolicy.requireSources]  — e.g. ['social-link']
 *                                                          to force domain-specific reader
 * @property {AbortSignal} [signal]
 */

/**
 * @typedef {Object} SearchTaskResult    — what every tool returns
 * @property {'ok'|'partial'|'fail'} status
 *                                       — `ok`  = full result usable
 *                                       — `partial` = some evidence but
 *                                          fallbackPolicy.acceptPartial
 *                                          required (e.g. social-link
 *                                          got share-preview, deep yt-dlp
 *                                          missed)
 *                                       — `fail` = no usable evidence
 * @property {string}   query             — echoed back, for trail joins
 * @property {EvidenceTrailEntry[]} evidenceTrail
 *                                       — already-aligned schema from G-1
 * @property {Array<EvidenceItem>} evidence
 *                                       — normalized items the agent reads
 * @property {Object}   meta              — task-level details
 * @property {string}   meta.source       — which `source` ran
 * @property {string}   [meta.via]        — finest-grained method tag
 *                                          (e.g. 'jina', 'browser:douyin',
 *                                          'crawl4ai')
 * @property {Object}   meta.timings      — {totalMs, byTier}
 * @property {boolean}  [meta.aborted]    — true iff signal aborted mid-run
 * @property {Object}   [meta.cache]      — {hit:'fresh'|'stale'|'miss',
 *                                          ageMs?}
 * @property {string}   [error]           — when status='fail': taxonomy code
 * @property {string}   [output]          — legacy rendered text for tool
 *                                          API back-compat; new agents
 *                                          should prefer `evidence[]`
 */

/**
 * @typedef {Object} EvidenceItem
 * @property {'web-page'|'social-link'|'cached'|'partial-only-preview'|'memory'|'file'} sourceType
 * @property {string}   title
 * @property {string}   url
 * @property {string}   [snippet]          — short summary / OG description
 * @property {string}   [body]             — full extracted content (truncated to MAX_CONTENT_LENGTH)
 * @property {'high'|'medium'|'low'|'unknown'} confidence
 *                                        — derived from extractionMethod
 *                                          (yt-dlp body = high, share-
 *                                          preview = medium, OG-only = low)
 * @property {string}   extractionMethod  — same vocab as evidenceTrail.tier
 * @property {boolean}  isPartial         — true iff status='partial' source
 * @property {string}   [fetchedAt]       — ISO timestamp
 * @property {string}   [contentHash]     — for dedup across tools
 */
```

### Error code taxonomy (unified)

```
INVALID_INPUT      — input.query empty / input.url malformed
TIMEOUT            — overall maxLatencyMs hit
ABORTED            — caller signal aborted (status='fail', meta.aborted=true)
NO_RESULTS         — search ran but found nothing
LOGIN_REQUIRED     — content needs cookies / login (was SOCIAL_LINK_BLOCKED)
EXTRACTION_FAILED  — page reachable but parser couldn't read it
NETWORK            — DNS / connect / 5xx etc.
PROVIDER_DOWN      — Jina / DDG / Playwright all failed
```

(Maps existing codes: `INVALID_URL`/`INVALID_QUERY` → `INVALID_INPUT`,
`NO_CONTENT` → `EXTRACTION_FAILED`, `SOCIAL_LINK_BLOCKED` →
`LOGIN_REQUIRED`, `SEARCH_FAILED` → context-dependent split.)

---

## 3. Migration path (incremental, back-compat)

**Phase G-2a** (this RFC + types only):
- Add `src/services/search/searchTask.js` exporting **only types/JSDoc**
  and `normalizeToSearchTaskResult(legacyResult, source)` adapter.
- Adapter inspects legacy shape (`{ok, output, meta, evidenceTrail}` for
  fetchUrl/webSearch; `{body, via, evidenceTrail}` for socialLink) and
  emits `SearchTaskResult`.  No production caller changes yet.
- Test: adapter is deterministic + idempotent on each tool's known shapes.

**Phase G-2b** (in-process call sites adopt adapter):
- `chatExecutionRunner` + `agentMemoryContext` wrap each tool call in
  `normalizeToSearchTaskResult` before consuming.  Drops the per-tool
  shape switch from the agent layer.
- Original tool APIs unchanged.

**Phase G-2c** (tools emit SearchTaskResult natively, parallel return):
- Each tool's `run()` returns BOTH the legacy shape AND a `searchTask`
  field carrying the normalized result.  Adapter from G-2a still works
  for callers that haven't migrated.
- Legacy callers see no change; new callers can opt into `.searchTask`.

**Phase G-2d** (deprecate legacy fields):
- After 2-week observation window, deprecate `output` / `meta` / `body`
  on the legacy shape.  Tools log a debugWarn when consumers read them.
- Final removal in Phase G-3.

---

## 4. Open questions (wait for Phase 2 real-data input)

1. **`fallbackPolicy.tiers` vocabulary** — should we lock it to the
   evidenceTrail tier names (cookie-resolve, social-link.yt-dlp, jina,
   playwright, external-reader.crawl4ai…) or invent a higher-level
   policy DSL?  Data needed: which tier combinations actually show up
   in production trails.
2. **`confidence` derivation** — proposed mapping (yt-dlp body = high,
   share-preview = medium, OG-only = low) is a guess.  Should sample
   real trails + check whether the resulting `confidence` predicts
   downstream "agent retried or stopped".
3. **Partial-result semantics** — when `status='partial'`, should
   `evidence[]` mark each item with `isPartial` independently, or is
   it always all-or-nothing per task?  Today's social-link can return
   partial (deep yt-dlp missed → shallow share-preview accepted), but
   webSearch is always all-or-nothing.  Need a decision.
4. **`source` dispatch** — does the agent pick `source` upfront, or
   does the router try multiple and merge?  G-3 social-link 4-level
   fallback says the latter; G-2 has to decide whether `source` is
   a routing hint or a hard constraint.

---

## 5. What this RFC does NOT solve (kept separate)

- Per-tool tier-level abort (G-1c's 6-commit chain solved this for
  webSearchTool; fetchUrl + socialLink each had their own chain).
- Playwright CLI subprocess kill (G-5 abort 链路 milestone).
- UI evidence layer / agent search merge (G-4).
- Prompt injection defense for fetched content (G-5 second half).

---

## 6. Decision points before implementation

Before any code lands, the project owner should sign off on:

- [ ] **Output channel naming**: keep `output` for legacy + add
      `evidence[]` for structured?  Or rename `output` → `text` for
      semantic clarity?
- [ ] **Error taxonomy** — 8 codes above feel right, or merge some?
- [ ] **Partial-result mark granularity** — per-item or per-task?
- [ ] **Migration scope** — only the 3 tools, or also memory-recall
      and file-grep in this milestone?

Phase G-2 won't ship until these are answered.  Real trail data from
Phase 2 (1-2 day production run) feeds into questions 2-4 of §4
("Open questions").
