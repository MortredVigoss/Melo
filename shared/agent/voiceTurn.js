// Live voice call rules (plan A, 2026-11-16, docs/realtime-voice-plan-20261116.md).
// The desktop server (prompt section), the desktop page (stop phrases, what a
// reply reads aloud) and the iPhone (ios/Melo/VoiceTurnRules.swift, same
// contract section and the fixtures in shared/protocol/agent-loop.json) use the
// same rules. Pure: no I/O, no globals beyond the contract.
import { AGENT_LOOP_CONTRACT, fillTemplate } from './loopContract.js';

export const VOICE_TURN = AGENT_LOOP_CONTRACT.voiceTurn;
const CJK = new RegExp(AGENT_LOOP_CONTRACT.cjkPattern.source, AGENT_LOOP_CONTRACT.cjkPattern.flags);
const STYLE_MAX_CHARS = 400;

/** 'zh' when the text has CJK ideographs (the contract's cjkPattern), else 'en'. */
export function voiceTurnLanguage(text) {
  return CJK.test(String(text || '')) ? 'zh' : 'en';
}

/** A phrase the call speaks itself (never sent to the model). */
export function voiceCallPhrase(key, language = 'zh', values = {}) {
  const entry = VOICE_TURN.phrases[key];
  if (!entry) throw new Error(`Unknown voice call phrase "${key}".`);
  return fillTemplate(entry[language === 'en' ? 'en' : 'zh'], values);
}

/** The per-turn instruction for an utterance, in the utterance's language. */
export function voiceTurnInstruction(text, { style = '' } = {}) {
  const language = voiceTurnLanguage(text);
  const base = fillTemplate(VOICE_TURN.instruction[language], { moreInChat: voiceCallPhrase('moreInChat', language) });
  const speakingStyle = String(style || '').trim().slice(0, STYLE_MAX_CHARS);
  return speakingStyle ? `${base}\n${fillTemplate(VOICE_TURN.style[language], { style: speakingStyle })}` : base;
}

function normalizeUtterance(text) {
  return String(text || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}
const STOP_PHRASES = new Set(VOICE_TURN.stopPhrases.map(normalizeUtterance));

/** True when the whole utterance is a stop phrase ("停", "算了吧。", "Stop it!"). */
export function isVoiceStopPhrase(text) {
  const normalized = normalizeUtterance(text);
  return Boolean(normalized) && STOP_PHRASES.has(normalized);
}

// Same patterns, in the same order, as SpeechText.plain in ios/Melo/SpeechText.swift.
const BLOCK_PATTERNS = [
  /<tool_call>[\s\S]*?<\/tool_call>/g, /<tool_call>[\s\S]*$/g,
  /<viz-spec>[\s\S]*?<\/viz-spec>/g, /<viz-spec>[\s\S]*$/g,
  /<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/g, /<think(?:ing)?>[\s\S]*$/g,
  /```[\s\S]*?```/g, /```[\s\S]*$/g,
  /`[^`\n]{1,200}`/g,
  /\[source:[^\]]+\]/g, /\[via:[^\]]+\]/g,
];

/** Text a voice should read: no tags, code, link targets, URLs, tables or list markers. */
export function plainSpeechText(text) {
  let out = String(text || '');
  for (const pattern of BLOCK_PATTERNS) out = out.replace(pattern, ' ');
  out = out
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/[^\s)\]>]+/g, ' ')
    .replace(/^\s*\|.*\|\s*$/gm, ' ')
    .replace(/^\s*[-=|:]{3,}\s*$/gm, ' ')
    .replace(/^\s*#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-*+•]|\d+[.)]|[☐☑])\s+/gm, '')
    .replace(/[*_~]{1,3}/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n');
  return out.trim();
}

/**
 * Sentences as SpeechText.splitSentences cuts them: CJK terminators, `!?` and
 * newlines end a sentence; an ASCII period only before whitespace or the end.
 */
export function splitSpeechSentences(text) {
  const sentences = [];
  const chars = [...String(text || '')];
  let current = '';
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index];
    current += char;
    const next = chars[index + 1];
    const boundary = char === '.' ? next === undefined || /\s/.test(next) : '。！？!?\n'.includes(char);
    if (boundary) {
      const sentence = current.trim();
      if (sentence) sentences.push(sentence);
      current = '';
    }
  }
  const tail = current.trim();
  if (tail) sentences.push(tail);
  return sentences;
}

const CUT_MARKS = ['，', ',', '、', '；', ';', ' '];
function cutSentence(sentence, limit) {
  const head = sentence.slice(0, limit);
  let at = -1;
  for (const mark of CUT_MARKS) at = Math.max(at, head.lastIndexOf(mark));
  return (at >= Math.floor(limit / 2) ? head.slice(0, at) : head).trim();
}

/**
 * What a call reads aloud for a reply. The model was asked to lead with the
 * answer and to say the moreInChat phrase before long details; the call reads
 * the sentences before that phrase (or the first sentences within
 * spokenMaxChars for the reply's language) and ends with the phrase whenever
 * something stays unread.
 * Lengths are UTF-16 units so the iPhone port gives the same result.
 * @returns {{ sentences: string[], text: string, condensed: boolean, language: 'zh'|'en' }}
 */
export function voiceCallSpeech(text) {
  const raw = String(text || '');
  const clean = plainSpeechText(raw);
  if (!clean) {
    if (!raw.trim()) return { sentences: [], text: '', condensed: false, language: voiceTurnLanguage(raw) };
    const language = voiceTurnLanguage(raw);
    const more = voiceCallPhrase('moreInChat', language);
    return { sentences: [more], text: more, condensed: true, language };
  }
  let head = clean;
  let tail = '';
  let marker = '';
  for (const language of ['zh', 'en']) {
    const phrase = voiceCallPhrase('moreInChat', language);
    const at = clean.indexOf(phrase);
    if (at >= 0) {
      head = clean.slice(0, at);
      tail = clean.slice(at + phrase.length).trim();
      marker = phrase;
      break;
    }
  }
  const language = voiceTurnLanguage(head || clean);
  const limit = VOICE_TURN.spokenMaxChars[language];
  const all = splitSpeechSentences(head);
  const picked = [];
  let used = 0;
  for (const sentence of all) {
    if (used + sentence.length > limit) break;
    picked.push(sentence);
    used += sentence.length;
  }
  let truncated = picked.length < all.length;
  if (!picked.length && all.length) {
    picked.push(cutSentence(all[0], limit));
    truncated = true;
  }
  const ending = marker || (truncated ? voiceCallPhrase('moreInChat', language) : '');
  const sentences = ending ? [...picked, ending] : picked;
  return { sentences, text: sentences.join(' '), condensed: truncated || Boolean(tail), language };
}

/** Call timings from the contract; only the end-of-speech wait is adjustable. */
export function voiceCallTiming({ endpointMs } = {}) {
  const timing = VOICE_TURN.timing;
  const endpoint = typeof endpointMs === 'number' && Number.isFinite(endpointMs) ? endpointMs : timing.endpointMs;
  return Object.freeze({
    endpointMs: Math.round(Math.min(timing.endpointMaxMs, Math.max(timing.endpointMinMs, endpoint))),
    bargeInMs: timing.bargeInMs,
    utteranceLimitMs: timing.utteranceLimitMs,
    echoTailMs: timing.echoTailMs,
    echoSimilarity: timing.echoSimilarity,
  });
}
