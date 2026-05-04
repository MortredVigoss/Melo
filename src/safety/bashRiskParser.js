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
  if (typeof command !== 'string' || !command.trim()) return [];
  const out = [];
  let cur = '';
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  let escape = false;

  const flush = () => {
    const t = cur.trim();
    if (t) out.push(t);
    cur = '';
  };

  while (i < command.length) {
    const ch = command[i];
    if (escape) { cur += ch; escape = false; i++; continue; }
    if (ch === '\\' && !inSingle) { cur += ch; escape = true; i++; continue; }
    if (ch === "'" && !inDouble) { inSingle = !inSingle; cur += ch; i++; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; cur += ch; i++; continue; }
    if (!inSingle && !inDouble) {
      const two = command.slice(i, i + 2);
      if (two === '&&' || two === '||') { flush(); i += 2; continue; }
      if (ch === ';' || ch === '|' || ch === '&') { flush(); i++; continue; }
    }
    cur += ch;
    i++;
  }
  flush();
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

function riskifyTokens(tokens) {
  const risks = [];
  if (!tokens.length) return risks;

  const headIdx = skipEnvAssignments(tokens);
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

  // ── Phase 2D follow-up #1 (Codex 🔴): nested shell detection ──────
  // `bash -c '...'` / `sh -c '...'` / `eval '...'` can run ANY inner
  // command; we don't recursively re-parse the inner string (would
  // need a full bash grammar). Surface them as `nested_shell` so the
  // gate prompts. `xargs ... sh -c` (or bash -c) is the same pattern
  // — xargs followed by a -c-using interpreter. Without this guard,
  // `bash -c 'rm -rf x'` would slip past the delete-class hard-reject.
  if (head === 'eval') {
    risks.push({ kind: 'nested_shell', pattern: 'eval', confidence: 'high' });
  }
  if (head === 'bash' || head === 'sh' || head === 'zsh' || head === 'dash' || head === 'ksh') {
    if (args.includes('-c')) {
      risks.push({ kind: 'nested_shell', pattern: `${head} -c`, confidence: 'high' });
    }
  }
  if (head === 'xargs') {
    // xargs followed by a -c-using shell
    const interp = args.find(a => a === 'bash' || a === 'sh' || a === 'zsh' || a === 'dash' || a === 'ksh');
    if (interp && args.includes('-c')) {
      risks.push({ kind: 'nested_shell', pattern: `xargs ${interp} -c`, confidence: 'high' });
    }
    // xargs -I {} <cmd> with a shell-using replacement is harder to
    // detect, but the most common form (`xargs sh -c '...'`) is caught above.
  }

  return risks;
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

  const subs = splitCommands(command);
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
    if (hasUnbalancedQuotes(sub)) {
      unparseable = true;
      continue;
    }
    let tokens;
    try {
      tokens = tokenize(sub);
    } catch {
      unparseable = true;
      continue;
    }
    for (const r of riskifyTokens(tokens)) allRisks.push(r);
  }

  // If we couldn't parse anything but ALSO didn't find any risks, we
  // surface a single 'unknown' so the gate's caller doesn't silently
  // skip the command. CLAUDE.md "无法判断风险 → 默认按高风险处理".
  if (unparseable && allRisks.length === 0) {
    allRisks.push({ kind: 'unknown', pattern: 'unparseable', confidence: 'low' });
  }

  return { risks: allRisks, unparseable };
}
