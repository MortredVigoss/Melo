// Verified against OpenAI model docs and the signed-in Codex catalog, 2026-10-06.
export const DEFAULT_CHAT_MODEL = 'gpt-6.1-sol';
export const DEFAULT_MODELS_BY_AUTH_MODE = Object.freeze({
  local: 'llama3.1',
  'api-key': 'gpt-4.1-mini', // Preserve the API-key mode's economical default.
  codex: DEFAULT_CHAT_MODEL,
});

export const DEFAULT_MODEL_CATALOGS = Object.freeze({
  local: Object.freeze(['llama3.1']),
  'api-key': Object.freeze([DEFAULT_CHAT_MODEL, 'gpt-6-astra', 'gpt-6-luna', 'gpt-4.1', 'gpt-4.1-mini']),
  codex: Object.freeze([DEFAULT_CHAT_MODEL, 'gpt-6-astra', 'gpt-6-luna']),
});

export function normalizeReasoningEffort(model, value, fallback = 'medium') {
  const effort = String(value || fallback).trim().toLowerCase();
  if (/^gpt-6-luna(?:-|$)/i.test(model) && effort === 'none') return 'none';
  if (/^gpt-6(?:\.|-)/i.test(model)) {
    if (effort === 'none' || effort === 'minimal') return 'low';
    return ['low', 'medium', 'high', 'xhigh', 'max'].includes(effort) ? effort : fallback;
  }
  return ['minimal', 'low', 'medium', 'high', 'xhigh'].includes(effort) ? effort : fallback;
}
