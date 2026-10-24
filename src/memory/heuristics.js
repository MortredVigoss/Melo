import { AGENT_LOOP_CONTRACT, contractRegExp } from '../../shared/agent/loopContract.js';
function normalizeSnippet(value = '', maxLength = 260) {
  const text = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!text) {
    return '';
  }

  return text.length > maxLength ? `${text.slice(0, maxLength).trim()}…` : text;
}

export function normalizeConversationSnippet(value, maxLength = 260) {
  return normalizeSnippet(value, maxLength);
}

export function normalizeComparablePhrase(value = '') {
  return normalizeConversationSnippet(value, 220)
    .toLowerCase()
    .replace(/[*_`"'“”‘’()[\]{}<>]/g, ' ')
    .replace(/[.,!?;:，。！？；：/\\|-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isSubsequenceMatch(text = '', query = '') {
  const haystack = String(text || '').toLowerCase();
  const needle = String(query || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!needle) {
    return false;
  }

  let searchIndex = 0;
  for (const char of needle) {
    if (char === ' ') {
      continue;
    }
    const foundAt = haystack.indexOf(char, searchIndex);
    if (foundAt === -1) {
      return false;
    }
    searchIndex = foundAt + 1;
  }

  return true;
}

export function isLikelyClarificationPrompt(text) {
  const normalized = normalizeConversationSnippet(text, 400).toLowerCase();
  if (!normalized) {
    return false;
  }

  const clarificationSignals = [
    'どちら', 'どれですか', 'どの意味', '어느 것', '무슨 뜻', 'cuál de', 'qué quieres decir',
    'which one',
    'which do you mean',
    'do you mean',
    'pick one',
    'choose one',
    'choose from',
    'tell me which',
    'what do you mean',
    'which meaning',
    '可能是这些之一',
    '可能是这些之',
    '你是指',
    '你想了解哪一个',
    '告诉我你想了解哪一个',
    '想了解哪一个',
    '请选择',
    '选一个',
    '具体是指',
    '是哪一个',
    '哪个',
    '哪一个',
  ];

  if (clarificationSignals.some(signal => normalized.includes(signal))) {
    return true;
  }

  const bulletCount = (String(text || '').match(/(^|\n)\s*[-*•]\s/g) || []).length;
  return bulletCount >= 2 && /[?？]/u.test(normalized);
}

export function isLikelyContextDependentReply(text) {
  const normalized = normalizeConversationSnippet(text, 160);
  if (!normalized) {
    return false;
  }

  const lower = normalized.toLowerCase();
  return contractRegExp(AGENT_LOOP_CONTRACT.intent.patterns.shortAck).test(lower)
    || contractRegExp(AGENT_LOOP_CONTRACT.intent.patterns.contextualReply).test(lower)
    || /^(?:that one|this one|first|second|third|第[一二三四五六七八九十]+个|这个|那个|それ|これ|그거|이거|ese|esa|este|esta)[。.!！?？]*$/iu.test(lower);

}

export function extractClarificationOptions(text = '') {
  const seen = new Set();
  const options = [];

  const pushOption = value => {
    const cleaned = String(value || '')
      .replace(/^\s*[-*•\d.)]+\s*/, '')
      .replace(/\*\*/g, '')
      .replace(/^[“"']+|[”"']+$/g, '')
      .trim();

    if (!cleaned || cleaned.length < 2 || cleaned.length > 120) {
      return;
    }

    if (/[?？]$/.test(cleaned) && isLikelyClarificationPrompt(cleaned)) {
      return;
    }

    const comparable = normalizeComparablePhrase(cleaned);
    if (!comparable || seen.has(comparable)) {
      return;
    }

    seen.add(comparable);
    options.push(cleaned);
  };

  for (const line of String(text || '').split(/\r?\n/g)) {
    pushOption(line);
  }

  for (const match of String(text || '').matchAll(/\*\*([^*]{2,80})\*\*/g)) {
    pushOption(match[1]);
  }

  return options.slice(0, 8);
}

export function findClarificationOptionMatch(latestText, options = []) {
  const normalizedLatest = normalizeComparablePhrase(latestText);
  if (!normalizedLatest) {
    return '';
  }

  return (
    options.find(option => {
      const normalizedOption = normalizeComparablePhrase(option);
      if (!normalizedOption) {
        return false;
      }

      return (
        normalizedOption === normalizedLatest ||
        normalizedOption.includes(normalizedLatest) ||
        normalizedLatest.includes(normalizedOption) ||
        isSubsequenceMatch(normalizedOption, normalizedLatest) ||
        isSubsequenceMatch(normalizedLatest, normalizedOption)
      );
    }) || ''
  );
}

export function detectClarificationFrame(previousAssistantText = '', latestUserText = '') {
  const assistantText = normalizeConversationSnippet(previousAssistantText, 360);
  const latestReply = normalizeConversationSnippet(latestUserText, 220);
  const options = extractClarificationOptions(previousAssistantText);
  const latestReplyLooksContextual = isLikelyContextDependentReply(latestReply);
  const matchedOption = latestReply ? findClarificationOptionMatch(latestReply, options) : '';
  let confidence = 0;
  const signals = [];

  if (assistantText && isLikelyClarificationPrompt(assistantText)) {
    confidence += 0.5;
    signals.push('explicit-question');
  }
  if (options.length >= 2) {
    confidence += 0.25;
    signals.push('options-listed');
  }
  if (latestReply && latestReplyLooksContextual) {
    confidence += 0.25;
    signals.push('contextual-reply');
  }
  if (matchedOption) {
    confidence = Math.min(1, confidence + 0.15);
    signals.push('option-match');
  }

  return {
    confidence: Number(confidence.toFixed(2)),
    signals,
    options,
    matchedOption,
    latestReplyLooksContextual,
    assistantText,
    latestReply,
    isFrame: Boolean(assistantText) && confidence >= 0.5,
  };
}
