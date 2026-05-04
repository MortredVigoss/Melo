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

test('Phase 2D #14 follow-up: sed exotic delimiters (`,` / `|` / `:` / `#` / `@`) + e flag → code_execution', () => {
  // Round 14's known-limit list flagged exotic-delim sed substitutes
  // as uncovered (JS regex can't negate a backreference). Replaced
  // pattern-2 regex with imperative scanner that handles ANY delim.
  // Codex's likely round-15 attack vectors all close here.
  for (const cmd of [
    `sed 's,x,y,e' file`,
    `sed 's|x|y|e' file`,
    `sed 's:x:y:e' file`,
    `sed 's#x#y#e' file`,
    `sed 's@x@y@e' file`,
    `sed 's,x,y,eg' file`,         // e + g flags
    `sed 's,x,y,ge' file`,         // g + e flags
    `gsed 's,x,y,e' file`,         // BSD homebrew GNU sed
    `env sed 's,x,y,e' file`,      // wrapper-aware
    `sudo sed 's|x|y|e' file`,
  ]) {
    const risks = parseBashRiskyOps(cmd).risks;
    assert.ok(
      risks.some(r => r.kind === 'code_execution'),
      `${cmd} must be code_execution (exotic-delim s///e shell-out)`,
    );
  }
});

test('Phase 2D #14 follow-up: regression — sed exotic-delim replacement-text with e<space> NOT flagged', () => {
  // Pattern 2 imperative scanner handles `s,foo,bar e baz,` (no e
  // flag) without the replacement text triggering the bare-e-cmd
  // pattern: substitutes are stripped before pattern 1 scan.
  for (const cmd of [
    `sed 's,foo,bar e baz,' file`,
    `sed 's|foo|bar e baz|' file`,
    `sed 's#foo#bar e baz#' file`,
    `sed 's,foo,end ,' file`,
    `sed 's:foo:replace e text:' file`,
  ]) {
    const risks = parseBashRiskyOps(cmd).risks;
    assert.equal(
      risks.filter(r => r.kind === 'code_execution').length,
      0,
      `${cmd} replacement-text e<space> with non-/ delim must not flag`,
    );
  }
});

test('Codex D fix #4: parallel/stdbuf/unbuffer/watch + other wrappers → code_execution', () => {
  // Codex re-review of D fix #3 (29273fd) found 4 wrappers not in
  // COMMAND_WRAPPERS: parallel / stdbuf / unbuffer / watch. Codex
  // verified `stdbuf -oL awk 'BEGIN{print ...}'` actually executes.
  // Fix: extend COMMAND_WRAPPERS with these + defensive additions
  // (entr/flock/script/rlwrap/pv/direnv/busybox/strace/ltrace/
  // valgrind/perf/timeout/tsp/ts).
  for (const cmd of [
    `parallel awk 'BEGIN{system("rm")}' ::: x`,
    `stdbuf -oL awk 'BEGIN{system("rm")}' file`,
    `unbuffer awk 'BEGIN{system("rm")}'`,
    `watch awk 'BEGIN{system("rm")}'`,
    `entr awk 'BEGIN{system("rm")}'`,
    // NOTE: `script -c '<shell-cmd>'` is NOT covered here — script's -c
    // arg goes through `/bin/sh -c`, which is round 8 nested_shell
    // territory not D fix #4 awk-wrapper. Documented as known-limit.
    `rlwrap awk 'BEGIN{system("rm")}'`,
    `pv awk 'BEGIN{system("rm")}'`,
    `direnv exec . awk 'BEGIN{system("rm")}'`,  // direnv exec form
    `busybox awk 'BEGIN{system("rm")}'`,
    `strace awk 'BEGIN{system("rm")}'`,
    `ltrace awk 'BEGIN{system("rm")}'`,
    `valgrind awk 'BEGIN{system("rm")}'`,
    `perf stat awk 'BEGIN{system("rm")}'`,    // perf takes subcommand 'stat' first
    `tsp awk 'BEGIN{system("rm")}'`,
  ]) {
    const risks = parseBashRiskyOps(cmd).risks;
    assert.ok(
      risks.some(r => r.kind === 'code_execution'),
      `${cmd} must be code_execution (new wrapper class)`,
    );
  }
});

