// Transport syntax belongs to the endpoint/protocol; capability decisions
// belong to the connection's declarations, never to a model-name regex.
export function fastGenerationOptions({ baseUrl, maxTokens, providerProfile, modelCapabilities = {} }) {
  const fast = providerProfile === 'fast';
  const budget = Number.isFinite(maxTokens) ? Math.max(1, Math.min(8192, Math.floor(maxTokens))) : fast ? 1024 : null;
  let officialOpenAI = false;
  try { officialOpenAI = new URL(baseUrl).hostname === 'api.openai.com'; } catch {}
  const parameter = modelCapabilities.outputTokenParameter || (officialOpenAI ? 'max_completion_tokens' : 'max_tokens');
  const effort = ['none','minimal','low'].find(value => modelCapabilities.reasoningEfforts?.includes(value));
  return {
    ...(budget == null ? {} : { [parameter]: budget }),
    ...(fast && modelCapabilities.reasoning !== false && effort ? { reasoning_effort: effort } : {}),
  };
}
