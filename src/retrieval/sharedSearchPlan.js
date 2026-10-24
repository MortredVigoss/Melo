import { planRequest } from '../../shared/agent/search.js';

/** Native capability proof is supplied by the connection Adapter, never inferred from a model name. */
export function buildSharedSearchPlan({ latestUserMessage = '', modelMessages = [], config = {}, capabilities = {} } = {}) {
  const sharedPlan = planRequest({ text: latestUserMessage, messages: modelMessages, config: { ...config.agentRuntime, webSearchTriggers: config.webSearchTriggers }, capabilities });
  const routes = { 'hosted-search': 'codex-native', 'http-search': 'melo-web', 'legacy-search': 'melo-web', 'browser-search': 'melo-web', 'fetch-url': 'fetch-url', 'social-link': 'social-link', none: 'none' };
  return { route: routes[sharedPlan.route] || sharedPlan.route, reason: sharedPlan.reason,
    nativeWebSearchEnabled: sharedPlan.nativeSearchAvailable === true, exposedNetworkTools: sharedPlan.tools.filter(id => ['web_search', 'fetch_url'].includes(id)),
    urls: sharedPlan.urls, sharedPlan };
}
