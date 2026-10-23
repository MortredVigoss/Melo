import { getRequestNetworkPolicy, requestUrls } from './requestPolicy.js';

import { extractTextUrls } from '../media/textUrls.js';
import { publicLookupIntent, publicLookupFollowUp } from './publicLookupIntent.js';

// Latest main function bodies; the Host supplies request identity and environment.
export function createSearchRouter({ currentRequestContext, requestEnvironment }) {
const SOCIAL_HOST_PATTERN = /(?:^|\.)((xiaohongshu|xhslink|douyin|iesdouyin|tiktok)\.com|xhslink\.com)$/i;

const DEFAULT_WEB_SEARCH_TRIGGER_RULES = Object.freeze([
  { pattern: /\b(latest|current|today's)\s+(news|price|stock|weather|score|update)s?\b/i, weight: 3 },
  { pattern: /\bwhat'?s\s+(happening|new)\b/i, weight: 3 },
  { pattern: /\bright\s+now\b/i, weight: 2 },
  { pattern: /\bstock\s+price\b/i, weight: 3 },
  { pattern: /\bweather\s+(forecast|in|at|today)\b/i, weight: 3 },
  { pattern: /\b(search|look up|find|google)\b/i, weight: 2 },
  { pattern: /最新(新闻|消息|价格|动态|行情|报道)/u, weight: 3 },
  { pattern: /(今天|现在|明天|这周)的?(天气|股价|新闻|头条|行情|温度|气温)/u, weight: 3 },
  { pattern: /(股价|股票|汇率|油价|金价)(是|多少|怎么样)/u, weight: 3 },
  { pattern: /(?:^|[\s，,。.!！？?；;：:]|请|帮我|帮忙|麻烦|顺便|再|去)查一?下.+?(的|最新|当前)/u, weight: 2 },
  // Bare 查 must be a request verb, not the suffix of 检查 / 核查 / 审查.
  { pattern: /搜索|搜一下|查找|查询|找一下|(?:^|[\s，,。.!！？?；;：:]|请|帮我|帮忙|麻烦|顺便|再|去)(?:查|搜)/u, weight: 2 },
  { pattern: /(天气|几度|多少度|下雨|气温|温度)/u, weight: 3 },
  { pattern: /(怎么去|在哪|地址|电话|营业时间|开放时间)/u, weight: 2 },
  { pattern: /(多少钱|价格|票价|费用|报价)/u, weight: 2 },
  { pattern: /航班|机票|\bflight(?:s| schedule| fare)?\b/iu, weight: 3 },
]);

const DEEP_RESEARCH_PATTERN = /(?:\b(?:deep research|research deeply|compare sources|multiple sources|source pack|citations?)\b|深度|详细调研|多来源|多个来源|横向对比|资料包|引用来源|来源对比)/iu;
const EXPLICIT_LOCAL_SEARCH_PATTERN = /(?:\b(?:local browser|melo search|browser search|use browser)\b|本地浏览器|用浏览器|用melo搜|用 melo 搜)/iu;
const LINK_READ_PATTERN = /(?:\b(?:open|read|fetch|summari[sz]e|parse|extract)\s+(?:this\s+)?(?:link|url|page|article|website|post)\b|打开链接|读取链接|读一下链接|总结链接|解析链接|这个链接|链接里|网页里|页面里|文章里)/iu;

// Web tools the search plan decides to expose per turn. A tool that declares
// `capability: 'network'` + `uiModule: 'search'` (tools/tool.js) is governed by
// the plan; the id set is the fallback for undeclared tools. Browser tools are
// gated by MELO_CDP_ENABLED above instead, never by the plan.
const SEARCH_NETWORK_TOOL_IDS = new Set(['web_search', 'fetch_url']);
// web_screenshot is a web tool too, but no route "exposes" it: like the
// browser tools it is only withheld when the user turned networking off for
// the turn, and the routing prompt says when to prefer it over fetch_url.
const NETWORK_OFF_ONLY_TOOL_IDS = new Set(['web_screenshot']);
function searchPlanGoverns(tool, id) {
  if (NETWORK_OFF_ONLY_TOOL_IDS.has(id)) return false;
  if (typeof tool?.capability === 'string' && typeof tool?.uiModule === 'string') return tool.capability === 'network' && tool.uiModule === 'search';
  return SEARCH_NETWORK_TOOL_IDS.has(id);
}
const EXPLICIT_SEARCH = /\b(?:search|look up|find|google)\b|搜索|搜一下|查找|(?:^|[\s，,。.!！？?；;：:]|请|帮我|帮忙|麻烦|顺便|再|去)查一下/iu;

let extraWebSearchTriggers = [];

function compileTrigger(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const weight = Number.isFinite(Number(entry.weight)) ? Number(entry.weight) : 1;
  const { pattern, flags } = entry;
  if (pattern instanceof RegExp) {
    return { pattern, weight };
  }
  if (typeof pattern === 'string' && pattern.trim()) {
    try {
      return { pattern: new RegExp(pattern, typeof flags === 'string' ? flags : 'iu'), weight };
    } catch {
      return null;
    }
  }
  return null;
}

function registerSearchTriggers(entries = []) {
  if (!Array.isArray(entries)) return;
  extraWebSearchTriggers = entries
    .map(compileTrigger)
    .filter(Boolean);
}

function clearSearchTriggers() {
  extraWebSearchTriggers = [];
}

function normalizeMessageContent(content = '') {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';

  const parts = [];
  for (const item of content) {
    if (typeof item === 'string') {
      parts.push(item);
    } else if (typeof item?.text === 'string') {
      parts.push(item.text);
    } else if (typeof item?.input_text === 'string') {
      parts.push(item.input_text);
    } else if (item?.type === 'text' && typeof item.text === 'string') {
      parts.push(item.text);
    } else if (item?.type === 'input_text' && typeof item.text === 'string') {
      parts.push(item.text);
    }
  }
  return parts.join(' ').trim();
}

function latestUserMessageText(messages = []) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (String(message?.role || '').toLowerCase() !== 'user') continue;
    return normalizeMessageContent(message.content);
  }
  return '';
}

const extractUrlsFromText = extractTextUrls;

function isSocialLinkUrl(url = '') {
  try {
    const hostname = new URL(String(url || '')).hostname.replace(/^www\./i, '');
    return SOCIAL_HOST_PATTERN.test(hostname);
  } catch {
    return false;
  }
}

function scoreWebSearchIntent(text = '') {
  const policy = getRequestNetworkPolicy(text);
  if (policy.searchForbidden || policy.localSearch) return 0;
  const query = policy.instruction.trim();
  if (!query) return 0;
  const intent = publicLookupIntent(query);
  if (intent === 'app' || intent === 'text') return 0;

  let score = intent === 'recommendation' ? 3 : 0;
  for (const { pattern, weight } of DEFAULT_WEB_SEARCH_TRIGGER_RULES) {
    if (pattern.test(query)) score += weight;
  }
  const context = currentRequestContext();
  const configured = context ? (context.config?.webSearchTriggers || []).map(compileTrigger).filter(Boolean) : extraWebSearchTriggers;
  for (const { pattern, weight } of configured) {
    pattern.lastIndex = 0;
    if (pattern.test(query)) score += weight;
  }
  return score;
}

function shouldUseNativeWebSearch(messagesOrText = [], { authMode = 'codex' } = {}) {
  const text = Array.isArray(messagesOrText)
    ? latestUserMessageText(messagesOrText)
    : String(messagesOrText || '').trim();
  if (authMode !== 'codex') return false;
  if (!text) return false;
  const policy = getRequestNetworkPolicy(text);
  if (policy.searchForbidden || policy.localSearch) return false;
  if (extractUrlsFromText(text).length) return false;
  if (DEEP_RESEARCH_PATTERN.test(text) || EXPLICIT_LOCAL_SEARCH_PATTERN.test(text)) return false;
  const score = scoreWebSearchIntent(text);
  return score >= 3 || (score >= 2 && EXPLICIT_SEARCH.test(policy.instruction));
}

function buildSearchPlan({
  latestUserMessage = '',
  modelMessages = [],
  authMode = 'codex',
} = {}) {
  let latestText = String(latestUserMessage || '').trim() || latestUserMessageText(modelMessages);
  const latestPolicy = getRequestNetworkPolicy(latestText);
  // Slot answers keep the pending lookup alive across several clarifications.
  // Stop at a new task or a network/search denial; never resurrect old consent.
  const slotAnswer = text => text.length <= 120 && /^(?:(?:就|只有|一共)?\s*(?:\d+|[一二三四五六七八九十两])\s*(?:个)?(?:人|位|成人)|(?:没(?:有)?|不带|无|不用|不要)(?:托运|随身)?(?:行李|托运)|(?:\d{4}年|今年|明年|后年)(?:[，,\s]*(?:肯定|当然)?默认(?:是|按)?今年)?|(?:早上|上午|下午|晚上|早去晚回)|(?:经济舱|商务舱)|(?:\d+\s*(?:adults?|people)|no\s+(?:checked\s+)?(?:bags?|luggage)))[\s。.!！]*$/iu.test(text.trim());
  if (!latestPolicy.searchForbidden && !latestPolicy.localSearch && slotAnswer(latestText)) {
    const previous = modelMessages.filter(message => message?.role === 'user').map(message => normalizeMessageContent(message.content));
    if (previous.at(-1) === latestText) previous.pop();
    const answers = [latestText];
    for (const text of previous.slice(-8).reverse()) {
      const priorPolicy = getRequestNetworkPolicy(text);
      if (priorPolicy.searchForbidden || priorPolicy.localSearch) break;
      if (slotAnswer(text)) { answers.unshift(text); continue; }
      if (scoreWebSearchIntent(text) >= 2) latestText = [text, ...answers].join('\n');
      break;
    }
  }
  if (/^(?:ok|okay|yes|sure|continue|go ahead|好|好的|继续)[\s!.?。！？]*$/iu.test(latestText)) {
    const previousUsers = modelMessages.filter(message => message?.role === 'user');
    if (normalizeMessageContent(previousUsers.at(-1)?.content) === latestText) previousUsers.pop();
    const previousText = normalizeMessageContent(previousUsers.at(-1)?.content);
    if (previousText) latestText = previousText;
  }
  if (!latestPolicy.searchForbidden && !latestPolicy.localSearch && publicLookupFollowUp(latestPolicy.instruction)) {
    const previous = modelMessages.filter(m => m?.role === 'user').map(m => normalizeMessageContent(m.content));
    if (previous.at(-1) === latestText) previous.pop();
    const answers = [latestText];
    for (const prior of previous.slice(-8).reverse()) {
      const policy = getRequestNetworkPolicy(prior);
      if (policy.searchForbidden || policy.localSearch || ['app', 'text'].includes(publicLookupIntent(policy.instruction))) break;
      if (publicLookupFollowUp(policy.instruction)) { answers.unshift(prior); continue; }
      if (scoreWebSearchIntent(prior) >= 3) latestText = [prior, ...answers].join('\n');
      break;
    }
  }
  const policy = getRequestNetworkPolicy(latestText);
  const routeText = policy.instruction;
  const urls = requestUrls(latestText);
  const noSearch = reason => ({ route: 'none', reason, nativeWebSearchEnabled: false, exposedNetworkTools: [], urls: [] });
  if (policy.fetchForbidden) return noSearch('user-disabled-network');
  if (policy.localSearch) return noSearch('explicit-workspace-search');
  const publicIntent = publicLookupIntent(routeText);
  if (publicIntent === 'app') return noSearch('explicit-app-search');
  const hasUrl = urls.length > 0;
  const hasSocialUrl = urls.some(isSocialLinkUrl);

  if (hasSocialUrl) {
    return {
      route: 'social-link',
      reason: 'social-url',
      nativeWebSearchEnabled: false,
      exposedNetworkTools: ['fetch_url'],
      urls,
    };
  }

  if (hasUrl || (!policy.searchForbidden && LINK_READ_PATTERN.test(routeText))) {
    return {
      route: 'fetch-url',
      reason: hasUrl ? 'url-present' : 'link-read-intent',
      nativeWebSearchEnabled: false,
      exposedNetworkTools: ['fetch_url'],
      urls,
    };
  }

  if (policy.searchForbidden) return noSearch('user-disabled-search');
  if (publicIntent === 'text') return noSearch('self-contained-text');

  if (DEEP_RESEARCH_PATTERN.test(routeText) || EXPLICIT_LOCAL_SEARCH_PATTERN.test(routeText)) {
    return {
      route: 'melo-web',
      reason: DEEP_RESEARCH_PATTERN.test(routeText) ? 'deep-research' : 'explicit-local-browser',
      nativeWebSearchEnabled: false,
      exposedNetworkTools: ['web_search', 'fetch_url'],
      urls: [],
    };
  }

  if (shouldUseNativeWebSearch(routeText, { authMode })) {
    return {
      route: 'codex-native',
      reason: 'codex-native-primary',
      nativeWebSearchEnabled: true,
      exposedNetworkTools: [],
      urls: [],
    };
  }

  if (scoreWebSearchIntent(routeText) >= 3 || (scoreWebSearchIntent(routeText) >= 2 && EXPLICIT_SEARCH.test(routeText))) {
    return {
      route: 'melo-web',
      reason: 'non-codex-web-intent',
      nativeWebSearchEnabled: false,
      exposedNetworkTools: ['web_search', 'fetch_url'],
      urls: [],
    };
  }

  return {
    route: 'none',
    reason: 'no-web-intent',
    nativeWebSearchEnabled: false,
    exposedNetworkTools: [],
    urls: [],
  };
}

function filterToolsForSearchPlan(tools = [], searchPlan = {}) {
  const exposed = new Set(searchPlan?.exposedNetworkTools || []);
  return (Array.isArray(tools) ? tools : []).filter(tool => {
    const id = String(tool?.id || '');
    if (/^browser_/u.test(id) && requestEnvironment().MELO_CDP_ENABLED !== '1') return false;
    if (/^browser_/u.test(id)) return searchPlan.reason !== 'user-disabled-network';
    if (NETWORK_OFF_ONLY_TOOL_IDS.has(id)) return searchPlan.reason !== 'user-disabled-network';
    if (!searchPlanGoverns(tool, id)) return true;
    return exposed.has(id);
  });
}

function constrainSearchPlan(plan, { toolIds = [], nativeSearch = false } = {}) {
  const ids = new Set(toolIds);
  if (plan.route === 'codex-native' && nativeSearch) return plan;
  if (plan.route === 'none') return plan;
  const needsFetch = ['fetch-url', 'social-link'].includes(plan.route);
  const required = needsFetch ? 'fetch_url' : 'web_search';
  if (ids.has(required)) return { ...plan, route: needsFetch ? plan.route : 'melo-web',
    nativeWebSearchEnabled: false, exposedNetworkTools: ['web_search', 'fetch_url'].filter(id => ids.has(id) && (!needsFetch || id === 'fetch_url')) };
  return { ...plan, route: 'unavailable', reason: needsFetch ? 'fetch-unavailable' : 'search-unavailable',
    nativeWebSearchEnabled: false, exposedNetworkTools: [] };
}

const SCREENSHOT_HINT = 'To show the user what a page looks like, use `web_screenshot`; to read it, use `fetch_url`.';

function buildSearchRoutingPrompt(searchPlan = {}) {
  const route = searchPlan?.route || 'none';
  if (route === 'unavailable') return '## Search Routing\nThe requested lookup is unavailable under the current Agent capabilities and tools (' + searchPlan.reason + '). Explain this limit and which facts remain unverified. Do not invent current facts or take over a phone/app/browser as a fallback.';
  if (searchPlan.reason === 'explicit-app-search') return '## Search Routing\nThe user requested a search inside a specific app. Use only an available, authorized tool for that app; otherwise explain the missing capability. Do not substitute public web results or take over another device.';
  if (route === 'codex-native') {
    return [
      '## Search Routing',
      'This turn is routed to Codex OAuth native web_search as the primary web source.',
      'Use native web_search when the answer needs current public facts. Stable knowledge can be answered directly; say which external facts were not checked. Read local context first when it identifies what to search.',
      'A browser tool failure does not mean public information is unavailable. Continue with native web_search; do not describe a disabled browser capability as a user permission denial.',
      'For flights, distinguish date-specific schedules (flight number, airports, local departure/arrival times) from live fares. Retrieve public schedules even if prices cannot be verified. Cite the exact travel dates and sources; never use generic route schedules or cached starting fares as a confirmed dated offer.',
      'Do not emit XML tool calls for `web_search` or `fetch_url` in this turn.',
    ].join('\n');
  }
  if (route === 'melo-web') {
    return [
      '## Search Routing',
      'This turn is routed to Melo web_search for structured source retrieval.',
      'Use `web_search` when broad public lookup is needed. Stable knowledge can be answered directly; say which external facts were not checked. Read local context first when it identifies what to search.',
      'For recommendations, retrieve public evidence before making current claims, read relevant returned source URLs when needed, and cite those sources. Snippets do not prove full-page contents. If search fails or sources are insufficient, say what could not be verified; never take over a phone screen as a fallback.',
      'If browser automation is unavailable, continue with public web search. Separate confirmed date-specific flight schedules from live fares and report precisely which facts remain unverified.',
      SCREENSHOT_HINT,
    ].join('\n');
  }
  if (route === 'fetch-url') {
    return [
      '## Search Routing',
      'This turn is routed to `fetch_url` because the user is asking about a specific link/page.',
      'Use `fetch_url` for the pasted URL. Do not use `web_search` for this turn.',
      SCREENSHOT_HINT,
    ].join('\n');
  }
  if (route === 'social-link') {
    return [
      '## Search Routing',
      'This turn is routed to `fetch_url`; social links are handled by Melo\'s dedicated social preview reader.',
      'Use `fetch_url` for the pasted social URL. Do not use `web_search` for this turn.',
      SCREENSHOT_HINT,
    ].join('\n');
  }
  if (searchPlan.reason === 'user-disabled-network' || searchPlan.reason === 'user-disabled-search') {
    return '## Search Routing\nThe user forbids web lookup for this turn. Answer from available context; if it is insufficient, say so. Do not invent current facts or replace web search with a local command unless the user separately requested that local action. Do not call `web_screenshot` either.';
  }
  return '';
}

return { extractUrlsFromText, registerSearchTriggers, clearSearchTriggers, normalizeMessageContent, latestUserMessageText, isSocialLinkUrl, scoreWebSearchIntent, shouldUseNativeWebSearch, buildSearchPlan, filterToolsForSearchPlan, constrainSearchPlan, buildSearchRoutingPrompt };
}
