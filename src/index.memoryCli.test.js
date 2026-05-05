// index.memoryCli.test.js — Phase E (2026-05-05).
//
// Subprocess-style smoke tests for the new `melo memory status` and
// `melo memory consolidate` CLI commands. Stands up a temp MELO_HOME
// per test so the assertions don't depend on the developer's
// production store. Covers:
//   - help banner
//   - status against a fresh (empty) home
//   - status --json shape
//   - consolidate when dreaming is disabled
//   - consolidate against an empty store (sweep finishes cleanly)
//
// Why subprocess instead of in-process: index.js installs SIGINT/SIGTERM
// + uncaughtException hooks at module load, plus calls `_cliCleanup`
// which calls `process.exit`. Importing the module inside a test would
// install handlers on the test runner itself and any unhandled
// rejection would tear the suite down. Running as a subprocess keeps
// that side-effect contained.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ENTRY = resolve(__dirname, 'index.js');

async function runMeloCli(args, { env = {} } = {}) {
  const meloHome = await mkdtemp(join(tmpdir(), 'melo-mem-cli-'));
  try {
    const { stdout, stderr } = await execFileP(
      process.execPath,
      [ENTRY, ...args],
      {
        env: {
          // Inherit PATH so node binary resolution still works.
          PATH: process.env.PATH,
          MELO_HOME: meloHome,
          ...env,
        },
        // Don't let a runaway subprocess drag the test suite past its budget.
        timeout: 20_000,
      },
    );
    return { stdout, stderr, meloHome };
  } finally {
    await rm(meloHome, { recursive: true, force: true });
  }
}

test('memory help prints both subcommands and flag list', async () => {
  const { stdout } = await runMeloCli(['memory', 'help']);
  assert.match(stdout, /melo memory <subcommand>/);
  assert.match(stdout, /\bstatus\b/);
  assert.match(stdout, /\bconsolidate\b/);
  assert.match(stdout, /--json/);
  assert.match(stdout, /--full/);
});

