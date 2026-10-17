// trailLogger — Phase 2 instrumentation for G-2b round-5 (RFC §7 lesson #5).
//
// Captures real production return shapes from the 3 search tools
// (fetchUrlTool / socialLinkTool / webSearchTool) so the SearchTask
// adapter can be refreshed against actual fixture data instead of
// hand-written guesses (which is what got us 4 Codex C-rounds).
//
// Activation: env var `MELO_SEARCH_TRAIL_LOG=1`.  Default off — no
// production overhead, no privacy leak unless explicitly enabled.
//
// Output: append-only JSONL at
//   $MELO_HOME/desktop/search-trail-log/YYYY-MM-DD.jsonl
// each line is one full search result event:
//   { ts, source, input, ok, error?, aborted?, evidenceTrail, meta }
//
// Body truncation: result.output / result.body capped to 500 chars
// (we want trail+meta shape, not full content — keeps log size sane,
// avoids leaking long page bodies into a debug file).
//
// CLAUDE.md §6 compliance: the log path is resolved AT CALL TIME (via
// getMeloHome()), not at module load.  This is a synchronous write
// path — getMeloHome() inside the function is correct here; lazy
// resolution at module top would freeze the path against whichever
// MELO_HOME was set when the tool was first imported.

import { mkdirSync } from 'node:fs';
import { appendBoundedLog } from './boundedLog.js';
import { dirname, join } from 'node:path';
import { getMeloHome } from '../config.js';
import { createCapabilityRecorder, describeSearchEvidence } from './capabilities.js';

const BODY_TRUNCATE_LIMIT = 500;
// Per-host limit so a single chatty host can't bury the rest.  Soft cap
// — if the log already has > N entries for the same canonical host
// today, skip with a note.  Not enforced in Phase 2 v0; reserved here
// so callers can opt in.
const _PER_HOST_SOFT_LIMIT = 200;

/**
 * @returns {boolean} true iff trail-log capture is currently enabled.
 *   Read at every call; flips when the operator toggles the env var
 *   between turns (e.g. for ad-hoc capture sessions).
 */
export function isTrailLoggingEnabled() {
  return process.env.MELO_SEARCH_TRAIL_LOG === '1';
}

/**
 * Per-day log file path.  Resolved at call time, not at module load,
 * so tests can swap MELO_HOME between runs.
 */
export function trailLogPathFor(iso = new Date().toISOString()) {
  const day = iso.slice(0, 10); // YYYY-MM-DD
  return join(getMeloHome(), 'desktop', 'search-trail-log', `${day}.jsonl`);
}

/**
 * Truncate a string-or-body field to keep the log compact.  Returns
 * the original value untouched when it's not a string.
 */
function _truncate(value, limit = BODY_TRUNCATE_LIMIT) {
  if (typeof value !== 'string') return value;
  if (value.length <= limit) return value;
  return value.slice(0, limit) + `… [truncated ${value.length - limit}c]`;
}

/**
 * Strip large body fields from a result so the log captures shape +
 * meta + trail without ballooning.  Mutates a shallow copy — never
 * the caller's object.
 */
function _shapeForLog(result) {
  if (!result || typeof result !== 'object') return result;
  // Shallow copy the top-level + meta so we don't write through to
  // the caller's object via the truncate calls below.
  const copy = { ...result };
  if (typeof copy.output === 'string') copy.output = _truncate(copy.output);
  if (typeof copy.body === 'string') copy.body = _truncate(copy.body);
  if (copy.meta && typeof copy.meta === 'object') {
    copy.meta = { ...copy.meta };
    // webSearchTool meta.results[] can be 10+ entries — keep but cap.
    if (Array.isArray(copy.meta.results)) {
      copy.meta.results = copy.meta.results.slice(0, 12);
    }
  }
  return copy;
}

/**
 * Wraps a tool's `run` function so every return path is logged without
 * modifying any of the existing return statements (CLAUDE.md §5
 * byte-for-byte friendly).  When trail-log is disabled the wrap is a
 * thin pass-through with negligible overhead.
 *
 * Usage at the tool definition:
 *
 *   export const fetchUrlTool = {
 *     ...,
 *     run: wrapWithTrailLog('url-fetch', async function run({...}, opts) {
 *       ...existing body unchanged...
 *     }),
 *   };
 *
 * The wrap forwards `this` and arguments verbatim so callers that rely
 * on the tool API surface see no difference.
 *
 * @param {'url-fetch'|'social-link'|'web-search'} source
 * @param {Function} runFn  — the original async run() body
 */
export function wrapWithTrailLog(source, runFn) {
  return async function wrappedRun(args, opts = {}) {
    const record = createCapabilityRecorder({ config: opts.config });
    const input = { query: args?.query, url: args?.url };
    let result;
    try {
      result = await runFn.call(this, args, opts);
    } catch (error) {
      if (error?.name !== 'AbortError' && !opts.signal?.aborted) {
        void record(source === 'web-search' ? 'search' : 'link', { ok: false, reason: 'reader-failed' });
      }
      throw error;
    }
    const evidence = describeSearchEvidence(source, result);
    void record(evidence.id, evidence);
    // Best-effort log AFTER the result is in hand — never delay or
    // alter the return on the production path.
    logSearchTrail({ source, input, result });
    return result;
  };
}

/**
 * The one public entry point.  Production callers in fetchUrlTool /
 * socialLinkTool / webSearchTool wrap their return like:
 *
 *   const result = await ...legacy work...;
 *   logSearchTrail({ source: 'url-fetch', input: { url }, result });
 *   return result;
 *
 * Safe to call unconditionally — the env check happens here, not at
 * the call site, so callers don't need to thread debug state.
 *
 * Errors are swallowed silently after a debugWarn — a logging failure
 * must never break a real search.
 *
 * @param {Object} args
 * @param {'url-fetch'|'social-link'|'web-search'} args.source
 * @param {Object} args.input          — { query?, url? } the caller invoked with
 * @param {Object} args.result         — the legacy tool return shape
 */
export function logSearchTrail({ source, input = {}, result } = {}) {
  if (!isTrailLoggingEnabled()) return;
  let path;
  try {
    const ts = new Date().toISOString();
    path = trailLogPathFor(ts);
    mkdirSync(dirname(path), { recursive: true });
    const payload = {
      ts,
      source,
      input: { query: input.query, url: input.url },
      ok: result?.ok ?? (typeof result?.body === 'string' && result.body.length > 0 ? true : undefined),
      error: result?.error,
      aborted: result?.aborted,
      missed: result?.missed,
      evidenceTrail: result?.evidenceTrail,
      meta: _shapeForLog(result).meta,
      output: _shapeForLog(result).output,
      body: _shapeForLog(result).body, // socialLink uses body, not output
    };
    // Single-line JSON for grep / jq friendliness.
    appendBoundedLog(path, JSON.stringify(payload) + '\n');
  } catch (err) {
    // Logging is best-effort.  Don't crash the tool.  Use console.warn
    // directly (not debugWarn) so the warning doesn't get filtered by
    // MELO_DEBUG flags — the operator who turned trail-log ON wants
    // to know if it's silently broken.
    // eslint-disable-next-line no-console
    console.warn(`[trail-log] write failed (path=${path || '<unresolved>'}): ${err?.message || err}`);
  }
}
