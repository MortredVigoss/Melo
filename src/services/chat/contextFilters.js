// Context filters for text that should remain visible in the UI/history but
// should not be re-injected into future model prompts or memory recall blocks.
//
// These are intentionally narrow and target assistant-side diagnostics:
// provider failures, social-link anti-bot/cookie notes, and Codex policy
// explanations. User text is not filtered by these helpers.

const PROVIDER_FAILURE_PATTERN =
  /^Melo could not complete the (?:model|OpenAI) request/i;

const CODEX_POLICY_FAILURE_PATTERN =
  /(?:cyber_policy|possible cybersecurity risk|current thread context looked cybersecurity-sensitive|Codex blocked this request)/i;

const SOCIAL_LINK_DIAGNOSTIC_PATTERN =
  /(?:SOCIAL_LINK_BLOCKED|fresh cookies|xsec_token|需要\s*fresh\s*cookies|需要登录态|登录态|临时访问凭证|cookie|cookies)/i;

export function isProviderFailureContextText(text = '') {
  return PROVIDER_FAILURE_PATTERN.test(String(text || '').trim());
}

export function isCodexPolicyFailureContextText(text = '') {
  return CODEX_POLICY_FAILURE_PATTERN.test(String(text || '').trim());
}

export function isSocialLinkDiagnosticContextText(text = '') {
  const normalized = String(text || '').trim();
  if (!normalized) {
    return false;
  }

  return SOCIAL_LINK_DIAGNOSTIC_PATTERN.test(normalized);
}

export function shouldSuppressAssistantContextText(text = '') {
  return (
    isProviderFailureContextText(text) ||
    isCodexPolicyFailureContextText(text) ||
    isSocialLinkDiagnosticContextText(text)
  );
}

export function shouldSuppressMemoryContextText(text = '') {
  return shouldSuppressAssistantContextText(text);
}