test('memory status (no flags) on a fresh MELO_HOME prints the no-store path with valid sections', async () => {
  const { stdout } = await runMeloCli(['memory', 'status']);
  assert.match(stdout, /Melo memory status/);
  assert.match(stdout, /MELO_HOME\s+\//);
  assert.match(stdout, /store path\s+\//);
  assert.match(stdout, /store exists\s+no/);
  // Counts header always emits even when the store is missing.
  assert.match(stdout, /Counts:/);
  // Embedding + tuning sections always emit since they read env, not the db.
  assert.match(stdout, /Embedding:/);
  assert.match(stdout, /Recall tuning/);
});

test('memory status --json on a fresh MELO_HOME emits parseable JSON with expected top-level shape', async () => {
  const { stdout } = await runMeloCli(['memory', 'status', '--json']);
  const parsed = JSON.parse(stdout);
  assert.ok(parsed.snapshot, 'snapshot key present');
  assert.equal(typeof parsed.snapshot.meloHome, 'string');
  assert.equal(parsed.snapshot.store.exists, false);
  assert.equal(parsed.snapshot.counts.memories, null);
  // F2: byKind / byAttic land on the snapshot (readonly path), no
  // separate `stats` key. Empty when store doesn't exist.
  assert.deepEqual(parsed.snapshot.byKind, {});
  assert.deepEqual(parsed.snapshot.byAttic, {});
  assert.equal(parsed.stats, undefined, 'no separate stats key — readonly path consolidates everything onto snapshot');
});

test('memory consolidate when MELO_DREAMING_ENABLED=0 → skipped:disabled message', async () => {
  const { stdout } = await runMeloCli(['memory', 'consolidate'], {
    env: { MELO_DREAMING_ENABLED: '0' },
  });
  assert.match(stdout, /Dreaming skipped/);
  assert.match(stdout, /disabled/);
  assert.match(stdout, /MELO_DREAMING_ENABLED=1/);
});

test('memory consolidate --json on empty store finishes with elapsedMs key', async () => {
  // Without explicitly setting MELO_DREAMING_ENABLED, the dreaming gate
  // defaults to enabled. With no memories the sweep is a no-op but
  // returns a valid summary object — pin the elapsedMs key as the
  // simplest successful-call fingerprint.
  const { stdout } = await runMeloCli(['memory', 'consolidate', '--json']);
  const parsed = JSON.parse(stdout);
  assert.equal(typeof parsed.elapsedMs, 'number');
  // skipped:false-or-absent + elapsedMs present = sweep ran cleanly.
  assert.notEqual(parsed.skipped, true);
});

test('memory <unknown subcommand> throws a helpful error', async () => {
  // index.js routes `main().catch(...)` to `output.write` (stdout) and
  // sets process.exitCode = 1, so execFile rejects with a non-zero exit
  // and the diagnostic text lives on err.stdout, not err.stderr.
  await assert.rejects(
    runMeloCli(['memory', 'wat']),
    err => /Unknown memory subcommand/.test(err.stdout || err.stderr || err.message),
  );
});

// ── --home flag + auto-warn hint (Phase F home-resolution gap) ──────
//
// The desktop app sets MELO_HOME to projectDir/.tmp/melo-home-user,
// not ~/.melo. A shell-launched `melo memory status` without --home
// would query the wrong store and report empty data while the real
// production store has thousands of rows. Pin both the flag override
// and the auto-warn hint that fires when the resolved home has no
// store but a sibling .tmp/melo-home-user does.

test('--home flag overrides MELO_HOME and queries the override path', async () => {
  const { mkdir } = await import('node:fs/promises');
  const { DatabaseSync } = await import('node:sqlite');
  const overrideHome = await mkdtemp(join(tmpdir(), 'melo-mem-override-'));
  await mkdir(join(overrideHome, 'desktop'), { recursive: true });
  const overrideStorePath = join(overrideHome, 'desktop', 'store.sqlite');
  const seed = new DatabaseSync(overrideStorePath);
  try {
    seed.exec(`
      CREATE TABLE memories (id TEXT PRIMARY KEY, kind TEXT, metadata_json TEXT);
      CREATE TABLE memories_fts (rowid INTEGER PRIMARY KEY);
      CREATE TABLE vec_memories (id TEXT);
      CREATE TABLE embedding_cache (key TEXT);
      INSERT INTO memories(id, kind, metadata_json) VALUES
        ('a','frame','{"attic":"hot"}'),
        ('b','scene','{"attic":"warm"}');
    `);
  } finally {
    seed.close();
  }

  // Default MELO_HOME (the per-test fresh dir) has no data; --home
  // points at the override which does. The CLI must follow --home and
  // report the override's rows, not the default's empty state.
  const defaultHome = await mkdtemp(join(tmpdir(), 'melo-mem-default-'));
  try {
    const { stdout } = await execFileP(
      process.execPath,
      [ENTRY, 'memory', 'status', '--home', overrideHome, '--json'],
      {
        env: { PATH: process.env.PATH, MELO_HOME: defaultHome },
        timeout: 20_000,
      },
    );
    const parsed = JSON.parse(stdout);
    assert.ok(
      parsed.snapshot.meloHome === overrideHome,
      `meloHome must reflect --home override (got: ${parsed.snapshot.meloHome})`,
    );
    assert.equal(parsed.snapshot.byKind.frame, 1);
    assert.equal(parsed.snapshot.byKind.scene, 1);
  } finally {
    await rm(overrideHome, { recursive: true, force: true });
    await rm(defaultHome, { recursive: true, force: true });
  }
});

test('--home without value throws helpful error', async () => {
  await assert.rejects(
    runMeloCli(['memory', 'status', '--home']),
    err => /--home.*requires a path/.test(err.stdout || err.stderr || err.message),
  );
});

test('memory help banner includes --home flag', async () => {
  const { stdout } = await runMeloCli(['memory', 'help']);
  assert.match(stdout, /--home/, 'help text must document --home');
  assert.match(stdout, /melo-home-user/, 'help text must mention the desktop wrapper home path');
});

// ── F2 — no-write side-effects on a real store (Codex 🔴 P0) ─────────
//
// Spin up a populated store inside a temp MELO_HOME, run `memory status`
// against it twice, and assert no `store.sqlite-wal` / `store.sqlite-shm`
// files appear. Pre-F2 the CLI went through getDb() which runs PRAGMA
// journal_mode = WAL on every open — turning a "read-only status check"
// into a side-effecting open of the user's production memory store.

test('memory status against a real existing store does NOT create WAL/SHM files', async () => {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { existsSync } = await import('node:fs');
  const meloHome = await mkdtemp(join(tmpdir(), 'melo-mem-cli-real-'));
  const desktop = join(meloHome, 'desktop');
  await mkdir(desktop, { recursive: true });
  const storePath = join(desktop, 'store.sqlite');
  // Seed a real SQLite file with the minimum schema collectMemoryStatus
  // touches. We don't need full melo schema — just `memories` /
  // `memories_fts` / `vec_memories` / `embedding_cache` tables so the
  // safeCount + by-kind / by-attic queries succeed (or no-op cleanly).
  // The point of the test is the NO-WAL invariant, not the row counts.
  const { DatabaseSync } = await import('node:sqlite');
  const seed = new DatabaseSync(storePath);
  try {
    seed.exec(`
      CREATE TABLE memories (id TEXT PRIMARY KEY, kind TEXT, metadata_json TEXT);
      CREATE TABLE memories_fts (rowid INTEGER PRIMARY KEY);
      CREATE TABLE vec_memories (id TEXT);
      CREATE TABLE embedding_cache (key TEXT);
      INSERT INTO memories(id, kind, metadata_json) VALUES
        ('a','fact','{"attic":"hot"}'),
        ('b','prompt','{"attic":"warm"}'),
        ('c','prompt','{}');
    `);
  } finally {
    seed.close();
  }
  // Run status twice; pre-F2 each open would create WAL/SHM.
  for (let i = 0; i < 2; i++) {
    const { stdout } = await execFileP(process.execPath, [ENTRY, 'memory', 'status', '--json'], {
      env: { PATH: process.env.PATH, MELO_HOME: meloHome },
      timeout: 20_000,
    });
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.snapshot.store.exists, true);
    // F2 invariant: byKind / byAttic populated from readonly handle.
    assert.equal(parsed.snapshot.byKind.fact, 1);
    assert.equal(parsed.snapshot.byKind.prompt, 2);
    assert.equal(parsed.snapshot.byAttic.hot, 1);
    assert.equal(parsed.snapshot.byAttic.warm, 1);
    assert.equal(parsed.snapshot.byAttic.none, 1, 'attic-less rows bucket as "none"');
  }

  // The actual write-side-effect assertion. Pre-F2 these would exist.
  assert.equal(existsSync(`${storePath}-wal`), false,
    'memory status MUST NOT create a WAL file on the production store');
  assert.equal(existsSync(`${storePath}-shm`), false,
    'memory status MUST NOT create a SHM file on the production store');

  await rm(meloHome, { recursive: true, force: true });
});
