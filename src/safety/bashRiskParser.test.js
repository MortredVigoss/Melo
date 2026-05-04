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

// ── Phase 2D follow-up #14: awk inline + sed e-cmd ───────────────────

test('Phase 2D follow-up #14: awk inline program flagged as code_execution', () => {
  // The classic system() shell-out demo Codex highlighted.
  const r = findRisk('awk \'BEGIN{system("rm /tmp/x")}\'', 'code_execution');
  assert.ok(r, 'awk inline program must be code_execution');
});

test('Phase 2D follow-up #14: ALL awk family without -f are code_execution (gawk/mawk/nawk)', () => {
  for (const head of ['awk', 'gawk', 'mawk', 'nawk']) {
    const risks = parseBashRiskyOps(`${head} '{print $1}' file.txt`).risks;
    assert.ok(
      risks.some(r => r.kind === 'code_execution'),
      `${head} '{print $1}' must be code_execution (program is inline)`,
    );
  }
});

test('Phase 2D follow-up #14: awk -f script.awk NOT flagged as code_execution (program from file)', () => {
  // -f sources the program from a file, gated separately by fileRead.
  // Tests every -f form documented: separate / glued / --file long.
  for (const cmd of [
    'awk -f script.awk data.txt',
    'awk -fscript.awk data.txt',
    'awk --file=script.awk data.txt',
    'awk --file script.awk data.txt',
  ]) {
    const risks = parseBashRiskyOps(cmd).risks;
    assert.equal(
      risks.filter(r => r.kind === 'code_execution').length,
      0,
      `${cmd} should NOT be code_execution (program from file)`,
    );
  }
});

test('Phase 2D follow-up #14: bare awk --version falls through (no positional, no pipe)', () => {
  // Probe form — neither positional program nor pipe-fed. Falls
  // through unflagged so user can approve via prompt rather than
  // hitting blanket DENIED. Same trade-off pattern as round 4's
  // strict-version-probe carve-out.
  const risks = parseBashRiskyOps('awk --version').risks;
  assert.equal(
    risks.filter(r => r.kind === 'code_execution').length,
    0,
    'awk --version (no positional, no pipe) must not be hard-rejected',
  );
});

test('Phase 2D follow-up #14: pipe-fed awk → code_execution (stdin = program)', () => {
  // No -f, no positional, but stdin from pipe becomes the program.
  const risks = parseBashRiskyOps('cat data.txt | awk').risks;
  assert.ok(
    risks.some(r => r.kind === 'code_execution'),
    'pipe-fed awk without -f must be code_execution (stdin is the program)',
  );
});

test('Phase 2D follow-up #14: cat | awk -f script.awk NOT flagged (pipe is data, -f sources program)', () => {
  // Regression: legitimate `cat data | awk -f script.awk` pattern.
  const risks = parseBashRiskyOps('cat data.txt | awk -f script.awk').risks;
  assert.equal(
    risks.filter(r => r.kind === 'code_execution').length,
    0,
    'pipe + awk -f means pipe is data, not program — must not be hard-rejected',
  );
});

test('Phase 2D follow-up #14: env / sudo / nohup awk inline → code_execution (wrapper-aware)', () => {
  for (const cmd of [
    'env awk \'BEGIN{print 1}\'',
    'sudo gawk \'{print}\' file',
    'nohup awk \'{print}\' file',
    'sudo -E awk -F: \'{print $1}\' /etc/passwd',
    'FOO=1 awk \'{print}\'',
  ]) {
    const risks = parseBashRiskyOps(cmd).risks;
    assert.ok(
      risks.some(r => r.kind === 'code_execution'),
      `${cmd} must be code_execution despite wrapper`,
    );
  }
});

test('Phase 2D follow-up #14: sed e-command flagged as code_execution', () => {
  // Bare `e CMD` at expression start.
  assert.ok(findRisk('sed \'e rm -f /tmp/x\' file', 'code_execution'));
  // `e CMD` after sed command separator (semicolon).
  assert.ok(findRisk('sed \'1,$d; e ls\' file', 'code_execution'));
});

