import { requestEnvironment } from '../runtime/requestScope.js';

// Capture once at delegation entry. Nested roles/skills inherit this resolved
// connection rather than re-reading mutable process credentials after awaits.
export function delegatedConfig(config, env = { ...requestEnvironment() }) {
  // Bug audit T17: members and skills honour the same MELO_FUNCTION_CALLING
  // override the main loop applies (`legacy` / `native`), whichever path
  // handed them their config.
  const toolCalling = env.MELO_FUNCTION_CALLING ? { toolCalling: env.MELO_FUNCTION_CALLING } : {};
  if (config.modelResolvedForTurn) return { ...config, ...toolCalling };
  const profile = Boolean(config.activeLlmProfileId);
  return {
    ...config,
    apiKey: profile ? config.apiKey : env.MELO_API_KEY || env.OPENAI_API_KEY || config.apiKey,
    baseUrl: profile ? config.baseUrl : env.MELO_BASE_URL || env.OPENAI_BASE_URL || config.baseUrl,
    model: config.conversationModelSelected || profile ? config.model : env.MELO_MODEL || config.model,
    modelResolvedForTurn: true,
    ...toolCalling,
  };
}