test('Codex D fix #4: positional-value wrappers (timeout/flock/tsp) → code_execution', () => {
  // `timeout 5 awk PROG` and `flock /tmp/f awk PROG` have a positional
  // VALUE between wrapper and awk (not a flag). awkIsInvocationContext
  // does a 2-step walkback to find the wrapper one extra position back.
  for (const cmd of [
    `timeout 5 awk 'BEGIN{system("rm")}'`,
    `timeout --signal=KILL 5 gawk 'BEGIN{system("rm")}'`,
    `timeout 5s awk 'BEGIN{system("rm")}'`,
    `flock /tmp/lock awk 'BEGIN{system("rm")}'`,
    `flock --shared /tmp/lock gawk 'BEGIN{system("rm")}'`,
    `tsp -L name awk 'BEGIN{system("rm")}'`,
  ]) {
    const risks = parseBashRiskyOps(cmd).risks;
    assert.ok(
      risks.some(r => r.kind === 'code_execution'),
      `${cmd} must be code_execution (positional-value wrapper)`,
    );
  }
});

test('Codex D fix #4: regression — false-positive in `awk -o out -f script` fixed via value-taker extension', () => {
  // analyzeAwkArgv pre-fix only had -F/-v/-W/-i as separate-form value
  // takers. GNU awk also has -o/-d/-D/-l/-L/-p (pretty-print/debug/
  // load/lint/profile). Pre-fix `awk -o out -f script.awk` flagged
  // because 'out' became hasPositional and shadowed -f.
  for (const cmd of [
    `awk -o out -f script.awk file`,           // -o pretty-print + -f
    `awk -d debug.txt -f script.awk`,          // -d debug
    `awk -D debug.txt -f script.awk`,          // -D debug mode
    `awk -l libname -f script.awk`,            // -l load library
    `awk -L value -f script.awk`,              // -L lint
    `awk -p profile.txt -f script.awk`,        // -p profile
  ]) {
    const risks = parseBashRiskyOps(cmd).risks;
    assert.equal(
      risks.filter(r => r.kind === 'code_execution').length,
      0,
      `${cmd} should NOT be code_execution (-o/-d/-D/-l/-L/-p value-takers)`,
    );
  }
});

test('Codex D fix #4: regression — value-taker wrappers + -f only still pass', () => {
  // `timeout 5 awk -f script.awk` should NOT flag — wrapper has its
  // value (5), then awk has -f only (no inline). Pin.
  for (const cmd of [
    `timeout 5 awk -f script.awk`,
    `flock /tmp/f awk -f script.awk`,
    `parallel awk -f script.awk ::: x`,
    `stdbuf -oL awk -f script.awk`,
    `watch awk -f script.awk`,
  ]) {
    const risks = parseBashRiskyOps(cmd).risks;
    assert.equal(
      risks.filter(r => r.kind === 'code_execution').length,
      0,
      `${cmd} should NOT be code_execution (wrapper + -f, no inline)`,
    );
  }
});

test('Codex D fix #3: positional inline program after wrapper → code_execution', () => {
  // D fix #3 (2026-05-04 third re-review): D fix #2 token-scan only
  // checked for inline FLAGS (-e/--source). awk's first non-flag
  // POSITIONAL is also inline program — `xargs gawk 'PROG'` /
  // `find -exec gawk 'PROG' {} ;` returned [] and autoApprove ran
  // system(). Fix: unified token-scan with full argv analysis
  // (analyzeAwkArgv) + invocation-context guard (awkIsInvocationContext).
  for (const cmd of [
    `printf x | xargs gawk 'BEGIN{system("rm")}'`,
    `xargs -I{} gawk 'BEGIN{system("rm")}' {}`,
    `xargs -0 awk 'BEGIN{system("rm")}'`,
    `find . -exec gawk 'BEGIN{system("rm")}' {} \\;`,
    `find . -name '*.txt' -exec awk 'BEGIN{system("rm")}' {} +`,
    `env xargs gawk 'BEGIN{system("rm")}'`,
    `time xargs gawk 'BEGIN{system("rm")}'`,
    `nice -n 10 xargs awk 'BEGIN{system("rm")}'`,
  ]) {
    const risks = parseBashRiskyOps(cmd).risks;
    assert.ok(
      risks.some(r => r.kind === 'code_execution'),
      `${cmd} must be code_execution (positional inline after wrapper)`,
    );
  }
});

