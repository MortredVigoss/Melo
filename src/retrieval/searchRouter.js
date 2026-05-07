const URL_PATTERN = /https?:\/\/[^\s<>"']+/gi;

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
  { pattern: /查一?下.+?(的|最新|当前)/u, weight: 2 },
  { pattern: /(帮我|请)?(查|搜|搜索|搜一下|查一下|找一下)/u, weight: 2 },
  { pattern: /(天气|几度|多少度|下雨|气温|温度)/u, weight: 3 },
  { pattern: /(怎么去|在哪|地址|电话|营业时间|开放时间)/u, weight: 2 },
  { pattern: /(多少钱|价格|票价|费用|报价)/u, weight: 2 },
]);

const DEEP_RESEARCH_PATTERN = /(?:\b(?:deep research|research deeply|compare sources|multiple sources|source pack|citations?)\b|深度|详细调研|多来源|多个来源|横向对比|资料包|引用来源|来源对比)/iu;
const EXPLICIT_LOCAL_SEARCH_PATTERN = /(?:\b(?:local browser|melo search|browser search|use browser)\b|本地浏览器|用浏览器|用melo搜|用 melo 搜)/iu;
const LINK_READ_PATTERN = /(?:\b(?:open|read|fetch|summari[sz]e|parse|extract)\s+(?:this\s+)?(?:link|url|page|article|website|post)\b|打开链接|读取链接|读一下链接|总结链接|解析链接|这个链接|链接里|网页里|页面里|文章里)/iu;

const SEARCH_NETWORK_TOOL_IDS = new Set(['web_search', 'fetch_url']);

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

export function registerSearchTriggers(entries = []) {
  if (!Array.isArray(entries)) return;
  extraWebSearchTriggers = entries
    .map(compileTrigger)
    .filter(Boolean);
}

export function clearSearchTriggers() {
  extraWebSearchTriggers = [];
}

export function normalizeMessageContent(content = '') {
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

export function latestUserMessageText(messages = []) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (String(message?.role || '').toLowerCase() !== 'user') continue;
    return normalizeMessageContent(message.content);
  }
  return '';
}

export function extractUrlsFromText(text = '') {
  const value = String(text || '');
  const urls = [];
  const seen = new Set();
  for (const match of value.matchAll(URL_PATTERN)) {
    const url = String(match[0] || '').replace(/[.,!?;:)'"]+$/u, '');
    if (!url || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

export function isSocialLinkUrl(url = '') {
  try {
    const hostname = new URL(String(url || '')).hostname.replace(/^www\./i, '');
    return SOCIAL_HOST_PATTERN.test(hostname);
  } catch {
    return false;
  }
}

export function scoreWebSearchIntent(text = '') {
  const query = String(text || '').trim();
  if (!query) return 0;

  let score = 0;
  for (const { pattern, weight } of DEFAULT_WEB_SEARCH_TRIGGER_RULES) {
    if (pattern.test(query)) score += weight;
  }
  for (const { pattern, weight } of extraWebSearchTriggers) {
    if (pattern.test(query)) score += weight;
  }
  return score;
}

export function shouldUseNativeWebSearch(messagesOrText = [], { authMode = 'codex' } = {}) {
  const text = Array.isArray(messagesOrText)
    ? latestUserMessageText(messagesOrText)
    : String(messagesOrText || '').trim();
  if (authMode !== 'codex') return false;
  if (!text) return false;
  if (extractUrlsFromText(text).length) return false;
  if (DEEP_RESEARCH_PATTERN.test(text) || EXPLICIT_LOCAL_SEARCH_PATTERN.test(text)) return false;
  return scoreWebSearchIntent(text) >= 3;
}

export function buildSearchPlan({
  latestUserMessage = '',
  modelMessages = [],
  authMode = 'codex',
} = {}) {
  const latestText = String(latestUserMessage || '').trim() || latestUserMessageText(modelMessages);
  const modelText = latestUserMessageText(modelMessages);
  const routeText = [latestText, modelText].filter(Boolean).join('\n');
  const urls = extractUrlsFromText(routeText);
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

  if (hasUrl || LINK_READ_PATTERN.test(routeText)) {
    return {
      route: 'fetch-url',
      reason: hasUrl ? 'url-present' : 'link-read-intent',
      nativeWebSearchEnabled: false,
      exposedNetworkTools: ['fetch_url'],
      urls,
    };
  }

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

  if (scoreWebSearchIntent(routeText) >= 3) {
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

export function filterToolsForSearchPlan(tools = [], searchPlan = {}) {
  const exposed = new Set(searchPlan?.exposedNetworkTools || []);
  return (Array.isArray(tools) ? tools : []).filter(tool => {
    const id = String(tool?.id || '');
    if (!SEARCH_NETWORK_TOOL_IDS.has(id)) return true;
    return exposed.has(id);
  });
}

export function buildSearchRoutingPrompt(searchPlan = {}) {
  const route = searchPlan?.route || 'none';
  if (route === 'codex-native') {
    return [
      '## Search Routing',
      'This turn is routed to Codex OAuth native web_search as the primary web source.',
      'Use the native web_search capability for current public web facts.',
      'Do not emit XML tool calls for `web_search` or `fetch_url` in this turn.',
    ].join('\n');
  }
  if (route === 'melo-web') {
    return [
      '## Search Routing',
      'This turn is routed to Melo web_search for structured source retrieval.',
      'Use `web_search` for broad web lookup, then answer from the returned sources.',
    ].join('\n');
  }
  if (route === 'fetch-url') {
    return [
      '## Search Routing',
      'This turn is routed to `fetch_url` because the user is asking about a specific link/page.',
      'Use `fetch_url` for the pasted URL. Do not use `web_search` for this turn.',
    ].join('\n');
  }
  if (route === 'social-link') {
    return [
      '## Search Routing',
      'This turn is routed to `fetch_url`; social links are handled by Melo\'s dedicated social preview reader.',
      'Use `fetch_url` for the pasted social URL. Do not use `web_search` for this turn.',
    ].join('\n');
  }
  return '';
}
