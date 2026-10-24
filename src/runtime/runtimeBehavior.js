import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveRuntimePaths } from './paths.js';
import { currentRequestContext, requestEnvironment } from './requestScope.js';
import { behaviorEnvironment, resolveBehavior } from '../../shared/agent/runtimeBehavior.js';

// Capture once at each operation's entry. Background callers without a request
// read only their captured home's config; no global cache or process.env writes.
export function captureBehavior(config, environment = requestEnvironment()) {
  const env = { ...environment };
  let settings = config ?? currentRequestContext()?.config;
  if (!settings) {
    try { settings = JSON.parse(readFileSync(join(resolveRuntimePaths({ env }).home, 'config.json'), 'utf8')); }
    catch { settings = {}; }
  }
  return Object.freeze(behaviorEnvironment(settings, env));
}
export function behaviorStatus(config, env = requestEnvironment()) { return resolveBehavior(config, env); }

export function memoryEndpointAllowed(url, env = captureBehavior()) {
  if (env.MELO_OFFLINE_ONLY !== '1') return true;
  try { const parsed = new URL(url); return ['http:','https:'].includes(parsed.protocol) && ['localhost','127.0.0.1','[::1]'].includes(parsed.hostname) && !parsed.username && !parsed.password; }
  catch { return false; }
}
