// Builds a search plan the way the chat turn does (services/chat/execution/
// prepareNode.js): the shared planner behind buildSharedSearchPlan, given a
// capability snapshot. Tests that used to call the old desktop planner
// (removed 2026-11-14, the product no longer ran it) use this instead, so they
// assert the planner that actually decides a turn.
import { buildSharedSearchPlan } from '../retrieval/sharedSearchPlan.js';

const WEB_TOOLS = Object.freeze(['web_search', 'fetch_url', 'web_screenshot']);

/**
 * @param {string} text  the latest user message
 * @param {Object} [options]
 * @param {Array<string|{role:string,content:string}>} [options.messages]  earlier turns, oldest first (strings are user turns)
 * @param {'hosted'|'http'|'none'} [options.search]
 *   hosted — the connection has verified hosted search (ChatGPT sign-in)
 *   http   — no hosted search, an HTTP search backend is configured (API-key connections)
 *   none   — neither: nothing can search
 * @param {string[]} [options.tools]  tools the Agent holds; default: the web tools
 */
export function productSearchPlan(text, { messages = [], search = 'hosted', tools = WEB_TOOLS } = {}) {
  const earlier = messages.map(message => (typeof message === 'string' ? { role: 'user', content: message } : message));
  const last = earlier.at(-1);
  const modelMessages = last?.role === 'user' && last.content === text ? earlier : [...earlier, { role: 'user', content: text }];
  return buildSharedSearchPlan({
    latestUserMessage: text,
    modelMessages,
    config: search === 'http' ? { agentRuntime: { search: { backend: 'http', endpoint: 'https://search.example/api' } } } : {},
    capabilities: { executors: [...tools], grants: [...tools], hostedSearch: search === 'hosted' ? 'verified' : 'unavailable', browserSearch: true },
  });
}
