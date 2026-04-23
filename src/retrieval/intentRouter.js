import { createOpenAICompatibleReply } from '../openai.js';
import { debugWarn } from '../debug.js';

// Real LRU: Map preserves insertion order, so we delete-and-reinsert on every
// read to move the entry to the "most recently used" tail.  Without that step
// the cache is a plain FIFO — the eviction loop at line ~110 was removing the
// oldest *inserted* key, which in a query-repeat workload ends up evicting
// still-hot entries.  See search audit B-1.
const INTENT_CACHE = new Map();
const INTENT_CACHE_MAX = 300;

// Exported for unit tests.  These are generic — the intent cache just happens
// to be the only current caller.
export function lruGet(cache, key) {
  if (!cache.has(key)) return undefined;
  const value = cache.get(key);
  cache.delete(key);
  cache.set(key, value);
  return value;
}

export function lruSet(cache, key, value, max) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > max) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

// Test-only: reset the cache between intent-router test cases.
export function _resetIntentCacheForTests() {
  INTENT_CACHE.clear();
}

const HIGH_STAKES_PATTERN = /(?:\b(invest|investment|medical|medication|diagnose|prescri|lawsuit|legal|contract|tax|dosage)\b|药|诊断|处方|投资|法律|诉讼|合同|税务|剂量)/i;
const CREATIVE_PATTERN = /(?:\b(write|draft|compose|poem|story|novel|lyrics?|brainstorm|imagine|screenplay)\b|写一|写个|写首|创作|想象|脑暴|剧本)/i;
const CODING_PATTERN = /(?:\b(code|function|class|typescript|javascript|python|bug|debug|refactor|implement)\b|编码|代码|函数|调试|重构|实现)/i;
const FACTUAL_MARKERS = /\b(what|who|when|where|why|how|which|is|are|was|were|did|does|do)\b/i;
const FACTUAL_CN_MARKERS = /(是什么|是谁|什么时候|在哪|为什么|怎么|哪个|哪些|多少|如何|什么是)/;
const SHORT_ACK_PATTERN = /^(ok|okay|yes|no|sure|thanks|thank you|好的|好|嗯|对|是|不是|谢谢)[\s!.?。！？]*$/i;

const FALLBACK_SYSTEM_PROMPT = `Classify the user message into exactly one category:
- factual: asking for facts, information, explanations about real things/people/events
- creative: asking for writing, brainstorming, stories, imagination
- coding: programming, debugging, technical implementation
- high-stakes: medical, legal, financial, or safety-critical advice
- casual: greetings, small talk, simple acknowledgments

Output ONLY the single category word. No punctuation. No explanation.`;

function classifyByRules(query) {
  const text = String(query || '').trim();
  if (!text) {
    return 'casual';
  }

  if (SHORT_ACK_PATTERN.test(text)) {
    return 'casual';
  }
  // Action-word patterns (CREATIVE/CODING) must be checked BEFORE topic-word
  // patterns (HIGH_STAKES). Otherwise a request like "写一篇关于投资的科普"
  // (write an article about investing) would be misrouted to high-stakes
  // because the topic "投资" appears, even though the user is asking for
  // creative writing, not personalized financial advice.
  if (CODING_PATTERN.test(text)) {
    return 'coding';
  }
  if (CREATIVE_PATTERN.test(text)) {
    return 'creative';
  }
  if (HIGH_STAKES_PATTERN.test(text)) {
    return 'high-stakes';
  }

  const hasQuestionMark = /[?？]$/.test(text);
  const hasFactualEn = FACTUAL_MARKERS.test(text);
  const hasFactualCn = FACTUAL_CN_MARKERS.test(text);
  if (hasQuestionMark || hasFactualEn || hasFactualCn) {
    return 'factual';
  }

  if (text.length < 8) {
    return 'casual';
  }

  // Long messages that didn't match a specific pattern are almost always
  // factual information requests or task instructions — default to 'factual'
  // so we avoid an extra API round-trip for the large majority of messages.
  // Only genuinely ambiguous short-to-medium messages (8–80 chars, no markers)
  // fall through to the API classifier.
  if (text.length > 80) {
    return 'factual';
  }

  return null;
}

export async function classifyIntent(userMessage, { config, signal } = {}) {
  const text = String(userMessage || '').trim();
  if (!text) {
    return 'casual';
  }

  const ruleResult = classifyByRules(text);
  if (ruleResult) {
    return ruleResult;
  }

  const cacheKey = text.slice(0, 200);
  const cached = lruGet(INTENT_CACHE, cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  if (!config?.apiKey && config?.authMode !== 'codex' && config?.authMode !== 'local') {
    return 'factual';
  }

  try {
    const reply = await createOpenAICompatibleReply({
      authMode: config.authMode,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: process.env.MELO_CLASSIFIER_MODEL || 'gpt-4o-mini',
      systemPrompt: FALLBACK_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: text }],
      signal,
      providerProfile: 'fast',
    });

    const normalized = String(reply || '')
      .toLowerCase()
      .trim()
      .split(/\s+/)[0] || 'factual';
    const allowed = ['factual', 'creative', 'coding', 'high-stakes', 'casual'];
    const intent = allowed.includes(normalized) ? normalized : 'factual';

    lruSet(INTENT_CACHE, cacheKey, intent, INTENT_CACHE_MAX);

    return intent;
  } catch (error) {
    debugWarn('intent_router', `LLM classification failed (falling back to "factual"):`, error?.message || error);
    return 'factual';
  }
}

export function intentRequiresVerification(intent) {
  return intent === 'factual' || intent === 'high-stakes';
}

export function intentAllowsUncertaintyMarker(intent) {
  return intent === 'factual' || intent === 'high-stakes';
}
