/**
 * translate tool
 *
 * Free translation via Google Translate's public API (no key required).
 * Auto-detects source language. Supports 100+ languages.
 */

const GT_BASE = 'https://translate.googleapis.com/translate_a/single';
const MAX_TEXT = 5000;

const LANG_ALIASES = {
  chinese: 'zh-CN', cn: 'zh-CN', zh: 'zh-CN', '中文': 'zh-CN', '简体': 'zh-CN', '繁体': 'zh-TW',
  english: 'en', en: 'en', '英文': 'en', '英语': 'en',
  japanese: 'ja', jp: 'ja', ja: 'ja', '日文': 'ja', '日语': 'ja',
  korean: 'ko', kr: 'ko', ko: 'ko', '韩文': 'ko', '韩语': 'ko',
  french: 'fr', fr: 'fr', '法语': 'fr',
  german: 'de', de: 'de', '德语': 'de',
  spanish: 'es', es: 'es', '西班牙语': 'es',
  russian: 'ru', ru: 'ru', '俄语': 'ru',
  arabic: 'ar', ar: 'ar', '阿拉伯语': 'ar',
  portuguese: 'pt', pt: 'pt', '葡萄牙语': 'pt',
  italian: 'it', it: 'it', '意大利语': 'it',
  thai: 'th', th: 'th', '泰语': 'th',
  vietnamese: 'vi', vi: 'vi', '越南语': 'vi',
  auto: 'auto',
};

function resolveLang(input) {
  if (!input) return 'auto';
  const key = input.trim().toLowerCase();
  return LANG_ALIASES[key] || key;
}

async function translateText(text, sourceLang, targetLang) {
  const sl = resolveLang(sourceLang);
  const tl = resolveLang(targetLang);
  const params = new URLSearchParams({
    client: 'gtx', sl, tl, dt: 't', q: text.slice(0, MAX_TEXT),
  });

  const res = await fetch(`${GT_BASE}?${params}`, {
    signal: AbortSignal.timeout(15_000),
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  if (!res.ok) throw new Error(`Google Translate HTTP ${res.status}`);
  const data = await res.json();

  // data[0] is array of [translatedSegment, originalSegment, ...]
  const translated = (data[0] || []).map(seg => seg[0] || '').join('');
  const detectedLang = data[2] || sl;

  return { translated, detectedLang, sourceLang: sl, targetLang: tl };
}

export const translateTool = {
  id: 'translate',
  name: 'Translate',
  description:
    'Translate text between languages using Google Translate (free, no API key). ' +
    'Auto-detects source language. Supports Chinese, English, Japanese, Korean, and 100+ other languages.',
  category: 'utility',
  isConcurrencySafe: true,
  requiresPermission: false,
  parametersSchema: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: 'The text to translate.',
      },
      from: {
        type: 'string',
        description: 'Source language (e.g. "en", "chinese", "auto"). Default: auto-detect.',
      },
      to: {
        type: 'string',
        description: 'Target language (e.g. "zh-CN", "english", "korean"). Required.',
      },
    },
    required: ['text', 'to'],
  },
  examples: [
    { text: '今天的天气真不错', to: 'english' },
    { text: 'Bonjour, comment ça va?', from: 'french', to: 'zh-CN' },
  ],

  async run({ text, from, to }) {
    if (!text?.trim()) return { ok: false, output: 'Missing "text".', error: 'INVALID_PARAMS' };
    if (!to?.trim()) return { ok: false, output: 'Missing "to" (target language).', error: 'INVALID_PARAMS' };
    try {
      const r = await translateText(text.trim(), from, to);
      const langNote = r.detectedLang !== r.sourceLang ? ` (detected: ${r.detectedLang})` : '';
      return {
        ok: true,
        output: `${r.translated}\n\n---\n${r.sourceLang}${langNote} → ${r.targetLang}`,
        meta: r,
      };
    } catch (e) {
      return { ok: false, output: `Translation failed: ${e.message}`, error: 'TRANSLATE_FAILED' };
    }
  },
};
