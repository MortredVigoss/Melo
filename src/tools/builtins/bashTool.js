/**
 * Built-in tool: bash
 *
 * Phase 2D + follow-up #1 (2026-05-04): default-deny model.
 *
 *   - **silent allowlist**: a small, explicit set of commands with
 *     no file side-effects and no arbitrary path read — `ls`,
 *     `pwd`, `whoami`, `date`, `git status`, `git log`, `git diff`,
 *     `git branch`, `npm test`, `npm run <script>`, etc. Matched
 *     by exact head + tightly-restricted args. EVERYTHING ELSE
 *     prompts (even if bashRiskParser sees no write/delete risk),
 *     because read-class commands like `cat ~/.ssh/id_rsa` would
 *     otherwise silently exfiltrate sensitive content.
 *   - **hard-reject**: delete-class risks (rm / find -delete /
 *     git clean / etc) → `requestBashOp` throws with a hint to
 *     use `file_delete` for trash-quarantined two-stage approval.
 *   - **nested-shell + substitution**: `bash -c '...'` / `eval '...'`
 *     / `$(...)` / `` `...` `` / `xargs sh -c` are flagged as
 *     `nested_shell` by the parser. They could hide arbitrary
 *     commands (including `rm`), so the gate prompts; if the user
 *     denies, no spawn. We do NOT recursively parse the inner
 *     string (a true bash grammar is huge); the user reads the
 *     full command in the prompt and decides.
 *   - **unparseable**: bashRiskParser surfaces an `unknown` risk
 *     so the gate prompts. "Can't classify ⇒ user decides".
 *
 * `requiresPermission: false` — FileSafetyGate is the only gate;
 * executor's toolId-level prompt would double-prompt with our
 * risk-aware classification.
 */

import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { relative as pathRelative, isAbsolute as pathIsAbsolute } from 'node:path';

import { parseBashRiskyOps } from '../../safety/bashRiskParser.js';
import { requestBashOp } from '../../safety/fileSafetyGate.js';

// Phase 2D follow-up #3 (Codex 🔴, 2026-05-04): unified allowlist
// rule — silent ONLY when (a) every non-position-0 arg is an
// option flag (starts with `-`, or `+` for date format), and
// (b) the cwd is inside workspacePath (no cwdOverride to
// arbitrary dirs like /etc). This kills the entire class of
// "allowlisted command + sensitive path arg" bypasses:
//   ls ~/.ssh                         → arg doesn't start with -
//   git diff --no-index ~/.ssh /tmp   → trailing paths aren't options
//   git log -- some/path              → "--" then "some/path" path
//   ls (cwdOverride: /etc)            → cwd outside workspace
// All fall to the default-deny path → prompt.
//
// Match-fn signature: (head, args) => boolean — only checks
// head + arg-shape, NOT cwd. cwd check is done separately in
// isInAllowlist.

// Are all args option flags? Empty args is allowed (no-op forms
// like `pwd`, `git status`).
function allOptionsOnly(args, allowedPrefixes = ['-']) {
  return args.every(arg => allowedPrefixes.some(p => arg.startsWith(p)));
}