test('Codex D fix #6: expansion-head + positional → code_execution (covers $AWK / ${a}wk / ${cmd[@]})', () => {
  // Codex re-review of D fix #5 (cf21ff5) found expansion-form awk
  // basenames: token literal `$AWK` / `${a}wk` / `${cmd[@]}` doesn't
  // match isAwkBasename's regex, but resolves to awk at runtime →
  // autoApprove ran system(). Round 9 expansion-before-c only covers
  // FLAG forms (-c/-e/...), not positional. D fix #6 adds: expansion
  // at sub-command head + ANY non-flag positional → flag.
  for (const cmd of [
    `$AWK 'BEGIN{system("rm")}'`,            // variable expansion
    `${'${a}'}wk 'BEGIN{system("rm")}'`,     // parameter substitution
    `${'${cmd[@]}'} 'BEGIN{system("rm")}'`,  // array expansion
    `"$AWK" 'BEGIN{system("rm")}'`,          // quoted variable (still expands)
    `${'${SHELL}'} 'BEGIN{print "x"}'`,      // any expansion + positional
    `$EDITOR file.txt`,                       // intentional over-flag (envvar invocation)
  ]) {
    const risks = parseBashRiskyOps(cmd).risks;
    assert.ok(
      risks.some(r => r.kind === 'code_execution'),
      `${cmd} must be code_execution (expansion-head + positional)`,
    );
  }
});

test('Codex D fix #6: regression — expansion-head WITHOUT positional NOT flagged', () => {
  // Pin the boundary: head expansion alone (no positional after) is
  // common in legit shell usage. `mkdir $DIR` / `cat $FILE` /
  // `ls $HOME` etc. must not flag.
  for (const cmd of [
    `mkdir $DIR`,
    `cat $FILE`,
    `ls $HOME`,
    `cd $WORKSPACE`,
    `echo $VAR`,
    `printf $TEMPLATE`,
  ]) {
    const risks = parseBashRiskyOps(cmd).risks;
    assert.equal(
      risks.filter(r => r.kind === 'code_execution').length,
      0,
      `${cmd} should NOT flag (expansion-head, no extra positional)`,
    );
  }
});

test('Codex D fix #6: regression — non-expansion head NOT flagged by D fix #6 path', () => {
  // The D fix #6 check requires the HEAD token to be an expansion.
  // Commands with literal heads (echo/cat/grep/...) followed by
  // expansion-shaped args don't trigger D fix #6 (other detectors
  // may flag for different reasons; pin only D fix #6 path here).
  for (const cmd of [
    `cat $FILE program.txt`,                 // head=cat (literal), not expansion
    `git commit -m "$MSG"`,                  // head=git
    `echo "$AWK is the awk binary"`,         // head=echo
    `printf "%s\\n" "$VAR"`,                 // head=printf
  ]) {
    const risks = parseBashRiskyOps(cmd).risks;
    const dFix6 = risks.filter(r => r.pattern === 'expansion-head + positional program');
    assert.equal(
      dFix6.length,
      0,
      `${cmd} should not trigger D fix #6 path (head is literal)`,
    );
  }
});

test('Codex D fix #5 (nuclear): awk-as-data with bare `awk` token IS flagged (over-flag accepted)', () => {
  // 5 rounds of D evaluation proved enumerated wrapper-flag chains
  // never get fully covered. D fix #5 dropped awkIsInvocationContext
  // entirely — any awk-family token + inline-form flags. Pin the
  // accepted over-flag surface (this is INTENTIONAL — agent uses
  // single-quote 1-token form to avoid).
  for (const cmd of [
    `echo awk -e hello`,                    // literal 'awk' word + -e<glued>
    `git commit -m awk -e hello`,            // commit message
    `git commit -m awk hello`,               // commit message no flag (positional after awk)
    `echo awk hello`,                        // bare echo with awk + arg
    `grep awk -e file`,                      // grep with awk + -e
  ]) {
    const risks = parseBashRiskyOps(cmd).risks;
    assert.ok(
      risks.some(r => r.kind === 'code_execution'),
      `${cmd} IS over-flagged after D fix #5 nuclear (intentional trade-off)`,
    );
  }
});

