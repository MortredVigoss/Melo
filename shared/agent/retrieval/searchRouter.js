import { getRequestNetworkPolicy } from './requestPolicy.js';

import { extractTextUrls } from '../media/textUrls.js';
import { publicLookupIntent } from './publicLookupIntent.js';

// The configurable search triggers and the "is this a hosted-search turn" check.
// Planning itself is shared/agent/search.js planRequest. The planner that used
// to live here as well (buildSearchPlan, filterToolsForSearchPlan,
// constrainSearchPlan and its routing prompt) was removed on 2026-11-14: the
// product had stopped calling it, only its tests still did.
// The Host supplies the request identity.
export function createSearchRouter({ currentRequestContext }) {
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

return { registerSearchTriggers, clearSearchTriggers, shouldUseNativeWebSearch };
}
