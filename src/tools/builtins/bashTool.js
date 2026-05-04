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

import { parseBashRiskyOps } from '../../safety/bashRiskParser.js';
import { requestBashOp } from '../../safety/fileSafetyGate.js';

// Phase 2D follow-up #1 (Codex 🔴): explicit allowlist of commands
// the agent runs constantly and that have no file side-effect AND
// no arbitrary path read. Anything not on this list prompts —
// includes `cat`, `grep`, `head`, `tail`, etc. (which CAN read
// sensitive paths and exfiltrate via stdout). Match-fn signature:
// (head: string, args: string[]) => boolean.
const SILENT_ALLOWLIST = [
  // Pure status / identity / no-arg utilities
  { match: (h, a) => h === 'ls' && a.every(arg => arg.startsWith('-') || /^[\w./@~-]+$/.test(arg)) },
  { match: (h, a) => h === 'pwd' && a.length === 0 },
  { match: (h, a) => h === 'whoami' && a.length === 0 },
  { match: (h, a) => h === 'date' && a.every(arg => arg.startsWith('+') || arg.startsWith('-') || /^[\w-]+$/.test(arg)) },
  { match: (h, a) => h === 'echo' && a.every(arg => !/[`$<>|&;(){}\\]/.test(arg)) },
  // git read-only subcommands
  { match: (h, a) => h === 'git' && (
      a[0] === 'status' || a[0] === 'log' || a[0] === 'diff' ||
      a[0] === 'branch' || a[0] === 'show' || a[0] === 'rev-parse' ||
      a[0] === 'remote' || a[0] === 'config' && a[1] === '--get' ||
      a[0] === 'describe' || a[0] === 'tag' && (a.length === 1 || a[1] === '-l' || a[1] === '--list')
    ) && !a.includes('--exec') && !a.some(x => x.startsWith('--upload-pack'))
  },
  // npm/node/test runners — read-only invocations
  { match: (h, a) => h === 'npm' && (a[0] === 'test' || a[0] === 'run' || a[0] === 'list' || a[0] === 'ls' || a[0] === 'view') },
  { match: (h, a) => h === 'node' && (a.includes('--version') || a[0] === '-v' || a[0] === '--version') },
  { match: (h, a) => h === 'pnpm' && (a[0] === 'test' || a[0] === 'run' || a[0] === 'list' || a[0] === 'ls') },
  { match: (h, a) => h === 'yarn' && (a[0] === 'test' || a[0] === 'run' || a[0] === 'list' || a[0] === 'why') },
  // language toolchain version checks
  { match: (h, a) => /^(python3?|ruby|perl|go|cargo|rustc)$/.test(h) && (a.includes('--version') || a[0] === '-v' || a[0] === '--version') },
  // which / type / command — lookup utilities
  { match: (h, a) => h === 'which' && a.every(arg => /^[\w.-]+$/.test(arg)) },
  { match: (h, a) => h === 'type' && a.every(arg => /^[\w.-]+$/.test(arg)) },
];

function isInAllowlist(command) {
  // Reject anything with shell metachars at the surface that could
  // affect dispatch (pipes, redirects, substitution, &&, ||, ;).
  // The parser's hasShellSubstitution / shellRedirect detection
  // would also catch these, but a quick string check here keeps
  // allowlist ascii-clean and obviously-safe.
  if (/[`$|&;<>(){}]/.test(command)) return false;
  // splitCommands tokenizes; for allowlist checking we want the raw
  // single-command form anyway. Trim + split by whitespace, respect
  // quotes minimally — if quotes are present we just refuse silent.
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
    const allowlisted = risks.length === 0 && isInAllowlist(command);

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
    const cwd = cwdOverride || workspacePath || process.cwd();

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