test('Codex D fix #5: awk-as-data still NOT flagged when basename is not awk-family or token is single quoted', () => {
  // Even after dropping context guard, these stay unflagged because:
  //   - 'awk' is part of a longer basename (path / filename)
  //   - whole arg is quoted as 1 token, no awk-basename word
  for (const cmd of [
    `cat docs/awk-tutorial.md`,             // basename 'awk-tutorial.md'
    `cat awk-script.sh`,                    // basename 'awk-script.sh'
    `find . -name 'awk*'`,                  // 'awk*' not awk-family regex
    `find . -name awk-script.sh`,           // 'awk-script.sh' not awk-family
    `printf 'awk -e foo'`,                  // 1 token after tokenize
    `echo 'awk -e is GNU only'`,            // single-quoted 1 token
  ]) {
    const risks = parseBashRiskyOps(cmd).risks;
    assert.equal(
      risks.filter(r => r.kind === 'code_execution').length,
      0,
      `${cmd} should NOT be code_execution (no awk-family basename match)`,
    );
  }
});

test('Codex D fix #3: regression — `awk -f` exempt under all wrapper forms', () => {
  // analyzeAwkArgv must correctly detect hasFileFlag and skip the
  // hard-reject path. Pin under direct/xargs/find/wrapper forms.
  for (const cmd of [
    `awk -f script.awk file.txt`,
    `awk -fscript.awk file.txt`,
    `awk --file=script.awk file.txt`,
    `awk --file script.awk file.txt`,
    `xargs awk -f script.awk`,
    `xargs gawk --file=/tmp/x.awk`,
    `find . -exec awk -f script.awk {} \\;`,
    `find . -exec awk --file=script.awk {} +`,
    `env xargs gawk -f script.awk`,
    `cat data.txt | xargs awk -f script.awk`,
  ]) {
    const risks = parseBashRiskyOps(cmd).risks;
    assert.equal(
      risks.filter(r => r.kind === 'code_execution').length,
      0,
      `${cmd} should NOT be code_execution (-f only, no inline)`,
    );
  }
});

test('Codex D fix #3: regression — bare `awk --version` / `gawk -V` falls through', () => {
  for (const cmd of [
    `awk --version`,
    `gawk -V`,
    `mawk --version`,
    `xargs awk --version`,                  // wrapper + version probe
  ]) {
    const risks = parseBashRiskyOps(cmd).risks;
    assert.equal(
      risks.filter(r => r.kind === 'code_execution').length,
      0,
      `${cmd} should NOT be code_execution (probe form)`,
    );
  }
});

test('Codex D fix #3: regression — preposed `< /tmp/x awk` still detected', () => {
  // P1 self-review case (round 14) must keep working with the new
  // unified token-scan: `< /tmp/script.awk awk` — redirect target
  // is transparent in invocation-context walkback. Token-scan finds
  // awk at head position (after preamble) → analyze argv → no
  // positional/inline/file → check stdin redirect → flag.
  const risks = parseBashRiskyOps(`< /tmp/script.awk awk`).risks;
  assert.ok(
    risks.some(r => r.kind === 'code_execution'),
    'preposed redirect + awk must detect stdin-fed code_execution',
  );
});

