import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { requestEnvironment } from '../runtime/requestScope.js';

// Codex maintains this account-specific catalog after a successful model-list
// fetch. It is discovery evidence, not proof that a model request succeeded.
export async function readCodexModelCatalog({ env = requestEnvironment(), now = Date.now(), onModelMetadata } = {}) {
  const path = join(env.CODEX_HOME || join(homedir(), '.codex'), 'models_cache.json');
  try {
    const cache = JSON.parse(await readFile(path, 'utf8'));
    const age = now - Date.parse(cache.fetched_at);
    if (!Number.isFinite(age) || age < -300000 || age > 24 * 60 * 60 * 1000) return [];
    onModelMetadata?.((Array.isArray(cache.models) ? cache.models : []).filter(model => model.visibility === 'list'));
    return [...new Set((Array.isArray(cache.models) ? cache.models : [])
      .filter(model => model.visibility === 'list')
      .map(model => String(model.slug || '').trim())
      .filter(model => /^[a-z0-9][a-z0-9._-]{0,99}$/i.test(model)))];
  } catch {
    return [];
  }
}
