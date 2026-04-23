/**
 * Search audit B-3 regression: workspace file search defaults to
 * `--fixed-strings` so user queries are treated as literals.  Without
 * this, a query containing regex metacharacters like `.` / `(` / `?`
 * either matches the wrong text or crashes the rg process entirely.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { streamWorkspaceContent } from './fileSearch.js';

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

test('streamWorkspaceContent treats dots as literal by default', async () => {
  const root = seedWorkspace();
  const hits = await collect(streamWorkspaceContent(root, 'foo.bar'));
  const paths = hits.map(h => h.filePath);
  assert.ok(paths.includes('src/a.txt'), 'literal "foo.bar" match');
  assert.ok(!paths.includes('src/b.txt'), 'dot is literal, not a regex wildcard');
});

test('streamWorkspaceContent survives unbalanced parens in the query', async () => {
  const root = seedWorkspace();
  // Without --fixed-strings, rg crashes here with a regex parse error and
  // the stream silently yields nothing.  With the flag, it finds the literal.
  const hits = await collect(streamWorkspaceContent(root, '(important)'));
  const paths = hits.map(h => h.filePath);
  assert.ok(paths.includes('src/c.txt'), 'literal "(important)" found');
});

test('fixedStrings: false re-enables regex mode for callers that want it', async () => {
  const root = seedWorkspace();
  const hits = await collect(
    streamWorkspaceContent(root, 'foo.bar', { fixedStrings: false }),
  );
  const paths = hits.map(h => h.filePath);
  assert.ok(paths.includes('src/a.txt'), 'foo.bar matches literal');
  assert.ok(paths.includes('src/b.txt'), 'dot acts as regex wildcard, matching fooXbar');
});
