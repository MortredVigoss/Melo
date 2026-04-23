/**
 * Search audit B-3 regression: workspace file search defaults to
 * `--fixed-strings` so user queries are treated as literals.  Without
 * this, a query containing regex metacharacters like `.` / `(` / `?`
 * either matches the wrong text or crashes the rg process entirely.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  streamWorkspaceContent,
  _setRipgrepBinaryForTests,
} from './fileSearch.js';

// Probe for rg once — tests that actually need a working ripgrep are
// skipped when the binary is missing (e.g. on contributor laptops without
// brew install ripgrep).  The "rg is missing" regression test is NOT
// skipped: it uses a guaranteed-missing binary name via the test hook so
// it works everywhere.
const HAS_RG = (() => {
  try {
    const res = spawnSync('rg', ['--version'], { stdio: 'ignore' });
    return res.status === 0;
  } catch {
    return false;
  }
})();
const rgOnly = { skip: HAS_RG ? false : 'ripgrep (rg) not installed on this host' };

// Teardown resets the binary hook between tests so an environment where rg
// is not installed doesn't poison the next test's spawn.
test.afterEach(() => {
  _setRipgrepBinaryForTests(null);
});

function seedWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'melo-filesearch-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'a.txt'), 'literal foo.bar token here\n');
  writeFileSync(join(root, 'src', 'b.txt'), 'the word fooXbar should NOT match dot query\n');
  writeFileSync(join(root, 'src', 'c.txt'), 'parens case: value (important) note\n');
  return root;
}

async function collect(iter) {
  const out = [];
  for await (const hit of iter) out.push(hit);
  return out;
}

test('streamWorkspaceContent treats dots as literal by default', rgOnly, async () => {
  const root = seedWorkspace();
  const hits = await collect(streamWorkspaceContent(root, 'foo.bar'));
  const paths = hits.map(h => h.filePath);
  assert.ok(paths.includes('src/a.txt'), 'literal "foo.bar" match');
  assert.ok(!paths.includes('src/b.txt'), 'dot is literal, not a regex wildcard');
});

test('streamWorkspaceContent survives unbalanced parens in the query', rgOnly, async () => {
  const root = seedWorkspace();
  // Without --fixed-strings, rg crashes here with a regex parse error and
  // the stream silently yields nothing.  With the flag, it finds the literal.
  const hits = await collect(streamWorkspaceContent(root, '(important)'));
  const paths = hits.map(h => h.filePath);
  assert.ok(paths.includes('src/c.txt'), 'literal "(important)" found');
});

test('fixedStrings: false re-enables regex mode for callers that want it', rgOnly, async () => {
  const root = seedWorkspace();
  const hits = await collect(
    streamWorkspaceContent(root, 'foo.bar', { fixedStrings: false }),
  );
  const paths = hits.map(h => h.filePath);
  assert.ok(paths.includes('src/a.txt'), 'foo.bar matches literal');
  assert.ok(paths.includes('src/b.txt'), 'dot acts as regex wildcard, matching fooXbar');
});

// ─── Robustness regressions (P0 search audit) ─────────────────────────────

test('missing rg binary yields no hits and does NOT throw (Bug 1)', async () => {
  // Simulate "rg not installed" by pointing spawn at a binary that will
  // never exist on any PATH.  Before the fix the ENOENT was swallowed in
  // one place but the -2 exit code from the close event re-threw below,
  // crashing the caller.  Now the whole thing degrades silently.
  _setRipgrepBinaryForTests('rg-absolutely-does-not-exist-7f3a2b9e');
  const root = seedWorkspace();
  const hits = await collect(streamWorkspaceContent(root, 'foo.bar'));
  assert.equal(hits.length, 0, 'zero hits, no exception');
});

test('early termination via maxMatches does not throw on SIGTERM (Bug 2)', rgOnly, async () => {
  // Seed a file with far more matches than we are willing to accept.  When
  // the generator breaks after maxMatches, the finally block kills rg with
  // SIGTERM.  The pre-fix code re-threw because SIGTERM's exit code isn't
  // 0/1/null.  The fix routes signal-deaths into the "normal termination"
  // branch.
  const root = mkdtempSync(join(tmpdir(), 'melo-filesearch-sigterm-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(
    join(root, 'src', 'many.txt'),
    Array.from({ length: 50 }, () => 'match-line\n').join(''),
  );
  const hits = await collect(
    streamWorkspaceContent(root, 'match-line', { maxMatches: 3 }),
  );
  // The caller-level maxMatches cap should stop the generator at exactly 3,
  // and the finally-block SIGTERM should not bubble up as an error.
  assert.equal(hits.length, 3, 'early break respected');
});
