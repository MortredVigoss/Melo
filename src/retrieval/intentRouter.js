import { createOpenAICompatibleReply } from '../openai.js';
import { judgeFast } from '../judge/fastJudge.js';
import { debugWarn } from '../debug.js';
import { isTranslationRequest } from './requestPolicy.js';
import { AGENT_LOOP_CONTRACT, contractRegExp } from '../runtime/agentLoopContract.js';

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

// Rule patterns, thresholds and the classifier prompt are shared with the
// iPhone finalize step (shared/protocol/agent-loop.json).
const INTENT = AGENT_LOOP_CONTRACT.intent;
const HIGH_STAKES_PATTERN = contractRegExp(INTENT.patterns.highStakes);
const CREATIVE_PATTERN = contractRegExp(INTENT.patterns.creative);
const CODING_PATTERN = contractRegExp(INTENT.patterns.coding);
const FACTUAL_MARKERS = contractRegExp(INTENT.patterns.factualEn);
const FACTUAL_CN_MARKERS = contractRegExp(INTENT.patterns.factualCn);
const SHORT_ACK_PATTERN = contractRegExp(INTENT.patterns.shortAck);
const CONTEXTUAL_REPLY_PATTERN = contractRegExp(INTENT.patterns.contextualReply);
const QUESTION_MARK_PATTERN = contractRegExp(INTENT.patterns.questionMark);

export function classifyRisk(query = '') {
  return HIGH_STAKES_PATTERN.test(String(query)) ? 'high' : 'normal';
}

export async function classifyRequest(userMessage, options = {}) {
  let taskType = await classifyIntent(userMessage, options);
  let riskText = String(userMessage || '');
  const contextualReply = CONTEXTUAL_REPLY_PATTERN.test(riskText.trim());
  if (contextualReply && Array.isArray(options.contextMessages)) {
    const turns = options.contextMessages.filter(message => message?.role === 'user');
    if (turns.at(-1)?.content === userMessage) turns.pop();
    const previous = turns.at(-1)?.content;
    if (typeof previous === 'string' && previous.trim()) {
      taskType = classifyByRules(previous) || 'factual';
      riskText = `${previous}\n${riskText}`;
    }
  }
  const riskLevel = taskType === 'high-stakes' ? 'high' : classifyRisk(riskText);
  return { taskType, riskLevel, requiresVerification: intentRequiresVerification({ taskType, riskLevel }) };
}

const FALLBACK_SYSTEM_PROMPT = INTENT.fallbackSystemPrompt;

// Exported for the shared agent-loop contract fixtures (the iPhone ports this
// rule step; null means "ambiguous — ask the classifier model").
export function classifyByRules(query) {
  const text = String(query || '').trim();
  if (!text) {
    return 'casual';
  }

  if (SHORT_ACK_PATTERN.test(text)) {
    return 'casual';
  }
  if (isTranslationRequest(text)) return 'creative';
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

  const hasQuestionMark = QUESTION_MARK_PATTERN.test(text);
  const hasFactualEn = FACTUAL_MARKERS.test(text);
  const hasFactualCn = FACTUAL_CN_MARKERS.test(text);
  if (hasQuestionMark || hasFactualEn || hasFactualCn) {
    return 'factual';
  }

  if (text.length < INTENT.shortTextChars) {
    return 'casual';
  }

  // Long messages that didn't match a specific pattern are almost always
  // factual information requests or task instructions — default to 'factual'
  // so we avoid an extra API round-trip for the large majority of messages.
  // Only genuinely ambiguous short-to-medium messages (8–80 chars, no markers)
  // fall through to the API classifier.
  if (text.length > INTENT.longTextChars) {
    return 'factual';
  }

  return null;
}

export async function classifyIntent(userMessage, { config, signal, onDecision, judge = judgeFast } = {}) {
  const text = String(userMessage || '').trim();
  if (!text) {
    return 'casual';
  }

  const ruleResult = classifyByRules(text);
  if (ruleResult) {
    return ruleResult;
  }

  if (config?.extraFast?.enabled === true) {
    return await judge({ config, task: 'intent', systemPrompt: FALLBACK_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: text }], fallback: 'factual', signal, onDecision });
  }

  // An OAuth classifier must use the configured, working model unless explicitly overridden.
  const classifierModel = config?.activeLlmProfileId ? config.model : process.env.MELO_CLASSIFIER_MODEL ||
    (config?.authMode === 'codex' ? (process.env.MELO_MODEL || config.model) : config?.model);
  const cacheKey = JSON.stringify([config?.authMode, config?.baseUrl, classifierModel, text]);
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
      apiProtocol: config.apiProtocol,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: classifierModel,
      systemPrompt: FALLBACK_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: text }],
      signal,
      providerProfile: 'fast',
      nativeWebSearchEnabled: false,
    });

    const normalized = String(reply || '')
      .toLowerCase()
      .trim()
      .split(/\s+/)[0] || 'factual';
    const allowed = INTENT.categories;
    const intent = allowed.includes(normalized) ? normalized : 'factual';

    lruSet(INTENT_CACHE, cacheKey, intent, INTENT_CACHE_MAX);

    return intent;
  } catch (error) {
    if (signal?.aborted) throw signal.reason || error;
    debugWarn('intent_router', `LLM classification failed (falling back to "factual"):`, error?.message || error);
    return 'factual';
  }
}

export function intentRequiresVerification(intent) {
  if (intent && typeof intent === 'object') {
    return intent.riskLevel === 'high' || intentRequiresVerification(intent.taskType);
  }
  return intent === 'factual' || intent === 'high-stakes';
}

export function intentAllowsUncertaintyMarker(intent) {
  return intentRequiresVerification(intent);
}
