import { isTranslationRequest } from './requestPolicy.js';
import { AGENT_LOOP_CONTRACT, contractRegExp } from '../loopContract.js';

// Real LRU: Map preserves insertion order, so we delete-and-reinsert on every
// read to move the entry to the "most recently used" tail.  Without that step
// the cache is a plain FIFO — the eviction loop at line ~110 was removing the
// oldest *inserted* key, which in a query-repeat workload ends up evicting
// still-hot entries.  See search audit B-1.
const INTENT_CACHE = new Map();

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
const GREETING_PATTERN = contractRegExp(INTENT.patterns.greeting);
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
  options.signal?.throwIfAborted();
  return classifyLocalRequest(userMessage, options);
}

export function classifyLocalRequest(userMessage, options = {}) {
  let taskType = classifyByRules(userMessage) || 'factual';
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


// Exported for the shared agent-loop contract fixtures (the iPhone ports this
// rule step; null means "ambiguous — use the conservative local fallback").
export function classifyByRules(query) {
  const text = String(query || '').trim();
  if (!text) {
    return 'casual';
  }

  if (SHORT_ACK_PATTERN.test(text) || GREETING_PATTERN.test(text)) {
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


  return null;
}

// Intent remains a local context/verification label. Smart routing owns the only
// optional classifier request, with the same turn budget and connection boundary.
export async function classifyIntent(userMessage, { signal } = {}) {
  signal?.throwIfAborted();
  return classifyByRules(userMessage) || 'factual';
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

// Only standalone greetings skip retrieval. Ongoing acknowledgements keep context.
export function isStandaloneGreeting({ text = '', messages = [], compactSummary = '' } = {}) {
  return messages.length <= 1 && !compactSummary && !messages.at(-1)?.attachments?.length &&
    (GREETING_PATTERN.test(text.trim()) || SHORT_ACK_PATTERN.test(text.trim()));
}

export function intentOperation(input = {}) {
  if (input.action === 'rules') return classifyByRules(input.text);
  if (input.action === 'risk') return classifyRisk(input.text);
  if (input.action === 'translation') return isTranslationRequest(input.text);
  if (input.action === 'greeting') return isStandaloneGreeting(input);
  return classifyLocalRequest(input.text, { contextMessages: input.messages });
}