test('Phase 2D follow-up #14: sed s/.../e flag flagged as code_execution', () => {
  for (const cmd of [
    'sed \'s/x/y/e\' file',
    'sed \'s/x/y/eg\' file',         // e + g (multiple flags)
    'sed \'s/x/y/ge\' file',         // g + e
    'sed -e \'s/x/y/e\' file',       // -e flag carrying expression
    'sed --expression=\'s/x/y/e\' file',
    'gsed \'s/x/y/e\' file',         // BSD homebrew GNU sed
  ]) {
    const risks = parseBashRiskyOps(cmd).risks;
    assert.ok(
      risks.some(r => r.kind === 'code_execution'),
      `${cmd} must be code_execution (s///e shell-out)`,
    );
  }
});

test('Phase 2D follow-up #14: regression — sed s/// without e flag NOT flagged', () => {
  // Plain substitutes are pipeline-common; must not hard-reject.
  for (const cmd of [
    'sed \'s/x/y/\' file',
    'sed \'s/x/y/g\' file',
    'sed \'s/x/y/p\' file',          // print flag, not e
    'sed \'s/x/y/i\' file',          // case-insensitive flag
    'sed \'1,5d\' file',
    'sed \'/pattern/d\' file',
  ]) {
    const risks = parseBashRiskyOps(cmd).risks;
    assert.equal(
      risks.filter(r => r.kind === 'code_execution').length,
      0,
      `${cmd} should not be flagged code_execution`,
    );
  }
});

test('Phase 2D follow-up #14: regression — replacement text containing "e<space>" NOT a false positive', () => {
  // The original sedExpressionHasEcmd regex used `\/[a-z]*e[a-z]*\s` which
  // matched the `/end ` substring inside `s/foo/end /` (replacement
  // contains "end " followed by closing slash). Refined regex requires
  // the e-flag to be AFTER the closing /, not inside replacement.
  const risks = parseBashRiskyOps('sed \'s/foo/end /\' file').risks;
  assert.equal(
    risks.filter(r => r.kind === 'code_execution').length,
    0,
    'replacement text with "end " must not match e-flag pattern',
  );
});

test('Phase 2D follow-up #14: env / sudo + sed e-cmd → code_execution (wrapper-aware)', () => {
  for (const cmd of [
    'env sed \'e rm -f x\' file',
    'sudo gsed \'s/x/y/e\' file',
    'nohup sed \'e ls\' file',
  ]) {
    const risks = parseBashRiskyOps(cmd).risks;
    assert.ok(
      risks.some(r => r.kind === 'code_execution'),
      `${cmd} must be code_execution despite wrapper`,
    );
  }
});

// ── Phase 2D follow-up #14 self-review fixes ─────────────────────────

test('Phase 2D #14 self-review (Bug 1): awk \'x=system(...)\' is code_execution (var=val skip removed)', () => {
  // Pre-fix: var=val regex `^[A-Za-z_][A-Za-z0-9_]*=` matched the
  // program token `x=system("rm /tmp/x")` and skipped it as if
  // it were a post-program awk var-assignment positional, leaving
  // hasPositional=false → unflagged. But awk's first non-flag
  // positional is ALWAYS the program when no -f is given, and
  // awk parses `x=system("rm")` as inline code that calls system().
  // Removed the var=val skip; any non-flag positional now flags.
  const cmds = [
    'awk \'x=system("rm /tmp/x")\'',
    'awk \'x=1; system("rm")\'',
    'awk \'y=length($0); print y\'',  // even benign-looking var=val programs flag
    'env awk \'x=system("rm")\'',     // wrapper-aware
  ];
  for (const cmd of cmds) {
    const risks = parseBashRiskyOps(cmd).risks;
    assert.ok(
      risks.some(r => r.kind === 'code_execution'),
      `${cmd} must be code_execution (var=val program shape was the bypass)`,
    );
  }
});

