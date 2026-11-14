// ─── Chat title + provider error messaging ───────────────────────────────────
// Two small UI-facing helpers that the chat layer uses when turning raw
// user input / raw provider failures into user-visible strings. Both are
// stateless and have no dependencies outside their own arguments.
//
// This module owns:
//   - generateChatTitle(content) — turn the first user message into a short
//     chat title (first sentence, first 6 words, capped at 42 chars)
//   - summarizeProviderFailureDetails(raw) — strip prefixes + HTML, collapse
//     whitespace, cap at 180 chars. Helper for formatProviderFailureMessage.
//   - formatProviderFailureMessage(error) — map a provider error into a
//     friendly one-liner: recognizes known OpenAI / Codex OAuth / 5xx /
//     stall / empty-response patterns and falls back to the summarized
//     detail for anything else.
//
// Extracted from desktopStore.js in the Phase 9h refactor (see
// _refactor-backup/REFACTOR_PLAN.md). Pure module — no imports at all.

export function generateChatTitle(content) {
  const cleaned = content.replace(/\s+/g, ' ').trim();
  if (!cleaned) {
    return 'Untitled chat';
  }

  const firstSentence = cleaned.split(/[.!?\n]/)[0].trim();
  const words = firstSentence.split(' ').slice(0, 6).join(' ');
  return words.length > 42 ? `${words.slice(0, 39)}...` : words;
}

function summarizeProviderFailureDetails(raw = '') {
  const cleaned = String(raw || '')
    .replace(/\s+/g, ' ')
    .replace(/^codex oauth request failed \([^)]*\):\s*/i, '')
    .replace(/^provider request failed \([^)]*\):\s*/i, '')
    .replace(/^codex cli request failed\.?\s*/i, '')
    .trim();

  if (!cleaned) {
    return '';
  }

  if (/<\/?[a-z][^>]*>/i.test(cleaned)) {
    return '';
  }

  return cleaned.length > 180 ? `${cleaned.slice(0, 177)}...` : cleaned;
}

// The fixed sentences a failed model request is answered with. They are stored
// as the reply, and later prompts and memory recognise some of them by this
// exact text (src/domain/chat/contextFilters.js), so they stay English here;
// the desktop chat shows them in the interface language
// (desktop-ui/features/chat/providerFailureText.js, kept equal by its test).
// The four connection sentences named OpenAI whatever service the
// conversation was using (agent audit 2026-11-10).
export const PROVIDER_FAILURE_TEXT = Object.freeze({
  quota: 'The model service is connected, but this API key currently has no available quota. Add billing or credits with your provider, then try again.',
  key: 'The model service rejected this API key. Check the key in Melo and try again.',
  model: 'The selected model is unavailable for this account. Choose another model and try again.',
  rate: 'The model service rate-limited this request. Wait a moment and try again.',
  policy: 'Codex blocked this request because the current thread context looked cybersecurity-sensitive. This is usually caused by stale technical, cookie, token, or error text in a long chat. Start a fresh chat or prune the old context, then retry.',
  login: 'Your Codex OAuth session needs attention. Reconnect Codex in Melo’s Model settings and try again.',
  stalled: 'The model stopped responding midway. This is usually a network hiccup or provider-side stall. Please retry in a moment.',
  empty: 'The model connection opened, but Melo never received a final reply. This is usually a temporary provider or streaming issue. Please retry in a moment.',
  timeout: 'This request hit Melo’s safety time cap. Longer tasks are allowed, so if this keeps happening it is likely a connectivity or provider issue rather than your prompt being too complex.',
  backend: 'The model backend did not finish this request. This is usually temporary or provider-side. Please retry in a moment.',
  unknown: 'Melo could not complete the model request right now. This is often temporary, so please retry in a moment.',
  detailsPrefix: 'Melo could not complete the model request right now. Details: ',
});

export function formatProviderFailureMessage(error) {
  const raw = String(error?.message || '').trim();
  const normalized = raw.toLowerCase();
  const details = summarizeProviderFailureDetails(raw);

  if (normalized.includes('insufficient_quota') || (normalized.includes('429') && normalized.includes('quota'))) {
    return PROVIDER_FAILURE_TEXT.quota;
  }

  if (normalized.includes('invalid_api_key') || normalized.includes('401 unauthorized')) {
    return PROVIDER_FAILURE_TEXT.key;
  }

  if (normalized.includes('model_not_found')) {
    return PROVIDER_FAILURE_TEXT.model;
  }

  if (normalized.includes('rate_limit')) {
    return PROVIDER_FAILURE_TEXT.rate;
  }

  if (normalized.includes('cyber_policy') || normalized.includes('possible cybersecurity risk')) {
    return PROVIDER_FAILURE_TEXT.policy;
  }

  if (
    normalized.includes('codex login has expired') ||
    normalized.includes('reconnect codex oauth') ||
    normalized.includes('codex login is not available') ||
    normalized.includes('missing the chatgpt account id')
  ) {
    return PROVIDER_FAILURE_TEXT.login;
  }

  if (normalized.includes('stream stalled') || normalized.includes('stopped producing output')) {
    return PROVIDER_FAILURE_TEXT.stalled;
  }

  if (
    normalized.includes('completed without returning a final reply') ||
    normalized.includes('returned no response body') ||
    normalized.includes('empty response')
  ) {
    return PROVIDER_FAILURE_TEXT.empty;
  }

  if (normalized.includes('timed out')) {
    return PROVIDER_FAILURE_TEXT.timeout;
  }

  if (
    normalized.includes(' 500 ') ||
    normalized.includes(' 502 ') ||
    normalized.includes(' 503 ') ||
    normalized.includes(' 504 ') ||
    normalized.includes('bad gateway') ||
    normalized.includes('gateway timeout') ||
    normalized.includes('service unavailable') ||
    normalized.includes('internal server error') ||
    normalized.includes('overloaded') ||
    normalized.includes('upstream') ||
    normalized.includes('socket hang up') ||
    normalized.includes('econnreset') ||
    normalized.includes('etimedout')
  ) {
    return PROVIDER_FAILURE_TEXT.backend;
  }

  if (details) {
    return `${PROVIDER_FAILURE_TEXT.detailsPrefix}${details}`;
  }

  return PROVIDER_FAILURE_TEXT.unknown;
}
