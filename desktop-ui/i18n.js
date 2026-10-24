import { runtimeStageName as stageName, runtimeStageOutput as localizedStageOutput } from '../shared/agent/runtimeMessages.js';
import { translations } from './translations.js';
export const LANGUAGES = Object.freeze([
  { id:'zh-CN', name:'简体中文', short:'中文' },
  { id:'en', name:'English', short:'EN' },
  { id:'ko', name:'한국어', short:'한국어' },
  { id:'ja', name:'日本語', short:'日本語' },
  { id:'es', name:'Español', short:'ES' },
]);
export const normalizeLanguage = value => LANGUAGES.some(language => language.id === value) ? value : 'zh-CN';
let language = 'zh-CN';
export const currentLanguage = () => language;
export function setLanguage(value) {
  language = normalizeLanguage(value);
  if (typeof document !== 'undefined') document.documentElement.lang = language;
  return language;
}
// Only call with authored interface text. Interpolated user content stays opaque.
export function t(source, values = {}, locale = language) {
  const text = translations[source]?.[normalizeLanguage(locale)] ?? String(source ?? '');
  return text.replace(/\{(\w+)\}/g, (token, key) => Object.hasOwn(values,key) ? String(values[key]) : token);
}
const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const cache = new WeakMap();
const slot = index => `\uE000${index}\uE001`;
function translateStaticText(text) {
  const core = text.trim();
  if (!core) return text;
  const slots = [];
  const key = core.replace(/\uE000(\d+)\uE001/g, (_, index) => { slots.push(index); return `{${slots.length-1}}`; });
  const translated = translations[key]?.[language];
  if (!translated) return text;
  // Catalog text is plain text, never markup. Preserve interpolation markers.
  return text.slice(0,text.indexOf(core)) + escape(translated).replace(/\{(\d+)\}/g, (_,i) => slots[i] === undefined ? `{${i}}` : slot(slots[i])) + text.slice(text.indexOf(core)+core.length);
}
function translateMarkup(source) {
  return source.split(/(<[^>]*>)/g).map(part => part.startsWith('<')
    ? part.replace(/\b(title|aria-label|placeholder|alt)="([^"]*)"/g, (_, name, value) => `${name}="${translateStaticText(value)}"`)
    : translateStaticText(part)).join('');
}
// Localizes only the literal portions of an authored template. Values are
// inserted after translation, so message text, titles, IDs and HTML never
// become translation keys. This also covers controls created outside render().
export function ui(strings, ...values) {
  let variants = cache.get(strings);
  if (!variants) { variants = new Map(); cache.set(strings,variants); }
  let compiled = variants.get(language);
  if (compiled === undefined) {
    const source = strings.reduce((result,part,index) => result + (index ? slot(index-1) : '') + part, '');
    compiled = translateMarkup(source); variants.set(language,compiled);
  }
  return compiled.replace(/\uE000(\d+)\uE001/g, (_,index) => String(values[Number(index)]));
}

export function runtimeStageName(stage) { return t(stageName(stage, language)); }

export function runtimeStageOutput(stage) { return localizedStageOutput(stage,currentLanguage()); }
