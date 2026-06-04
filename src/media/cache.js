import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getMeloHome } from '../config.js';

// G-6 #5 (audit 2026-05-11): `const CACHE_DIR = join(getMeloHome(), 'media-cache')`
// was module-load frozen — CLAUDE.md §6 violation.  `cacheKeyToPath` is called
// from `getCachedExtraction` / `setCachedExtraction` which are async and
// fire-and-forget on errors, so a runtime/test MELO_HOME flip would silently
// write+read against the WRONG home.  Resolved per-call now.
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CACHE_ENTRY_BYTES = 2 * 1024 * 1024;

// 2026-06-04 audit闭环 round-2 (Codex C): the on-read unlink alone does NOT
// bound growth — media keys are `attachment.kind:url`, and a one-shot URL is
// never re-read, so its file never gets pruned on the read path.  A
// rate-limited sweep on the WRITE path walks the shard tree and unlinks every
// expired entry, catching the never-re-read ones too.  Rate-limited (at most
// once per home per cooldown) so the chat hot path isn't charged a shard walk
// on every cache write; no persistent timer (those leak — see the dreaming
// scheduler re-arm fix in this same audit), the write path drives it.
const SWEEP_COOLDOWN_MS = 60 * 60 * 1000; // ≤ 1 sweep/hour per cache dir
const _lastSweepAtMs = new Map(); // cacheDir → last sweep epoch ms
let _pendingSweep = null; // in-flight background sweep promise (test drain hook)

function mediaCacheDir() {
  return join(getMeloHome(), 'media-cache');
}

function cacheKeyToPath(key, dir = mediaCacheDir()) {
  const hash = createHash('sha256').update(String(key || '')).digest('hex');
  return join(dir, hash.slice(0, 2), `${hash.slice(2)}.json`);
}

// Walk the sharded cache dir and unlink every entry older than the TTL.
// Best-effort: never throws, skips anything it can't stat/unlink. `dir` is
// captured by the caller at entry (§6) and threaded in — this async walk
// never re-reads getMeloHome().
async function sweepExpiredEntries(dir) {
  const cutoff = Date.now() - CACHE_TTL_MS;
  let shards;
  try {
    shards = await readdir(dir);
  } catch {
    return; // no cache dir yet — nothing to sweep
  }
  for (const shard of shards) {
    const shardDir = join(dir, shard);
    let files;
    try {
      files = await readdir(shardDir);
    } catch {
      continue;
    }
    for (const file of files) {
      const filePath = join(shardDir, file);
      try {
        const details = await stat(filePath);
        if (details.mtimeMs < cutoff) {
          await unlink(filePath);
        }
      } catch {
        // raced delete / permission / not-a-file — skip, sweep is best-effort
      }
    }
  }
}

// Rate-limited, FIRE-AND-FORGET entry point. Returns synchronously. When the
// cooldown for this cache dir has elapsed it stamps the timestamp (BEFORE
// launching — the synchronous stamp doubles as a single-flight guard, since
// JS is single-threaded a concurrent caller sees the new stamp and skips) and
// kicks the shard walk in the background. The walk is NOT awaited so a large
// cache can never block the media-processing write path (Codex B 闭环:
// awaiting the full sweep risked a hot-path hitch on a big cache). Errors are
// swallowed — cleanup must never surface to the caller.
function maybeSweep(dir) {
  const last = _lastSweepAtMs.get(dir) || 0;
  if (Date.now() - last < SWEEP_COOLDOWN_MS) return;
  _lastSweepAtMs.set(dir, Date.now());
  // Track the in-flight promise so tests can deterministically await it
  // (_drainPendingSweepForTests) instead of guessing tick counts. Production
  // never awaits this — fire-and-forget.
  _pendingSweep = sweepExpiredEntries(dir).catch(() => {});
}

export async function getCachedExtraction(key) {
  try {
    const filePath = cacheKeyToPath(key);
    const details = await stat(filePath);
    if (Date.now() - details.mtimeMs > CACHE_TTL_MS) {
      // Opportunistic prune of the entry we just looked at — cheap, and
      // catches re-read stale keys before the next scheduled sweep. The
      // write-path sweep handles the never-re-read majority. Awaited so it's
      // deterministic; try/catch keeps the read path exception-safe on a race.
      try { await unlink(filePath); } catch { /* best-effort prune */ }
      return null;
    }

    const raw = await readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function setCachedExtraction(key, value) {
  try {
    const dir = mediaCacheDir(); // §6: single home read at entry, threaded below
    const filePath = cacheKeyToPath(key, dir);
    const payload = JSON.stringify(value);
    if (Buffer.byteLength(payload) > MAX_CACHE_ENTRY_BYTES) {
      return;
    }

    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, payload, 'utf8');
    // Rate-limited TTL sweep — the real growth bound (handles one-shot URLs
    // that the on-read prune never sees). Fire-and-forget + cooldown-gated, so
    // it never blocks this write even on a large cache.
    maybeSweep(dir);
  } catch {
    // Cache misses should not block chat flow.
  }
}

// ─── Test hooks ──────────────────────────────────────────────────────────────
// Run the sweep immediately (bypass cooldown) — lets tests assert that
// never-re-read expired entries are pruned. `dir` defaults to the current
// home's cache dir.
export async function _sweepExpiredNowForTests(dir = mediaCacheDir()) {
  await sweepExpiredEntries(dir);
}
export function _resetSweepStateForTests() {
  _lastSweepAtMs.clear();
  _pendingSweep = null;
}
// Await the background sweep launched by the most recent write (if any) so
// tests can assert its effect deterministically — no fixed-tick guessing.
export async function _drainPendingSweepForTests() {
  await _pendingSweep;
}
