import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { parseBashRiskyOps } from '../safety/bashRiskParser.js';
import { requestBashOp } from '../safety/fileSafetyGate.js';

// The HTTP runner must not be a second, unguarded shell entry point.
export async function startApprovedBackgroundTask(runner, args, { signal, sseEmitter, onComplete, detachAfterApproval = false } = {}) {
  const { command, workspacePath, chatId } = args;
  const env = { ...process.env };
  if (typeof command !== 'string' || !command.trim() || command.length > 4000) {
    throw new Error('command must contain 1 to 4000 characters.');
  }
  const cwd = resolve(typeof workspacePath === 'string' && workspacePath ? workspacePath : process.cwd());
  const realCwd = await realpath(cwd);
  const risks = parseBashRiskyOps(command).risks;
  const rel = relative(cwd, realCwd);
  await requestBashOp({
    command,
    risks: risks.length ? risks : [{ kind: 'unknown', pattern: 'Background command requires confirmation', confidence: 'low' }],
    chatId, signal, sseEmitter,
    workspacePath: cwd, effectiveCwd: cwd, realCwd,
    cwdInsideWorkspace: !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../'),
  });
  if (signal?.aborted) throw new Error('Background command aborted.');
  const timeout = Number(args.timeout);
  return runner.start({
    command, workspacePath: realCwd, signal: detachAfterApproval ? undefined : signal, onComplete, env,
    timeout: Number.isFinite(timeout) && timeout > 0 ? Math.min(timeout, 24 * 60 * 60_000) : undefined,
  });
}