test('Phase 2D #14 self-review (Bug 2): sed e-cmd with address prefix is detected', () => {
  // Pre-fix: pattern 1 `(?:^|[\n;{}])\s*e\s` only matched at start
  // or after sed command-block separators. Missed every address-
  // prefixed form: `/regex/e`, `$e`, `2e`, `1,5e`, `!e`, `~Ne`.
  // Fix: pattern 1 reverted to `(?:^|[^a-zA-Z])e\s` AFTER stripping
  // out s/.../.../FLAGS regions (so replacement text can't false-
  // positive). All sed boundary chars now covered uniformly.
  const cmds = [
    `sed '/foo/e rm /tmp/x' file`,    // regex address
    `sed '$e rm /tmp/x' file`,         // last-line address
    `sed '2e rm /tmp/x' file`,         // numeric address
    `sed '1,5e rm /tmp/x' file`,       // range address
    `sed '/foo/!e rm /tmp/x' file`,    // negated address
    `sed '0~2e rm /tmp/x' file`,       // step address (gawk)
  ];
  for (const cmd of cmds) {
    const risks = parseBashRiskyOps(cmd).risks;
    assert.ok(
      risks.some(r => r.kind === 'code_execution'),
      `${cmd} must be code_execution (address-prefixed sed e-cmd)`,
    );
  }
});

test('Phase 2D #14 self-review (Bug 2): sed s///g + ; e CMD chain is detected (after stripping)', () => {
  // The strip-substitute approach removes `s/.../.../FLAGS`
  // regions before scanning for bare `e CMD`, so a chained
  // `s/x/y/g; e rm` correctly flags via pattern 1 after the
  // substitute is gone.
  const risks = parseBashRiskyOps(`sed 's/x/y/g; e rm /tmp/x' file`).risks;
  assert.ok(
    risks.some(r => r.kind === 'code_execution'),
    'chained s///+e CMD must be detected',
  );
});

test('Phase 2D #14 self-review (Bug 2): replacement text containing "e<space>" still NOT a false positive', () => {
  // The replacement-text false-positive guard from the original
  // refinement must continue to hold under the new strip-substitute
  // approach. Both replacement forms below contain `e<space>`:
  for (const cmd of [
    `sed 's/foo/end /' file`,            // replacement ends with `e<space>`
    `sed 's/abc/replace e text/' file`,  // replacement contains `e<space>` mid-string
    `sed 's/x/the end /' file`,          // multiple letter+e+space combos
  ]) {
    const risks = parseBashRiskyOps(cmd).risks;
    assert.equal(
      risks.filter(r => r.kind === 'code_execution').length,
      0,
      `${cmd} replacement-text e<space> must NOT trigger`,
    );
  }
});

test('Phase 2D #14 self-review (P1): preposed redirect — head-based detection still fires', () => {
  // Pre-fix: tokens=[redirect '<', word '/tmp/x', word 'rm', ...]
  // → skipEnvAssignments returned 0 → head was '<' (the redirect
  // op) → no detection ever matched. Fix: skipPreamble strips
  // leading redirect+target pairs (any order with env-assignments).
  // Now `< /tmp/x rm -rf foo` parses as head='rm' and the
  // delete-class detection fires.
  for (const cmd of [
    `< /tmp/x rm -rf /tmp/foo`,             // preposed input redirect + rm
    `> out.log rm -rf /tmp/foo`,            // preposed output redirect + rm
    `< /tmp/x FOO=1 rm /tmp/foo`,           // redirect + env-assignment + rm
    `FOO=1 < /tmp/x rm /tmp/foo`,           // env-assignment + redirect + rm
    `> /tmp/log 2> /tmp/err rm /tmp/foo`,   // multiple preposed redirects
  ]) {
    const risks = parseBashRiskyOps(cmd).risks;
    assert.ok(
      risks.some(r => r.kind === 'delete'),
      `${cmd} must detect rm despite preposed redirect`,
    );
  }
});

test('Phase 2D #14 self-review (P1): preposed redirect + awk → code_execution', () => {
  // Same skipPreamble fix benefits findWrappedCommand, so wrapper-
  // aware detections (awk inline / sed e-cmd / interpreter inline)
  // also see past leading redirects.
  const risks = parseBashRiskyOps(`< /tmp/script.awk awk`).risks;
  // Either awk stdin-redirect (since `<` is a redirect token) OR
  // awk pipe/inline detection should trip — at minimum the redirect
  // token in tokens triggers the stdin-redirect arm because
  // skipPreamble counts it but tokens still contain it. Pin: code_
  // execution risk exists.
  assert.ok(
    risks.some(r => r.kind === 'code_execution'),
    'preposed `< /tmp/x awk` must detect awk + stdin redirect',
  );
});
