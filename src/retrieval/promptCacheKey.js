import { createHash } from 'node:crypto';

export function buildPromptCacheKey({ home, accountId, endpoint, model, scope, profile = 'default', version = 'prompt-v2' }) {
  if (!scope) return null;
  const key = JSON.stringify([version, home, accountId, endpoint, model, profile, scope]);
  return `melo-${createHash('sha256').update(key).digest('hex').slice(0, 48)}`;
}
