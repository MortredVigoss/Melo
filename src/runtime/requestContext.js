import { randomUUID, createHash } from 'node:crypto';
import { resolveRuntimePaths } from './paths.js';
import { currentRequestContext, requestEnvironment } from './requestScope.js';
import { createRunBudget } from './runBudget.js';

export function createRequestContext(options = {}) {
  const parent = currentRequestContext();
  const env = Object.freeze({ ...requestEnvironment(), ...(options.env || {}), ...(options.home ? { MELO_HOME: options.home } : {}) });
  // Run budget (design audit C1): one deadline / token / tool-call pool for
  // the whole turn. A context derived from another (`{...current, home}`)
  // keeps the caller's budget so the pool is shared, not restarted.
  const budget = options.budget || createRunBudget({ env });
  const paths = resolveRuntimePaths({ env: options.home ? { ...env, MELO_HOME: options.home } : env });
  const requestId = options.requestId || parent?.requestId || randomUUID();
  const runId = options.runId || (options.chatId
    ? createHash('sha256').update(JSON.stringify([paths.home, options.chatId, requestId])).digest('hex').slice(0, 32)
    : randomUUID());
  return Object.freeze({
    env, paths, home: paths.home,
    requestId,
    runId,
    chatId: options.chatId || null,
    signal: options.signal,
    budget,
    config: options.config || null,
    workspacePath: options.workspacePath || null,
    bootstrapBase: options.bootstrapBase || parent?.bootstrapBase || null,
    startedAt: new Date().toISOString(),
  });
}

export function requestIdentity(context) {
  return { turnRequestId: context.requestId, runId: context.runId, chatId: context.chatId };
}
