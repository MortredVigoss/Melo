import { currentRequestContext, requestEnvironment } from '../runtime/requestScope.js';
import { createSearchRouter } from '../../shared/agent/retrieval/searchRouter.js';

export const { extractUrlsFromText, registerSearchTriggers, clearSearchTriggers, normalizeMessageContent, latestUserMessageText, isSocialLinkUrl, scoreWebSearchIntent, shouldUseNativeWebSearch, buildSearchPlan, filterToolsForSearchPlan, constrainSearchPlan, buildSearchRoutingPrompt: legacyBuildSearchRoutingPrompt } = createSearchRouter({ currentRequestContext, requestEnvironment });

export function buildSearchRoutingPrompt(plan) {
  if (!plan?.sharedPlan) return legacyBuildSearchRoutingPrompt(plan);
  const shared = plan.sharedPlan;
  const instructions = shared.instructions || (shared.route === 'unavailable'
    ? `Search is unavailable (search-unavailable: ${shared.reason}). Explain the missing capability; do not invent retrieved evidence or use a screen as a fallback.` : '');
  return instructions ? '## Search Routing\n' + instructions : '';
}