const SILENT_ALLOWLIST = [
  // Pure status / identity / no-arg utilities
  { match: (h, a) => h === 'pwd' && a.length === 0 },
  { match: (h, a) => h === 'whoami' && a.length === 0 },
  { match: (h, a) => h === 'date' && allOptionsOnly(a, ['-', '+']) },
  { match: (h, a) => h === 'ls' && allOptionsOnly(a) },
  { match: (h, a) => h === 'echo' && a.every(arg => !/[`$<>|&;(){}\\]/.test(arg)) },
  // Phase 2D follow-up #5 (Codex 🔴, 2026-05-04): `git` is REMOVED
  // from the silent allowlist entirely. Each previous round added
  // a deny-list option (`--no-index`, `--exec`, `--upload-pack`,
  // `--textconv`) but new options keep surfacing — `git diff
  // --output=/tmp/x` writes arbitrarily, `git log --output=` same,
  // `--pager=`/`--editor=`/`--external-diff=` all execute external
  // commands. Maintaining a complete deny-list of every git option
  // that loads externals or writes files is unrealistic. Cleanest
  // safe answer: every `git <anything>` command goes through
  // requestBashOp prompt. UX cost: one prompt for `git status` etc.
  // Phase 3 UI's "always allow this exact command" can soften the
  // friction once it ships.
  // Phase 2D follow-up #4 (Codex 🔴, 2026-05-04): version probes
  // must be EXACTLY `<bin>` / `<bin> -v` / `<bin> --version`.
  // Any extra arg loads attacker-controlled side effects:
  //   node --require /tmp/evil.js --version  → runs /tmp/evil.js
  //   python -B --version                    → bytecode-disabled but
  //                                            still benign; we still
  //                                            refuse to keep the rule
  //                                            obvious and uniform
  //   ruby -e '...' --version                → runs the -e payload
  // So: args.length 0 OR args === ['-v'] OR args === ['--version'].
  { match: (h, a) => h === 'node' && isVersionProbe(a) },
  { match: (h, a) => /^(python3?|ruby|perl|go|cargo|rustc)$/.test(h) && isVersionProbe(a) },
  // which / type — lookup utilities. Restrict to bare binary names
  // (no slashes, dots, tildes, leading dash) so `which ./malicious`
  // / `which ~/.ssh/foo` go through the prompt.
  { match: (h, a) => h === 'which' && a.length > 0 && a.every(arg => /^[\w-]+$/.test(arg) && !arg.startsWith('-')) },
  { match: (h, a) => h === 'type' && a.length > 0 && a.every(arg => /^[\w-]+$/.test(arg) && !arg.startsWith('-')) },
];

function isVersionProbe(args) {
  if (!Array.isArray(args)) return false;
  if (args.length === 0) return true;
  if (args.length === 1 && (args[0] === '-v' || args[0] === '-V' || args[0] === '--version')) return true;
  return false;
}

// Phase 2D follow-up #4 (Codex 🔴, 2026-05-04): cwd safety must
// realpath BOTH workspacePath and cwd, then use path.relative to
// detect any `..` (lexical escape) or symlink-resolved escape.
// String prefix is unsafe — `$WS/../sibling` and a symlink at
// `$WS/link → /elsewhere` both pass a bare prefix check.
function cwdInsideWorkspace(cwd, workspacePath) {
  if (!workspacePath || typeof workspacePath !== 'string') return false;
  if (!cwd || typeof cwd !== 'string') return false;
  if (!pathIsAbsolute(workspacePath) || !pathIsAbsolute(cwd)) return false;
  let realWs;
  let realCwd;
  try {
    realWs = realpathSync(workspacePath);
    realCwd = realpathSync(cwd);
  } catch {
    // realpath fails (missing dir, EACCES) → treat as outside.
    return false;
  }
  if (realWs === realCwd) return true;
  const rel = pathRelative(realWs, realCwd);
  // `..` (lexical/real escape) or absolute (different volume) → outside.
  if (!rel || rel === '' || rel.startsWith('..') || pathIsAbsolute(rel)) return false;
  return true;
}

function isInAllowlist(command, cwd, workspacePath) {
  // Phase 2D follow-up #3: cwd MUST be inside workspacePath. An
  // explicit `cwdOverride` to /etc / ~ / etc lets allowlisted
  // commands run in a sensitive directory and silently leak its
  // contents (e.g. `ls` in /etc reveals system file names).
  if (!cwdInsideWorkspace(cwd, workspacePath)) return false;
  // Reject any shell metachars / quotes at the surface — these
  // could affect dispatch (pipes, redirects, substitution) or
  // hide arbitrary content the parser sees through.
  if (/[`$|&;<>(){}]/.test(command)) return false;
  if (/['"\\]/.test(command)) return false;
  const parts = command.trim().split(/\s+/);
  if (parts.length === 0) return false;
  const head = parts[0];
  const args = parts.slice(1);
  for (const entry of SILENT_ALLOWLIST) {
    try {
      if (entry.match(head, args)) return true;
    } catch { /* match fn error → not allowlisted */ }
  }
  return false;
}

// Per-stream output cap — prevents a runaway command from flooding context
const MAX_STREAM_BYTES = 50_000;  // 50 KB each for stdout and stderr
const TRUNCATION_NOTICE = '\n\n[... output truncated — use head/tail/grep to reduce output ...]';

export const bashTool = {
  id: 'bash',
  name: 'Bash',
  description:
    'Execute a shell command in the workspace directory. ' +
    'Returns stdout, stderr, and exit code. ' +
    'Prefer this for running scripts, compiling, testing, git operations, etc. ' +
    'Risky commands (write, overwrite, append, in-place edit, move, git reset, ...) ' +
    'trigger a user prompt; destructive deletes (rm, find -delete, git clean, ...) are ' +
    'HARD-REJECTED — use the file_delete tool so files go to .melo-trash/ with two-stage approval. ' +
    'Commands the parser can\'t tokenize (broken quoting, etc) also prompt as "unknown" risk.',
  category: 'system',
  // FileSafetyGate.requestBashOp owns the path-level approval; toolId
  // level prompt would double-prompt for any risky bash. Silent for
  // zero-risk commands (ls / git status / etc) — exactly the contract
  // Phase 2B read tools follow.
  requiresPermission: false,
  isConcurrencySafe: false,
  parametersSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The shell command to run.',
      },
      timeout: {
        type: 'number',
        description: 'Timeout in milliseconds (default: 30000, max: 120000).',
      },
      cwd: {
        type: 'string',
        description: 'Working directory override (absolute path). Defaults to workspace root.',
      },
    },
    required: ['command'],
  },
  examples: [
    { command: 'ls -la' },
    { command: 'npm test' },
    { command: 'git status' },
  ],

  /**
   * @param {{ command: string, timeout?: number, cwd?: string }} args
   * @param {import('../tool.js').ToolRunContext} context
   * @returns {Promise<import('../tool.js').ToolResult>}
   */
  async run(args, context = {}) {
    const { command, timeout = 30_000, cwd: cwdOverride } = args;
    const { workspacePath, onOutput, signal, sseEmitter, chatId } = context;

    if (typeof command !== 'string' || !command.trim()) {
      return { ok: false, output: 'command must be a non-empty string.', error: 'INVALID_ARGS' };
    }

    // Phase 2D + follow-up #1 (2026-05-04, post-Codex 🔴): default-
    // deny — only commands explicitly on the silent-allowlist run
    // without a prompt. Read-class commands like `cat ~/.ssh/...`
    // would otherwise silently exfiltrate sensitive content via
    // stdout, and nested-shell escapes (`bash -c 'rm -rf x'` /
    // `eval ...` / `$(...)`) would slip past the parser's top-level
    // delete-class detection. So:
    //   1. parse risks (delete → hard-reject; nested_shell → prompt;
    //      write/append/in_place_edit/move/etc → prompt)
    //   2. if NO risks AND command is on the allowlist → silent
    //   3. otherwise → prompt (even if no risks — read-class lives here)
    const parsed = parseBashRiskyOps(command);
    const risks = parsed.risks;
    // Pre-compute cwd here so isInAllowlist can validate it sits
    // inside workspacePath (Phase 2D follow-up #3).
    const effectiveCwd = cwdOverride || workspacePath || process.cwd();
    const allowlisted = risks.length === 0 && isInAllowlist(command, effectiveCwd, workspacePath);

    if (!allowlisted) {
      // Synthesize an `unknown` risk for empty risks so requestBashOp
      // still fires the prompt (it short-circuits when risks is empty).
      const promptRisks = risks.length > 0
        ? risks
        : [{ kind: 'unknown', pattern: '(default-deny — command not on silent allowlist)', confidence: 'low' }];
      try {
        await requestBashOp({
          command,
          risks: promptRisks,
          chatId,
          sseEmitter,
          signal,
          workspacePath,
        });
      } catch (err) {
        return {
          ok: false,
          output: err.message,
          error: err.code === 'FILE_SAFETY_DENIED' ? 'DENIED' : 'GATE_ERROR',
          meta: { denied: err.code === 'FILE_SAFETY_DENIED', risks: promptRisks },
        };
      }
    }

    const clampedTimeout = Math.min(Math.max(timeout, 1000), 120_000);
    const cwd = effectiveCwd;

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let finished = false;

      const proc = spawn('bash', ['-c', command], {
        cwd,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const killTimer = setTimeout(() => {
        if (!finished) {
          proc.kill('SIGTERM');
          setTimeout(() => { if (!finished) proc.kill('SIGKILL'); }, 2000);
        }
      }, clampedTimeout);

      const onAbort = () => {
        if (!finished) {
          proc.kill('SIGTERM');
          setTimeout(() => { if (!finished) proc.kill('SIGKILL'); }, 2000);
        }
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      proc.stdout.on('data', (chunk) => {
        const text = chunk.toString();
        if (typeof onOutput === 'function') onOutput(text);
        if (!stdoutTruncated) {
          if (stdout.length + text.length > MAX_STREAM_BYTES) {
            stdout += text.slice(0, MAX_STREAM_BYTES - stdout.length);
            stdoutTruncated = true;
          } else {
            stdout += text;
          }
        }
      });

      proc.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        if (typeof onOutput === 'function') onOutput(text);
        if (!stderrTruncated) {
          if (stderr.length + text.length > MAX_STREAM_BYTES) {
            stderr += text.slice(0, MAX_STREAM_BYTES - stderr.length);
            stderrTruncated = true;
          } else {
            stderr += text;
          }
        }
      });

      proc.on('close', (code, sigName) => {
        finished = true;
        clearTimeout(killTimer);
        signal?.removeEventListener('abort', onAbort);

        const exitCode = sigName ? null : (code ?? 1);
        const ok = exitCode === 0;
        const parts = [];
        if (stdout) parts.push(`stdout:\n${stdout.trimEnd()}${stdoutTruncated ? TRUNCATION_NOTICE : ''}`);
        if (stderr) parts.push(`stderr:\n${stderr.trimEnd()}${stderrTruncated ? TRUNCATION_NOTICE : ''}`);
        if (sigName) parts.push(`killed by signal: ${sigName}`);
        if (!parts.length) parts.push(ok ? '(no output)' : `exited with code ${exitCode}`);

        resolve({
          ok,
          output: parts.join('\n\n'),
          error: ok ? undefined : `Exit code ${exitCode ?? sigName}`,
          meta: { exitCode, stdout, stderr, stdoutTruncated, stderrTruncated },
        });
      });

      proc.on('error', (err) => {
        finished = true;
        clearTimeout(killTimer);
        signal?.removeEventListener('abort', onAbort);
        resolve({
          ok: false,
          output: `Failed to spawn process: ${err.message}`,
          error: err.message,
          meta: { exitCode: null, stdout, stderr },
        });
      });
    });
  },
};
