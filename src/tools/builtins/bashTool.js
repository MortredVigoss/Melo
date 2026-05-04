/**
 * Built-in tool: bash
 *
 * Phase 2D (2026-05-04): every bash invocation is now parsed by
 * `bashRiskParser.parseBashRiskyOps` and routed through
 * `FileSafetyGate.requestBashOp`. The gate:
 *   - **hard-rejects** any `delete`-class risk (rm / git clean /
 *     find -delete / etc) with a hint to use `file_delete` — that
 *     way deletes always go through the trash quarantine + two-
 *     stage approval, no exception via bash;
 *   - **prompts** for everything else risky (write/append/overwrite/
 *     reset_repo/truncate/in_place_edit/move/unknown);
 *   - **silently allows** zero-risk commands (ls, cat, git status,
 *     npm test, etc).
 *
 * If the parser flags `unparseable: true` (broken quoting, syntax
 * we can't tokenize), we add an explicit `unknown`-class risk so
 * the gate prompts — "can't classify ⇒ user decides" beats silently
 * running an unanalyzable command.
 *
 * `requiresPermission: false` — FileSafetyGate is the only path-
 * aware gate; the executor's toolId-level prompt would just double-
 * prompt before our risk-aware classification fires.
 *
 * Known limit: nested command shells (eval / bash -c / xargs sh -c)
 * have their inner commands NOT recursively re-parsed. Phase 2D
 * round 2 will close this if Codex flags it.
 */

import { spawn } from 'node:child_process';

import { parseBashRiskyOps } from '../../safety/bashRiskParser.js';
import { requestBashOp } from '../../safety/fileSafetyGate.js';

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

    // Phase 2D (2026-05-04): parse the command for risky patterns,
    // then route through the gate. Risk-free commands skip the
    // prompt; risky ones get user approval (or hard-reject for
    // delete-class + the new "unparseable" / "unknown" tier).
    const parsed = parseBashRiskyOps(command);
    const risks = parsed.unparseable
      ? [...parsed.risks, { kind: 'unknown', pattern: '(unparseable command — quotes/syntax)' }]
      : parsed.risks;
    if (risks.length > 0) {
      try {
        await requestBashOp({
          command,
          risks,
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
          meta: { denied: err.code === 'FILE_SAFETY_DENIED', risks },
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
