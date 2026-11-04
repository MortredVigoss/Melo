import { currentRequestContext, requestEnvironment } from '../runtime/requestScope.js';
import { createSearchRouter } from '../../shared/agent/retrieval/searchRouter.js';

export const { extractUrlsFromText, registerSearchTriggers, clearSearchTriggers, normalizeMessageContent, latestUserMessageText, isSocialLinkUrl, scoreWebSearchIntent, shouldUseNativeWebSearch, buildSearchPlan, filterToolsForSearchPlan, constrainSearchPlan, buildSearchRoutingPrompt: legacyBuildSearchRoutingPrompt } = createSearchRouter({ currentRequestContext, requestEnvironment });

export function buildSearchRoutingPrompt(plan) {
  if (!plan?.sharedPlan) return legacyBuildSearchRoutingPrompt(plan);
  const shared = plan.sharedPlan;
  // Capability guidance can be non-empty while retrieval is unavailable. Keep
  // the actual status instead of treating any instruction text as availability.
  const instructions = [shared.route === 'unavailable'
    ? `Search is unavailable (search-unavailable: ${shared.reason}). Explain the missing capability; do not invent retrieved evidence or use a screen as a fallback.` : '', shared.instructions].filter(Boolean).join('\n');
  return instructions ? '## Search Routing\n' + instructions : '';
}
