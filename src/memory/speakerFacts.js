import {
  normalizeComparablePhrase,
  normalizeConversationSnippet,
} from './heuristics.js';

const SINGLE_VALUE_FACT_CATEGORIES = new Set([
  'name',
  'role',
  'location',
  'work',
]);

function splitCandidateSentences(text = '') {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .split(/[\n。！？!?]+/g)
    .map(part => normalizeConversationSnippet(part, 180))
    .filter(Boolean);
}

function cleanFactValue(value = '', maxLength = 60) {
  return normalizeConversationSnippet(
    String(value || '')
      .replace(/^[\s:：-]+/, '')
      .replace(/[\s.。!！?？,，;；:：]+$/g, ''),
    maxLength,
  );
}

function pushFact(target, seen, category, text, sourceText) {
  const normalizedText = cleanFactValue(text, 120);
  if (!normalizedText) {
    return;
  }

  const key = `${category}:${normalizeComparablePhrase(normalizedText)}`;
  if (!key || seen.has(key)) {
    return;
  }

  seen.add(key);
  target.push({
    category,
    text: normalizedText,
    sourceText: normalizeConversationSnippet(sourceText || normalizedText, 180),
  });
}

function extractFactFromSentence(sentence = '', facts, seen) {
  const text = cleanFactValue(sentence, 180);
  if (!text) {
    return;
  }

  let match =
    text.match(/^(?:my name is|call me)\s+(.{1,40})$/i) ||
    text.match(/^我叫(.{1,20})$/u) ||
    text.match(/^叫我(.{1,20})$/u);
  if (match?.[1]) {
    pushFact(facts, seen, 'name', `Name: ${cleanFactValue(match[1], 40)}`, text);
    return;
  }

  match =
    text.match(/^i am an?\s+(.{1,50})$/i) ||
    text.match(/^i'?m an?\s+(.{1,50})$/i) ||
    text.match(/^我是(.{1,30})$/u);
  if (match?.[1]) {
    pushFact(facts, seen, 'role', `Role: ${cleanFactValue(match[1], 50)}`, text);
    return;
  }

  match =
    text.match(/^i live in\s+(.{1,50})$/i) ||
    text.match(/^i'?m based in\s+(.{1,50})$/i) ||
    text.match(/^我住在(.{1,30})$/u) ||
    text.match(/^我在(.{1,30})$/u);
  if (match?.[1]) {
    pushFact(facts, seen, 'location', `Location: ${cleanFactValue(match[1], 50)}`, text);
    return;
  }

  match =
    text.match(/^i work at\s+(.{1,50})$/i) ||
    text.match(/^i work on\s+(.{1,50})$/i) ||
    text.match(/^我在(.{1,30})工作$/u);
  if (match?.[1]) {
    const label = /^i work on\s+/i.test(text) ? 'Works on' : 'Works at';
    pushFact(facts, seen, 'work', `${label}: ${cleanFactValue(match[1], 50)}`, text);
    return;
  }

  match =
    text.match(/^i prefer\s+(.{1,60})$/i) ||
    text.match(/^my favorite\s+(.{1,30})\s+is\s+(.{1,50})$/i) ||
    text.match(/^我偏好(.{1,40})$/u) ||
    text.match(/^我更喜欢(.{1,40})$/u);
  if (match?.[2]) {
    pushFact(
      facts,
      seen,
      'preference',
      `Prefers ${cleanFactValue(match[1], 30)}: ${cleanFactValue(match[2], 50)}`,
      text,
    );
    return;
  }
  if (match?.[1]) {
    pushFact(facts, seen, 'preference', `Prefers: ${cleanFactValue(match[1], 60)}`, text);
    return;
  }

  match =
    text.match(/^i like\s+(.{1,60})$/i) ||
    text.match(/^i love\s+(.{1,60})$/i) ||
    text.match(/^我喜欢(.{1,40})$/u);
  if (match?.[1]) {
    pushFact(facts, seen, 'likes', `Likes: ${cleanFactValue(match[1], 60)}`, text);
  }
}

export function extractSpeakerFacts(text = '') {
  const facts = [];
  const seen = new Set();

  for (const sentence of splitCandidateSentences(text)) {
    extractFactFromSentence(sentence, facts, seen);
    if (facts.length >= 6) {
      break;
    }
  }

  return facts;
}

export function getSpeakerFactStorageKey(fact = {}) {
  const category = String(fact?.category || '').trim().toLowerCase();
  const text = normalizeComparablePhrase(String(fact?.text || ''));
  if (!category) {
    return '';
  }

  if (SINGLE_VALUE_FACT_CATEGORIES.has(category)) {
    return category;
  }

  return text ? `${category}:${text}` : category;
}
