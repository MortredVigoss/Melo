/**
 * bashRiskParser.test.js — pin every documented risk pattern.
 * Confidence levels are intentionally not asserted on every case
 * (they're heuristic) but kind + pattern are.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseBashRiskyOps,
  splitCommands,
  tokenize,
  hasUnbalancedQuotes,
} from './bashRiskParser.js';

function kindsOf(cmd) {
  return parseBashRiskyOps(cmd).risks.map(r => r.kind);
}

function findRisk(cmd, kind, pattern = null) {
  const risks = parseBashRiskyOps(cmd).risks;
  if (pattern) return risks.find(r => r.kind === kind && r.pattern === pattern);
  return risks.find(r => r.kind === kind);
}

// ── splitCommands ─────────────────────────────────────────────────────

test('splitCommands handles simple command', () => {
  assert.deepEqual(splitCommands('ls /tmp'), ['ls /tmp']);
});

test('splitCommands splits on ; && || | &', () => {
  assert.deepEqual(splitCommands('ls; cat foo'), ['ls', 'cat foo']);
  assert.deepEqual(splitCommands('ls && cat foo'), ['ls', 'cat foo']);
  assert.deepEqual(splitCommands('ls || cat foo'), ['ls', 'cat foo']);
  assert.deepEqual(splitCommands('ls | grep x'), ['ls', 'grep x']);
});

test('splitCommands does NOT split on separators inside quotes', () => {
  assert.deepEqual(
    splitCommands('echo "a; b" && echo c'),
    ['echo "a; b"', 'echo c'],
  );
  assert.deepEqual(
    splitCommands("echo 'a && b'; echo c"),
    ["echo 'a && b'", 'echo c'],
  );
});

// ── tokenize ──────────────────────────────────────────────────────────

test('tokenize splits on whitespace, strips quotes', () => {
  const ts = tokenize('rm -rf "my folder/x"');
  assert.deepEqual(ts.map(t => t.text), ['rm', '-rf', 'my folder/x']);
  assert.deepEqual(ts.map(t => t.kind), ['word', 'word', 'word']);
});

test('tokenize recognizes redirects as separate tokens', () => {
  const ts = tokenize('echo hi > foo');
  const kinds = ts.map(t => t.kind);
  const texts = ts.map(t => t.text);
  assert.deepEqual(kinds, ['word', 'word', 'redirect', 'word']);
  assert.deepEqual(texts, ['echo', 'hi', '>', 'foo']);
});

test('tokenize prefers longer redirect operator (`>>` not `>`+`>`)', () => {
  const ts = tokenize('echo hi >> log.txt');
  assert.equal(ts.find(t => t.kind === 'redirect').text, '>>');
});

// ── delete patterns ───────────────────────────────────────────────────

test('rm -rf flagged as delete', () => {
  const r = findRisk('rm -rf /tmp/junk', 'delete');
  assert.ok(r, 'expected a delete risk');
  assert.equal(r.pattern, 'rm');
  assert.equal(r.confidence, 'high');
  assert.equal(r.target, '/tmp/junk');
});

test('rmdir / unlink flagged as delete', () => {
  assert.ok(findRisk('rmdir /tmp/empty', 'delete'));
  assert.ok(findRisk('unlink /tmp/foo', 'delete'));
});

test('find ... -delete flagged as delete', () => {
  const r = findRisk('find . -name "*.log" -delete', 'delete');
  assert.ok(r);
  assert.equal(r.pattern, 'find -delete');
});

test('find ... -exec rm flagged as delete', () => {
  const r = findRisk('find . -name "*.log" -exec rm {} \\;', 'delete');
  assert.ok(r);
  assert.match(r.pattern, /find -exec rm/);
});

test('git clean flagged as delete', () => {
  const r = findRisk('git clean -fdx', 'delete');
  assert.ok(r);
  assert.equal(r.pattern, 'git clean');
});

// ── reset_repo patterns ───────────────────────────────────────────────

test('git reset --hard flagged as reset_repo', () => {
  const r = findRisk('git reset --hard HEAD~1', 'reset_repo');
  assert.ok(r);
  assert.equal(r.pattern, 'git reset --hard');
});

test('git checkout -- foo flagged as reset_repo', () => {
  const r = findRisk('git checkout -- src/foo.js', 'reset_repo');
  assert.ok(r);
});

test('git checkout . flagged as reset_repo', () => {
  const r = findRisk('git checkout .', 'reset_repo');
  assert.ok(r);
});

// ── truncate / overwrite / append ─────────────────────────────────────

test('truncate flagged', () => {
  assert.ok(findRisk('truncate -s 0 foo.log', 'truncate'));
});

test('> redirect flagged as overwrite', () => {
  const r = findRisk('echo hi > /tmp/foo', 'overwrite');
  assert.ok(r);
  assert.equal(r.pattern, '>');
  assert.equal(r.target, '/tmp/foo');
});

test('>> redirect flagged as append', () => {
  const r = findRisk('echo hi >> /tmp/foo', 'append');
  assert.ok(r);
  assert.equal(r.pattern, '>>');
});

test('tee flagged as overwrite', () => {
  const r = findRisk('echo hi | tee /tmp/foo', 'overwrite');
  assert.ok(r);
  assert.equal(r.pattern, 'tee');
});

test('dd of= flagged as overwrite', () => {
  const r = findRisk('dd if=/dev/zero of=/tmp/foo bs=1024 count=1', 'overwrite');
  assert.ok(r);
  assert.equal(r.pattern, 'dd of=');
  assert.equal(r.target, '/tmp/foo');
});

// ── in_place_edit ─────────────────────────────────────────────────────

test('sed -i flagged', () => {
  assert.ok(findRisk('sed -i "s/old/new/g" foo.txt', 'in_place_edit'));
});

test('sed without -i is NOT flagged', () => {
  // Plain sed prints to stdout; no in-place edit. The redirect detection
  // would still flag a separate `> file` if present.
  const risks = parseBashRiskyOps('sed "s/a/b/" foo.txt').risks;
  assert.equal(risks.filter(r => r.kind === 'in_place_edit').length, 0);
});

test('perl -i flagged', () => {
  assert.ok(findRisk('perl -i -pe s/a/b/ foo.txt', 'in_place_edit'));
});

test('awk -i inplace flagged', () => {
  assert.ok(findRisk('awk -i inplace "{print}" foo.txt', 'in_place_edit'));
});

// ── interpreter scripts ───────────────────────────────────────────────

test('python -c "...os.remove..." flagged as delete', () => {
  const cmd = 'python -c "import os; os.remove(\'/tmp/foo\')"';
  const r = findRisk(cmd, 'delete');
  assert.ok(r, `expected delete risk in: ${cmd}`);
});

test('python -c "...shutil.rmtree..." flagged as delete', () => {
  const cmd = 'python3 -c "import shutil; shutil.rmtree(\'/tmp/x\')"';
  assert.ok(findRisk(cmd, 'delete'));
});

test('node -e "...fs.unlinkSync..." flagged as delete', () => {
  const cmd = 'node -e "require(\'fs\').unlinkSync(\'/tmp/x\')"';
  assert.ok(findRisk(cmd, 'delete'));
});

test('node -e "...fs.rmSync..." flagged as delete', () => {
  const cmd = 'node -e "require(\'fs\').rmSync(\'/tmp/x\', {recursive: true})"';
  assert.ok(findRisk(cmd, 'delete'));
});

test('ruby -e "...File.delete..." flagged as delete', () => {
  const cmd = 'ruby -e "File.delete(\'/tmp/x\')"';
  assert.ok(findRisk(cmd, 'delete'));
});

test('Phase 2D follow-up #10: ANY python -c is flagged code_execution (even benign)', () => {
  // Pre-followup: benign `python -c "print(1)"` was unflagged
  // because the delete-API regex didn't match. Post-followup: any
  // interpreter inline-code form is hard-rejected as code_execution
  // — the user can't reliably classify "is this Python dangerous?".
  const risks = parseBashRiskyOps('python -c "print(1)"').risks;
  assert.equal(risks.length, 1);
  assert.equal(risks[0].kind, 'code_execution');
});

// ── mv ────────────────────────────────────────────────────────────────

test('mv flagged as move risk', () => {
  const r = findRisk('mv /tmp/a /tmp/b', 'move');
  assert.ok(r);
  assert.equal(r.target, '/tmp/b');
});

// ── compound commands ────────────────────────────────────────────────

test('chained command: only the dangerous half is flagged', () => {
  const risks = parseBashRiskyOps('ls /tmp && rm -rf /tmp/junk').risks;
  // ls is benign, rm is dangerous → exactly one risk.
  assert.equal(risks.length, 1);
  assert.equal(risks[0].kind, 'delete');
});

test('multiple risks in one chain are all reported', () => {
  const risks = parseBashRiskyOps('rm /tmp/a; sed -i "s/x/y/" b.txt').risks;
  const kinds = risks.map(r => r.kind).sort();
  assert.deepEqual(kinds, ['delete', 'in_place_edit']);
});

// ── env-var prefix ────────────────────────────────────────────────────

test('env-var prefix doesn\'t mask the head command (FOO=1 rm baz still flagged)', () => {
  assert.ok(findRisk('FOO=1 BAR=2 rm /tmp/baz', 'delete'));
});

// ── benign commands ──────────────────────────────────────────────────

test('benign read commands produce zero risks', () => {
  for (const cmd of [
    'ls /tmp',
    'cat foo.txt',
    'rg pattern src/',
    'grep -r foo src/',
    'head -n 10 foo',
    'tail -f log.txt',
    'wc -l foo',
    'pwd',
  ]) {
    const risks = parseBashRiskyOps(cmd).risks;
    assert.equal(risks.length, 0, `expected no risks in: ${cmd} (got ${JSON.stringify(risks)})`);
  }
});

// ── unparseable ──────────────────────────────────────────────────────

test('hasUnbalancedQuotes detects unclosed quote', () => {
  assert.equal(hasUnbalancedQuotes('echo "hi'), true);
  assert.equal(hasUnbalancedQuotes("echo 'hi"), true);
  assert.equal(hasUnbalancedQuotes('echo "balanced"'), false);
});

test('unbalanced quotes with no other risks → kind:unknown', () => {
  const result = parseBashRiskyOps('echo "no closing quote');
  assert.equal(result.unparseable, true);
  assert.equal(result.risks.length, 1);
  assert.equal(result.risks[0].kind, 'unknown');
  assert.equal(result.risks[0].confidence, 'low');
});

test('empty command yields no risks (not unknown)', () => {
  const result = parseBashRiskyOps('');
  assert.deepEqual(result.risks, []);
  assert.equal(result.unparseable, false);
});

// ── quote handling around redirects ───────────────────────────────────

test('quoted ">" inside a string is NOT treated as a redirect', () => {
  // `echo "a > b"` should produce no overwrite risk.
  const risks = parseBashRiskyOps('echo "a > b"').risks;
  assert.equal(risks.filter(r => r.kind === 'overwrite').length, 0);
});

test('redirect after pipe: subcommands re-tokenized correctly', () => {
  const risks = parseBashRiskyOps('cat foo | sort > /tmp/sorted').risks;
  const overwrite = risks.find(r => r.kind === 'overwrite');
  assert.ok(overwrite);
  assert.equal(overwrite.target, '/tmp/sorted');
});
