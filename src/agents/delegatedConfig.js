import { requestEnvironment } from '../runtime/requestScope.js';

// Capture once at delegation entry. Nested roles/skills inherit this resolved
// connection rather than re-reading mutable process credentials after awaits.
export function delegatedConfig(config, env = { ...requestEnvironment() }) {
  if (config.modelResolvedForTurn) return { ...config };
  const profile = Boolean(config.activeLlmProfileId);
  return {
    ...config,
    apiKey: profile ? config.apiKey : env.MELO_API_KEY || env.OPENAI_API_KEY || config.apiKey,
    baseUrl: profile ? config.baseUrl : env.MELO_BASE_URL || env.OPENAI_BASE_URL || config.baseUrl,
    model: config.conversationModelSelected || profile ? config.model : env.MELO_MODEL || config.model,
    modelResolvedForTurn: true,
  };
}
