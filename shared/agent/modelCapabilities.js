// Connection-scoped declarations. Model IDs are opaque; unknown is not false.
export function normalizeModelCapabilities(value = {}) {
  const out = {};
  for (const key of ['vision', 'reasoning', 'imageGen', 'tools']) if (typeof value?.[key] === 'boolean') out[key] = value[key];
  if (Array.isArray(value?.reasoningEfforts)) out.reasoningEfforts = [...new Set(value.reasoningEfforts.filter(v => typeof v === 'string' && /^[a-z_-]{1,32}$/.test(v)))];
  if (out.reasoningEfforts?.includes(value?.defaultReasoningEffort)) out.defaultReasoningEffort = value.defaultReasoningEffort;
  if (['max_tokens','max_completion_tokens'].includes(value?.outputTokenParameter)) out.outputTokenParameter = value.outputTokenParameter;
  return out;
}
export function capabilitiesFromMetadata(row = {}) {
  const caps = normalizeModelCapabilities(row.capabilities);
  const inputs = row.input_modalities || row.architecture?.input_modalities;
  const outputs = row.output_modalities || row.architecture?.output_modalities;
  if (Array.isArray(inputs)) caps.vision = inputs.includes('image');
  if (Array.isArray(outputs)) caps.imageGen = outputs.includes('image');
  if (Array.isArray(row.supported_parameters) && row.supported_parameters.includes('max_completion_tokens')) caps.outputTokenParameter = 'max_completion_tokens';
  const efforts = row.supported_reasoning_levels || row.supported_reasoning_efforts;
  if (Array.isArray(efforts)) {
    caps.reasoningEfforts = efforts.map(v => typeof v === 'string' ? v : v.effort).filter(Boolean);
    caps.reasoning = caps.reasoningEfforts.length > 0;
    caps.defaultReasoningEffort = row.default_reasoning_level || row.default_reasoning_effort;
  }
  return normalizeModelCapabilities(caps);
}
export function resolvedModelCapabilities(connection = {}, model = connection.model) {
  const result = { ...normalizeModelCapabilities(connection.modelMetadata?.[model]) };
  const test = connection.visionTest;
  if (test?.requestedModel === model && typeof test.ok === 'boolean') result.vision = test.ok;
  return { ...result, ...normalizeModelCapabilities(connection.modelCapabilities?.[model]) };
}
export function connectionForModel(config = {}) {
  const profile = config.llmProfiles?.[config.activeLlmProfileId];
  // Direct/vision overrides cannot borrow a same-named model's declarations from another endpoint.
  return profile && profile.baseUrl === config.baseUrl && profile.authMode === config.authMode &&
    (profile.apiProtocol || 'chat-completions') === (config.apiProtocol || 'chat-completions') ? profile : config;
}
export function modelCapabilityOperation(input) {
  if (input.action === 'metadata') return capabilitiesFromMetadata(input.row);
  return resolvedModelCapabilities(input.connection, input.model);
}