test('Codex D fix #2: xargs / find -exec / wrapper-of-wrapper awk inline → code_execution (token-scan)', () => {
  // Codex pre-pp re-review of the round 14 D-fix (D-graded again,
  // 2026-05-04): D-fix #1 added hasInlineFlag for direct `gawk -e`,
  // but missed `xargs gawk -e` because xargs isn't a COMMAND_WRAPPER.
  // findWrappedCommand returned null and the entire awk block was
  // skipped. Fix: add awk token-scan modeled on round 10's SCRIPT_
  // INTERPRETERS scan — find awk-family at ANY token position +
  // downstream inline flag. Pin all wrapper variants here.
  for (const cmd of [
    `xargs gawk -e 'BEGIN{system("rm")}'`,
    `xargs gawk --source='BEGIN{system("rm")}'`,
    `xargs -I{} gawk -e 'system("rm")' {}`,
    `xargs -0 awk --source 'system("rm")'`,
    `find . -exec gawk -e 'BEGIN{system("rm")}' {} \\;`,
    `find . -name '*.txt' -exec awk --source='BEGIN{system("rm")}' {} +`,
    `env xargs gawk -e 'BEGIN{system("rm")}'`,            // wrapper-of-wrapper
    `printf data | xargs awk --source 'BEGIN{system("rm")}'`,
    `time xargs gawk -e 'system("rm")'`,                   // time + xargs + awk
    `nice -n 10 xargs awk --source='system("rm")'`,        // nice + xargs + awk
  ]) {
    const risks = parseBashRiskyOps(cmd).risks;
    assert.ok(
      risks.some(r => r.kind === 'code_execution'),
      `${cmd} must be code_execution (token-scan covers wrapper bypass)`,
    );
  }
});

test('Codex D fix #2: regression — token-scan does NOT mis-flag awk-as-data-token', () => {
  // The token-scan trade-off: `echo "awk -e foo"` (3 echo args
  // including the literal token 'awk' and '-e<glued>') would flag.
  // Single-quoted string keeps it as 1 token after tokenize, no
  // flag. Pin this distinction.
  // 1-token (single quoted) — should NOT flag:
  for (const cmd of [
    `echo 'awk -e foo'`,                  // single-quoted = 1 token after tokenize
    `echo "use awk -e syntax"`,            // double-quoted = 1 token
    `cat docs/awk-tutorial.md`,            // 'awk' in path, no -e nearby
    `grep 'awk -e' docs/`,                 // single-quoted pattern
  ]) {
    const risks = parseBashRiskyOps(cmd).risks;
    assert.equal(
      risks.filter(r => r.kind === 'code_execution').length,
      0,
      `${cmd} should NOT flag (awk is data, not a real invocation)`,
    );
  }
  // Multi-token (3 unquoted args) — known false positive, accept:
  // `echo awk -e hello` would flag. Documented as known-limit; agent
  // uses `echo 'awk -e hello'` to avoid.
});

test('Codex D fix #2: regression — direct awk -f script.awk still NOT flagged after token-scan', () => {
  // Token-scan looks for awk-family + later inline-flag; -f doesn't
  // qualify as inline-flag → -f-only commands stay unflagged.
  for (const cmd of [
    `awk -f script.awk file.txt`,
    `gawk -f /tmp/x.awk data.txt`,
    `xargs awk -f script.awk`,             // wrapper + -f only (no -e)
    `find . -exec awk -f /tmp/x.awk {} \\;`, // find -exec + -f only
  ]) {
    const risks = parseBashRiskyOps(cmd).risks;
    assert.equal(
      risks.filter(r => r.kind === 'code_execution').length,
      0,
      `${cmd} should NOT be code_execution (-f only, no inline flag)`,
    );
  }
});

test('Codex D fix: gawk -e/--source inline-program flags (all 4 forms) → code_execution', () => {
  // Codex pre-pp review of the round-14 batch (graded D, 2026-05-04):
  // round-14 awk detector caught the SEPARATE `-e PROGRAM` form via
  // the positional-scan loop, but missed three glued/long variants:
  //   `gawk -e'BEGIN{system("rm")}'`            (POSIX-glued -e)
  //   `gawk --source 'BEGIN{system("rm")}'`     (long separate)
  //   `gawk --source='BEGIN{system("rm")}'`     (long glued)
  // All three matched `if (a.startsWith('-')) continue;` in the
  // positional-scan loop, the program payload was lost, and
  // autoApprove + one click executed system(). Fixed by an explicit
  // hasInlineFlag check BEFORE the hasFileFlag exemption.
  for (const cmd of [
    `gawk -e 'BEGIN{system("rm /tmp/x")}'`,             // separate
    `gawk -e'BEGIN{system("rm /tmp/x")}'`,              // POSIX-glued -e
    `gawk --source 'BEGIN{system("rm /tmp/x")}'`,       // long separate
    `gawk --source='BEGIN{system("rm /tmp/x")}'`,       // long glued
    `awk -e'foo'`,                                       // bare awk + glued
    `mawk -e 'foo'`,                                     // mawk + separate (apply uniformly)
    `nawk --source='foo'`,                               // nawk + glued long
    `env gawk -e'system("rm")'`,                        // wrapper-aware
    `sudo -E gawk --source='system("rm")'`,             // wrapper-aware long-glued
  ]) {
    const risks = parseBashRiskyOps(cmd).risks;
    assert.ok(
      risks.some(r => r.kind === 'code_execution'),
      `${cmd} must be code_execution (-e/--source inline program)`,
    );
  }
});

