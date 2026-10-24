export function normalizeLocale(value, fallback = 'en') {
  const base = String(value || '').replace('_', '-').split('-')[0].toLowerCase();
  return ['zh','en','ja','ko','es','ar','ru'].includes(base) ? base : fallback;
}
export function detectReplyLanguage(text = '') {
  const value = String(text).replace(/```[\s\S]*?```|https?:\/\/\S+|@\w+/g, ' ').trim();
  if (/[\u3040-\u30ff]/u.test(value)) return 'ja';
  if (/[\uac00-\ud7af\u1100-\u11ff]/u.test(value)) return 'ko';
  if (/[\u3400-\u9fff]/u.test(value)) return 'zh';
  if (/[\u0600-\u06ff]/u.test(value)) return 'ar';
  if (/[\u0400-\u04ff]/u.test(value)) return 'ru';
  if (/[¿¡ñáéíóúü]|\b(?:hola|gracias|quiero|puedes|cómo|tiempo|mañana|ayuda|necesito|dime|cambia|imagen|fondo|dónde|cuánto|por favor)\b/iu.test(value)) return 'es';
  if (/\b(?:the|please|hello|thanks|what|how|can|could|would|is|are|weather|help|show|explain)\b/iu.test(value)) return 'en';
  if ((value.match(/[A-Za-z]+/g) || []).length >= 2 && /[A-Za-z]/.test(value)) return 'en';
  return null;
}
export function resolveReplyLocale({ agentLanguage, text = '', channelLanguage, interfaceLanguage, systemLanguage = 'en' } = {}) {
  return normalizeLocale(agentLanguage, '') || detectReplyLanguage(text) || normalizeLocale(channelLanguage, '') || normalizeLocale(interfaceLanguage, '') || normalizeLocale(systemLanguage);
}
export function localeOperation(input) {
  return resolveReplyLocale(input);
}
