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
  // stats is null when the store doesn't exist (we skip memoryStats() call).
  assert.equal(parsed.stats, null);
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
