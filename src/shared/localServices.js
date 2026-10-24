// Defaults are service identities, never tests for whether a model/provider supports a feature.
export const LOCAL_SERVICE_DEFAULTS = Object.freeze({
  ollama: 'http://127.0.0.1:11434/v1',
  lmstudio: 'http://127.0.0.1:1234/v1',
  llamacpp: 'http://127.0.0.1:8080/v1',
  customVoice: 'http://127.0.0.1:7860/v1',
});

export function localServiceUrl(value, fallback = '') {
  const url = new URL(String(value || fallback));
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash) {
    throw new Error('Local service address must be an HTTP(S) loopback URL.');
  }
  return url.href.replace(/\/+$/, '');
}

export function customVoiceService(config = {}) {
  const baseUrl = localServiceUrl(config.customVoiceBaseUrl, LOCAL_SERVICE_DEFAULTS.customVoice);
  const endpoint = new URL(baseUrl);
  return { baseUrl, healthUrl: new URL('/health', endpoint).href,
    host: endpoint.hostname.replace(/^\[|\]$/g, ''), port: endpoint.port || (endpoint.protocol === 'https:' ? '443' : '80') };
}

export function customVoiceActive(config = {}) {
  if (config.ttsProvider) return config.ttsProvider === 'custom';
  // Exact compatibility for saved voice-pack settings. No arbitrary port/name matching.
  try { return localServiceUrl(config.whisperBaseUrl) === customVoiceService(config).baseUrl; }
  catch { return false; }
}
