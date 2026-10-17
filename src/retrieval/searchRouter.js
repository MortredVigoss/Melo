import { currentRequestContext, requestEnvironment } from '../runtime/requestScope.js';
import { createSearchRouter } from '../../shared/agent/retrieval/searchRouter.js';

export const { registerSearchTriggers, clearSearchTriggers, normalizeMessageContent, latestUserMessageText, extractUrlsFromText, isSocialLinkUrl, scoreWebSearchIntent, shouldUseNativeWebSearch, buildSearchPlan, filterToolsForSearchPlan, buildSearchRoutingPrompt } = createSearchRouter({ currentRequestContext, requestEnvironment });
