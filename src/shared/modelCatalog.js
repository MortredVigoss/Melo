import { PROVIDER_DEFAULTS } from '../../shared/agent/providerDefaults.js';
export { PROVIDER_DEFAULTS };
const defaults = PROVIDER_DEFAULTS;
export const DEFAULT_CHAT_MODEL = defaults.chat.codex;
export const DEFAULT_MODELS_BY_AUTH_MODE = Object.freeze(defaults.chat);
export const DEFAULT_MODEL_CATALOGS = Object.freeze(defaults.catalogs);

export function normalizeReasoningEffort(_model, value, fallback = 'medium', capabilities = {}) {
  if (capabilities.reasoning === false) return null;
  const allowed = capabilities.reasoningEfforts || ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  if (!allowed.length) return null;
  const effort = String(value || '').trim().toLowerCase();
  return allowed.includes(effort) ? effort : capabilities.defaultReasoningEffort || (allowed.includes(fallback) ? fallback : allowed[0]);
}
