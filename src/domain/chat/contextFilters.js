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

// Match ONLY structured markers and verbatim long phrases from
// socialLinkTool's failure output (src/tools/builtins/fetchUrlTool.js +
// socialLinkTool.js). Short keywords like "fresh cookies", "xsec_token",
// or "登录态" appear in normal technical explanations too, so matching
// them would silently strip legitimate answers from prompt + memory.
const SOCIAL_LINK_DIAGNOSTIC_PATTERN =
  /(?:SOCIAL_LINK_BLOCKED|SOCIAL_LINK_FAILED|Could not read this social-link URL|dedicated extractor \(yt-dlp|Customize → Safety → Web-fetch cookies)/i;

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
