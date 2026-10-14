// Vendor-specific options only on a known protocol/endpoint. In particular,
// API service_tier is never sent to Codex OAuth or enabled implicitly.
export function fastGenerationOptions({ model, baseUrl, maxTokens, providerProfile }) {
  const fast = providerProfile === 'fast';
  const budget = Number.isFinite(maxTokens) ? Math.max(1, Math.min(8192, Math.floor(maxTokens))) : fast ? 1024 : null;
  let officialOpenAI = false;
  try { officialOpenAI = new URL(baseUrl).hostname === 'api.openai.com'; } catch {}
  const reasoningModel = officialOpenAI && /^(?:gpt-[56](?:[.-]|$)|o[134](?:-|$))/i.test(model);
  return {
    ...(budget == null ? {} : reasoningModel ? { max_completion_tokens: budget } : { max_tokens: budget }),
    ...(fast && officialOpenAI && /^gpt-6(?:\.|-)/i.test(model)
      ? { reasoning_effort: /^gpt-6-luna(?:-|$)/i.test(model) ? 'none' : 'low' } : {}),
  };
}
