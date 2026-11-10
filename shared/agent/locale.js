export function normalizeLocale(value, fallback = 'en') {
  const base = String(value || '').replace('_', '-').split('-')[0].toLowerCase();
  return ['zh','en','ja','ko','es','ar','ru'].includes(base) ? base : fallback;
}
export function detectReplyLanguage(text = '') {
  const value = String(text).replace(/```[\s\S]*?```|https?:\/\/\S+|@\w+/g, ' ').trim();
  const count = pattern => (value.match(pattern) || []).length;
  // One borrowed word does not decide the language (2026-11-10): "ありがとう是什么意思" and
  // "鮨の匠这家店怎么样" are Chinese, "Café Sydney" and "Pokémon" are not Spanish. Kana or Hangul
  // decide unless the text also uses characters only Chinese writes, and kana must be a real share
  // of the CJK text; an accented letter counts for Spanish only after English has been ruled out.
  const kana = count(/[\u3040-\u30ff]/gu), hangul = count(/[\uac00-\ud7af\u1100-\u11ff]/gu), han = count(/[\u3400-\u9fff]/gu);
  const chineseOnly = /[这这么吗们没还给谁哪啊呢您你她它很什怎這麼嗎們沒還給誰]/u.test(value);
  if (kana && !chineseOnly && kana * 5 >= kana + han) return 'ja';
  if (hangul && !chineseOnly) return 'ko';
  if (han || kana || hangul) return 'zh';
  if (/[\u0600-\u06ff]/u.test(value)) return 'ar';
  if (/[\u0400-\u04ff]/u.test(value)) return 'ru';
  if (/[¿¡]|\b(?:hola|gracias|quiero|puedes|cómo|tiempo|mañana|ayuda|necesito|dime|cambia|imagen|fondo|dónde|cuánto|por favor)\b/iu.test(value)) return 'es';
  if (/\b(?:the|please|hello|thanks|what|how|can|could|would|is|are|weather|help|show|explain|tell|about|does|did|when|where|why|who|which|find|give|make|write|and|of|for|with|you|your|this|that)\b/iu.test(value)) return 'en';
  if (/[ñáéíóú]/iu.test(value)) return 'es';
  if ((value.match(/[A-Za-z]+/g) || []).length >= 2 && /[A-Za-z]/.test(value)) return 'en';
  return null;
}
export function resolveReplyLocale({ agentLanguage, text = '', channelLanguage, interfaceLanguage, systemLanguage = 'en' } = {}) {
  return normalizeLocale(agentLanguage, '') || detectReplyLanguage(text) || normalizeLocale(channelLanguage, '') || normalizeLocale(interfaceLanguage, '') || normalizeLocale(systemLanguage);
}
export function localeOperation(input) {
  return replyLocale(input.chat, input.text, input);
}

// Conversation language is request-local. An attachment-only turn inherits the
// most recent user language; assistant prose never overrides the user's choice.
export function replyLocale(chat = {}, userMessage = '', preferences = {}) {
  const text = [userMessage, ...(chat.messages || []).filter(row => row.role === 'user').reverse().map(row => typeof row.content === 'string' ? row.content : '')]
    .find(value => detectReplyLanguage(value)) || '';
  return resolveReplyLocale({ ...preferences, agentLanguage: preferences.agentLanguage || chat.replyLanguage, text });
}
