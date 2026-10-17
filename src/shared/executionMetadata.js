// Deliberate allowlist: response bodies, headers, prompts and encrypted items
// must never become execution telemetry. Missing counters remain missing.
const count = n => Number.isSafeInteger(n) && n >= 0;
const identifier = value => typeof value === 'string' && /^[a-z0-9._:/-]{1,200}$/i.test(value) ? value : '';
export function executionMetadata(raw = {}) {
  const result = {};
  for (const key of ['responseId', 'reportedModel', 'transport', 'responseStatus', 'finishReason']) {
    const value = identifier(raw[key]); if (value) result[key] = value;
  }
  for (const key of ['durationMs', 'firstEventMs', 'firstTextMs', 'outputCharacters', 'summaryCharacters', 'summaryParts']) {
    if (count(raw[key])) result[key] = raw[key];
  }
  if (typeof raw.simulated === 'boolean') result.simulated = raw.simulated;
  if (typeof raw.summaryTruncated === 'boolean') result.summaryTruncated = raw.summaryTruncated;
  if (raw.usage && typeof raw.usage === 'object') {
    const u = raw.usage;
    const usage = {
      input: u.input_tokens ?? u.prompt_tokens ?? u.input,
      output: u.output_tokens ?? u.completion_tokens ?? u.output,
      total: u.total_tokens ?? u.total,
      cached: u.input_tokens_details?.cached_tokens ?? u.prompt_tokens_details?.cached_tokens ?? u.cache_read_input_tokens ?? u.cached,
      cacheWrite: u.input_tokens_details?.cache_write_tokens ?? u.cache_creation_input_tokens ?? u.cacheWrite,
      reasoning: u.output_tokens_details?.reasoning_tokens ?? u.completion_tokens_details?.reasoning_tokens ?? u.reasoning,
    };
    // Anthropic's input_tokens excludes cache read/write tokens.
    if (count(u.input_tokens) && ('cache_read_input_tokens' in u || 'cache_creation_input_tokens' in u)) {
      const read = u.cache_read_input_tokens ?? 0, write = u.cache_creation_input_tokens ?? 0;
      usage.input = count(read) && count(write) ? u.input_tokens + read + write : undefined;
    }
    result.usage = Object.fromEntries(Object.entries(usage).filter(([, value]) => count(value)));
    if (!Object.keys(result.usage).length) delete result.usage;
  }
  return result;
}

export function publicSummaryText(value, max = 24000) {
  return String(value ?? '').slice(0, max)
    .replace(/\b(Bearer\s+)[^\s]+/gi, '$1[redacted]')
    .replace(/((?:api[_-]?key|password|access[_-]?token|secret)["']?\s*[:=]\s*["']?)[^\s,;"'}]+/gi, '$1[redacted]');
}