test('Codex D fix: regression — awk -f script.awk still NOT flagged after inline-flag fix', () => {
  // The new hasInlineFlag branch must not steal cases that have
  // -f/--file (file-source, fileRead-gated). Pin: -f forms remain
  // unflagged at the parser level (they reach the prompt for the
  // user to decide).
  for (const cmd of [
    `awk -f script.awk file.txt`,
    `awk -fscript.awk file.txt`,
    `awk --file=script.awk file.txt`,
    `awk --file script.awk file.txt`,
    `gawk -f /tmp/x.awk data.txt`,
    `cat data.txt | awk -f script.awk`,
  ]) {
    const risks = parseBashRiskyOps(cmd).risks;
    assert.equal(
      risks.filter(r => r.kind === 'code_execution').length,
      0,
      `${cmd} should NOT be code_execution (program from file)`,
    );
  }
});

test('Codex D fix: regression — `awk -f script.awk -e "extra inline"` is flagged (inline part wins)', () => {
  // If a command has BOTH -f and -e, awk runs both: -f script first,
  // then -e program. The inline part is dangerous → flag. Pin: hasInlineFlag
  // takes precedence over hasFileFlag exemption.
  const risks = parseBashRiskyOps(`awk -f script.awk -e 'BEGIN{system("rm")}' data.txt`).risks;
  assert.ok(
    risks.some(r => r.kind === 'code_execution'),
    'awk with both -f and -e must flag (inline part is dangerous)',
  );
});

test('Phase 2D #14 follow-up: sed exotic-delim with escaped delim in PATTERN/REPLACEMENT still flags', () => {
  // The imperative scanner advances by 2 chars on `\\` so an
  // escaped delim inside PATTERN/REPLACEMENT doesn't terminate the
  // sub-section prematurely. Self-review pin.
  for (const cmd of [
    `sed 's,foo\\,bar,baz,e' file`,    // comma delim + escaped comma in PATTERN
    `sed 's|foo|bar\\|baz|e' file`,    // pipe delim + escaped pipe in REPLACEMENT
    `sed 's#foo\\#bar#baz#e' file`,    // hash delim + escaped hash in PATTERN
    `sed 's:f\\:o:b\\:r:e' file`,      // colon delim + escapes in both
  ]) {
    const risks = parseBashRiskyOps(cmd).risks;
    assert.ok(
      risks.some(r => r.kind === 'code_execution'),
      `${cmd} must be code_execution despite escaped delim in PATTERN/REPLACEMENT`,
    );
  }
});

test('Phase 2D #14 follow-up: regression — words starting with `s` are not mis-parsed', () => {
  // The imperative scanner requires `s` to be at command position
  // (start-of-string or after a non-alphanumeric). Otherwise words
  // like `says` / `sass` / `sed` itself / `bash`'s `s` in args
  // would falsely trigger substitute scanning.
  for (const cmd of [
    `echo 'says hello world'`,
    `echo 'sassafras tree'`,
    `cat tests/fixtures/some-file.txt`,
    `awk '{print "s" $1}' file`,    // 'print "s"' looks like s+",
    `grep 'say.*hello' /tmp/x`,
  ]) {
    const risks = parseBashRiskyOps(cmd).risks;
    assert.equal(
      risks.filter(r => r.kind === 'code_execution' && r.pattern && r.pattern.includes('sed')).length,
      0,
      `${cmd} should not produce a sed code_execution risk (s is part of a word)`,
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
