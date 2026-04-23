/**
 * Built-in tool: bash
 *
 * Executes a shell command in the user's workspace.
 * Requires user permission by default.
 * Streams stdout/stderr incrementally via context.onOutput.
 */

import { spawn } from 'node:child_process';

// Per-stream output cap — prevents a runaway command from flooding context
const MAX_STREAM_BYTES = 50_000;  // 50 KB each for stdout and stderr
const TRUNCATION_NOTICE = '\n\n[... output truncated — use head/tail/grep to reduce output ...]';

export const bashTool = {
  id: 'bash',
  name: 'Bash',
  description:
    'Execute a shell command in the workspace directory. ' +
    'Returns stdout, stderr, and exit code. ' +
    'Prefer this for running scripts, compiling, testing, git operations, etc.',
  category: 'system',
  requiresPermission: true,
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
    const { workspacePath, onOutput, signal } = context;

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
